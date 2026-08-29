// netlify/functions/syndy-recap-scheduled.js
// A Netlify Scheduled Function — runs weekly, same export-default +
// DB_SECRET pattern as the other scheduled functions in this project.
// Looks at the most recently SAVED week in /state/history and, if it's
// genuinely recent (not stale leftover data from a while ago) and
// hasn't already been recapped, builds a real narrative from it — who
// won, who's cold, who broke a losing streak — and posts it to Group
// Chat as Syndy.
//
// Template-based, not a live LLM call — several phrasing variants per
// story beat, randomly picked, so it reads as written rather than
// robotic without needing an unattended model call for something that
// posts automatically with no review step. Same reasoning already
// applied to Syndy's Book's market generation.
//
// Needs the same env vars already set for the other functions in this
// project: FIREBASE_DB_SECRET. No new ones.

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

const RECAP_MAX_AGE_MS = 8 * 24 * 3600 * 1000; // if the latest saved week is older than this, there's genuinely nothing fresh to recap — skip rather than post something stale

export default async (req) => {
  if (!DB_SECRET) {
    console.log("Missing FIREBASE_DB_SECRET — skipping run.");
    return new Response("Missing config", { status: 200 });
  }

  try {
    const state = await dbGet("/state");
    const history = (state && state.history) || [];
    if (history.length === 0) {
      console.log("No saved weeks yet — nothing to recap.");
      return new Response("No history", { status: 200 });
    }
    const latestWeek = history[history.length - 1];
    if (!latestWeek || !latestWeek.savedAt) {
      console.log("Latest week has no savedAt — skipping.");
      return new Response("No savedAt", { status: 200 });
    }
    if (Date.now() - latestWeek.savedAt > RECAP_MAX_AGE_MS) {
      console.log("Latest saved week is too old to be worth recapping — skipping.");
      return new Response("Stale", { status: 200 });
    }

    // Guard against recapping the same week twice — keyed by the week's
    // own savedAt timestamp, which is unique per save.
    const lastRecappedAt = await dbGet("/syndyRecap/lastSavedAtRecapped");
    if (lastRecappedAt === latestWeek.savedAt) {
      console.log("Already recapped this exact week — skipping.");
      return new Response("Already recapped", { status: 200 });
    }

    const members = state.members || [];
    const groupEntries = latestWeek.groupEntries || {};

    // Real per-member current streak, same loop logic used for badges/
    // roasts elsewhere in this app — computed fresh here since this
    // function has no access to any client-side cache of it.
    function currentStreakFor(name) {
      let curWin = 0, curLoss = 0;
      history.forEach((week) => {
        const entry = week.groupEntries && week.groupEntries[name];
        if (!entry || !entry.result || entry.result === "MIA") return;
        if (entry.result === "Win") { curWin++; curLoss = 0; }
        else if (entry.result === "Loss") { curLoss++; curWin = 0; }
        else { curWin = 0; curLoss = 0; }
      });
      return { curWin, curLoss };
    }
    // Streak BEFORE this latest week, to detect a genuine "broke the
    // drought" moment — same computation, just over history minus the
    // most recent entry.
    function streakBeforeLatestFor(name) {
      let curWin = 0, curLoss = 0;
      history.slice(0, -1).forEach((week) => {
        const entry = week.groupEntries && week.groupEntries[name];
        if (!entry || !entry.result || entry.result === "MIA") return;
        if (entry.result === "Win") { curWin++; curLoss = 0; }
        else if (entry.result === "Loss") { curLoss++; curWin = 0; }
        else { curWin = 0; curLoss = 0; }
      });
      return { curWin, curLoss };
    }

    const winners = [];
    const streakBreakers = [];
    const coldRunners = [];
    Object.entries(groupEntries).forEach(([name, entry]) => {
      if (!entry || !entry.result || entry.result === "MIA") return;
      if (entry.result === "Win") {
        winners.push(name);
        const before = streakBeforeLatestFor(name);
        if (before.curLoss >= 2) streakBreakers.push({ name, brokeStreak: before.curLoss });
      }
    });
    members.forEach((m) => {
      const streak = currentStreakFor(m.name);
      if (streak.curLoss >= 2) coldRunners.push({ name: m.name, curLoss: streak.curLoss });
    });
    coldRunners.sort((a, b) => b.curLoss - a.curLoss);

    const seasonLeader = [...members].sort((a, b) => (b.pl || 0) - (a.pl || 0))[0];

    const lines = [];
    lines.push(`📋 ${pick(["Weekly Recap", "This Week On The Board", "Round-Up"])} — ${latestWeek.label || "this week"}`);

    if (winners.length > 0) {
      const winLine = winners.length === 1
        ? pick([`🔥 ${winners[0]} was the standout, the only one to actually get it home this week.`, `🔥 ${winners[0]} carried the week — everyone else can thank him later.`])
        : pick([`🔥 ${winners.join(", ")} all got there this week — solid round for the board.`, `🔥 Winners this week: ${winners.join(", ")}.`]);
      lines.push(winLine);
    } else {
      lines.push(pick(["🧊 Nobody actually won this week. Rough round all round.", "🧊 A clean sweep of losses this week — not a great look for anyone."]));
    }

    if (streakBreakers.length > 0) {
      streakBreakers.forEach((sb) => {
        lines.push(pick([
          `💪 ${sb.name} finally snapped a ${sb.brokeStreak}-loss run — about time.`,
          `💪 After ${sb.brokeStreak} losses in a row, ${sb.name} actually got one up. The drought's over.`,
        ]));
      });
    }

    if (coldRunners.length > 0) {
      const worst = coldRunners[0];
      lines.push(pick([
        `🥶 ${worst.name} is now on a ${worst.curLoss}-loss run and counting — someone check on him.`,
        `🥶 Spare a thought for ${worst.name}, ${worst.curLoss} losses deep and still going.`,
      ]));
    }

    if (seasonLeader && typeof seasonLeader.pl === "number") {
      const plText = `${seasonLeader.pl < 0 ? "-" : ""}$${Math.abs(seasonLeader.pl).toFixed(2)}`;
      lines.push(pick([
        `🏆 Still on top of the season: ${seasonLeader.name} at ${plText}.`,
        `🏆 ${seasonLeader.name} remains the one to beat this season, sitting on ${plText}.`,
      ]));
    }

    await postToGroupChat(lines.join("\n"));
    await dbPut("/syndyRecap/lastSavedAtRecapped", latestWeek.savedAt);
    console.log(`Posted recap for week: ${latestWeek.label}`);
    return new Response("Posted", { status: 200 });
  } catch (err) {
    console.error("syndy-recap-scheduled error:", err.message);
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
};

export const config = {
  // Once a week — Monday 9am AEST (UTC+10, standard time; shifts an
  // hour once daylight saving starts in October, same caveat as every
  // other scheduled function's clock time in this project).
  schedule: "0 23 * * 0",
};
