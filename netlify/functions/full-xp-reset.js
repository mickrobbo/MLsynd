// ONE-TIME USE. Delete this file after you've run it once successfully.
//
// Full reset per admin request: zeroes EVERYONE's balance and lifetimeEarned
// (not just balance — lifetimeEarned is what drives Player Tier, so this is
// what makes tier status track only what's manually given from here on),
// clears the tier ratchet for everyone so celebrations fire cleanly again,
// and zeroes the open casino pot. Manual XP given afterward via the Ledger's
// "Casino bonus" / dues-payment flows already updates lifetimeEarned itself
// (awardXPToUid -> bumpLifetimeEarned), so tier will track it automatically
// with no further code changes needed.
//
// Does NOT touch: /xp/{uid}/log history (adds one new closing entry instead
// of deleting anything), /casinoPot/history (past distribution records).
//
// Usage:
//   Preview (no writes):
//   https://<site>.netlify.app/.netlify/functions/full-xp-reset?key=YOUR_KEY&mode=preview
//   Apply:
//   same URL with &mode=apply
//
// Requires env var FULL_RESET_KEY (any random string, independent of the
// other one-off tools' keys).

const FIREBASE_URL = 'https://mlsynd-default-rtdb.firebaseio.com';

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

export default async (req) => {
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if(!key || key !== process.env.FULL_RESET_KEY){
    return new Response('Unauthorized', { status: 401 });
  }
  const mode = url.searchParams.get('mode') || 'preview';

  let secret;
  try{ secret = await getFirebaseAccessToken(); }
  catch(e){ return new Response('Auth failed: ' + e.message, { status: 500 }); }

  try{
    const xpAll = (await dbGet('/xp', secret)) || {};
    const users = (await dbGet('/users', secret)) || {};
    const uids = Object.keys(xpAll);
    const plan = uids.map(uid => ({
      uid,
      name: (users[uid] && users[uid].name) || '(unknown)',
      currentBalance: xpAll[uid].balance || 0,
      currentLifetimeEarned: xpAll[uid].lifetimeEarned || 0
    }));
    const currentMonths = await dbGet('/casinoPot/months', secret);
    const potBucketsToZero = Object.keys(currentMonths || {});

    if(mode === 'preview'){
      return new Response(JSON.stringify({ mode: 'preview', wouldReset: plan, potBucketsToZero }, null, 2),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    for(const p of plan){
      await dbPut(`/xp/${p.uid}/balance`, secret, 0);
      await dbPut(`/xp/${p.uid}/lifetimeEarned`, secret, 0);
      await dbDelete(`/xp/${p.uid}/lastKnownTier`, secret);
      await dbPost(`/xp/${p.uid}/log`, secret, {
        amount: -p.currentBalance,
        reason: 'Full Ledger Reset (admin request) — balance and lifetime XP zeroed, tier restarts from XP given from here on',
        balanceAfter: 0,
        ts: Date.now()
      });
    }
    await dbDelete('/casinoPot/months', secret);

    return new Response(JSON.stringify({ mode: 'apply', reset: plan, potBucketsZeroed: potBucketsToZero }, null, 2),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }catch(e){
    return new Response('Failed: ' + e.message, { status: 500 });
  }
};
