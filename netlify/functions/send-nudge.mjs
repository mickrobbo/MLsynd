// Sends a single "nudge" push notification from one member to another.
// Written from scratch based on the client's own send-nudge.mjs contract
// (already fully coded in DASHBOARD-index.html's profileNudgeBtn handler)
// and the proven webpush pattern already used by
// casino-pot-distribute-scheduled.js's sendPotPushNotifications — this is
// the most likely reason Nudge "doesn't work properly": the client side
// was always correct and already handles every response case cleanly
// (success, rate-limited, no subscription on file, not deployed), but
// this file itself may never have actually been deployed, matching the
// exact "file exists in the app's expectations but was never pushed"
// pattern this project has hit more than once this week. If a DIFFERENT
// version of this file already exists in your repo, let me know so we
// can reconcile rather than have two conflicting copies.
//
// POST body: { idToken, toUid }
// Responses the client already understands:
//   200 — nudge sent
//   429 { error } — nudged this person too recently, cooldown still active
//   404 { error } — toUid has no push subscription on file (they've never
//                   enabled notifications, or their subscription expired)
//   4xx/5xx with no parseable JSON body — the client correctly reports
//                   this as "server said HTTP <code>" rather than
//                   misreporting it as a notification-settings issue
//
// Needs the same env vars already set up for casino-pot-distribute-
// scheduled.js: FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY,
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT. Also needs the
// Firebase Web API key (same one already used client-side for
// sign-in) to verify the caller's idToken — hardcoded below since it's
// not a secret (Firebase API keys are meant to be public; what actually
// gates access is the security rules, same as everywhere else in this
// project), matching how the Ledger already embeds it as FB_API_KEY.

import webpush from 'web-push';

const FIREBASE_URL = 'https://mlsynd-default-rtdb.firebaseio.com';
const FB_API_KEY = 'AIzaSyAOxWjx7kwaEKN3Ab29kObrTZBIEyUhKfI';
const NUDGE_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between nudges to the same person from the same sender

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

// Verifies the caller genuinely owns a real, currently-valid Firebase
// session and returns THEIR OWN uid — deliberately not trusting a
// client-supplied "fromUid" for this, which would let anyone nudge
// "as" anyone else just by editing the request body.
async function verifyIdTokenAndGetUid(idToken){
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FB_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });
  if(!res.ok) return null;
  const data = await res.json();
  const user = data.users && data.users[0];
  return user ? user.localId : null;
}

export default async (req) => {
  let body;
  try{ body = await req.json(); }catch(e){ return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
  const { idToken, toUid } = body || {};
  if(!idToken || !toUid){
    return new Response(JSON.stringify({ error: 'Missing idToken or toUid' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const fromUid = await verifyIdTokenAndGetUid(idToken);
  if(!fromUid){
    return new Response(JSON.stringify({ error: 'Not signed in' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  if(fromUid === toUid){
    return new Response(JSON.stringify({ error: "Can't nudge yourself" }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  let secret;
  try{ secret = await getFirebaseAccessToken(); }
  catch(e){ return new Response(JSON.stringify({ error: 'Server auth failed: ' + e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }

  try{
    const cooldownPath = `/nudges/${fromUid}_${toUid}/lastSentAt`;
    const lastSentAt = await dbGet(cooldownPath, secret).catch(() => null);
    if(lastSentAt && (Date.now() - lastSentAt) < NUDGE_COOLDOWN_MS){
      const minsLeft = Math.ceil((NUDGE_COOLDOWN_MS - (Date.now() - lastSentAt)) / 60000);
      return new Response(JSON.stringify({ error: `Already nudged recently — try again in ${minsLeft} min` }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    }

    const sub = await dbGet(`/pushSubscriptions/${toUid}`, secret).catch(() => null);
    if(!sub || !sub.endpoint){
      return new Response(JSON.stringify({ error: "They haven't enabled notifications" }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    let fromName = 'Someone';
    try{
      const userRec = await dbGet(`/users/${fromUid}`, secret);
      fromName = (userRec && userRec.name) || fromName;
    }catch(e){}

    const vapidPublic = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
    const vapidSubject = process.env.VAPID_SUBJECT;
    if(!vapidPublic || !vapidPrivate || !vapidSubject){
      return new Response(JSON.stringify({ error: 'Push not configured on the server' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

    const payload = JSON.stringify({
      title: `👋 ${fromName} nudged you`,
      body: 'Just a poke — check the app when you get a sec.',
      url: '/'
    });
    await webpush.sendNotification(sub, payload);

    await dbPut(cooldownPath, secret, Date.now());
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }catch(e){
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
