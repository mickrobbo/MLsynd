// netlify/functions/send-payout-notify.js
// Sends a direct "you won" push to a specific winner — called from the
// admin's own client session right after they manually resolve a
// Syndy's Book market or Leg Bet (the scheduled function's own
// auto-resolution sends this same kind of push directly, since it
// already runs with full DB_SECRET trust; this covers the other path,
// where a human admin resolves one from the Dashboard UI instead).
// Same verify/lookup/push pattern as send-nudge.mjs and send-mention.mjs.
//
// Needs the same env vars already set for the other functions in this
// project: FIREBASE_DB_SECRET, FIREBASE_WEB_API_KEY, VAPID_PUBLIC_KEY,
// VAPID_PRIVATE_KEY, VAPID_SUBJECT. No new ones, nothing to add.

import webpush from "web-push";

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:mlsynd00@gmail.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const DB_BASE = "https://mlsynd-default-rtdb.firebaseio.com";
const DB_SECRET = process.env.FIREBASE_DB_SECRET;

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
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbApiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const user = data.users && data.users[0];
  return user ? { uid: user.localId, email: user.email } : null;
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!DB_SECRET || !process.env.VAPID_PRIVATE_KEY) {
    return new Response(JSON.stringify({ error: "Server not configured" }), { status: 500 });
  }

  try {
    const { idToken, toUid, amount, reason } = await req.json();
    if (!idToken || !toUid || typeof amount !== "number") {
      return new Response(JSON.stringify({ error: "Missing idToken, toUid, or amount" }), { status: 400 });
    }

    // Verify the CALLER is a real approved admin — this sends a push as
    // if a payout genuinely happened, so it shouldn't be callable by
    // just anyone holding a valid session. Email comes straight from
    // the verified token itself (Firebase's own accounts:lookup), not
    // a possibly-unset /users field.
    const auth = await verifyFirebaseIdToken(idToken);
    if (!auth || auth.email !== "mlsynd00@gmail.com") {
      return new Response(JSON.stringify({ error: "Admin only" }), { status: 403 });
    }

    const sub = await dbGet(`/pushSubscriptions/${toUid}`);
    if (!sub || !sub.endpoint) {
      return new Response(JSON.stringify({ sent: false, reason: "no subscription" }), { status: 200 });
    }

    try {
      await webpush.sendNotification(
        sub,
        JSON.stringify({ title: "🎉 You won!", body: `+${amount.toLocaleString()} XP — ${reason || "Syndy's Book"}`, url: "/" })
      );
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await dbPut(`/pushSubscriptions/${toUid}`, null); // dead subscription — clean it up
        return new Response(JSON.stringify({ sent: false, reason: "dead subscription" }), { status: 200 });
      }
      throw err;
    }

    return new Response(JSON.stringify({ sent: true }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
