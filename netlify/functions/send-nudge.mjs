// netlify/functions/send-nudge.js
// Lets one signed-in approved member send a lightweight push "nudge" to
// another, launched from that person's profile. Runs server-side with a
// Firebase Database Secret so it can read the TARGET's push subscription
// — /pushSubscriptions/{uid} is self-read-only in the real rules (a push
// subscription is effectively a way to send data straight to someone's
// device, more sensitive than most of what this app already exposes
// group-wide), so this genuinely can't be done as a plain client-side
// Firebase read the way most other features here are. Same DB_SECRET
// pattern check-lockouts-scheduled.mjs already uses, and the same
// idToken-verification pattern syndy-chat.mjs already uses — nothing new
// architecturally, just combined for this one purpose.
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
// 5 minutes — long enough to stop an accidental double-tap or genuine
// spam, short enough that it never feels like a real cooldown/penalty
// for the fun little feature this is.
const NUDGE_COOLDOWN_MS = 5 * 60 * 1000;

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
    const { idToken, toUid } = await req.json();
    if (!idToken || !toUid) {
      return new Response(JSON.stringify({ error: "Missing idToken or toUid" }), { status: 400 });
    }

    // Verify the CALLER server-side rather than trusting a client-supplied
    // fromUid field, which could be spoofed to nudge (or rate-limit-block)
    // as anyone.
    const auth = await verifyFirebaseIdToken(idToken);
    if (!auth) {
      return new Response(JSON.stringify({ error: "Invalid or expired session" }), { status: 401 });
    }
    const fromUid = auth.uid;
    if (fromUid === toUid) {
      return new Response(JSON.stringify({ error: "Can't nudge yourself" }), { status: 400 });
    }

    // Confirm the caller is a real approved member, not just anyone
    // holding a valid Firebase account (a signed-up-but-not-yet-approved
    // account, or a read-only guest, still has a valid idToken).
    const fromUser = await dbGet(`/users/${fromUid}`);
    if (!fromUser || fromUser.status !== "approved") {
      return new Response(JSON.stringify({ error: "Not an approved member" }), { status: 403 });
    }
    const fromName = fromUser.name || "Someone";

    // Cooldown keyed by the (sender, target) pair, not just the sender —
    // nudging ten different people in a row is fine, only hammering the
    // SAME person repeatedly inside the window is blocked.
    const cooldownKey = `${fromUid}_${toUid}`;
    const lastSent = await dbGet(`/pushNudgeLastSentAt/${cooldownKey}`);
    if (lastSent && Date.now() - lastSent < NUDGE_COOLDOWN_MS) {
      const secsLeft = Math.ceil((NUDGE_COOLDOWN_MS - (Date.now() - lastSent)) / 1000);
      return new Response(JSON.stringify({ error: `Already nudged them — wait ${secsLeft}s` }), { status: 429 });
    }

    const sub = await dbGet(`/pushSubscriptions/${toUid}`);
    if (!sub || !sub.endpoint) {
      return new Response(JSON.stringify({ error: "That person hasn't turned on notifications" }), { status: 404 });
    }

    try {
      await webpush.sendNotification(
        sub,
        JSON.stringify({ title: "👋 Nudge", body: `${fromName} nudged you.`, url: "/" })
      );
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await dbPut(`/pushSubscriptions/${toUid}`, null); // dead subscription — clean it up rather than leave it to fail again next time
        return new Response(JSON.stringify({ error: "That person hasn't turned on notifications" }), { status: 404 });
      }
      throw err;
    }

    await dbPut(`/pushNudgeLastSentAt/${cooldownKey}`, Date.now());
    return new Response(JSON.stringify({ sent: true }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
