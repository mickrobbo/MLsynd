// netlify/functions/send-group-notify.js
// Broadcasts a push for a new Group Chat message to everyone EXCEPT the
// sender (and anyone already covered by send-mention.mjs for the same
// message, passed in via excludeUids, so a mentioned person doesn't get
// both a "mentioned you" push AND a redundant "new message" push for
// the same post). Same verify/lookup/push pattern as send-nudge.mjs and
// send-mention.mjs.
//
// Only the SENDER's own client ever calls this, exactly once per
// message they post — same reasoning as send-mention.mjs for why this
// can't double-fire regardless of how many people have the chat open.
//
// Per-RECIPIENT cooldown (not per sender-recipient pair, since this is
// a broadcast) — in an active conversation, someone shouldn't get a
// fresh notification for every single message; they get one, then
// nothing more until the cooldown clears, however many messages land
// in between.
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
// 5 minutes — long enough that an active back-and-forth only pings
// someone once, not on every message; short enough that a genuinely
// new burst of conversation later still notifies again.
const GROUP_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

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
  return user ? { uid: user.localId } : null;
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!DB_SECRET || !process.env.VAPID_PRIVATE_KEY) {
    return new Response(JSON.stringify({ error: "Server not configured" }), { status: 500 });
  }

  try {
    const { idToken, text, hasImage, excludeUids } = await req.json();
    if (!idToken) {
      return new Response(JSON.stringify({ error: "Missing idToken" }), { status: 400 });
    }

    const auth = await verifyFirebaseIdToken(idToken);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Invalid or expired session" }), { status: 401 });
    }
    const fromUid = auth.uid;

    const fromUser = await dbGet(`/users/${fromUid}`);
    if (!fromUser || fromUser.status !== "approved") {
      return new Response(JSON.stringify({ error: "Not an approved member" }), { status: 403 });
    }
    const fromName = fromUser.name || "Someone";

    const skipUids = new Set([fromUid, ...(Array.isArray(excludeUids) ? excludeUids : [])]);
    const subscriptions = (await dbGet("/pushSubscriptions")) || {};
    const now = Date.now();
    const body = hasImage ? "📷 sent an image" : (text || "").slice(0, 100);

    let sent = 0, skipped = 0;
    for (const uid of Object.keys(subscriptions)) {
      if (skipUids.has(uid)) continue;
      const sub = subscriptions[uid];
      if (!sub || !sub.endpoint) continue;

      const lastSent = await dbGet(`/pushGroupChatLastSentAt/${uid}`);
      if (lastSent && now - lastSent < GROUP_NOTIFY_COOLDOWN_MS) { skipped++; continue; }

      try {
        await webpush.sendNotification(
          sub,
          JSON.stringify({ title: `💬 ${fromName} in Group Chat`, body, url: "/" })
        );
        await dbPut(`/pushGroupChatLastSentAt/${uid}`, now);
        sent++;
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await dbPut(`/pushSubscriptions/${uid}`, null); // dead subscription — clean it up
        }
        skipped++;
      }
    }

    return new Response(JSON.stringify({ sent, skipped }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
