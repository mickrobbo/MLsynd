// netlify/functions/afl-ladder.js
// Pulls the current AFL ladder (standings) from Squiggle.

exports.handler = async function (event) {
  const year = (event.queryStringParameters && event.queryStringParameters.year) || new Date().getFullYear();

  try {
    const resp = await fetch(`https://api.squiggle.com.au/?q=standings;year=${encodeURIComponent(year)}`, {
      headers: { "User-Agent": "MLSynd Ladder (contact: mlsynd00@gmail.com)" },
    });

    if (!resp.ok) {
      return {
        statusCode: resp.status,
        body: JSON.stringify({ error: `Squiggle returned ${resp.status}` }),
      };
    }

    const data = await resp.json();
    const raw = data.standings || [];

    const ladder = raw
      .map((t) => ({
        name: t.name,
        rank: t.rank,
        played: t.played,
        wins: t.wins,
        losses: t.losses,
        draws: t.draws,
        percentage: t.percentage,
        points: t.pts != null ? t.pts : (t.points != null ? t.points : null),
      }))
      .sort((a, b) => (a.rank || 99) - (b.rank || 99));

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
