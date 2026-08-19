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
// Needs the same FIREBASE_DB_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
// and VAPID_SUBJECT env vars already set up for your other push features,
// and 'web-push' as a dependency in functions/package.json (already there).

import webpush from 'web-push';

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

async function dbGet(path, secret){
  const res = await fetch(`${FIREBASE_URL}${path}.json?auth=${secret}`);
  if(!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}
async function dbDelete(path, secret){
  const res = await fetch(`${FIREBASE_URL}${path}.json?auth=${secret}`, { method: 'DELETE' });
  if(!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
}

async function sendWeeklyReminderPush(secret){
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

  const subs = (await dbGet('/pushSubscriptions', secret)) || {};
  let sent = 0;
  for(const uid of Object.keys(subs)){
    const sub = subs[uid];
    if(!sub || !sub.endpoint) continue;
    try{
      await webpush.sendNotification(sub, payload);
      sent++;
    }catch(err){
      if(err && (err.statusCode === 404 || err.statusCode === 410)){
        try{ await dbDelete(`/pushSubscriptions/${uid}`, secret); }catch(e){}
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
  const secret = process.env.FIREBASE_DB_SECRET;
  if(!secret){
    console.error('FIREBASE_DB_SECRET not set');
    return new Response('Missing FIREBASE_DB_SECRET', { status: 500 });
  }
  try{
    const result = await sendWeeklyReminderPush(secret);
    console.log('Weekly reminder push result:', JSON.stringify(result));
    return new Response(JSON.stringify(result), { status: 200 });
  }catch(e){
    console.error('Weekly reminder push failed:', e);
    return new Response('Failed: ' + e.message, { status: 500 });
  }
};
