// netlify/functions/acts-of-god-scheduled.js
// A Netlify Scheduled Function — runs every 30 minutes with no user
// attached, same export-default + DB_SECRET pattern as
// check-lockouts-scheduled.mjs (confirmed against Netlify's current docs
// before writing this, not assumed).
//
// Each run: if an Act of God is already active, does nothing (never
// stacks events). Otherwise rolls a small random chance to trigger one —
// Double XP Hour, Golden Hour (cosmetic only), or a surprise House
// Bounty — and broadcasts it to everyone with push enabled, the same way
// a tip-lock reminder goes out. The whole point is that it needs to feel
// like it's actually happening live, not something you only discover by
// having the app open at the right moment.
//
// Needs the same env vars already set for the other functions in this
// project: FIREBASE_DB_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
// VAPID_SUBJECT. No new ones, nothing to add.

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
async function dbPost(path, value) {
  const res = await fetch(`${DB_BASE}${path}.json?auth=${DB_SECRET}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  return res.json(); // { name: "-Nxxxx" }
}
async function postToGroupChat(text) {
  await dbPost("/groupChat/messages", { senderUid: "syndy", senderName: "Syndy", text, ts: Date.now() });
}

// ~10% chance per 30-min run this function actually gets invoked. Real
// frequency depends on Netlify actually triggering the schedule on time,
// which some plans only guarantee promptly with recent site traffic —
// worth keeping an eye on in practice, not something I can verify from
// here.
const TRIGGER_CHANCE = 0.10;
const EVENT_DURATION_MS = 60 * 60 * 1000; // 1 hour

const EVENT_TYPES = [
  // Double XP's weight was 3 (out of a 3+2+2=7 pool), giving it roughly
  // 43% of triggered events — about 2 Double XP Hours/day on average
  // (0.10 trigger chance x 48 runs/day x 3/7 share). Dropped to 1 per
  // request, cutting its share of the pool to 1/5 = 20%, which works out
  // to roughly 1/day instead — made rarer specifically, without touching
  // how often Golden Hour or House Bounty fire (their weights, and the
  // overall 10% TRIGGER_CHANCE for any Act of God at all, are unchanged).
  { type: "doubleXp", label: "⚡ Double XP Hour", desc: "Every Casino win pays double for the next hour.", weight: 1 },
  { type: "goldenHour", label: "✨ Golden Hour", desc: "The whole casino floor is glowing for the next hour.", weight: 2 },
  { type: "houseBounty", label: "🎁 A Bounty From The House", desc: "The house just posted a bounty of its own — first to claim it keeps it.", weight: 2 },
];
function pickWeighted(items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let roll = Math.random() * total;
  for (const item of items) {
    if (roll < item.weight) return item;
    roll -= item.weight;
  }
  return items[items.length - 1];
}
const HOUSE_BOUNTY_TITLES = ["Big Winner", "Hot Streak", "Lucky Number", "Casino Royale", "House Special"];
const HOUSE_BOUNTY_STAKES = [500, 750, 1000, 1500];

export default async (req) => {
  if (!DB_SECRET) {
    console.log("Missing FIREBASE_DB_SECRET — skipping run.");
    return new Response("Missing config", { status: 200 });
  }

  try {
    const now = Date.now();
    const current = await dbGet("/actsOfGod/current");
    if (current && current.endsAt && current.endsAt > now) {
      console.log(`An Act of God (${current.type}) is already active until ${new Date(current.endsAt).toISOString()} — skipping.`);
      return new Response("Already active", { status: 200 });
    }

    if (Math.random() > TRIGGER_CHANCE) {
      console.log("No Act of God triggered this run.");
      return new Response("No trigger", { status: 200 });
    }

    const chosen = pickWeighted(EVENT_TYPES);
    const event = {
      type: chosen.type,
      label: chosen.label,
      desc: chosen.desc,
      startedAt: now,
      endsAt: now + EVENT_DURATION_MS,
    };

    if (chosen.type === "houseBounty") {
      const title = HOUSE_BOUNTY_TITLES[Math.floor(Math.random() * HOUSE_BOUNTY_TITLES.length)];
      const stakeXp = HOUSE_BOUNTY_STAKES[Math.floor(Math.random() * HOUSE_BOUNTY_STAKES.length)];
      const posted = await dbPost("/bounties", {
        creatorUid: "house",
        creatorName: "The House",
        title,
        stakeXp,
        status: "open",
        createdAt: now,
        isHouseBounty: true,
      });
      event.bountyId = posted.name;
    }

    await dbPut("/actsOfGod/current", event);
    await dbPost("/actsOfGod/history", event); // no pruning — nobody ever reads more than the last handful at this app's scale
    await postToGroupChat(`${event.label} — ${event.desc}`); // posted once here, server-side — never from the client, since every connected device polls independently and would each post a duplicate

    const subscriptions = (await dbGet("/pushSubscriptions")) || {};
    let sent = 0, skipped = 0;
    for (const uid of Object.keys(subscriptions)) {
      const sub = subscriptions[uid];
      if (!sub || !sub.endpoint) continue;
      try {
        await webpush.sendNotification(sub, JSON.stringify({ title: event.label, body: event.desc, url: "/" }));
        sent++;
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await dbPut(`/pushSubscriptions/${uid}`, null); // dead subscription — clean it up
        }
        skipped++;
      }
    }

    console.log(`Triggered Act of God: ${chosen.type}. Notified ${sent}, skipped ${skipped}.`);
    return new Response(`Triggered ${chosen.type}`, { status: 200 });
  } catch (err) {
    console.error("acts-of-god-scheduled error:", err.message);
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
};

export const config = {
  schedule: "*/30 * * * *",
};
