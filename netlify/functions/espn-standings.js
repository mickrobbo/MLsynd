// netlify/functions/espn-standings.js
// Pulls league standings from ESPN's public standings endpoint. Built for
// NRL, but works for any sport ESPN covers via the same LEAGUE_PATHS map
// used by espn-scores.js.

const LEAGUE_PATHS = {
  nfl: "football/nfl",
  nba: "basketball/nba",
  mlb: "baseball/mlb",
  nhl: "hockey/nhl",
  nrl: "rugby-league/nrl",
  epl: "soccer/eng.1",
};

exports.handler = async function (event) {
  const sport = ((event.queryStringParameters || {}).sport || "").toLowerCase();
  const path = LEAGUE_PATHS[sport];

  if (!path) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ladder: [] }),
    };
  }

  try {
    const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/standings`);

    if (!resp.ok) {
      return {
        statusCode: resp.status,
        body: JSON.stringify({ error: `ESPN returned ${resp.status}` }),
      };
    }

    const data = await resp.json();

    // ESPN sometimes nests standings under children[] (conferences/divisions),
    // sometimes returns a flat standings.entries[] — handle both.
    const groups = data.children && data.children.length ? data.children : [data];

    const ladder = [];
    groups.forEach((group) => {
      const entries = (group.standings && group.standings.entries) || [];
      entries.forEach((entry) => {
        const statFor = (name) => {
          const s = (entry.stats || []).find((s) => s.name === name || s.abbreviation === name);
          return s ? (s.value != null ? s.value : s.displayValue) : null;
        };
        ladder.push({
          name: entry.team ? (entry.team.displayName || entry.team.name) : "",
          group: group.name || null,
          rank: statFor("rank"),
          played: statFor("gamesPlayed"),
          wins: statFor("wins"),
          losses: statFor("losses"),
          draws: statFor("ties") != null ? statFor("ties") : statFor("draws"),
          points: statFor("points"),
        });
      });
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ladder }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
