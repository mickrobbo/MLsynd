// netlify/functions/send-mention.js
// Lets one signed-in approved member trigger a push to a SPECIFIC person
// they @mentioned in Group Chat. Same verify/lookup/push pattern as
// send-nudge.mjs (that comment explains why this can't just be a plain
// client-side Firebase read — a push subscription is self-read-only).
// The real difference from a nudge: this carries the actual message
// context, and the cooldown is much shorter — a nudge is a deliberate,
// occasional prank; a mention is a normal part of fast-moving
// conversation, and rate-limiting it the same way would suppress
// legitimate notifications.
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
// Short — just enough to stop a literal spam-loop, not a real cooldown.
// Someone genuinely mentioning the same person twice in two minutes of
// real conversation should still notify both times.
const MENTION_COOLDOWN_MS = 20 * 1000;

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
    const { idToken, toUid, messageText } = await req.json();
    if (!idToken || !toUid) {
      return new Response(JSON.stringify({ error: "Missing idToken or toUid" }), { status: 400 });
    }

    const auth = await verifyFirebaseIdToken(idToken);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Invalid or expired session" }), { status: 401 });
    }
    const fromUid = auth.uid;
    if (fromUid === toUid) {
      return new Response(JSON.stringify({ sent: false, reason: "self-mention, skipped" }), { status: 200 });
    }

    const fromUser = await dbGet(`/users/${fromUid}`);
    if (!fromUser || fromUser.status !== "approved") {
      return new Response(JSON.stringify({ error: "Not an approved member" }), { status: 403 });
    }
    const fromName = fromUser.name || "Someone";

    const cooldownKey = `${fromUid}_${toUid}`;
    const lastSent = await dbGet(`/pushMentionLastSentAt/${cooldownKey}`);
    if (lastSent && Date.now() - lastSent < MENTION_COOLDOWN_MS) {
      return new Response(JSON.stringify({ sent: false, reason: "cooldown" }), { status: 200 });
    }

    const sub = await dbGet(`/pushSubscriptions/${toUid}`);
    if (!sub || !sub.endpoint) {
      return new Response(JSON.stringify({ sent: false, reason: "no subscription" }), { status: 200 });
    }

    const snippet = (messageText || "").slice(0, 100);
    try {
      await webpush.sendNotification(
        sub,
        JSON.stringify({ title: `💬 ${fromName} mentioned you`, body: snippet, url: "/" })
      );
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await dbPut(`/pushSubscriptions/${toUid}`, null); // dead subscription — clean it up
        return new Response(JSON.stringify({ sent: false, reason: "dead subscription" }), { status: 200 });
      }
      throw err;
    }

    await dbPut(`/pushMentionLastSentAt/${cooldownKey}`, Date.now());
    return new Response(JSON.stringify({ sent: true }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
