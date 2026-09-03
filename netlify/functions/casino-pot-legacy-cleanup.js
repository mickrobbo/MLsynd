// ONE-TIME cleanup function. Flagged by the health check: a bucket at
// /casinoPot/months/2026-09 exists (old monthly-cadence key format, from
// before the twice-monthly rebuild), is closed (not the current period),
// and has never been distributed — the current distribution logic only
// ever looks for keys ending "-01"/"-16", so a bare "2026-09" key is
// invisible to it and would sit there undelivered forever without this.
//
// Deliberately NOT just letting the next scheduled run sweep it up
// automatically: that would silently fold old, unrelated losses into a
// future period's payout with no clear record of where the extra amount
// came from. This runs the exact same distribution math (fines, the 20%
// burn, the 250M cap, the 75/25 split, the same eligibility check) as
// every other distribution, but keeps it as its own clearly-labelled,
// clearly-audited one-time event — history label is "2026-09-LEGACY",
// not "2026-09", specifically so it's never confused with a normal cycle
// if anyone looks at the history later.
//
// Deploy to netlify/functions/, hit once via:
//   POST https://mlsynddash.netlify.app/.netlify/functions/casino-pot-legacy-cleanup
//   Header: X-Cleanup-Key: <value matching LEGACY_CLEANUP_KEY env var>
// Check the JSON response carefully before trusting it, then delete this
// file and the env var. If the response looks wrong for any reason, DO
// NOT re-run it — come back with the response and figure out what's off
// first, rather than risk a second attempt compounding a mistake.

const FIREBASE_URL = 'https://mlsynd-default-rtdb.firebaseio.com';
const TIMEZONE = 'Australia/Melbourne';
const CASINO_POT_ELIGIBLE_PLAYS = 20;
const CASINO_POT_CAP = 250000000;
const CASINO_POT_BURN_RATE = 0.20;
const LEGACY_BUCKET_KEY = '2026-09';
const LEGACY_LABEL = '2026-09-LEGACY';

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
  const crypto = await import('crypto');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64url(header)}.${b64url(claim)}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKey, 'base64url');
  const jwt = `${unsigned}.${signature}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  if(!res.ok) throw new Error(`OAuth token exchange failed — HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function dbGet(path, secret){
  const res = await fetch(`${FIREBASE_URL}${path}.json?access_token=${secret}`);
  if(!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}
async function dbPut(path, secret, value){
  const res = await fetch(`${FIREBASE_URL}${path}.json?access_token=${secret}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value)
  });
  if(!res.ok) throw new Error(`PUT ${path} failed: ${res.status}`);
  return res.json();
}
async function dbDelete(path, secret){
  const res = await fetch(`${FIREBASE_URL}${path}.json?access_token=${secret}`, { method: 'DELETE' });
  if(!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
}

function periodKeyFor(date, timeZone){
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const day = Number(parts.find(p => p.type === 'day').value);
  const periodStartDay = day <= 15 ? '01' : '16';
  return `${y}-${m}-${periodStartDay}`;
}

async function creditPotXP(uid, amount, reason, secret){
  if(!(amount > 0)) return;
  const bal = (await dbGet(`/xp/${uid}/balance`, secret)) || 0;
  const next = bal + amount;
  await dbPut(`/xp/${uid}/balance`, secret, next);
  const logRes = await fetch(`${FIREBASE_URL}/xp/${uid}/log.json?access_token=${secret}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, reason, balanceAfter: next, ts: Date.now() })
  });
  if(!logRes.ok) throw new Error(`XP log POST failed for ${uid}: ${logRes.status}`);
}

async function isEligibleForProportional(uid, playCount, secret){
  if(playCount >= CASINO_POT_ELIGIBLE_PLAYS) return true;
  try{
    const log = (await dbGet(`/xp/${uid}/log`, secret)) || {};
    return Object.values(log).some(entry => {
      if(!entry || !(entry.amount > 0)) return false;
      if(/^(Blackjack|Baccarat|Roulette|Casino War|Craps|Plinko|Big Wheel|Mines|Slots|Video Poker|Spin the Wheel|Crash|Double or Nothing)/i.test(entry.reason || '')) return false;
      if(/^Casino Pot – (Even Split|Jackpot|Proportional)/.test(entry.reason || '')) return false;
      // No period-key match required here, unlike a normal live distribution —
      // this bucket is old enough that requiring the entry's own ts to fall
      // in some specific matching period would be meaningless. Real non-
      // casino XP earned at any point is treated as qualifying, which is
      // the more generous reading and appropriate for a one-time cleanup
      // of genuinely stale data rather than an active period.
      return true;
    });
  }catch(e){
    return false;
  }
}

export default async (req) => {
  const providedKey = req.headers.get('x-cleanup-key');
  const expectedKey = process.env.LEGACY_CLEANUP_KEY;
  if(!expectedKey) return new Response(JSON.stringify({ error: 'LEGACY_CLEANUP_KEY not set on server' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  if(!providedKey || providedKey !== expectedKey) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  let secret;
  try{ secret = await getFirebaseAccessToken(); }
  catch(e){ return new Response(JSON.stringify({ error: 'Server auth failed: ' + e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }

  try{
    // Idempotency first, before touching anything else — if this has
    // already been run once (label already in history), refuse outright
    // rather than risk a second payout.
    const existingHistory = await dbGet(`/casinoPot/history/${LEGACY_LABEL}`, secret);
    if(existingHistory){
      return new Response(JSON.stringify({ skipped: true, reason: 'already run — found existing history entry', existingHistory }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const bucket = await dbGet(`/casinoPot/months/${LEGACY_BUCKET_KEY}`, secret);
    if(!bucket){
      return new Response(JSON.stringify({ skipped: true, reason: `no bucket found at /casinoPot/months/${LEGACY_BUCKET_KEY} — may have already been cleared some other way` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const losses = bucket.losses || {};
    const playCounts = bucket.playCounts || {};
    const fines = Number(bucket.fines) || 0;

    const rawPot = Object.values(losses).reduce((s, v) => s + (Number(v) || 0), 0);
    const totalPot = Math.max(0, rawPot - fines);

    if(totalPot <= 0){
      return new Response(JSON.stringify({ skipped: true, reason: 'bucket exists but totalPot is 0 after fines — nothing to distribute, bucket left in place for manual review', rawPot, fines }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const allUids = new Set([...Object.keys(losses), ...Object.keys(playCounts)]);
    const eligible = [];
    for(const uid of allUids){
      const ok = await isEligibleForProportional(uid, playCounts[uid] || 0, secret);
      if(ok) eligible.push(uid);
    }

    if(eligible.length === 0){
      return new Response(JSON.stringify({ skipped: true, reason: 'no eligible participants found — bucket left in place for manual review', rawPot, totalPot, uidsSeen: [...allUids] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const cappedPot = Math.min(totalPot, CASINO_POT_CAP);
    const capBurnedAmount = totalPot - cappedPot;
    const regularBurnedAmount = Math.floor(cappedPot * CASINO_POT_BURN_RATE);
    const burnedAmount = capBurnedAmount + regularBurnedAmount;
    const distributable = cappedPot - regularBurnedAmount;
    const proportionalPool = Math.floor(distributable * 0.75);
    const jackpotPool = distributable - proportionalPool;

    const proportional = {};
    const share = Math.floor(proportionalPool / eligible.length);
    eligible.forEach(uid => { proportional[uid] = share; });

    const jackpotCandidates = Object.keys(playCounts).filter(uid => (playCounts[uid] || 0) > 0);
    const jackpotPoolCandidates = jackpotCandidates.length > 0 ? jackpotCandidates : eligible;
    const jackpotWinner = jackpotPoolCandidates[Math.floor(Math.random() * jackpotPoolCandidates.length)];

    for(const uid of Object.keys(proportional)){
      await creditPotXP(uid, proportional[uid], `Casino Pot – Even Split (${LEGACY_LABEL})`, secret);
    }
    await creditPotXP(jackpotWinner, jackpotPool, `Casino Pot – Jackpot (${LEGACY_LABEL})`, secret);

    const historyEntry = {
      month: LEGACY_LABEL, totalPot, rawPot, finesApplied: fines, cappedPot, capBurnedAmount,
      proportional, jackpotWinner, jackpotAmount: jackpotPool, burnedAmount,
      participants: jackpotPoolCandidates, distributedAt: Date.now(),
      note: 'One-time cleanup of a pre-twice-monthly legacy bucket, found by the health check. Not a normal distribution cycle.'
    };
    await dbPut(`/casinoPot/history/${LEGACY_LABEL}`, secret, historyEntry);
    await dbDelete(`/casinoPot/months/${LEGACY_BUCKET_KEY}`, secret);

    return new Response(JSON.stringify({ ok: true, historyEntry }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }catch(e){
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
