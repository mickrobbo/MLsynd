// netlify/functions/syndy-hype-scheduled.js
// A Netlify Scheduled Function — runs daily, same pattern as the other
// scheduled functions in this project. Checks real AFL fixture data
// (the same afl-fixtures function the Tipping tab already uses, called
// here server-to-server) for whether a new round is starting soon, and
// if so — and it hasn't already been hyped — posts a real hype message
// to Group Chat using genuine data: the round's kickoff, how many games,
// and who's currently leading the Tipping ladder.
//
// Needs the same env vars already set for the other functions in this
// project: FIREBASE_DB_SECRET. No new ones.

const DB_BASE = "https://mlsynd-default-rtdb.firebaseio.com";
const DB_SECRET = process.env.FIREBASE_DB_SECRET;
const SITE_BASE = "https://mlsynddash.netlify.app";

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
  await fetch(`${DB_BASE}${path}.json?auth=${DB_SECRET}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}
async function postToGroupChat(text) {
  await dbPost("/groupChat/messages", { senderUid: "syndy", senderName: "Syndy", text, ts: Date.now() });
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// A round is "hypeable" once its earliest kickoff is within this window
// — close enough to feel imminent, far enough out that the post isn't
// buried the moment the first bounce happens.
const HYPE_WINDOW_MS = 48 * 3600 * 1000;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default async (req) => {
  if (!DB_SECRET) {
    console.log("Missing FIREBASE_DB_SECRET — skipping run.");
    return new Response("Missing config", { status: 200 });
  }

  try {
    const fixRes = await fetch(`${SITE_BASE}/.netlify/functions/afl-fixtures`, { cache: "no-store" });
    if (!fixRes.ok) {
      console.log(`afl-fixtures returned ${fixRes.status} — skipping.`);
      return new Response("Fixtures unavailable", { status: 200 });
    }
    const fixData = await fixRes.json();
    const games = fixData.games || [];
    if (games.length === 0) {
      console.log("No fixture data — skipping.");
      return new Response("No games", { status: 200 });
    }

    const now = Date.now();
    // Earliest NOT-YET-STARTED game overall — same "first game of round"
    // logic used client-side, just finding it across all rounds rather
    // than for one specific round.
    const upcoming = games
      .map((g) => ({ ...g, kickoffMs: new Date(g.date.replace(" ", "T") + "+10:00").getTime() }))
      .filter((g) => !isNaN(g.kickoffMs) && g.kickoffMs > now)
      .sort((a, b) => a.kickoffMs - b.kickoffMs);
    if (upcoming.length === 0) {
      console.log("No upcoming games found — skipping.");
      return new Response("No upcoming games", { status: 200 });
    }
    const nextGame = upcoming[0];
    const msUntilKickoff = nextGame.kickoffMs - now;
    if (msUntilKickoff > HYPE_WINDOW_MS) {
      console.log(`Next round's kickoff is more than 48h away — skipping for now.`);
      return new Response("Too early", { status: 200 });
    }

    const alreadyHyped = await dbGet("/syndyHype/lastHypedRound");
    if (alreadyHyped === nextGame.round) {
      console.log(`Round ${nextGame.round} already hyped — skipping.`);
      return new Response("Already hyped", { status: 200 });
    }

    const roundGameCount = games.filter((g) => g.round === nextGame.round).length;
    const kickoffDate = new Date(nextGame.kickoffMs);
    const dayName = DAY_NAMES[kickoffDate.getUTCDay()];
    // getUTCDay() on a value already offset +10h in the source string is
    // fine here — same reasoning as the rest of this app's AEST-string
    // date handling, not trying to be a general-purpose timezone tool.

    // Real Tipping ladder leader — genuine data, not invented. tippingStats
    // is keyed by uid; resolve to a real name via /state's linked members
    // where possible, same as everywhere else this kind of lookup happens.
    let leaderLine = "";
    try {
      const [tippingStats, state] = await Promise.all([dbGet("/tippingStats"), dbGet("/state")]);
      if (tippingStats && state) {
        const members = state.members || [];
        const entries = Object.entries(tippingStats)
          .filter(([, v]) => v && typeof v.seasonPoints === "number")
          .sort((a, b) => b[1].seasonPoints - a[1].seasonPoints);
        if (entries.length > 0) {
          const [leaderUid, leaderData] = entries[0];
          const member = members.find((m) => m.linkedUid === leaderUid);
          const leaderName = member ? member.name : null;
          if (leaderName) {
            leaderLine = pick([
              ` ${leaderName}'s currently on top of the Tipping ladder with ${leaderData.seasonPoints} points — can he extend it?`,
              ` Keep an eye on ${leaderName}, leading Tipping on ${leaderData.seasonPoints} points heading in.`,
            ]);
          }
        }
      }
    } catch (e) {} // leader line is a nice-to-have, not worth failing the whole post over

    const text = `🏉 ${pick(["Round " + nextGame.round + " incoming", "Here we go — Round " + nextGame.round])} — first bounce ${dayName}, ${roundGameCount} game${roundGameCount === 1 ? "" : "s"} on this round.${leaderLine}`;

    await postToGroupChat(text);
    await dbPut("/syndyHype/lastHypedRound", nextGame.round);
    console.log(`Posted hype for round ${nextGame.round}.`);
    return new Response("Posted", { status: 200 });
  } catch (err) {
    console.error("syndy-hype-scheduled error:", err.message);
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
};

export const config = {
  schedule: "0 22 * * *", // once a day, 8am AEST (UTC+10) — same daylight-saving caveat as every other scheduled function here
};
