// netlify/functions/check-lockouts-scheduled.js
// A Netlify Scheduled Function — runs every 30 minutes with no user
// attached, so it authenticates to Firebase with a Database Secret rather
// than a normal signed-in session (set FIREBASE_DB_SECRET as a Netlify env
// var — Firebase console → Project Settings → Service Accounts → Database
// secrets). Scheduled functions specifically require this export-default
// style per Netlify's docs (not the exports.handler style used by the
// rest of this repo's regular functions) — confirmed against their
// current docs before writing this, rather than assumed.
//
// Checks for games whose 12h pick-lock is coming up in the next 30-75
// minutes, finds anyone subscribed to push who hasn't submitted a pick for
// that game yet, and sends them a reminder. Tracks who's already been
// notified per-game (/pushNotified/{gameId}/{uid}) so re-running every 30
// minutes doesn't spam the same person repeatedly about the same game.

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

export default async (req) => {
  if (!DB_SECRET || !process.env.VAPID_PRIVATE_KEY) {
    console.log("Missing FIREBASE_DB_SECRET or VAPID keys — skipping run.");
    return new Response("Missing config", { status: 200 });
  }

  try {
    const fixturesRes = await fetch("https://mlsynddash.netlify.app/.netlify/functions/afl-fixtures");
    const fixturesData = await fixturesRes.json();
    const games = fixturesData.games || [];

    const now = Date.now();
    const windowStartMs = now + 30 * 60 * 1000;
    const windowEndMs = now + 75 * 60 * 1000;

    const lockingGames = games.filter((g) => {
      if (!g.date) return false;
      const kickoffMs = new Date(g.date.replace(" ", "T") + "+10:00").getTime();
      const lockMs = kickoffMs - 12 * 60 * 60 * 1000;
      return lockMs > windowStartMs && lockMs <= windowEndMs;
    });

    if (lockingGames.length === 0) {
      console.log("No games locking in the check window for picks.");
    }

    const subscriptions = (await dbGet("/pushSubscriptions")) || {};
    let sent = 0;
    let skipped = 0;

    for (const g of lockingGames) {
      const [picks, notified] = await Promise.all([
        dbGet(`/tipping/picks/${g.id}`),
        dbGet(`/pushNotified/${g.id}`),
      ]);
      const picked = picks || {};
      const alreadyNotified = notified || {};

      for (const uid of Object.keys(subscriptions)) {
        if (picked[uid]) continue; // already tipped this game
        if (alreadyNotified[uid]) continue; // already told them about this game
        const sub = subscriptions[uid];
        if (!sub || !sub.endpoint) continue;

        try {
          await webpush.sendNotification(
            sub,
            JSON.stringify({
              title: "Tip locking soon",
              body: `${g.hteam} v ${g.ateam} locks in under an hour — get your pick in.`,
              url: "/",
            })
          );
          sent++;
          await dbPut(`/pushNotified/${g.id}/${uid}`, true);
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            // subscription is dead — remove it so future runs don't keep trying
            await dbPut(`/pushSubscriptions/${uid}`, null);
          }
          skipped++;
        }
      }
    }

    console.log(`Checked ${lockingGames.length} game(s), sent ${sent}, skipped ${skipped}.`);

    // ---- Joker last-chance reminder ----
    // One-shot, once ever (well, once per season — cleared by the Ledger's
    // season archive/reset action alongside everything else under
    // /tipping). Joker is "one round per season, home-and-away only" —
    // reminding every single round someone hasn't used it yet would be
    // spammy for something that's genuinely fine to sit on all season.
    // The one moment that actually matters is the LAST home-and-away
    // round locking, since after that using it at all is no longer
    // possible. Uses the same games list already fetched above.
    let jokerSent = 0, jokerSkipped = 0;
    try {
      const regularRounds = games
        .filter((g) => !((g.roundname || "").toLowerCase().includes("final")))
        .map((g) => g.round);
      if (regularRounds.length > 0) {
        const lastRegularRound = Math.max(...regularRounds);
        const lastRoundGames = games.filter((g) => g.round === lastRegularRound && g.date);
        const lastRoundKickoffTimes = lastRoundGames
          .map((g) => new Date(g.date.replace(" ", "T") + "+10:00").getTime())
          .filter((t) => !isNaN(t));

        if (lastRoundKickoffTimes.length > 0) {
          // Joker locks at the round's earliest kickoff itself, not 12h
          // before — matches roundLockTime's actual semantics (see
          // syncRoundLockTime client-side), unlike the picks reminder
          // above which fires ahead of the 12h pick-lock window.
          const jokerLockMs = Math.min(...lastRoundKickoffTimes);
          if (jokerLockMs > windowStartMs && jokerLockMs <= windowEndMs) {
            const [allJokers, jokerAlreadyNotified] = await Promise.all([
              dbGet("/tipping/joker"),
              dbGet("/pushJokerLastChanceNotified"),
            ]);
            const jokersByUid = allJokers || {};
            const alreadyNotified = jokerAlreadyNotified || {};

            for (const uid of Object.keys(subscriptions)) {
              if (jokersByUid[uid] && jokersByUid[uid].round != null) continue; // already used their Joker this season, somewhere
              if (alreadyNotified[uid]) continue; // already told them about this, this season
              const sub = subscriptions[uid];
              if (!sub || !sub.endpoint) continue;

              try {
                await webpush.sendNotification(
                  sub,
                  JSON.stringify({
                    title: "Last chance for your Joker",
                    body: `Round ${lastRegularRound} locks in under an hour — it's the final home-and-away round, so this is your last chance to use your Joker this season.`,
                    url: "/",
                  })
                );
                jokerSent++;
                await dbPut(`/pushJokerLastChanceNotified/${uid}`, true);
              } catch (err) {
                if (err.statusCode === 410 || err.statusCode === 404) {
                  await dbPut(`/pushSubscriptions/${uid}`, null);
                }
                jokerSkipped++;
              }
            }
          }
        }
      }
    } catch (err) {
      console.error("Joker last-chance check failed:", err.message);
    }
    console.log(`Joker last-chance: sent ${jokerSent}, skipped ${jokerSkipped}.`);

    return new Response(`Sent ${sent}, joker ${jokerSent}`, { status: 200 });
  } catch (err) {
    console.error("check-lockouts-scheduled error:", err.message);
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
};

export const config = {
  schedule: "*/30 * * * *",
};
