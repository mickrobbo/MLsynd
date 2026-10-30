// netlify/functions/efl-fixtures.mjs
// EFL Championship season fixture list for the Tipping tab, in the SAME shape
// as afl-fixtures / nrl-fixtures (id, round, roundname, date, unixtime, venue,
// hteam, ateam, scores, complete 0-100, winner, margin) so the tipping screens
// treat every league identically. Source: ESPN's public scoreboard for
// soccer/eng.2 (the same host the Sport tab's EFL ladder already uses).
//
// A football season runs August to May, so `year` is the year the season
// STARTS (2026 = 2026/27). Every game carries year too, so the app never
// mixes seasons.
//
// ESPN has no matchweek number, so it is worked out: a game's matchweek is
// the highest number of games either of its two teams has played by then,
// in kick-off order. Anything past matchweek 46 (the playoffs) is left out.
//
// Add ?debug=1 to see the first raw event, to check the feed shape.

const UA = { "User-Agent": "MLSynd Tipping (contact: mlsynd00@gmail.com)", Accept: "application/json" };
const TZ = "Australia/Melbourne";
const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.2/scoreboard";
const MAX_ROUND = 46;

const cache = new Map(); // year -> { at, body }
const TTL_MS = 60 * 1000;

function localStamp(ms) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}

const ymd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function loadSeason(year, debug) {
  // One request per calendar month, 1 Aug to 31 May.
  const ranges = [];
  for (let i = 0; i < 10; i++) {
    const start = new Date(Date.UTC(year, 7 + i, 1));
    const end = new Date(Date.UTC(year, 7 + i + 1, 0));
    ranges.push(`${ymd(start)}-${ymd(end)}`);
  }
  const chunks = await Promise.all(ranges.map((r) =>
    getJson(`${BASE}?dates=${r}&limit=500`).catch(() => null)));

  let rawSample = null;
  const seen = new Set();
  const raw = [];
  for (const c of chunks) {
    for (const ev of (c && c.events) || []) {
      if (!ev || seen.has(ev.id)) continue;
      seen.add(ev.id);
      const comp = (ev.competitions && ev.competitions[0]) || {};
      const cs = comp.competitors || [];
      const home = cs.find((x) => x.homeAway === "home"), away = cs.find((x) => x.homeAway === "away");
      if (!home || !away) continue;
      const ms = new Date(ev.date).getTime();
      if (isNaN(ms)) continue;
      if (!rawSample) rawSample = ev;
      const st = (ev.status && ev.status.type) || {};
      const hs = home.score !== undefined && home.score !== "" ? Number(home.score) : null;
      const as = away.score !== undefined && away.score !== "" ? Number(away.score) : null;
      raw.push({
        id: String(ev.id), ms,
        hteam: (home.team && (home.team.shortDisplayName || home.team.displayName)) || "TBC",
        ateam: (away.team && (away.team.shortDisplayName || away.team.displayName)) || "TBC",
        venue: (comp.venue && comp.venue.fullName) || "",
        done: !!st.completed, hs: Number.isFinite(hs) ? hs : null, as: Number.isFinite(as) ? as : null,
      });
    }
  }
  raw.sort((a, b) => a.ms - b.ms);

  const played = new Map(); // team -> games counted so far
  const games = [];
  for (const g of raw) {
    const round = Math.max((played.get(g.hteam) || 0), (played.get(g.ateam) || 0)) + 1;
    played.set(g.hteam, (played.get(g.hteam) || 0) + 1);
    played.set(g.ateam, (played.get(g.ateam) || 0) + 1);
    if (round > MAX_ROUND) continue; // playoffs
    let winner = null, margin = null;
    if (g.done && g.hs != null && g.as != null) {
      margin = Math.abs(g.hs - g.as);
      winner = g.hs > g.as ? g.hteam : g.as > g.hs ? g.ateam : null;
    }
    games.push({
      id: `e-${g.id}`, year, round, roundname: `Matchweek ${round}`,
      date: localStamp(g.ms), unixtime: Math.floor(g.ms / 1000),
      venue: g.venue, hteam: g.hteam, ateam: g.ateam,
      hscore: g.hs, ascore: g.as, complete: g.done ? 100 : 0, winner, margin,
    });
  }
  const body = { year: Number(year), games };
  if (debug) body.rawSample = rawSample;
  return body;
}

function respond(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=30, s-maxage=60" },
  });
}

export default async function (request) {
  const url = new URL(request.url);
  const now = new Date();
  const defaultYear = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const year = Number(url.searchParams.get("year")) || defaultYear;
  const debug = url.searchParams.get("debug") === "1";
  const hit = cache.get(year);
  if (!debug && hit && Date.now() - hit.at < TTL_MS) return respond(hit.body);
  try {
    const body = await loadSeason(year, debug);
    if (!debug) cache.set(year, { at: Date.now(), body });
    return respond(body);
  } catch (err) {
    if (hit) return respond(hit.body);
    return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
}
