// netlify/functions/nrl-fixtures.mjs
// Full NRL season fixture list for the Tipping tab, in the SAME shape as
// afl-fixtures (id, round, roundname, date, venue, hteam, ateam, scores,
// complete 0-100, winner, margin) so the tipping screens treat both leagues
// identically. Source: the public nrl.com draw feed (competition 111).
//
// State of Origin: pulled from the same feed (competition 116) and attached
// to the NRL round whose weekend came just before it, because Origin is a
// mid-week game played between two NRL rounds. If the Origin feed is
// unavailable the NRL games still load (originLoaded:false in the reply).
//
// Add ?debug=1 to see the first raw fixture, to check the feed shape.
//
// Every game also carries `unixtime` (seconds, the true UTC kickoff) so the
// app never has to guess AEST vs AEDT from a local time string.

const UA = { "User-Agent": "MLSynd Tipping (contact: mlsynd00@gmail.com)", Accept: "application/json" };
const TZ = "Australia/Sydney";

const cache = new Map(); // year -> { at, body }
const TTL_MS = 60 * 1000;

function localStamp(ms) {
  // "YYYY-MM-DD HH:MM:SS" in Sydney time, the same style Squiggle uses.
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

function fixturesOf(data) {
  const out = [];
  for (const grp of (data && data.drawGroups) || []) {
    for (const f of grp.fixtures || []) if (f && f.type !== "Bye") out.push(f);
  }
  return out;
}

function teamName(t) {
  return (t && (t.nickName || t.name || t.teamName)) || "TBC";
}

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function toGame(f, year, round, extra) {
  const kick = f.clock && (f.clock.kickOffTimeLong || f.clock.kickOffTime);
  const ms = kick ? new Date(kick).getTime() : NaN;
  const home = f.homeTeam || {}, away = f.awayTeam || {};
  const done = /full\s*time|post/i.test(f.matchState || "") || /post/i.test(f.matchMode || "");
  const hs = typeof home.score === "number" ? home.score : null;
  const as = typeof away.score === "number" ? away.score : null;
  const hteam = teamName(home), ateam = teamName(away);
  let winner = null, margin = null;
  if (done && hs != null && as != null) {
    margin = Math.abs(hs - as);
    winner = hs > as ? hteam : as > hs ? ateam : null;
  }
  const url = f.matchCentreUrl || `${year}-${round}-${hteam}-v-${ateam}`;
  return {
    id: `n-${slug(url).replace(/^draw-/, "")}`.slice(0, 80),
    round,
    roundname: f.roundTitle || `Round ${round}`,
    date: isNaN(ms) ? null : localStamp(ms),
    unixtime: isNaN(ms) ? null : Math.floor(ms / 1000),
    venue: f.venue || "",
    hteam, ateam,
    hscore: hs, ascore: as,
    complete: done ? 100 : 0,
    winner, margin,
    ...extra,
  };
}

async function loadSeason(year, debug) {
  const base = `https://www.nrl.com/draw/data?competition=111&season=${year}`;
  const first = await getJson(`${base}&round=1`);
  const rounds = ((first && first.filterRounds) || [])
    .map((r) => Number(r.value)).filter((n) => Number.isFinite(n) && n > 0);
  const roundList = rounds.length ? [...new Set(rounds)] : Array.from({ length: 27 }, (_, i) => i + 1);

  const byRound = new Map([[1, first]]);
  const todo = roundList.filter((r) => r !== 1);
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(todo.slice(i, i + 6).map(async (r) => {
      try { byRound.set(r, await getJson(`${base}&round=${r}`)); } catch (e) { /* round not published yet */ }
    }));
  }

  const games = [];
  let rawSample = null;
  for (const r of roundList.sort((a, b) => a - b)) {
    for (const f of fixturesOf(byRound.get(r))) {
      if (!rawSample) rawSample = f;
      games.push(toGame(f, year, r, {}));
    }
  }

  // State of Origin — attach each game to the NRL round whose last game
  // kicked off most recently before it.
  let originLoaded = false;
  try {
    const od = await getJson(`https://www.nrl.com/draw/data?competition=116&season=${year}`);
    let ofx = fixturesOf(od);
    const orRounds = ((od && od.filterRounds) || []).map((r) => Number(r.value)).filter(Number.isFinite);
    if (orRounds.length > 1) {
      const more = await Promise.all(orRounds.filter((r) => r !== Number(od.selectedRoundId)).map((r) =>
        getJson(`https://www.nrl.com/draw/data?competition=116&season=${year}&round=${r}`).catch(() => null)));
      more.forEach((d) => { ofx = ofx.concat(fixturesOf(d)); });
    }
    const seen = new Set();
    const originGames = [];
    ofx.forEach((f, i) => {
      const g = toGame(f, year, 0, { origin: true });
      if (seen.has(g.id)) return;
      seen.add(g.id);
      g.roundname = f.roundTitle && /origin/i.test(f.roundTitle) ? f.roundTitle : `State of Origin ${["I", "II", "III"][originGames.length] || originGames.length + 1}`;
      originGames.push(g);
    });
    for (const og of originGames) {
      const prior = games.filter((g) => !g.origin && g.unixtime && og.unixtime && g.unixtime < og.unixtime);
      const last = prior.sort((a, b) => b.unixtime - a.unixtime)[0];
      if (!last) continue;
      og.round = last.round;
      games.push(og);
    }
    originLoaded = originGames.length > 0;
  } catch (e) { /* Origin feed unavailable — NRL games still work */ }

  const body = { year: Number(year), games, originLoaded };
  if (debug) body.rawSample = rawSample;
  return body;
}

export default async function (request) {
  const url = new URL(request.url);
  const year = Number(url.searchParams.get("year")) || new Date().getFullYear();
  const debug = url.searchParams.get("debug") === "1";
  const hit = cache.get(year);
  if (!debug && hit && Date.now() - hit.at < TTL_MS) return respond(hit.body);
  try {
    const body = await loadSeason(year, debug);
    if (!debug) cache.set(year, { at: Date.now(), body });
    return respond(body);
  } catch (err) {
    if (hit) return respond(hit.body); // serve the last good copy rather than break tipping
    return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
}

function respond(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=30, s-maxage=60",
    },
  });
}
