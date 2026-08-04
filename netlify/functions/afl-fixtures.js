// netlify/functions/afl-fixtures.js
// Pulls the full AFL season fixture list from Squiggle (all rounds, teams,
// venues, kickoff times, and results where games are complete). Used by the
// Tipping tab to show upcoming games to pick and past games to score.

exports.handler = async function (event) {
  const year = (event.queryStringParameters && event.queryStringParameters.year) || new Date().getFullYear();

  try {
    const resp = await fetch(`https://api.squiggle.com.au/?q=games;year=${encodeURIComponent(year)}`, {
      headers: { "User-Agent": "MLSynd Tipping (contact: mlsynd00@gmail.com)" },
    });

    if (!resp.ok) {
      return {
        statusCode: resp.status,
        body: JSON.stringify({ error: `Squiggle returned ${resp.status}` }),
      };
    }

    const data = await resp.json();
    const games = (data.games || []).map((g) => ({
      id: g.id,
      round: g.round,
      roundname: g.roundname,
      date: g.date, // local AEST/AEDT, e.g. "2026-08-08 19:20:00"
      venue: g.venue,
      hteam: g.hteam,
      ateam: g.ateam,
      hscore: g.hscore,
      ascore: g.ascore,
      complete: g.complete, // 0-100
      winner: g.winner,
      margin: g.margin,
    }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ year: Number(year), games }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
