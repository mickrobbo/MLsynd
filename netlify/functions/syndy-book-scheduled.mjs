// netlify/functions/syndy-book-scheduled.js
// A Netlify Scheduled Function — runs every 3 hours, same export-default +
// DB_SECRET pattern as check-lockouts-scheduled.mjs / acts-of-god-scheduled.mjs.
//
// Two passes each run:
//   1. RESOLVE — any open market past its closesAt gets checked against
//      real data and paid out.
//   2. CREATE — if there's room (fewer than MAX_OPEN_MARKETS currently
//      open) and a random roll hits, generates one new market from real
//      group data and posts it.
//
// Deliberately NOT a live LLM call deciding questions or outcomes —
// Syndy's actual LLM (Perplexity, via syndy-chat.mjs) is a web-search
// model, not built for reliably returning structured data real XP
// payouts should hinge on, and an unattended, unreviewed LLM judging
// "did this resolve yes or no" is a real risk to the group's economy.
// Instead: a pool of structured templates, each with a genuinely
// PROGRAMMATIC resolution check (compare two real numbers, check a real
// status) — the variety and "feels alive" quality comes from real data
// (whoever's actually close to a tier-up, whoever's actually on a
// streak, real XP gaps) rather than from freeform generation. Every
// market this creates can always be checked and resolved with total
// certainty.
//
// Needs the same env vars already set for the other functions in this
// project: FIREBASE_DB_SECRET, plus (new, for the "you won" push
// notifications below) VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
// — already set for the other push-sending functions in this project,
// nothing new to add there either.

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
// Direct "you won" push to the specific winner — separate from the
// Group Chat announcement, which everyone sees but doesn't personally
// notify the winner themselves. Best-effort: a missing/dead
// subscription just means no push goes out, never blocks the actual
// payout, which has already happened by the time this is called.
async function sendWinPush(uid, amount, reason) {
  try {
    const sub = await dbGet(`/pushSubscriptions/${uid}`);
    if (!sub || !sub.endpoint) return;
    await webpush.sendNotification(
      sub,
      JSON.stringify({ title: "🎉 You won!", body: `+${amount.toLocaleString()} XP — ${reason}`, url: "/" })
    );
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      await dbPut(`/pushSubscriptions/${uid}`, null); // dead subscription — clean it up
    }
  }
}
async function awardXp(uid, amount, reason) {
  const current = (await dbGet(`/xp/${uid}/balance`)) || 0;
  const next = current + amount;
  await dbPut(`/xp/${uid}/balance`, next);
  await dbPost(`/xp/${uid}/log`, { amount, reason, balanceAfter: next, ts: Date.now() });
  if (amount > 0) {
    const lt = (await dbGet(`/xp/${uid}/lifetimeEarned`)) || 0;
    await dbPut(`/xp/${uid}/lifetimeEarned`, lt + amount);
  }
}

const MAX_OPEN_MARKETS = 3;
const CREATE_CHANCE = 0.35; // per 3h run, when there's room — averages a bit under one new market a day
const CASINO_TIERS = [
  { name: "Diamond", threshold: 1000000, key: "diamond" },
  { name: "Platinum", threshold: 500000, key: "platinum" },
  { name: "Gold", threshold: 250000, key: "gold" },
  { name: "Silver", threshold: 100000, key: "silver" },
  { name: "Bronze", threshold: 10000, key: "bronze" },
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---- Gather real data ----
async function gatherContext() {
  const [state, xpAll, bounties, reserve, tippingStats] = await Promise.all([
    dbGet("/state"),
    dbGet("/xp"),
    dbGet("/bounties"),
    dbGet("/predictionMarketReserve"),
    dbGet("/tippingStats"),
  ]);
  const members = (state && state.members) || [];
  const linked = members.filter((m) => m.linkedUid);
  const reserveBalance = reserve || 0;

  const players = linked.map((m) => {
    const xp = (xpAll && xpAll[m.linkedUid]) || {};
    const tipping = (tippingStats && tippingStats[m.linkedUid]) || {};
    return {
      name: m.name,
      uid: m.linkedUid,
      balance: xp.balance || 0,
      lifetimeEarned: xp.lifetimeEarned || 0,
      streak: xp.currentStreak || 0,
      pl: m.pl || 0,
      wins: m.wins || 0,
      losses: m.losses || 0,
      indWin: m.indWin || 0,
      indLoss: m.indLoss || 0,
      tippingPoints: tipping.seasonPoints || 0,
    };
  });

  return { players, bounties: bounties || {}, reserveBalance };
}

function computeWorth(reserveBalance, difficulty) {
  // difficulty 0-1, higher = less likely = bigger reward. Capped to a
  // slice of the actual reserve so Syndy can never promise more than she
  // can pay out. This is Syndy's Book's OWN reserve — deliberately not
  // the Casino Pot, which is a specific monthly jackpot-loss-tracker
  // with its own unrelated mechanic that this shouldn't touch.
  const base = 200 + difficulty * 800;
  return Math.max(100, Math.min(Math.round(base), Math.round(reserveBalance * 0.3)) || Math.round(base));
}

// ---- Templates — each returns { question, resolution, difficulty } or null if no valid candidate right now ----
const TEMPLATES = [
  // Streak continuation
  (ctx) => {
    const candidates = ctx.players.filter((p) => p.streak >= 2);
    if (candidates.length === 0) return null;
    const p = pick(candidates);
    const target = p.streak + 2;
    return {
      question: `Will ${p.name}'s win streak reach ${target} before it breaks?`,
      resolution: { type: "streakReach", uid: p.uid, name: p.name, target },
      difficulty: 0.6,
    };
  },
  // XP race between two players
  (ctx) => {
    if (ctx.players.length < 2) return null;
    const shuffled = [...ctx.players].sort(() => Math.random() - 0.5);
    const [a, b] = shuffled;
    if (!a || !b) return null;
    const ahead = a.balance >= b.balance ? a : b;
    const behind = ahead === a ? b : a;
    const gap = ahead.balance - behind.balance;
    const closeness = ahead.balance > 0 ? 1 - Math.min(1, gap / ahead.balance) : 0.5;
    return {
      question: `Will ${ahead.name} still be ahead of ${behind.name} on Casino XP in 24 hours?`,
      resolution: { type: "xpRace", aheadUid: ahead.uid, aheadName: ahead.name, behindUid: behind.uid, behindName: behind.name },
      difficulty: 1 - closeness, // the closer the race, the more genuinely uncertain, the bigger the reward
    };
  },
  // Tier-up
  (ctx) => {
    const candidates = [];
    ctx.players.forEach((p) => {
      const currentTier = CASINO_TIERS.find((t) => p.lifetimeEarned >= t.threshold);
      const currentIdx = currentTier ? CASINO_TIERS.findIndex((t) => t.key === currentTier.key) : CASINO_TIERS.length;
      const next = CASINO_TIERS[currentIdx - 1];
      if (!next) return; // already Diamond or no next tier
      const floor = currentTier ? currentTier.threshold : 0;
      const span = next.threshold - floor;
      const progress = span > 0 ? (p.lifetimeEarned - floor) / span : 0;
      if (progress >= 0.6) candidates.push({ p, next, progress });
    });
    if (candidates.length === 0) return null;
    const { p, next, progress } = pick(candidates);
    return {
      question: `Will ${p.name} reach ${next.name} tier by the end of the week?`,
      resolution: { type: "tierUp", uid: p.uid, name: p.name, targetThreshold: next.threshold },
      difficulty: 1 - progress,
    };
  },
  // Open bounty getting claimed
  (ctx) => {
    const open = Object.entries(ctx.bounties).filter(([, b]) => b && b.status === "open");
    if (open.length === 0) return null;
    const [id, b] = pick(open);
    return {
      question: `Will the open bounty "${b.title || "Untitled"}" get claimed within 48 hours?`,
      resolution: { type: "bountyClaimed", bountyId: id },
      difficulty: 0.5,
    };
  },
  // Board season P/L flipping positive
  (ctx) => {
    const candidates = ctx.players.filter((p) => p.pl < 0 && p.pl > -400);
    if (candidates.length === 0) return null;
    const p = pick(candidates);
    return {
      question: `Will ${p.name}'s season P/L go positive within a week?`,
      resolution: { type: "plPositive", name: p.name },
      difficulty: 0.7,
    };
  },
  // Group multi win-rate — will it stay above 50%
  (ctx) => {
    const candidates = ctx.players.filter((p) => p.wins + p.losses >= 3);
    if (candidates.length === 0) return null;
    const p = pick(candidates);
    const decided = p.wins + p.losses;
    const winPct = decided > 0 ? p.wins / decided : 0;
    return {
      question: `Will ${p.name}'s group multi win rate still be above 50% in a week?`,
      resolution: { type: "groupWinRateAbove50", name: p.name },
      difficulty: 1 - Math.min(1, Math.abs(winPct - 0.5) * 2), // closer to exactly 50% = more genuinely uncertain
    };
  },
  // Individual bets race between two players
  (ctx) => {
    if (ctx.players.length < 2) return null;
    const shuffled = [...ctx.players].sort(() => Math.random() - 0.5);
    const [a, b] = shuffled;
    if (!a || !b) return null;
    const ahead = a.indWin >= b.indWin ? a : b;
    const behind = ahead === a ? b : a;
    const gap = ahead.indWin - behind.indWin;
    const closeness = ahead.indWin > 0 ? 1 - Math.min(1, gap / Math.max(1, ahead.indWin)) : 0.5;
    return {
      question: `Will ${ahead.name} still have more individual wins than ${behind.name} in a week?`,
      resolution: { type: "indWinRace", aheadName: ahead.name, behindName: behind.name },
      difficulty: 1 - closeness,
    };
  },
  // Tipping points race between two players
  (ctx) => {
    const tippers = ctx.players.filter((p) => p.tippingPoints > 0);
    if (tippers.length < 2) return null;
    const shuffled = [...tippers].sort(() => Math.random() - 0.5);
    const [a, b] = shuffled;
    if (!a || !b) return null;
    const ahead = a.tippingPoints >= b.tippingPoints ? a : b;
    const behind = ahead === a ? b : a;
    const gap = ahead.tippingPoints - behind.tippingPoints;
    const closeness = ahead.tippingPoints > 0 ? 1 - Math.min(1, gap / ahead.tippingPoints) : 0.5;
    return {
      question: `Will ${ahead.name} still be ahead of ${behind.name} on the Tipping ladder in a week?`,
      resolution: { type: "tippingRace", aheadName: ahead.name, behindName: behind.name },
      difficulty: 1 - closeness,
    };
  },
];

// ---- Fixed-odds leg betting — "will [player]'s next leg win or lose",
// odds computed by Syndy from their real historical group-multi win
// rate (with a house margin), NOT the real live odds for a specific
// leg — those genuinely aren't available anywhere in this app before
// the result is already known (odds and result get entered together,
// in the same save, once the outcome's already decided). Resolves
// against whatever their ACTUAL next real result turns out to be, once
// the Ledger records it — a genuine, concrete, verifiable outcome, just
// not literally "this week's" leg specifically.
//
// Unlike the pooled predictionMarkets above, this is fixed odds: each
// stake has a deterministic payout (stake × odds) regardless of what
// anyone else bets, which means the reserve is a genuine counterparty
// and can lose more than it collects if enough people call it right.
// LEG_BET_MAX_EXPOSURE_PCT caps total potential payout per side, fixed
// at creation time, so a single bet can never threaten more than a
// bounded slice of the reserve.
const LEG_BET_STAKE_WINDOW_MS = 24 * 3600 * 1000; // 24h to place a stake
const LEG_BET_RESOLVE_TIMEOUT_MS = 9 * 24 * 3600 * 1000; // if no real result shows up within 9 days of creation, void and refund rather than leave it hanging indefinitely
const LEG_BET_MAX_EXPOSURE_PCT = 0.25; // per side, of the reserve at creation time
const LEG_BET_MARGIN = 0.12; // house overround — shades both sides' fair odds down

function computeLegOdds(winPct) {
  const p = Math.max(0.1, Math.min(0.9, winPct)); // clamp — nobody's a genuine 0% or 100% shot, and extreme odds are a bad look regardless
  const fairWin = 1 / p;
  const fairLose = 1 / (1 - p);
  return {
    winOdds: Math.round(fairWin * (1 - LEG_BET_MARGIN) * 100) / 100,
    loseOdds: Math.round(fairLose * (1 - LEG_BET_MARGIN) * 100) / 100,
  };
}

async function tryCreateLegBet(ctx, reserveBalance) {
  const candidates = ctx.players.filter((p) => p.wins + p.losses >= 4); // needs a real sample size before Syndy will price it
  if (candidates.length === 0) return null;
  const p = pick(candidates);
  const decided = p.wins + p.losses;
  const winPct = p.wins / decided;
  const odds = computeLegOdds(winPct);
  const now = Date.now();
  const maxExposure = Math.max(50, Math.round(reserveBalance * LEG_BET_MAX_EXPOSURE_PCT));

  return {
    playerName: p.name,
    playerUid: p.uid,
    winOdds: odds.winOdds,
    loseOdds: odds.loseOdds,
    maxExposurePerSide: maxExposure,
    createdAt: now,
    closesAt: now + LEG_BET_STAKE_WINDOW_MS,
    resolveByAt: now + LEG_BET_RESOLVE_TIMEOUT_MS,
    status: "open",
    outcome: null,
    createdBy: "syndy",
  };
}

async function tryResolveLegBet(betId, bet) {
  const stakes = bet.stakes || {};
  const stakeList = Object.entries(stakes);
  const now = Date.now();

  // Look for a real result recorded for this player since the bet was
  // created — any saved week with a Win/Loss (Void/MIA don't count,
  // there's genuinely nothing to resolve against yet).
  const state = await dbGet("/state");
  const history = (state && state.history) || [];
  const relevantWeek = history
    .filter((w) => w && w.savedAt > bet.createdAt && w.groupEntries && w.groupEntries[bet.playerName])
    .find((w) => {
      const r = w.groupEntries[bet.playerName].result;
      return r === "Win" || r === "Loss";
    });

  if (!relevantWeek) {
    if (now >= bet.resolveByAt) {
      // No real result showed up in time — void and refund everyone
      // rather than guess or leave it open indefinitely.
      for (const [uid, s] of stakeList) {
        await awardXp(uid, s.amount, `Syndy's Book leg bet refunded (no result recorded in time) — ${bet.playerName}`);
      }
      await dbPut(`/legBets/${betId}/status`, "voided");
      await postToGroupChat(`📖 Leg bet on ${bet.playerName} voided — no result came through in time, everyone's stake was refunded.`);
      console.log(`Voided leg bet ${betId} — no result within timeout.`);
    }
    return; // still waiting, nothing to do this run
  }

  const outcome = relevantWeek.groupEntries[bet.playerName].result === "Win" ? "win" : "lose";
  const winners = stakeList.filter(([, s]) => s.side === outcome);
  const losers = stakeList.filter(([, s]) => s.side !== outcome);
  const odds = outcome === "win" ? bet.winOdds : bet.loseOdds;

  const currentReserve = (await dbGet("/predictionMarketReserve")) || 0;
  let totalPayout = 0;
  for (const [, s] of winners) {
    totalPayout += Math.floor(s.amount * odds);
  }
  // Same reserve-affordability clamp as the pooled markets — if the
  // reserve genuinely can't cover it (the exposure cap should normally
  // prevent this, but the reserve's balance can move for other reasons
  // between creation and resolution), scale every winner's payout down
  // proportionally rather than pay some in full and others nothing.
  const scale = totalPayout > 0 ? Math.min(1, currentReserve / totalPayout) : 1;
  let actuallyPaid = 0;
  for (const [uid, s] of winners) {
    const payout = Math.floor(Math.floor(s.amount * odds) * scale);
    actuallyPaid += payout;
    await awardXp(uid, payout, `Syndy's Book leg bet payout — ${bet.playerName} to ${outcome} @ ${odds}`);
    await sendWinPush(uid, payout, `Leg bet — ${bet.playerName} to ${outcome}`);
  }
  const losePool = losers.reduce((sum, [, s]) => sum + (s.amount || 0), 0);
  const reserveDelta = losePool - actuallyPaid;
  if (reserveDelta !== 0) {
    await dbPut("/predictionMarketReserve", currentReserve + reserveDelta);
  }

  await dbPut(`/legBets/${betId}/status`, "resolved");
  await dbPut(`/legBets/${betId}/outcome`, outcome);
  await dbPut(`/legBets/${betId}/resolvedAt`, now);

  const winnerNames = winners.map(([, s]) => s.name).join(", ") || "nobody";
  await postToGroupChat(
    `📖 Leg bet resolved: ${bet.playerName}'s leg came in ${outcome.toUpperCase()}. Paid out: ${winnerNames}.`
  );
  console.log(`Resolved leg bet ${betId} as ${outcome}, ${winners.length} winner(s).`);
}

async function tryResolveMarket(marketId, mkt) {
  const stakes = mkt.stakes || {};
  let outcome = null;

  try {
    if (mkt.resolution.type === "streakReach") {
      const streak = (await dbGet(`/xp/${mkt.resolution.uid}/currentStreak`)) || 0;
      outcome = streak >= mkt.resolution.target ? "yes" : "no";
    } else if (mkt.resolution.type === "xpRace") {
      const [aheadBal, behindBal] = await Promise.all([
        dbGet(`/xp/${mkt.resolution.aheadUid}/balance`),
        dbGet(`/xp/${mkt.resolution.behindUid}/balance`),
      ]);
      outcome = (aheadBal || 0) >= (behindBal || 0) ? "yes" : "no";
    } else if (mkt.resolution.type === "tierUp") {
      const lifetime = (await dbGet(`/xp/${mkt.resolution.uid}/lifetimeEarned`)) || 0;
      outcome = lifetime >= mkt.resolution.targetThreshold ? "yes" : "no";
    } else if (mkt.resolution.type === "bountyClaimed") {
      const bounty = await dbGet(`/bounties/${mkt.resolution.bountyId}`);
      outcome = bounty && bounty.status === "claimed" ? "yes" : "no";
    } else if (mkt.resolution.type === "plPositive") {
      const state = await dbGet("/state");
      const member = ((state && state.members) || []).find((m) => m.name === mkt.resolution.name);
      outcome = member && member.pl >= 0 ? "yes" : "no";
    } else if (mkt.resolution.type === "groupWinRateAbove50") {
      const state = await dbGet("/state");
      const member = ((state && state.members) || []).find((m) => m.name === mkt.resolution.name);
      if (!member) return;
      const decided = (member.wins || 0) + (member.losses || 0);
      const winPct = decided > 0 ? (member.wins || 0) / decided : 0;
      outcome = winPct > 0.5 ? "yes" : "no";
    } else if (mkt.resolution.type === "indWinRace") {
      const state = await dbGet("/state");
      const members = (state && state.members) || [];
      const ahead = members.find((m) => m.name === mkt.resolution.aheadName);
      const behind = members.find((m) => m.name === mkt.resolution.behindName);
      if (!ahead || !behind) return;
      outcome = (ahead.indWin || 0) >= (behind.indWin || 0) ? "yes" : "no";
    } else if (mkt.resolution.type === "tippingRace") {
      const state = await dbGet("/state");
      const members = (state && state.members) || [];
      const ahead = members.find((m) => m.name === mkt.resolution.aheadName);
      const behind = members.find((m) => m.name === mkt.resolution.behindName);
      if (!ahead || !behind || !ahead.linkedUid || !behind.linkedUid) return;
      const [aheadPoints, behindPoints] = await Promise.all([
        dbGet(`/tippingStats/${ahead.linkedUid}/seasonPoints`),
        dbGet(`/tippingStats/${behind.linkedUid}/seasonPoints`),
      ]);
      outcome = (aheadPoints || 0) >= (behindPoints || 0) ? "yes" : "no";
    } else {
      return; // unknown resolution type — leave it for manual admin resolution
    }
  } catch (err) {
    console.error(`Could not check resolution for market ${marketId}:`, err.message);
    return;
  }

  if (!outcome) return;

  const stakeList = Object.entries(stakes);
  const winners = stakeList.filter(([, s]) => s.side === outcome);
  const losers = stakeList.filter(([, s]) => s.side !== outcome);
  const winPool = winners.reduce((sum, [, s]) => sum + (s.amount || 0), 0);
  const losePool = losers.reduce((sum, [, s]) => sum + (s.amount || 0), 0);

  // Losers' stakes go entirely to Syndy's Book's own reserve, not to
  // winners. Winners get their own stake back plus a proportional share
  // of "worth" (the reward set at creation), drawn from the reserve and
  // re-clamped to whatever it can actually afford right now.
  const currentReserve = (await dbGet("/predictionMarketReserve")) || 0;
  const actualWorth = Math.max(0, Math.min(mkt.worth || 0, currentReserve));
  for (const [uid, s] of winners) {
    const share = winPool > 0 ? Math.floor((s.amount / winPool) * actualWorth) : 0;
    const payout = s.amount + share;
    await awardXp(uid, payout, `Syndy's Book payout — "${mkt.question}"`);
    await sendWinPush(uid, payout, `"${mkt.question}"`);
  }
  const reserveDelta = losePool - actualWorth;
  if (reserveDelta !== 0) {
    await dbPut("/predictionMarketReserve", currentReserve + reserveDelta);
  }

  await dbPut(`/predictionMarkets/${marketId}/status`, "resolved");
  await dbPut(`/predictionMarkets/${marketId}/outcome`, outcome);
  await dbPut(`/predictionMarkets/${marketId}/resolvedAt`, Date.now());

  const winnerNames = winners.map(([, s]) => s.name).join(", ") || "nobody";
  await postToGroupChat(
    `📖 Market resolved: "${mkt.question}" — the answer was ${outcome.toUpperCase()}. Paid out: ${winnerNames}.`
  );
  console.log(`Resolved market ${marketId} as ${outcome}, ${winners.length} winner(s).`);
}

export default async (req) => {
  if (!DB_SECRET) {
    console.log("Missing FIREBASE_DB_SECRET — skipping run.");
    return new Response("Missing config", { status: 200 });
  }

  try {
    const now = Date.now();
    const markets = (await dbGet("/predictionMarkets")) || {};
    const entries = Object.entries(markets);

    // ---- Pass 1: resolve anything past its close time ----
    const toResolve = entries.filter(([, m]) => m && m.status === "open" && m.closesAt <= now && m.resolution);
    for (const [id, mkt] of toResolve) {
      await tryResolveMarket(id, mkt);
    }

    // ---- Pass 2: maybe create a new one ----
    const openCount = entries.filter(([, m]) => m && m.status === "open" && m.closesAt > now).length;
    if (openCount < MAX_OPEN_MARKETS && Math.random() < CREATE_CHANCE) {
      const ctx = await gatherContext();
      const shuffledTemplates = [...TEMPLATES].sort(() => Math.random() - 0.5);
      let generated = null;
      for (const tmpl of shuffledTemplates) {
        generated = tmpl(ctx);
        if (generated) break;
      }
      if (generated) {
        const worth = computeWorth(ctx.reserveBalance, generated.difficulty);
        const closesAt = now + 24 * 3600 * 1000; // 24h to stake, resolution itself may take longer depending on resolution.type
        const marketData = {
          question: generated.question,
          worth,
          createdAt: now,
          closesAt,
          status: "open",
          outcome: null,
          createdBy: "syndy",
          resolution: generated.resolution,
        };
        const posted = await dbPost("/predictionMarkets", marketData);
        await postToGroupChat(`📖 Syndy's Book — new market: "${generated.question}" (worth ${worth.toLocaleString()} XP, closes in 24h). Stake YES or NO in the Casino tab.`);
        console.log(`Created market ${posted.name}: ${generated.question}`);
      } else {
        console.log("No valid market candidate this run.");
      }
    } else {
      console.log(`Skipping creation — openCount=${openCount}, roll=${Math.random() < CREATE_CHANCE}.`);
    }

    // ---- Pass 3: leg bets — resolve anything due ----
    const legBets = (await dbGet("/legBets")) || {};
    const legBetEntries = Object.entries(legBets);
    const legBetsToResolve = legBetEntries.filter(([, b]) => b && b.status === "open" && b.closesAt <= now);
    for (const [id, bet] of legBetsToResolve) {
      await tryResolveLegBet(id, bet);
    }

    // ---- Pass 4: leg bets — maybe create a new one ----
    const openLegBetCount = legBetEntries.filter(([, b]) => b && b.status === "open" && b.closesAt > now).length;
    if (openLegBetCount < MAX_OPEN_MARKETS && Math.random() < CREATE_CHANCE) {
      const ctx = await gatherContext();
      const legBetData = await tryCreateLegBet(ctx, ctx.reserveBalance);
      if (legBetData) {
        const posted = await dbPost("/legBets", legBetData);
        await postToGroupChat(
          `📖 Syndy's Book — leg bet: ${legBetData.playerName} to WIN @ ${legBetData.winOdds}x or LOSE @ ${legBetData.loseOdds}x. Closes in 24h — stake in the Casino tab.`
        );
        console.log(`Created leg bet ${posted.name} on ${legBetData.playerName}.`);
      } else {
        console.log("No valid leg bet candidate this run.");
      }
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("syndy-book-scheduled error:", err.message);
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
};

export const config = {
  schedule: "0 */3 * * *",
};
