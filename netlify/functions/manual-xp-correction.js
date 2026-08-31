// ONE-TIME USE. Delete this file after you've run it once successfully.
//
// Manually sets one person's /xp/{uid}/balance to a specific value and
// logs an audited correction entry explaining why — for cases like
// Murph's, where the automated duplicate-payout reversal correctly
// removed XP that was never legitimately his, but happened to leave him
// negative because some of the bogus XP had already been spent before
// the cleanup ran. This tool doesn't try to guess the "right" number —
// you supply it, based on your own judgement of where he legitimately
// stood before the bug (per your own message: "around the 600k mark").
//
// Does NOT touch lifetimeEarned — that's a separate all-time counter and
// isn't what went negative here; only the spendable balance is corrected.
//
// Usage:
//   Preview (no writes):
//   https://<site>.netlify.app/.netlify/functions/manual-xp-correction?key=YOUR_KEY&mode=preview&uid=UID&newBalance=600000
//   Apply:
//   same URL with &mode=apply
//
// Requires env var MANUAL_FIX_KEY (reuse CASINO_POT_FIX_KEY's old value if
// you haven't deleted it, or set a fresh one — either is fine, they're
// independent of each other).

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

export default async (req) => {
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if(!key || key !== process.env.MANUAL_FIX_KEY){
    return new Response('Unauthorized', { status: 401 });
  }
  const uid = url.searchParams.get('uid');
  const newBalanceRaw = url.searchParams.get('newBalance');
  if(!uid || !newBalanceRaw){
    return new Response('Missing required ?uid=<uid>&newBalance=<number>', { status: 400 });
  }
  const newBalance = Number(newBalanceRaw);
  if(!Number.isFinite(newBalance)){
    return new Response('newBalance must be a number', { status: 400 });
  }
  const mode = url.searchParams.get('mode') || 'preview';

  let secret;
  try{ secret = await getFirebaseAccessToken(); }
  catch(e){ return new Response('Auth failed: ' + e.message, { status: 500 }); }

  try{
    const currentBalance = (await dbGet(`/xp/${uid}/balance`, secret)) || 0;
    const userRec = await dbGet(`/users/${uid}`, secret);
    const name = (userRec && userRec.name) || '(unknown name)';
    const delta = newBalance - currentBalance;

    if(mode === 'preview'){
      return new Response(JSON.stringify({
        mode: 'preview', uid, name, currentBalance, newBalance, delta
      }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    await dbPut(`/xp/${uid}/balance`, secret, newBalance);
    await dbPost(`/xp/${uid}/log`, secret, {
      amount: delta,
      reason: 'Manual Correction — balance restored to legitimate pre-incident estimate (admin request, casino pot duplicate-payout cleanup)',
      balanceAfter: newBalance,
      ts: Date.now()
    });

    return new Response(JSON.stringify({
      mode: 'apply', uid, name, previousBalance: currentBalance, newBalance, delta
    }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }catch(e){
    return new Response('Failed: ' + e.message, { status: 500 });
  }
};
