// netlify/functions/minigolf-dealer.js
//
// A single action: checkWeeklyPrize. There's no scheduled/cron function
// here — same reasoning as Hold'em's checkAutoStart/checkTimeout: this
// function can't stay running to fire a timer on its own, so it's
// lazily triggered by mgResume() every time any member opens the Mini
// Golf panel. Whichever member's client happens to be the first to
// call this after a week actually ends is the one that triggers that
// week's payout — cheap, and correct regardless of which specific
// client does it.
//
// Every shared helper below (normalizePemKey, getFirebaseAccessToken,
// verifyFirebaseIdToken, getApprovedMemberInfo, dbGet/dbSet/dbPush,
// creditXP, dbGetWithETag/dbSetIfUnchanged, the ESM export default +
// Web Response shape) is copied verbatim from holdem-dealer.js rather
// than re-derived — same reasoning as pong-mp-dealer.js: an earlier
// guess at this app's privileged-access pattern (FIREBASE_DB_SECRET)
// turned out to be wrong once holdem-dealer.js was actually available
// to check against; this reuses the confirmed-real OAuth2
// service-account flow instead.
//
// Data model:
//   /minigolf/weeklyScores/{weekKey}/{uid}: { strokes, ts } — written
//     directly by clients (firebase-rules.json only accepts a write
//     that's an improvement on the existing value), read by every
//     client to render the live ladder.
//   /minigolf/activeWeekKey: the week currently being tracked as
//     "not yet paid out". Dealer-only (no client .write rule at all).
//   /minigolf/weeklyWinners/{weekKey}: { uid, strokes, paidAt } — a
//     permanent record of each week's winner, written once, when paid.
//
// Known simplification: if NOBODY opens Mini Golf for more than a
// week (so multiple weeks elapse between checks), this only ever pays
// out the single most-recently-tracked week and then jumps straight to
// the current week — any week in between that also had real scores
// would be silently skipped rather than paid retroactively. Reasonable
// for a group that opens this app daily; flagged here rather than
// silently assumed away.

import crypto from 'crypto';

const FIREBASE_URL = 'https://mlsynd-default-rtdb.firebaseio.com';
const MINIGOLF_WEEKLY_PRIZE_XP = 100000;

// ---- Copied verbatim from holdem-dealer.js — see that file for the
// full explanation of each piece. ----

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
  if(user.role === 'readonly') return null;
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
  return (await res.json()).name;
}
async function dbGetWithETag(path, accessToken){
  const res = await fetch(`${FIREBASE_URL}${path}.json?access_token=${accessToken}`, {
    headers: { 'X-Firebase-ETag': 'true' }
  });
  if(!res.ok) return { value: null, etag: null };
  const etag = res.headers.get('ETag');
  const value = await res.json();
  return { value, etag };
}
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

// Fisher-Yates shuffle, take the first 9 indices to flip. Plain
// Math.random() is fine here — unlike the client-side Pong engine,
// nothing needs to reproduce this exact sequence anywhere else, and
// this only ever runs once per week, server-side, behind the same
// ETag claim that already prevents a double-run.
function pickNineToFlip(){
  const indices = [...Array(18).keys()];
  for(let i = indices.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return new Set(indices.slice(0, 9));
}
function rotateVariant(currentVariant){
  const flip = pickNineToFlip();
  return currentVariant.map((v, i) => flip.has(i) ? (v === 'A' ? 'B' : 'A') : v);
}

// ---- Ported from index.html's own xpWeekKey() (used for the Weekly
// Bonus feature) so this shares the exact same week-boundary
// convention as the rest of the app, rather than inventing a separate
// one — a pure function, so porting it unchanged into Node is safe. ----
function xpWeekKey(d){
  const now = d || new Date();
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function json(obj, status){
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}

export default async (req) => {
  if(req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let body;
  try{ body = await req.json(); }catch(e){ return new Response('Invalid JSON', { status: 400 }); }
  const { idToken, action } = body || {};
  if(!idToken || !action) return json({ error: 'Missing idToken or action' }, 400);

  let auth;
  try{ auth = await verifyFirebaseIdToken(idToken); }
  catch(e){ return json({ error: 'Server misconfigured.' }, 500); }
  if(!auth) return json({ error: 'Invalid or expired session — please sign in again.' }, 401);

  let accessToken;
  try{ accessToken = await getFirebaseAccessToken(); }
  catch(e){ return json({ error: `Server misconfigured. (${e.message})` }, 500); }

  const member = await getApprovedMemberInfo(auth.uid, accessToken);
  if(!member) return json({ error: 'Mini Golf is for approved members only.' }, 403);

  try{
    if(action !== 'checkWeeklyPrize') return json({ error: `Unknown action: ${action}` }, 400);

    const currentWeekKey = xpWeekKey();
    const { value: activeWeekKey, etag } = await dbGetWithETag('/minigolf/activeWeekKey', accessToken);

    // First run ever — nothing to pay yet, just start tracking the
    // current week. Conditional write: if two clients race to
    // initialize at once, only one wins; the loser's write is
    // rejected and it simply returns paid:false, which is correct
    // either way (there was nothing to pay on a first run regardless).
    if(!activeWeekKey){
      await dbSetIfUnchanged('/minigolf/activeWeekKey', currentWeekKey, etag, accessToken);
      // Explicitly seed the course to all-A rather than leaving it
      // missing — the client already defaults to all-A if this node
      // doesn't exist, but writing it here means it genuinely exists
      // in Firebase from day one instead of relying on that fallback
      // forever.
      const { etag: variantEtag } = await dbGetWithETag('/minigolf/activeVariant', accessToken);
      await dbSetIfUnchanged('/minigolf/activeVariant', new Array(18).fill('A'), variantEtag, accessToken);
      return json({ ok: true, paid: false, initialized: true });
    }

    // Still the same week — nothing to do yet.
    if(activeWeekKey === currentWeekKey){
      return json({ ok: true, paid: false });
    }

    // The tracked week has ended. Claim the right to process it via a
    // conditional write BEFORE looking up or paying a winner — if this
    // fails, another client already claimed it (either already paid,
    // or is paying it right now), so this call backs off cleanly
    // instead of risking a double payout.
    const claimed = await dbSetIfUnchanged('/minigolf/activeWeekKey', currentWeekKey, etag, accessToken);
    if(!claimed){
      return json({ ok: true, paid: false });
    }

    // Course rotation happens on every week transition, independent of
    // whether anyone actually played or won — a real course changes
    // week to week regardless. Reads its own ETag separately from the
    // activeWeekKey one above (different node) and applies the same
    // conditional-write safety, though by this point `claimed` already
    // means this specific request is the one and only one processing
    // this transition, so a second racing rotation shouldn't occur in
    // practice — the extra guard costs nothing and errs safe anyway.
    let rotationResult = null;
    try{
      const { value: currentVariant, etag: variantEtag } = await dbGetWithETag('/minigolf/activeVariant', accessToken);
      const baseVariant = (Array.isArray(currentVariant) && currentVariant.length === 18) ? currentVariant : new Array(18).fill('A');
      const nextVariant = rotateVariant(baseVariant);
      const variantSet = await dbSetIfUnchanged('/minigolf/activeVariant', nextVariant, variantEtag, accessToken);
      if(variantSet) rotationResult = nextVariant;
    }catch(e){
      console.error('Mini Golf course rotation failed (non-fatal — prize payout below still proceeds):', e);
    }

    const endedWeekKey = activeWeekKey;
    const scores = await dbGet(`/minigolf/weeklyScores/${endedWeekKey}`, accessToken);
    if(!scores){
      return json({ ok: true, paid: false, weekAdvanced: true, endedWeekKey, rotatedVariant: rotationResult });
    }

    let winnerUid = null, winnerStrokes = Infinity;
    for(const uid of Object.keys(scores)){
      const s = scores[uid] && scores[uid].strokes;
      if(typeof s === 'number' && s < winnerStrokes){ winnerStrokes = s; winnerUid = uid; }
    }
    if(!winnerUid){
      return json({ ok: true, paid: false, weekAdvanced: true, endedWeekKey, rotatedVariant: rotationResult });
    }

    await creditXP(winnerUid, MINIGOLF_WEEKLY_PRIZE_XP, `Mini Golf weekly prize (${endedWeekKey})`, accessToken);
    await dbSet(`/minigolf/weeklyWinners/${endedWeekKey}`, { uid: winnerUid, strokes: winnerStrokes, paidAt: Date.now() }, accessToken);

    return json({ ok: true, paid: true, winnerUid, strokes: winnerStrokes, weekKey: endedWeekKey, amount: MINIGOLF_WEEKLY_PRIZE_XP, rotatedVariant: rotationResult });
  }catch(e){
    console.error('Mini Golf dealer error:', e);
    return json({ error: `Something went wrong. (${e.message})` }, 500);
  }
};
