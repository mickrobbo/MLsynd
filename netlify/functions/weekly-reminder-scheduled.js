// Sends a push notification every Thursday at 8am Australia/Melbourne
// time, reminding members to check outstanding tips/bets/multi legs.
// Runs hourly and self-gates on the real AEST/AEDT weekday+hour (same
// pattern as casino-pot-distribute-scheduled.js and
// check-lockouts-scheduled.js) — daylight saving handled automatically,
// and a missed run just gets picked up next hour rather than waiting a
// full week.
//
// This function does NOT compute the actual outstanding items server-side
// — that list changes constantly (someone could submit a tip five minutes
// after this fires), so it's deliberately just a generic nudge. The real
// per-person detail is computed live in the app itself
// (computeWeeklyOutstandingItems in DASHBOARD-index.html) when someone
// opens it.
//
// Needs the same VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT
// env vars already set up for your other push features, 'web-push' as a
// dependency in functions/package.json (already there), and
// FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY — just those two fields
// from your Firebase Admin SDK service account file, not the whole JSON
// (AWS Lambda caps total env var size at 4KB across every function, so
// the unused fields in the full file are dead weight worth trimming).
// Admin-level Realtime Database access here goes through a signed JWT
// exchanged for a short-lived Google OAuth2 access token (see
// getFirebaseAccessToken) —
// same role a legacy database secret used to play, but this project's
// Firebase console doesn't expose that mechanism.

import webpush from 'web-push';
import crypto from 'crypto';

const FIREBASE_URL = 'https://mlsynd-default-rtdb.firebaseio.com';
const TIMEZONE = 'Australia/Melbourne';
const TARGET_WEEKDAY = 'Thursday';
const TARGET_HOUR = 8;

function isReminderTime(){
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: TIMEZONE, weekday: 'long', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
  const weekday = parts.find(p => p.type === 'weekday').value;
  const hour = parts.find(p => p.type === 'hour').value;
  return weekday === TARGET_WEEKDAY && Number(hour) === TARGET_HOUR;
}

async function getFirebaseAccessToken(){
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawKey = process.env.FIREBASE_PRIVATE_KEY;
  if(!clientEmail) throw new Error('FIREBASE_CLIENT_EMAIL not set');
  if(!rawKey) throw new Error('FIREBASE_PRIVATE_KEY not set');
  const privateKey = rawKey
  .replace(/\\n/g, '\n')
  .replace(/"/g, '')
  .trim();

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
  if(!res.ok){
    const errText = await res.text();
    throw new Error(`OAuth token exchange failed — HTTP ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function dbGet(path, accessToken){
  const res = await fetch(`${FIREBASE_URL}${path}.json?access_token=${accessToken}`);
  if(!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}
async function dbDelete(path, accessToken){
  const res = await fetch(`${FIREBASE_URL}${path}.json?access_token=${accessToken}`, { method: 'DELETE' });
  if(!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
}

async function sendWeeklyReminderPush(accessToken){
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT;
  if(!vapidPublic || !vapidPrivate || !vapidSubject){
    console.warn('Weekly reminder push skipped — VAPID env vars not set');
    return { sent: 0, skipped: true };
  }
  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  const payload = JSON.stringify({
    title: '🔔 MLSynd weekly check-in',
    body: "Got outstanding tips, individual bets, or the group multi to sort? Check the app before kickoff.",
    url: '/'
  });

  const subs = (await dbGet('/pushSubscriptions', accessToken)) || {};
  let sent = 0;
  for(const uid of Object.keys(subs)){
    const sub = subs[uid];
    if(!sub || !sub.endpoint) continue;
    try{
      await webpush.sendNotification(sub, payload);
      sent++;
    }catch(err){
      if(err && (err.statusCode === 404 || err.statusCode === 410)){
        try{ await dbDelete(`/pushSubscriptions/${uid}`, accessToken); }catch(e){}
      } else {
        console.warn('Weekly reminder push failed for', uid, err && err.message);
      }
    }
  }
  return { sent, total: Object.keys(subs).length };
}

export const config = { schedule: '0 * * * *' }; // hourly — self-gates on isReminderTime() below

export default async () => {
  if(!isReminderTime()){
    return new Response(`Not ${TARGET_HOUR}am ${TARGET_WEEKDAY} in ${TIMEZONE} — skipping.`, { status: 200 });
  }
  let accessToken;
  try{
    accessToken = await getFirebaseAccessToken();
  }catch(e){
    console.error('Firebase service account auth failed:', e.message);
    return new Response('Server misconfigured: ' + e.message, { status: 500 });
  }
  try{
    const result = await sendWeeklyReminderPush(accessToken);
    console.log('Weekly reminder push result:', JSON.stringify(result));
    return new Response(JSON.stringify(result), { status: 200 });
  }catch(e){
    console.error('Weekly reminder push failed:', e);
    return new Response('Failed: ' + e.message, { status: 500 });
  }
};
