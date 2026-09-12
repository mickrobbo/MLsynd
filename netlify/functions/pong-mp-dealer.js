// netlify/functions/pong-mp-dealer.js
//
// Stage 4: the trusted settlement dealer for staked multiplayer Pong.
// This is the ONLY place XP actually moves for a Pong PvP match — never
// a direct client write, for the same reason Hold'em's pot payouts go
// through holdem-dealer.js rather than either player's own client.
//
// Every piece of shared infrastructure below (normalizePemKey,
// getFirebaseAccessToken, verifyFirebaseIdToken, getApprovedMemberInfo,
// dbGet/dbSet/dbPush, creditXP, the ESM export default + Web Response
// shape) is copied verbatim from holdem-dealer.js rather than
// re-derived, once that file was available for reference — an earlier
// version of this function guessed at a FIREBASE_DB_SECRET-based
// approach, which was wrong; Hold'em actually uses a full Google
// service-account OAuth2 flow via FIREBASE_CLIENT_EMAIL /
// FIREBASE_PRIVATE_KEY. No new env vars needed if Hold'em is already
// deployed — this reuses the exact same three (those, plus
// FIREBASE_WEB_API_KEY for idToken verification).
//
// Actions (all POST body: { idToken, matchId, action, ...extra }):
//   startMatch      — escrows the caller's stake once status is
//                      'accepted'; flips to 'in_progress' once BOTH
//                      sides have escrowed.
//   reportResult    — a client reports its own final engine snapshot
//                      ({ scoreP1, scoreP2, winner, tick }). Once both
//                      sides have reported, pong-mp-settlement-logic.mjs
//                      decides settle-vs-dispute; only agreement pays out.
//   forfeit         — either player concedes an in-progress match,
//                      paying the full pot to the other side — the
//                      safety valve for a match stuck stalled forever
//                      (see pong-mp-lockstep.test.js's closing note).
//   resolveDispute  — admin-only, manually decides a disputed match.

import crypto from 'crypto';
import { decideSettlement } from './lib/pong-mp-settlement-logic.mjs';

const FIREBASE_URL = 'https://mlsynd-default-rtdb.firebaseio.com';
const ADMIN_EMAIL = 'mlsynd00@gmail.com';

// ---- Everything from here down through creditXP is copied verbatim
// from holdem-dealer.js — see that file for the full explanation of
// each piece. Not re-derived, so it doesn't drift from the proven,
// already-live version.

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
  if(user.role === 'readonly') return null; // consistent with Hold'em — spectating is fine conceptually, real members only for staked play
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

// ---- Pong-specific from here down ----

async function getBalance(uid, accessToken){
  const bal = await dbGet(`/xp/${uid}/balance`, accessToken);
  return typeof bal === 'number' ? bal : 0;
}

export default async (req) => {
  if(req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  let body;
  try{ body = await req.json(); }catch(e){ return new Response('Invalid JSON', { status: 400 }); }
  const { idToken, matchId, action } = body || {};
  if(!idToken || !matchId || !action) return new Response('Missing idToken, matchId, or action', { status: 400 });

  let auth;
  try{ auth = await verifyFirebaseIdToken(idToken); }
  catch(e){ return new Response(JSON.stringify({ error: 'Server misconfigured.' }), { status: 500 }); }
  if(!auth) return new Response(JSON.stringify({ error: 'Invalid or expired session — please sign in again.' }), { status: 401 });

  let accessToken;
  try{ accessToken = await getFirebaseAccessToken(); }
  catch(e){ return new Response(JSON.stringify({ error: `Server misconfigured. (${e.message})` }), { status: 500 }); }

  const member = await getApprovedMemberInfo(auth.uid, accessToken);
  if(!member) return new Response(JSON.stringify({ error: 'Pong PvP is for approved members only.' }), { status: 403 });

  function json(obj, status){
    return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  }

  try{
    const match = await dbGet(`/pongMatches/${matchId}`, accessToken);
    if(!match) return json({ error: 'Match not found.' }, 404);

    const isChallenger = auth.uid === match.challengerUid;
    const isOpponent = auth.uid === match.opponentUid;
    if(!isChallenger && !isOpponent && action !== 'resolveDispute'){
      return json({ error: 'You are not part of this match.' }, 403);
    }
    const mySide = isChallenger ? 'p1' : 'p2';

    if(action === 'startMatch'){
      if(match.status !== 'accepted' && match.status !== 'in_progress'){
        return json({ error: `Match isn't ready to start (status: ${match.status}).` }, 400);
      }
      const escrow = match.escrow || {};
      if(escrow[mySide]){
        // Already paid — return current state rather than error, so a
        // client retrying after a flaky response doesn't get confused
        // or double-charged.
        return json({ alreadyEscrowed: true, status: match.status });
      }
      const balance = await getBalance(auth.uid, accessToken);
      if(balance < match.stake){
        return json({ error: `You need ${match.stake.toLocaleString()} XP to start this match — you have ${balance.toLocaleString()}.` }, 400);
      }
      await creditXP(auth.uid, -match.stake, `Pong PvP stake escrowed (match ${matchId})`, accessToken);
      const newEscrow = { ...escrow, [mySide]: true };
      await dbSet(`/pongMatches/${matchId}/escrow`, newEscrow, accessToken);
      const bothPaid = !!(newEscrow.p1 && newEscrow.p2);
      if(bothPaid) await dbSet(`/pongMatches/${matchId}/status`, 'in_progress', accessToken);
      return json({ escrowed: true, bothPaid, status: bothPaid ? 'in_progress' : match.status });
    }

    if(action === 'reportResult'){
      if(match.status !== 'in_progress') return json({ error: `Match isn't in progress (status: ${match.status}).` }, 400);
      const report = body.report;
      if(!report) return json({ error: 'Missing report.' }, 400);

      await dbSet(`/pongMatches/${matchId}/reports/${mySide}`, { ...report, reportedAt: Date.now() }, accessToken);
      const reports = { ...(match.reports || {}), [mySide]: report };
      if(!reports.p1 || !reports.p2) return json({ waiting: true });

      const decision = decideSettlement(match, reports.p1, reports.p2);
      if(decision.outcome === 'disputed'){
        await dbSet(`/pongMatches/${matchId}/status`, 'disputed', accessToken);
        await dbSet(`/pongMatches/${matchId}/disputeReason`, decision.reason, accessToken);
        return json({ disputed: true, reason: decision.reason });
      }

      await creditXP(decision.winnerUid, decision.pot, `Pong PvP win (match ${matchId})`, accessToken);
      await dbSet(`/pongMatches/${matchId}/status`, 'completed', accessToken);
      await dbSet(`/pongMatches/${matchId}/result`, {
        winnerUid: decision.winnerUid, scoreP1: decision.scoreP1, scoreP2: decision.scoreP2, pot: decision.pot
      }, accessToken);
      return json({ settled: true, winnerUid: decision.winnerUid, pot: decision.pot });
    }

    if(action === 'forfeit'){
      if(match.status !== 'in_progress') return json({ error: `Can only forfeit an in-progress match (status: ${match.status}).` }, 400);
      const winnerUid = mySide === 'p1' ? match.opponentUid : match.challengerUid;
      const pot = match.stake * 2;
      await creditXP(winnerUid, pot, `Pong PvP win by forfeit (match ${matchId})`, accessToken);
      await dbSet(`/pongMatches/${matchId}/status`, 'completed_by_forfeit', accessToken);
      await dbSet(`/pongMatches/${matchId}/result`, { winnerUid, forfeitedBy: auth.uid, pot }, accessToken);
      return json({ forfeited: true, winnerUid, pot });
    }

    if(action === 'resolveDispute'){
      const isAdmin = (auth.email || '').trim().toLowerCase() === ADMIN_EMAIL;
      if(!isAdmin) return json({ error: 'Admin only.' }, 403);
      if(match.status !== 'disputed') return json({ error: `Match isn't disputed (status: ${match.status}).` }, 400);
      const winnerSide = body.winnerSide;
      if(winnerSide !== 'p1' && winnerSide !== 'p2') return json({ error: 'winnerSide must be "p1" or "p2".' }, 400);
      const winnerUid = winnerSide === 'p1' ? match.challengerUid : match.opponentUid;
      const pot = match.stake * 2;
      await creditXP(winnerUid, pot, `Pong PvP win (admin-resolved dispute, match ${matchId})`, accessToken);
      await dbSet(`/pongMatches/${matchId}/status`, 'completed_by_admin', accessToken);
      await dbSet(`/pongMatches/${matchId}/result`, { winnerUid, pot, resolvedByAdmin: true }, accessToken);
      return json({ resolved: true, winnerUid, pot });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  }catch(e){
    console.error('Pong PvP dealer error:', e);
    return json({ error: `Something went wrong. (${e.message})` }, 500);
  }
};
