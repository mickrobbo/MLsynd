// netlify/functions/pong-mp-dealer.js
//
// Stage 4: the trusted settlement dealer for staked multiplayer Pong.
// This is the ONLY place XP actually moves for a Pong PvP match —
// never a direct client write, for the same reason Hold'em's pot
// payouts go through holdem-dealer.js rather than either player's own
// client: a client can't be trusted to credit XP into an account that
// isn't its own.
//
// IMPORTANT — I don't have holdem-dealer.js's actual source in front of
// me, only what's described about it (verifies an idToken, mints
// realtime tokens, mediates XP). This function is built to match every
// convention I *can* see elsewhere in this app (the FIREBASE_DB_SECRET
// privileged-write pattern used by check-lockouts-scheduled.js, the
// admin-email-fallback pattern used throughout firebase-rules.json,
// the XP-log shape used by every awardXP call), but the idToken
// verification approach below (a plain REST call to Google's
// identitytoolkit endpoint) is REASONABLE, NOT CONFIRMED to be what
// holdem-dealer.js itself does. If holdem-dealer.js does this
// differently, send it over and I'll match it exactly rather than run
// two different auth patterns side by side in the same app.
//
// Actions (all POST body: { idToken, matchId, action, ...extra }):
//   startMatch      — escrows the caller's stake once status is
//                      'accepted'; flips to 'in_progress' once BOTH
//                      sides have escrowed.
//   reportResult    — a client reports its own final engine snapshot
//                      ({ scoreP1, scoreP2, winner, tick }). Once both
//                      sides have reported, pong-mp-settlement-logic.js
//                      decides settle-vs-dispute; only a clean agreement
//                      ever pays out.
//   forfeit         — either player concedes an in-progress match,
//                      paying the full pot to the other side — the
//                      safety valve for a match stuck stalled forever
//                      (see pong-mp-lockstep.test.js's closing note).
//   resolveDispute  — admin-only, manually decides a disputed match.
//
// Required environment variables (Netlify site settings):
//   FIREBASE_URL        — same one every other function/client uses
//   FIREBASE_DB_SECRET  — same legacy secret check-lockouts-scheduled.js
//                          already uses for session-less privileged
//                          reads/writes (bypasses firebase-rules.json
//                          entirely for REST calls that include it)
//   FIREBASE_WEB_API_KEY — needed for the idToken verification call
//                          below; may already exist under a different
//                          name (e.g. whatever FB_API_KEY resolves from
//                          client-side) — check before assuming this
//                          needs to be added fresh.

const { decideSettlement } = require('./lib/pong-mp-settlement-logic.js');

const FIREBASE_URL = process.env.FIREBASE_URL;
const FIREBASE_DB_SECRET = process.env.FIREBASE_DB_SECRET;
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;
const ADMIN_EMAIL = 'mlsynd00@gmail.com';

function resp(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

async function dbGet(path) {
  const res = await fetch(`${FIREBASE_URL}${path}.json?auth=${FIREBASE_DB_SECRET}`);
  if (!res.ok) throw new Error(`Firebase read failed: ${path}`);
  return res.json();
}
async function dbSet(path, value) {
  const res = await fetch(`${FIREBASE_URL}${path}.json?auth=${FIREBASE_DB_SECRET}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value)
  });
  if (!res.ok) throw new Error(`Firebase write failed: ${path}`);
  return res.json();
}
async function dbPush(path, value) {
  const res = await fetch(`${FIREBASE_URL}${path}.json?auth=${FIREBASE_DB_SECRET}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value)
  });
  if (!res.ok) throw new Error(`Firebase write failed: ${path}`);
  return res.json();
}

// See the file-level note above — this specific verification approach
// is my best-match inference, not a confirmed copy of an existing
// working implementation.
async function verifyIdToken(idToken) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });
  const data = await res.json();
  if (!res.ok || !data.users || !data.users[0]) throw new Error('Session expired — sign in again.');
  return { uid: data.users[0].localId, email: data.users[0].email };
}

async function getBalance(uid) {
  const bal = await dbGet(`/xp/${uid}/balance`);
  return typeof bal === 'number' ? bal : 0;
}

// Same log shape as every other awardXP-style write in this app
// (amount, reason, balanceAfter, ts) so this shows up in a player's XP
// history indistinguishably from any other credit/debit.
async function creditXP(uid, amount, reason) {
  const current = await getBalance(uid);
  const next = current + amount;
  await dbSet(`/xp/${uid}/balance`, next);
  await dbPush(`/xp/${uid}/log`, { amount, reason, balanceAfter: next, ts: Date.now() });
  return next;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return resp(405, { error: 'Method not allowed.' });
    const body = JSON.parse(event.body || '{}');
    const { idToken, matchId, action } = body;
    if (!idToken || !matchId || !action) return resp(400, { error: 'Missing idToken, matchId, or action.' });

    const { uid, email } = await verifyIdToken(idToken);
    const status = await dbGet(`/users/${uid}/status`);
    if (status !== 'approved') return resp(403, { error: 'Not an approved member.' });

    const match = await dbGet(`/pongMatches/${matchId}`);
    if (!match) return resp(404, { error: 'Match not found.' });

    const isChallenger = uid === match.challengerUid;
    const isOpponent = uid === match.opponentUid;
    if (!isChallenger && !isOpponent && action !== 'resolveDispute') {
      return resp(403, { error: 'You are not part of this match.' });
    }
    const mySide = isChallenger ? 'p1' : 'p2';

    if (action === 'startMatch') return resp(200, await handleStartMatch(matchId, match, uid, mySide));
    if (action === 'reportResult') return resp(200, await handleReportResult(matchId, match, mySide, body.report));
    if (action === 'forfeit') return resp(200, await handleForfeit(matchId, match, uid, mySide));
    if (action === 'resolveDispute') {
      if (email !== ADMIN_EMAIL) return resp(403, { error: 'Admin only.' });
      return resp(200, await handleResolveDispute(matchId, match, body.winnerSide));
    }
    return resp(400, { error: `Unknown action: ${action}` });
  } catch (e) {
    return resp(500, { error: e.message || 'Something went wrong.' });
  }
};

async function handleStartMatch(matchId, match, uid, mySide) {
  if (match.status !== 'accepted' && match.status !== 'in_progress') {
    throw new Error(`Match isn't ready to start (status: ${match.status}).`);
  }
  const escrow = match.escrow || {};
  if (escrow[mySide]) {
    // Already paid — return the current state rather than erroring, so
    // a client that retries this call after a flaky response doesn't
    // get double-charged or see a confusing failure.
    return { alreadyEscrowed: true, status: match.status };
  }
  const balance = await getBalance(uid);
  if (balance < match.stake) {
    throw new Error(`You need ${match.stake.toLocaleString()} XP to start this match — you have ${balance.toLocaleString()}.`);
  }
  await creditXP(uid, -match.stake, `Pong PvP stake escrowed (match ${matchId})`);
  const newEscrow = { ...escrow, [mySide]: true };
  await dbSet(`/pongMatches/${matchId}/escrow`, newEscrow);
  const bothPaid = !!(newEscrow.p1 && newEscrow.p2);
  if (bothPaid) await dbSet(`/pongMatches/${matchId}/status`, 'in_progress');
  return { escrowed: true, bothPaid, status: bothPaid ? 'in_progress' : match.status };
}

async function handleReportResult(matchId, match, mySide, report) {
  if (match.status !== 'in_progress') throw new Error(`Match isn't in progress (status: ${match.status}).`);
  if (!report) throw new Error('Missing report.');

  await dbSet(`/pongMatches/${matchId}/reports/${mySide}`, { ...report, reportedAt: Date.now() });
  const reports = { ...(match.reports || {}), [mySide]: report };
  if (!reports.p1 || !reports.p2) return { waiting: true };

  const decision = decideSettlement(match, reports.p1, reports.p2);
  if (decision.outcome === 'disputed') {
    await dbSet(`/pongMatches/${matchId}/status`, 'disputed');
    await dbSet(`/pongMatches/${matchId}/disputeReason`, decision.reason);
    return { disputed: true, reason: decision.reason };
  }

  await creditXP(decision.winnerUid, decision.pot, `Pong PvP win (match ${matchId})`);
  await dbSet(`/pongMatches/${matchId}/status`, 'completed');
  await dbSet(`/pongMatches/${matchId}/result`, {
    winnerUid: decision.winnerUid, scoreP1: decision.scoreP1, scoreP2: decision.scoreP2, pot: decision.pot
  });
  return { settled: true, winnerUid: decision.winnerUid, pot: decision.pot };
}

async function handleForfeit(matchId, match, uid, mySide) {
  if (match.status !== 'in_progress') throw new Error(`Can only forfeit an in-progress match (status: ${match.status}).`);
  const winnerUid = mySide === 'p1' ? match.opponentUid : match.challengerUid;
  const pot = match.stake * 2;
  await creditXP(winnerUid, pot, `Pong PvP win by forfeit (match ${matchId})`);
  await dbSet(`/pongMatches/${matchId}/status`, 'completed_by_forfeit');
  await dbSet(`/pongMatches/${matchId}/result`, { winnerUid, forfeitedBy: uid, pot });
  return { forfeited: true, winnerUid, pot };
}

async function handleResolveDispute(matchId, match, winnerSide) {
  if (match.status !== 'disputed') throw new Error(`Match isn't disputed (status: ${match.status}).`);
  if (winnerSide !== 'p1' && winnerSide !== 'p2') throw new Error('winnerSide must be "p1" or "p2".');
  const winnerUid = winnerSide === 'p1' ? match.challengerUid : match.opponentUid;
  const pot = match.stake * 2;
  await creditXP(winnerUid, pot, `Pong PvP win (admin-resolved dispute, match ${matchId})`);
  await dbSet(`/pongMatches/${matchId}/status`, 'completed_by_admin');
  await dbSet(`/pongMatches/${matchId}/result`, { winnerUid, pot, resolvedByAdmin: true });
  return { resolved: true, winnerUid, pot };
}
