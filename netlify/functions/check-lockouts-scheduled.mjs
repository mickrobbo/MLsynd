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

// Real UTC kickoff of a game. Uses the feed's unix time when it has one,
// otherwise reads the local time as Melbourne/Sydney time (AEST or AEDT as
// the date requires) — a fixed +10:00 was an hour out from October to April.
const tzFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function kickoffMs(g) {
  if (g.unixtime) return Number(g.unixtime) * 1000;
  const m = String(g.date || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return NaN;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let guess = asUtc - 10 * 3600e3;
  for (let i = 0; i < 2; i++) {
    const parts = tzFmt.formatToParts(new Date(guess));
    const v = (t) => +parts.find((x) => x.type === t).value;
    guess += asUtc - Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second"));
  }
  return guess;
}

// Each league is its own comp with its own picks, Joker and reminders.
const SPORTS = [
  { key: "afl", label: "AFL", fn: "afl-fixtures", root: "/tipping", jokerNotified: "/pushJokerLastChanceNotified" },
  { key: "nrl", label: "NRL", fn: "nrl-fixtures", root: "/tippingNrl", jokerNotified: "/pushJokerLastChanceNotifiedNrl" },
];

export default async (req) => {
  if (!DB_SECRET || !process.env.VAPID_PRIVATE_KEY) {
    console.log("Missing FIREBASE_DB_SECRET or VAPID keys — skipping run.");
    return new Response("Missing config", { status: 200 });
  }

  let totalSent = 0, totalJoker = 0;
  for (const sport of SPORTS) {
    try {
      const r = await runSport(sport);
      totalSent += r.sent; totalJoker += r.jokerSent;
    } catch (err) {
      console.error(`check-lockouts-scheduled ${sport.label} error:`, err.message);
    }
  }
  return new Response(`Sent ${totalSent}, joker ${totalJoker}`, { status: 200 });
};

async function runSport(sport) {
  {
    const fixturesRes = await fetch(`https://mlsynddash.netlify.app/.netlify/functions/${sport.fn}`);
    if (!fixturesRes.ok) throw new Error(`${sport.fn} returned ${fixturesRes.status}`);
    const fixturesData = await fixturesRes.json();
    const games = fixturesData.games || [];

    const now = Date.now();
    const windowStartMs = now + 30 * 60 * 1000;
    const windowEndMs = now + 75 * 60 * 1000;

    const lockingGames = games.filter((g) => {
      if (!g.date && !g.unixtime) return false;
      const lockMs = kickoffMs(g) - 12 * 60 * 60 * 1000;
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
        dbGet(`${sport.root}/picks/${g.id}`),
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
              title: `${sport.label} tip locking soon`,
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
          .map((g) => kickoffMs(g))
          .filter((t) => !isNaN(t));

        if (lastRoundKickoffTimes.length > 0) {
          // Joker locks at the round's earliest kickoff itself, not 12h
          // before — matches roundLockTime's actual semantics (see
          // syncRoundLockTime client-side), unlike the picks reminder
          // above which fires ahead of the 12h pick-lock window.
          const jokerLockMs = Math.min(...lastRoundKickoffTimes);
          if (jokerLockMs > windowStartMs && jokerLockMs <= windowEndMs) {
            const [allJokers, jokerAlreadyNotified] = await Promise.all([
              dbGet(`${sport.root}/joker`),
              dbGet(sport.jokerNotified),
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
                    title: `Last chance for your ${sport.label} Joker`,
                    body: `${sport.label} Round ${lastRegularRound} locks in under an hour — it's the final home-and-away round, so this is your last chance to use your Joker this season.`,
                    url: "/",
                  })
                );
                jokerSent++;
                await dbPut(`${sport.jokerNotified}/${uid}`, true);
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
    console.log(`${sport.label} joker last-chance: sent ${jokerSent}, skipped ${jokerSkipped}.`);

    return { sent, jokerSent };
  }
}

export const config = {
  schedule: "*/30 * * * *",
};
