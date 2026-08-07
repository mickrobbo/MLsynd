// netlify/functions/espn-individual.js
// PGA Tour and LIV Golf don't fit the team-vs-team scoreboard shape at all —
// these are individual competitors ranked by position, not two teams with a
// score each. Kept as its own function rather than bolted onto
// espn-scores.js/espn-standings.js, which are built around team fields.
// (F1 used to go through here too, but moved to its own dedicated
// f1-championship.js sourced from Jolpica-F1, which actually provides the
// season standings + podiums-per-race that were needed — this endpoint
// could only ever give one race weekend's session results.)
//
// Verified against a live response before building this (2026-08-07):
// Golf (pga/liv): events[0].competitions[0].competitors[] — each has
// `order` (current leaderboard position) and `score` (relative to par,
// e.g. "-9"). This single list already covers both "score" and "ranking"
// at once, since a golf leaderboard is inherently both.

const LEAGUE_PATHS = {
  pga: "golf/pga",
  liv: "golf/liv",
};

exports.handler = async function (event) {
  const sport = ((event.queryStringParameters || {}).sport || "").toLowerCase();
  const path = LEAGUE_PATHS[sport];

  if (!path) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ results: [] }),
    };
  }

  try {
    const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);
    if (!resp.ok) {
      return { statusCode: resp.status, body: JSON.stringify({ error: `ESPN returned ${resp.status}` }) };
    }

    const data = await resp.json();
    const events = data.events || [];
    if (events.length === 0) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventName: null, results: [] }),
      };
    }

    const ev = events[0];
    const competitions = ev.competitions || [];
    const comp = competitions[0];
    const competitors = (comp && comp.competitors) || [];
    const results = competitors
      .map((c, i) => ({
        rank: c.order || i + 1,
        name: c.athlete ? c.athlete.displayName || c.athlete.fullName : "",
        score: c.score != null ? c.score : null,
        country: c.athlete && c.athlete.flag ? c.athlete.flag.alt : null,
      }))
      .sort((a, b) => a.rank - b.rank);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventName: ev.name || ev.shortName || null,
        sessionLabel: null,
        completed: !!(comp && comp.status && comp.status.type && comp.status.type.completed),
        results,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
