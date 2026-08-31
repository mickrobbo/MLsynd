// ONE-TIME USE. Delete this file after you've run it once successfully.
//
// Fixes the aftermath of the triple-payout bug (Sep 1 2026):
//   1. Finds every /xp/{uid}/log entry with reason "Monthly Casino Pot –
//      Proportional (...)" or "Monthly Casino Pot – Jackpot (...)" created
//      since `sinceTs`, and for any that were paid MORE THAN ONCE, reverses
//      every extra payment (keeps the earliest, credits a negative
//      correction entry for the rest, adjusts balance + lifetimeEarned).
//      Proportional duplicates are grouped per-person; jackpot duplicates
//      are grouped across everyone (since each buggy run drew its own,
//      possibly different, random winner).
//   2. Deletes everything under /casinoPot/months — zeroes the currently
//      "in progress" pot back to 0 so it isn't carrying inflated numbers
//      into next month's distribution. NOTE: this also wipes any genuine
//      casino losses tracked since the bug, not just bad data — that's
//      the actual effect of "burn the pot to zero" as requested.
//   3. For every uid that had at least one payout reversed, deletes their
//      /xp/{uid}/lastKnownTier field. That field only ever ratchets up and
//      is what decides whether the "Tier Up!" celebration fires again — if
//      the bogus XP pushed someone over a tier threshold during the
//      incident, this field is now permanently stuck too high even after
//      their XP is corrected. Deleting it resets the ratchet cleanly.
//
// Usage (from a browser, once deployed):
//   Preview (no writes):  https://<your-site>.netlify.app/.netlify/functions/casino-pot-emergency-fix?key=YOUR_KEY&mode=preview&sinceTs=1234567890000
//   Apply (writes data):  same URL with &mode=apply
//
// Requires one new env var: CASINO_POT_FIX_KEY (set it to any random
// string in Netlify's environment variables) — this function DOES have a
// normal public URL (it's not a scheduled function), so the key stops
// anyone else from being able to hit it.
//
// sinceTs is required and should be a millisecond timestamp from just
// before the bug started (e.g. last night's midnight) — this scopes the
// reversal ONLY to entries from the incident, so it can never touch a
// legitimate distribution from a previous month.

const FIREBASE_URL = 'https://mlsynd-default-rtdb.firebaseio.com';
const POT_REASON_RE = /^Monthly Casino Pot – (Proportional|Even Split|Jackpot) \((.+)\)$/;

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
async function dbPost(path, secret, value){
  const res = await fetch(`${FIREBASE_URL}${path}.json?access_token=${secret}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value)
  });
  if(!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json();
}
async function dbDelete(path, secret){
  const res = await fetch(`${FIREBASE_URL}${path}.json?access_token=${secret}`, { method: 'DELETE' });
  if(!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
}

async function findDuplicatePayouts(secret, sinceTs){
  const users = (await dbGet('/xp', secret)) || {};
  const proportionalByUid = {}; // uid -> [{key, entry}]
  const jackpotAll = []; // [{uid, key, entry}]

  for(const uid of Object.keys(users)){
    const log = (users[uid] && users[uid].log) || {};
    for(const key of Object.keys(log)){
      const entry = log[key];
      if(!entry || !(entry.ts >= sinceTs)) continue;
      const m = POT_REASON_RE.exec(entry.reason || '');
      if(!m) continue;
      const kind = m[1];
      if(kind === 'Proportional' || kind === 'Even Split'){
        (proportionalByUid[uid] = proportionalByUid[uid] || []).push({ key, entry });
      } else if(kind === 'Jackpot'){
        jackpotAll.push({ uid, key, entry });
      }
    }
  }

  const reversals = []; // [{uid, key, entry}]
  for(const uid of Object.keys(proportionalByUid)){
    const list = proportionalByUid[uid].sort((a, b) => a.entry.ts - b.entry.ts);
    for(let i = 1; i < list.length; i++) reversals.push({ uid, ...list[i] });
  }
  const jackpotSorted = jackpotAll.sort((a, b) => a.entry.ts - b.entry.ts);
  for(let i = 1; i < jackpotSorted.length; i++){
    reversals.push({ uid: jackpotSorted[i].uid, key: jackpotSorted[i].key, entry: jackpotSorted[i].entry });
  }

  return reversals;
}

async function applyReversal(secret, r){
  const bal = (await dbGet(`/xp/${r.uid}/balance`, secret)) || 0;
  const nextBal = bal - r.entry.amount;
  await dbPut(`/xp/${r.uid}/balance`, secret, nextBal);
  const lt = (await dbGet(`/xp/${r.uid}/lifetimeEarned`, secret)) || 0;
  await dbPut(`/xp/${r.uid}/lifetimeEarned`, secret, Math.max(0, lt - r.entry.amount));
  await dbPost(`/xp/${r.uid}/log`, secret, {
    amount: -r.entry.amount,
    reason: `Casino Pot Duplicate Payout Reversal (correcting ${r.entry.reason})`,
    balanceAfter: nextBal,
    ts: Date.now()
  });
}

// The Player Tier feature stores /xp/{uid}/lastKnownTier as a one-way
// ratchet (only ever moves up) purely to decide whether to fire the
// "Tier Up!" celebration again. If the bogus duplicate XP pushed anyone's
// live Prestige Score over a tier threshold during the incident, that
// celebration already fired and wrote the inflated tier name there
// permanently — reversing their XP won't undo that, since nothing ever
// writes this field back down on its own. Rather than re-deriving each
// person's "correct" tier server-side (would require re-implementing the
// Board Season Score formula outside the client app — too risky to get
// subtly wrong), we just delete the field for anyone who received a
// reversed payout. That resets the ratchet cleanly: worst case someone
// gets one harmless replay celebration for a tier they'd already fairly
// earned before the bug; the alternative (leaving it stuck high) silently
// and permanently breaks the celebration for them.
async function resetTierRatchet(secret, uid){
  try{ await dbDelete(`/xp/${uid}/lastKnownTier`, secret); }catch(e){}
}

export default async (req) => {
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if(!key || key !== process.env.CASINO_POT_FIX_KEY){
    return new Response('Unauthorized', { status: 401 });
  }
  const mode = url.searchParams.get('mode') || 'preview';
  const sinceTsRaw = url.searchParams.get('sinceTs');
  if(!sinceTsRaw){
    return new Response('Missing required ?sinceTs=<ms epoch> — scope this to just before the bug started.', { status: 400 });
  }
  const sinceTs = Number(sinceTsRaw);

  let secret;
  try{
    secret = await getFirebaseAccessToken();
  }catch(e){
    return new Response('Auth failed: ' + e.message, { status: 500 });
  }

  try{
    const reversals = await findDuplicatePayouts(secret, sinceTs);
    const totalReversedXP = reversals.reduce((s, r) => s + r.entry.amount, 0);
    const affectedUids = [...new Set(reversals.map(r => r.uid))];
    const currentMonths = await dbGet('/casinoPot/months', secret);
    const potBucketsToZero = Object.keys(currentMonths || {});

    if(mode === 'preview'){
      return new Response(JSON.stringify({
        mode: 'preview',
        wouldReverse: reversals.map(r => ({ uid: r.uid, amount: r.entry.amount, reason: r.entry.reason, ts: r.entry.ts })),
        totalReversedXP,
        wouldResetTierRatchetFor: affectedUids,
        potBucketsToZero
      }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // mode === 'apply'
    for(const r of reversals) await applyReversal(secret, r);
    for(const uid of affectedUids) await resetTierRatchet(secret, uid);
    await dbDelete('/casinoPot/months', secret);

    return new Response(JSON.stringify({
      mode: 'apply',
      reversed: reversals.map(r => ({ uid: r.uid, amount: r.entry.amount, reason: r.entry.reason })),
      totalReversedXP,
      tierRatchetResetFor: affectedUids,
      potBucketsZeroed: potBucketsToZero
    }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }catch(e){
    return new Response('Failed: ' + e.message, { status: 500 });
  }
};
