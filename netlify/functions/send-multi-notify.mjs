// netlify/functions/send-multi-notify.mjs  (added 2026-10-16, v175)
// Push alert to the group when the admin marks a group-multi leg Win/Loss.
// Called only from the admin's own Dashboard session, right after the
// result is saved. Same verify/lookup/push pattern as send-group-notify.mjs.
//
// Only the admin account can trigger it (checked server-side), and each
// leg+result is sent at most once (/pushMultiNotified), so re-saving the
// same result, or two devices saving at once, never double-notifies.
//
// Needs the env vars already set for the other push functions:
// FIREBASE_DB_SECRET, FIREBASE_WEB_API_KEY, VAPID_PUBLIC_KEY,
// VAPID_PRIVATE_KEY, VAPID_SUBJECT. Nothing new to add.

import webpush from "web-push";

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:mlsynd00@gmail.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const DB_BASE = "https://mlsynd-default-rtdb.firebaseio.com";
const DB_SECRET = process.env.FIREBASE_DB_SECRET;
const ADMIN_EMAIL = "mlsynd00@gmail.com";

async function dbGet(path) {
  const res = await fetch(`${DB_BASE}${path}.json?auth=${DB_SECRET}`);
  if (!res.ok) throw new Error(`Firebase GET ${path} failed: ${res.status}`);
  return res.json();
}
async function dbPut(path, value) {
  await fetch(`${DB_BASE}${path}.json?auth=${DB_SECRET}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}
async function verifyFirebaseIdToken(idToken) {
  const fbApiKey = process.env.FIREBASE_WEB_API_KEY;
  if (!fbApiKey) throw new Error("FIREBASE_WEB_API_KEY not set");
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbApiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const user = data.users && data.users[0];
  return user ? { uid: user.localId, email: (user.email || "").toLowerCase() } : null;
}
const safeKey = (s) => String(s || "").replace(/[.#$\[\]\/]/g, "_").slice(0, 120);

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!DB_SECRET || !process.env.VAPID_PRIVATE_KEY) {
    return new Response(JSON.stringify({ error: "Server not configured" }), { status: 500 });
  }
  try {
    const { idToken, legKey, result, title, body } = await req.json();
    if (!idToken || !legKey || !result || !title) {
      return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400 });
    }
    const auth = await verifyFirebaseIdToken(idToken);
    if (!auth) return new Response(JSON.stringify({ error: "Invalid or expired session" }), { status: 401 });
    if (auth.email !== ADMIN_EMAIL) return new Response(JSON.stringify({ error: "Admin only" }), { status: 403 });

    const key = safeKey(legKey);
    const already = await dbGet(`/pushMultiNotified/${key}`);
    if (already === result) return new Response(JSON.stringify({ sent: 0, skipped: "already notified" }), { status: 200 });
    await dbPut(`/pushMultiNotified/${key}`, result);

    const subscriptions = (await dbGet("/pushSubscriptions")) || {};
    const payload = JSON.stringify({ title: String(title).slice(0, 80), body: String(body || "").slice(0, 160), url: "/" });
    let sent = 0, skipped = 0;
    for (const uid of Object.keys(subscriptions)) {
      if (uid === auth.uid) continue;
      const sub = subscriptions[uid];
      if (!sub || !sub.endpoint) continue;
      try { await webpush.sendNotification(sub, payload); sent++; }
      catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) await dbPut(`/pushSubscriptions/${uid}`, null);
        skipped++;
      }
    }
    return new Response(JSON.stringify({ sent, skipped }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
