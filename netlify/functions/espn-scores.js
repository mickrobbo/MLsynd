// netlify/functions/espn-scores.js
// Pulls live/upcoming scores from ESPN's public (undocumented but stable)
// scoreboard endpoints, covering every sport in the Dashboard's Sport tab
// except AFL (which uses Squiggle instead, via afl-scores.js).

const LEAGUE_PATHS = {
  nfl: "football/nfl",
  nba: "basketball/nba",
  mlb: "baseball/mlb",
  nhl: "hockey/nhl",
  nrl: "rugby-league/3",
  epl: "soccer/eng.1",
};

exports.handler = async function (event) {
  const sport = ((event.queryStringParameters || {}).sport || "").toLowerCase();
  const path = LEAGUE_PATHS[sport];

  if (!path) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ games: [] }),
    };
  }

  try {
    const resp = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);

    if (!resp.ok) {
      return {
        statusCode: resp.status,
        body: JSON.stringify({ error: `ESPN returned ${resp.status}` }),
      };
    }

    const data = await resp.json();

    const games = (data.events || []).map((ev) => {
      const comp = (ev.competitions || [])[0] || {};
      const competitors = comp.competitors || [];
      const home = competitors.find((c) => c.homeAway === "home") || {};
      const away = competitors.find((c) => c.homeAway === "away") || {};
      const statusType = (ev.status || {}).type || {};
      const state = statusType.state; // 'pre' | 'in' | 'post'

      return {
        hteam: home.team ? (home.team.shortDisplayName || home.team.displayName) : "",
        ateam: away.team ? (away.team.shortDisplayName || away.team.displayName) : "",
        hscore: home.score != null && home.score !== "" ? home.score : null,
        ascore: away.score != null && away.score !== "" ? away.score : null,
        complete: statusType.completed ? 100 : (state === "in" ? 50 : 0),
        live: state === "in",
        timestr: statusType.shortDetail || statusType.description || "",
        venue: comp.venue ? comp.venue.fullName : "",
        date: ev.date || null, // ISO UTC timestamp
      };
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ games }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
