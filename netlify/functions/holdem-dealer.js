// ---- Hold'em dealer ----
// Trusted server-side referee for up to 9 players. Every action (sit,
// stand, start a hand, check/call/bet/raise/fold) goes through here —
// firebase-rules.json sets .write: false on /holdemTables, /holdemHands,
// and /holdemHandSecrets specifically so NO client can touch shared game
// state directly. Only this function's service-account token can write
// there, which is what makes hole-card secrecy actually enforceable: a
// player's cards live at /holdemHandSecrets/{handId}/{uid}, readable only
// by that uid, written only here.
//
// Auth: same Firebase ID token verification as syndy-chat.js (Google
// validates the token server-side via Identity Toolkit), then confirms
// /users/{uid} has status: 'approved' before any table action.
//
// Because this function is a trusted server (not an untrusted client),
// XP is credited/debited DIRECTLY here — buy-in is deducted the instant
// someone sits, winnings are credited the instant a hand resolves. This
// is actually simpler and more immediate than the Blackjack challenge
// system's "pull your own winnings" pattern, which only existed because
// THAT resolution logic ran in an untrusted browser. A trusted server
// doesn't have that problem.
//
// FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY / FIREBASE_WEB_API_KEY:
// same three env vars syndy-chat.js already uses — no new secrets needed
// if that's already deployed.
//
// Data model:
//   /holdemTables/{tableId}: { name, bigBlind, maxSeats, seats: {0:{uid,
//     name,stack,sittingOut}, 1:{...}, ...}, buttonSeatIndex,
//     currentHandId, status: 'waiting'|'hand_in_progress' }
//   /holdemHands/{handId}: PUBLIC hand state only — street, board, pot,
//     toAct, actionLog, result, players (stack/committed/folded/allIn —
//     no hole cards), actionDeadline (for auto-fold timeout),
//     revealedHoleCards (populated at showdown only, folded players'
//     cards are never revealed)
//   /holdemHandSecrets/{handId}/{uid}: { holeCards: [...] } — readable
//     only by that uid

import crypto from 'crypto';
import { createHand, applyAction, legalActions } from './lib/holdem-engine-multiway.mjs';

const FIREBASE_URL = 'https://mlsynd-default-rtdb.firebaseio.com';
const ACTION_TIMEOUT_MS = 90 * 1000; // 90s to act before auto-fold/auto-check — generous for an async app, short enough that a table doesn't stall forever on one AFK player
const MIN_PLAYERS_TO_START = 2;
const REBUY_MAX_BIG_BLINDS = 100; // standard deep-stack cash game convention
const AUTO_START_DELAY_MS = 4000; // 3-5s pause between hands when auto-start is on, so results are readable before the next deal

function normalizePemKey(raw){
  let key = (raw || '').trim();
  if((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))){
    key = key.slice(1, -1).trim();
  }
  key = key.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const match = key.match(/-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]*?)-----END (RSA )?PRIVATE KEY-----/);
  if(!match) return key;
  const label = match[1] ? 'RSA PRIVATE KEY' : 'PRIVATE KEY';
  const body = match[2].replace(/[^A-Za-z0-9+/=]/g, '');
  const lines = body.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

async function getFirebaseAccessToken(){
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawKey = process.env.FIREBASE_PRIVATE_KEY;
  if(!clientEmail) throw new Error('FIREBASE_CLIENT_EMAIL not set');
  if(!rawKey) throw new Error('FIREBASE_PRIVATE_KEY not set');
  const privateKey = normalizePemKey(rawKey);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  };
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64url(header)}.${b64url(claim)}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKey, 'base64url');
  const jwt = `${unsigned}.${signature}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  if(!res.ok) throw new Error(`OAuth token exchange failed — HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

// Mints a Firebase custom token for an already-verified uid — a
// different JWT shape from getFirebaseAccessToken above (that one gets
// an OAuth2 access token for THIS SERVER to call Firebase's REST API as
// admin; this one lets a CLIENT sign into the Firebase JS SDK's own
// firebase.auth() session as themselves). Same signing key, same RS256
// approach, genuinely different claim structure — this is Firebase's
// documented custom-token format, not something invented here. Exists
// specifically to bridge this app's REST-based auth (used everywhere
// else) into the SDK session that real-time listeners require, without
// touching or replacing how sign-in works anywhere else in the app.
async function mintCustomToken(uid){
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawKey = process.env.FIREBASE_PRIVATE_KEY;
  if(!clientEmail) throw new Error('FIREBASE_CLIENT_EMAIL not set');
  if(!rawKey) throw new Error('FIREBASE_PRIVATE_KEY not set');
  const privateKey = normalizePemKey(rawKey);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    sub: clientEmail,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now, exp: now + 3600,
    uid
  };
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64url(header)}.${b64url(claim)}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKey, 'base64url');
  return `${unsigned}.${signature}`;
}

async function verifyFirebaseIdToken(idToken){
  const fbApiKey = process.env.FIREBASE_WEB_API_KEY;
  if(!fbApiKey) throw new Error('FIREBASE_WEB_API_KEY not set');
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbApiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
  });
  if(!res.ok) return null;
  const data = await res.json();
  const user = data.users && data.users[0];
  return user ? { uid: user.localId, email: user.email } : null;
}

async function getApprovedMemberInfo(uid, accessToken){
  const res = await fetch(`${FIREBASE_URL}/users/${uid}.json?access_token=${accessToken}`);
  if(!res.ok) return null;
  const user = await res.json();
  if(!user || user.status !== 'approved') return null;
  if(user.role === 'readonly') return null; // spectating is fine for guests conceptually, but keeping this consistent with Syndy/Challenges: real members only for now
  return { ...user, uid };
}

async function dbGet(path, accessToken){
  const res = await fetch(`${FIREBASE_URL}${path}.json?access_token=${accessToken}`);
  if(!res.ok) return null;
  return res.json();
}
async function dbSet(path, value, accessToken){
  await fetch(`${FIREBASE_URL}${path}.json?access_token=${accessToken}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value)
  });
}
async function dbPush(path, value, accessToken){
  const res = await fetch(`${FIREBASE_URL}${path}.json?access_token=${accessToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value)
  });
  return (await res.json()).name; // Firebase's generated push key
}

// ---- ETag-based compare-and-swap, used only for /holdemHandInternal ----
// Firebase's REST API supports real conditional writes via ETags — not a
// hand-rolled version field, the actual primitive Firebase provides for
// exactly this. GET with X-Firebase-ETag returns a tag representing the
// current value; PUT with if-match rejects with 412 if that value has
// changed since the read. This is what stops two concurrent actions (or
// a timeout firing at the same moment as a real action) from silently
// overwriting each other — whichever write loses the race gets a clear
// rejection instead of corrupting the other player's action.
async function dbGetWithETag(path, accessToken){
  const res = await fetch(`${FIREBASE_URL}${path}.json?access_token=${accessToken}`, {
    headers: { 'X-Firebase-ETag': 'true' }
  });
  if(!res.ok) return { value: null, etag: null };
  const etag = res.headers.get('ETag');
  const value = await res.json();
  return { value, etag };
}
// Returns true if the write landed, false if the value changed since the
// read (someone else got there first) — caller decides what to do next;
// this never silently overwrites.
async function dbSetIfUnchanged(path, value, etag, accessToken){
  const res = await fetch(`${FIREBASE_URL}${path}.json?access_token=${accessToken}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'if-match': etag },
    body: JSON.stringify(value)
  });
  return res.status === 200;
}

async function creditXP(uid, amount, reason, accessToken){
  if(!amount) return;
  const balRes = await fetch(`${FIREBASE_URL}/xp/${uid}/balance.json?access_token=${accessToken}`);
  const current = (balRes.ok ? await balRes.json() : 0) || 0;
  const next = current + amount;
  await dbSet(`/xp/${uid}/balance`, next, accessToken);
  await dbPush(`/xp/${uid}/log`, { amount, reason, balanceAfter: next, ts: Date.now() }, accessToken);
  if(amount > 0){
    const ltRes = await fetch(`${FIREBASE_URL}/xp/${uid}/lifetimeEarned.json?access_token=${accessToken}`);
    const lt = (ltRes.ok ? await ltRes.json() : 0) || 0;
    await dbSet(`/xp/${uid}/lifetimeEarned`, lt + amount, accessToken);
  }
}

// Strips hole cards out of the engine's internal player objects before
// anything gets written to the PUBLIC /holdemHands path — this is the
// one function standing between "hole cards stay secret" and "everyone
// can see everyone's cards by reading the table". Called on every single
// write of hand state.
function publicPlayers(engineHand){
  const out = {};
  Object.values(engineHand.players).forEach(p => {
    out[p.uid] = { stack: p.stack, committed: p.committed, totalCommitted: p.totalCommitted, folded: p.folded, allIn: p.allIn };
  });
  return out;
}
function publicHandRecord(tableId, engineHand, revealedHoleCards){
  return {
    tableId,
    buttonUid: engineHand.buttonUid,
    seatOrder: engineHand.seatOrder,
    street: engineHand.street,
    board: engineHand.board,
    pot: engineHand.pot,
    betsThisStreet: engineHand.betsThisStreet,
    toAct: engineHand.result ? null : engineHand.toAct,
    actionLog: engineHand.actionLog,
    result: engineHand.result,
    players: publicPlayers(engineHand),
    actionDeadline: engineHand.result ? null : Date.now() + ACTION_TIMEOUT_MS,
    revealedHoleCards: revealedHoleCards || {}
  };
}
async function writeHandSecrets(handId, engineHand, accessToken){
  await Promise.all(Object.values(engineHand.players).map(p =>
    dbSet(`/holdemHandSecrets/${handId}/${p.uid}`, { holeCards: p.holeCards }, accessToken)
  ));
}

// ---- Full-fidelity internal state — never exposed to any client ----
// The engine needs its COMPLETE state to keep working correctly between
// HTTP calls (each dealer invocation is stateless — nothing survives in
// memory), including two things that must never be readable by anyone:
// the remaining deck (would let a player predict future cards) and
// needsToAct (whose exposure doesn't leak anything sensitive on its own,
// but is meaningless without the rest of the engine's bookkeeping and
// belongs with it). This is written to /holdemHandInternal, which
// firebase-rules.json locks to .read:false/.write:false for every client
// — only this function's service-account token can touch it. The public
// /holdemHands record and the per-player /holdemHandSecrets are both
// derived FROM this, never the other way around.
function serializeInternal(engineHand){
  return { ...engineHand, needsToAct: [...engineHand.needsToAct] };
}
function deserializeInternal(stored){
  return { ...stored, needsToAct: new Set(stored.needsToAct || []) };
}
async function saveInternalHand(handId, engineHand, accessToken){
  await dbSet(`/holdemHandInternal/${handId}`, serializeInternal(engineHand), accessToken);
}
// The concurrency-safe read pair — used by 'act' and 'checkTimeout', the
// two paths that read-modify-write an EXISTING hand and could genuinely
// race against each other or against each other's timing. There's no
// plain (non-ETag) read counterpart to saveInternalHand above — every
// actual read of an existing hand's internal state goes through the
// ETag-protected version below; saveInternalHand's own unconditional
// write is only ever reached from a brand-new hand under a fresh
// generated key (doStartHand), which has nothing to read first.
async function loadInternalHandWithETag(handId, accessToken){
  const { value, etag } = await dbGetWithETag(`/holdemHandInternal/${handId}`, accessToken);
  return { hand: value ? deserializeInternal(value) : null, etag };
}
async function saveInternalHandIfUnchanged(handId, engineHand, etag, accessToken){
  return dbSetIfUnchanged(`/holdemHandInternal/${handId}`, serializeInternal(engineHand), etag, accessToken);
}

// Applies the tested engine's action, writes back full internal state,
// the public projection, and (if the hand just ended) reveals non-folded
// players' hole cards. Shared by both the 'act' handler and the
// auto-fold-on-timeout path below, so there's exactly one place that does
// this bookkeeping.
//
// If `etag` is passed, the internal-state write is conditional (rejects
// if the hand changed since it was read — see loadInternalHandWithETag
// above) and this returns false without touching anything else on
// conflict, INCLUDING the public record and any XP payout, so a losing
// race never partially applies. If `etag` is omitted (only startHand
// does this, for a hand that was just created under a fresh key),
// the write is unconditional.
async function persistEngineHand(tableId, handId, engineHand, accessToken, etag){
  if(etag !== undefined){
    const ok = await saveInternalHandIfUnchanged(handId, engineHand, etag, accessToken);
    if(!ok) return false;
  } else {
    await saveInternalHand(handId, engineHand, accessToken);
  }
  let revealed = {};
  if(engineHand.result){
    Object.values(engineHand.players).forEach(p => {
      if(!p.folded) revealed[p.uid] = p.holeCards;
    });
  }
  await dbSet(`/holdemHands/${handId}`, publicHandRecord(tableId, engineHand, revealed), accessToken);
  if(engineHand.result){
    // Pay out immediately — this is the direct-crediting advantage of
    // being a trusted server. Each pot's winners split it evenly; an odd
    // remainder XP (can't literally split an odd number of XP) goes to
    // whoever's earliest in seat order among the winners — arbitrary but
    // deterministic, and off by at most 1 XP either way.
    for(const pot of engineHand.result.pots){
      const share = Math.floor(pot.amount / pot.winners.length);
      let remainder = pot.amount - share * pot.winners.length;
      for(const uid of pot.winners){
        const amount = share + (remainder > 0 ? 1 : 0);
        if(remainder > 0) remainder--;
        await creditXP(uid, amount, `Hold'em pot (${engineHand.result.reason})`, accessToken);
      }
    }
    // Whatever's left in each player's stack after the hand goes back to
    // their seat's stack figure — NOT their real XP balance yet, they
    // keep playing with it at the table until they stand up (see 'stand').
    const table = await dbGet(`/holdemTables/${tableId}`, accessToken);
    if(table && table.seats){
      Object.entries(table.seats).forEach(([seatIdx, seat]) => {
        const p = engineHand.players[seat.uid];
        if(p) table.seats[seatIdx].stack = p.stack;
      });
      table.currentHandId = null;
      table.status = 'waiting';

      // Lightweight hand history — winners, pot sizes, board, timestamp
      // only. Deliberately NOT the full action log or any hole cards
      // beyond what's already public (showdown reveals), so this doesn't
      // become a second copy of sensitive hand state to keep secure —
      // it's a scoreboard, not a replay.
      const winnersSummary = [];
      engineHand.result.pots.forEach(pot => {
        const share = Math.floor(pot.amount / pot.winners.length);
        pot.winners.forEach(uid => {
          const seatEntry = Object.values(table.seats).find(s => s.uid === uid);
          winnersSummary.push({ uid, name: seatEntry ? seatEntry.name : 'Player', amount: share });
        });
      });
      await dbSet(`/holdemHistory/${tableId}/${handId}`, {
        handId, endedAt: Date.now(), board: engineHand.board,
        potTotal: engineHand.result.pots.reduce((s, p) => s + p.amount, 0),
        winners: winnersSummary, reason: engineHand.result.reason
      }, accessToken);

      // Auto-start next hand — a timestamp the CLIENT lazily checks and
      // acts on (same pattern as the action timeout), not a server-side
      // timer, since this stateless function can't stay running to fire
      // one later. Only scheduled if there are still enough eligible
      // players (seated, not sitting out, with chips) to actually deal.
      const eligibleCount = Object.values(table.seats).filter(s => !s.sittingOut && s.stack > 0).length;
      table.autoStartAt = (table.autoStart && eligibleCount >= MIN_PLAYERS_TO_START) ? Date.now() + AUTO_START_DELAY_MS : null;

      await dbSet(`/holdemTables/${tableId}`, table, accessToken);
    }
  }
  return true;
}

// Shared by the 'startHand' and 'checkAutoStart' actions below — same
// validation, same deal logic, so the two paths (one explicit, one a
// lazy trigger) can't drift apart from each other.
async function doStartHand(table, tableId, accessToken){
  const seatedEntries = Object.entries(table.seats).filter(([i, s]) => !s.sittingOut && s.stack > 0);
  if(seatedEntries.length < MIN_PLAYERS_TO_START) return { error: `Need at least ${MIN_PLAYERS_TO_START} players with chips to start a hand.` };

  const seatIndices = seatedEntries.map(([i]) => Number(i)).sort((a, b) => a - b);
  // Rotate the button to the next seated player after wherever it was —
  // wraps correctly even if seats have been vacated since the last hand.
  let buttonIdx = seatIndices.findIndex(i => i >= (table.buttonSeatIndex || 0));
  if(buttonIdx === -1) buttonIdx = 0; else buttonIdx = (buttonIdx) % seatIndices.length;
  const orderedSeats = seatIndices.map(i => ({ uid: table.seats[i].uid, stack: table.seats[i].stack }));
  const engineButtonIdx = seatIndices.indexOf(seatIndices[buttonIdx]);

  const engineHand = createHand(orderedSeats, engineButtonIdx, table.bigBlind || 10);
  const handId = await dbPush('/holdemHands', {}, accessToken); // reserve the key first so we can reference it while building the record
  await persistEngineHand(tableId, handId, engineHand, accessToken);
  await writeHandSecrets(handId, engineHand, accessToken);

  table.currentHandId = handId;
  table.status = 'hand_in_progress';
  table.buttonSeatIndex = seatIndices[buttonIdx];
  table.autoStartAt = null;
  await dbSet(`/holdemTables/${tableId}`, table, accessToken);
  return { handId };
}

export default async (req) => {
  if(req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let body;
  try{ body = await req.json(); }catch(e){ return new Response('Invalid JSON', { status: 400 }); }
  const { idToken, tableId, action } = body || {};
  if(!idToken || !action) return new Response('Missing idToken or action', { status: 400 });

  let auth;
  try{ auth = await verifyFirebaseIdToken(idToken); }
  catch(e){ return new Response(JSON.stringify({ error: 'Server misconfigured.' }), { status: 500 }); }
  if(!auth) return new Response(JSON.stringify({ error: 'Invalid or expired session — please sign in again.' }), { status: 401 });

  let accessToken;
  try{ accessToken = await getFirebaseAccessToken(); }
  catch(e){ return new Response(JSON.stringify({ error: `Server misconfigured. (${e.message})` }), { status: 500 }); }

  const member = await getApprovedMemberInfo(auth.uid, accessToken);
  if(!member) return new Response(JSON.stringify({ error: 'Hold\'em is for approved members only.' }), { status: 403 });

  try{
    if(action === 'mintRealtimeToken'){
      // Lets the client's Firebase JS SDK session authenticate as
      // themselves (auth.uid checks in firebase-rules.json work
      // normally), specifically so real-time listeners can be used
      // instead of polling. This is the ONLY purpose of this token —
      // it doesn't change or replace how sign-in works anywhere else.
      const customToken = await mintCustomToken(auth.uid);
      return json({ ok: true, customToken });
    }

    if(action === 'createTable'){
      const { name, bigBlind, maxSeats } = body;
      if(!name || !name.trim()) return json({ error: 'Give the table a name.' }, 400);
      const bb = Math.max(1, Math.floor(Number(bigBlind) || 10));
      const seats = Math.min(9, Math.max(2, Math.floor(Number(maxSeats) || 9)));
      const newTableId = await dbPush('/holdemTables', {}, accessToken);
      const table = { name: name.trim(), bigBlind: bb, maxSeats: seats, seats: {}, buttonSeatIndex: 0, status: 'waiting', currentHandId: null, createdBy: auth.uid, createdAt: Date.now() };
      await dbSet(`/holdemTables/${newTableId}`, table, accessToken);
      return json({ ok: true, tableId: newTableId, table });
    }

    if(action === 'sit'){
      const { buyIn } = body;
      if(!(buyIn > 0)) return json({ error: 'Enter a buy-in above 0.' }, 400);
      const balRes = await fetch(`${FIREBASE_URL}/xp/${auth.uid}/balance.json?access_token=${accessToken}`);
      const balance = (balRes.ok ? await balRes.json() : 0) || 0;
      if(balance < buyIn) return json({ error: `You only have ${balance.toLocaleString()} XP.` }, 400);

      const table = await dbGet(`/holdemTables/${tableId}`, accessToken);
      if(!table) return json({ error: 'Table not found.' }, 404);
      const seatCount = Object.keys(table.seats || {}).length;
      if(seatCount >= (table.maxSeats || 9)) return json({ error: 'Table is full.' }, 400);
      if(Object.values(table.seats || {}).some(s => s.uid === auth.uid)) return json({ error: 'Already seated at this table.' }, 400);

      let nextSeatIdx = 0;
      while(table.seats && table.seats[nextSeatIdx]) nextSeatIdx++;
      table.seats = table.seats || {};
      table.seats[nextSeatIdx] = { uid: auth.uid, name: member.name || member.email, stack: buyIn, sittingOut: false, joinedAt: Date.now() };
      await creditXP(auth.uid, -buyIn, `Sat down at ${table.name}`, accessToken);
      await dbSet(`/holdemTables/${tableId}`, table, accessToken);
      return json({ ok: true, table });
    }

    if(action === 'stand'){
      const table = await dbGet(`/holdemTables/${tableId}`, accessToken);
      if(!table || !table.seats) return json({ error: 'Table not found.' }, 404);
      if(table.currentHandId) return json({ error: "Can't stand up mid-hand — wait for this hand to finish (fold if it's your turn)." }, 400);
      const seatIdx = Object.keys(table.seats).find(i => table.seats[i].uid === auth.uid);
      if(seatIdx == null) return json({ error: 'Not seated at this table.' }, 400);
      const stack = table.seats[seatIdx].stack;
      delete table.seats[seatIdx];
      await creditXP(auth.uid, stack, `Stood up from ${table.name}, cashed out`, accessToken);
      await dbSet(`/holdemTables/${tableId}`, table, accessToken);
      return json({ ok: true });
    }

    if(action === 'toggleSitOut'){
      // Stays seated (stack intact, no cash-out) but skipped for future
      // deals until toggled back — for stepping away without giving up
      // your seat or forcing a full stand-up/sit-back-down round trip.
      const table = await dbGet(`/holdemTables/${tableId}`, accessToken);
      if(!table || !table.seats) return json({ error: 'Table not found.' }, 404);
      const seatIdx = Object.keys(table.seats).find(i => table.seats[i].uid === auth.uid);
      if(seatIdx == null) return json({ error: 'Not seated at this table.' }, 400);
      table.seats[seatIdx].sittingOut = !table.seats[seatIdx].sittingOut;
      await dbSet(`/holdemTables/${tableId}`, table, accessToken);
      return json({ ok: true, sittingOut: table.seats[seatIdx].sittingOut });
    }

    if(action === 'toggleAutoStart'){
      // Any seated player can flip this — matches the trust level already
      // used for toggleSitOut. Per-table, persisted on the table object.
      const table = await dbGet(`/holdemTables/${tableId}`, accessToken);
      if(!table) return json({ error: 'Table not found.' }, 404);
      table.autoStart = !table.autoStart;
      if(!table.autoStart) table.autoStartAt = null; // cancel any already-scheduled auto-start
      await dbSet(`/holdemTables/${tableId}`, table, accessToken);
      return json({ ok: true, autoStart: table.autoStart });
    }

    if(action === 'rebuy'){
      // Add more XP to an existing seat's stack without standing up (and
      // therefore without cashing out and losing your seat). Blocked
      // during an active hand, same restriction 'stand' already has —
      // changing a stack mid-hand would complicate side-pot math for a
      // hand that's already in progress with a fixed set of stacks.
      const { amount } = body;
      if(!(amount > 0)) return json({ error: 'Enter an amount above 0.' }, 400);
      const table = await dbGet(`/holdemTables/${tableId}`, accessToken);
      if(!table || !table.seats) return json({ error: 'Table not found.' }, 404);
      if(table.currentHandId) return json({ error: 'Wait for the current hand to finish before adding chips.' }, 400);
      const seatIdx = Object.keys(table.seats).find(i => table.seats[i].uid === auth.uid);
      if(seatIdx == null) return json({ error: 'Not seated at this table.' }, 400);
      const seat = table.seats[seatIdx];
      const maxStack = (table.bigBlind || 10) * REBUY_MAX_BIG_BLINDS;
      if(seat.stack + amount > maxStack){
        return json({ error: `Max stack at this table is ${maxStack.toLocaleString()} XP (100 big blinds) — you can add up to ${Math.max(0, maxStack - seat.stack).toLocaleString()} more.` }, 400);
      }
      const balRes = await fetch(`${FIREBASE_URL}/xp/${auth.uid}/balance.json?access_token=${accessToken}`);
      const balance = (balRes.ok ? await balRes.json() : 0) || 0;
      if(balance < amount) return json({ error: `You only have ${balance.toLocaleString()} XP.` }, 400);
      await creditXP(auth.uid, -amount, `Added chips at ${table.name}`, accessToken);
      table.seats[seatIdx].stack += amount;
      await dbSet(`/holdemTables/${tableId}`, table, accessToken);
      return json({ ok: true, newStack: table.seats[seatIdx].stack });
    }

    if(action === 'startHand'){
      const table = await dbGet(`/holdemTables/${tableId}`, accessToken);
      if(!table || !table.seats) return json({ error: 'Table not found.' }, 404);
      if(table.currentHandId) return json({ error: 'A hand is already in progress.' }, 400);
      const result = await doStartHand(table, tableId, accessToken);
      if(result.error) return json({ error: result.error }, 400);
      return json({ ok: true, handId: result.handId });
    }

    if(action === 'checkAutoStart'){
      // Lazy trigger, same pattern as checkTimeout — no server-side timer
      // (this function can't stay running to fire one), so whichever
      // client's poll happens to land after autoStartAt is the one that
      // actually starts the next hand.
      const table = await dbGet(`/holdemTables/${tableId}`, accessToken);
      if(!table || !table.seats) return json({ ok: true, started: false });
      if(table.currentHandId || !table.autoStartAt || Date.now() < table.autoStartAt) return json({ ok: true, started: false });
      const result = await doStartHand(table, tableId, accessToken);
      if(result.error) return json({ ok: true, started: false }); // e.g. someone stood up and now there aren't enough players — quietly don't start, not an error worth surfacing
      return json({ ok: true, started: true, handId: result.handId });
    }


    if(action === 'act'){
      const { handId, playerAction } = body;
      const table = await dbGet(`/holdemTables/${tableId}`, accessToken);
      if(!table || table.currentHandId !== handId) return json({ error: 'This hand is not currently active.' }, 400);
      // ETag-protected read-modify-write — if someone else's action (or
      // the auto-fold timeout) lands in the gap between this read and
      // write, the conditional save rejects and this returns a clear
      // error rather than silently overwriting whatever they just did.
      // One retry: re-read the now-current state and re-validate this
      // exact action against it fresh (not blindly reapplied) — if it's
      // still legal, it goes through; if the board's moved on, the
      // player gets a clear "try again" rather than a confusing failure.
      for(let attempt = 0; attempt < 2; attempt++){
        const { hand: rebuilt, etag } = await loadInternalHandWithETag(handId, accessToken);
        if(!rebuilt) return json({ error: 'Hand not found.' }, 404);
        if(rebuilt.result) return json({ error: 'This hand has already finished.' }, 400);
        const legal = legalActions(rebuilt, auth.uid);
        if(!legal.includes(playerAction)) return json({ error: `Illegal action — legal right now: ${legal.join(', ')}` }, 400);
        const next = applyAction(rebuilt, auth.uid, playerAction);
        const saved = await persistEngineHand(tableId, handId, next, accessToken, etag);
        if(saved) return json({ ok: true });
        // else: someone else wrote first — loop once to retry against fresh state
      }
      return json({ error: "Someone else's action landed at the same moment — try again." }, 409);
    }

    if(action === 'checkTimeout'){
      // Lazy check, same pattern as the 24h challenge expiry — called
      // whenever anyone's client polls the table, no scheduled function
      // needed. If it's been too long since actionDeadline, the player
      // whose turn it is gets auto-folded (or auto-checked if they owe
      // nothing) so the table doesn't stall forever on one AFK player.
      const table = await dbGet(`/holdemTables/${tableId}`, accessToken);
      if(!table || !table.currentHandId) return json({ ok: true, timedOut: false });
      const hand = await dbGet(`/holdemHands/${table.currentHandId}`, accessToken);
      if(!hand || hand.result || !hand.actionDeadline || Date.now() < hand.actionDeadline) return json({ ok: true, timedOut: false });
      // Same ETag protection — a real action from the player might land
      // in the exact instant their timeout also fires. Whichever write
      // wins, the other is rejected rather than corrupting the hand; on
      // conflict this just no-ops (the real action already resolved it,
      // nothing left to time out), not an error worth surfacing.
      const { hand: rebuilt, etag } = await loadInternalHandWithETag(table.currentHandId, accessToken);
      if(!rebuilt || rebuilt.result) return json({ ok: true, timedOut: false });
      const legal = legalActions(rebuilt, hand.toAct);
      if(legal.length === 0) return json({ ok: true, timedOut: false }); // toAct no longer matches this player's actual legal state — a real action already landed
      const autoAction = legal.includes('check') ? 'check' : 'fold';
      const next = applyAction(rebuilt, hand.toAct, autoAction);
      const saved = await persistEngineHand(tableId, table.currentHandId, next, accessToken, etag);
      if(!saved) return json({ ok: true, timedOut: false }); // lost the race to a real action — nothing to do
      return json({ ok: true, timedOut: true, autoAction, uid: hand.toAct });
    }

    return json({ error: 'Unknown action.' }, 400);
  }catch(e){
    console.error('Hold\'em dealer error:', e);
    return json({ error: `Something went wrong. (${e.message})` }, 500);
  }

  function json(obj, status){
    return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  }
};
