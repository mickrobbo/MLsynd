// netlify/functions/afl-ladder.js
// Pulls the current AFL ladder (standings) from Squiggle.

export default async function (request) {
  const url = new URL(request.url);
  const year = url.searchParams.get("year") || new Date().getFullYear();

  try {
    const resp = await fetch(`https://api.squiggle.com.au/?q=standings;year=${encodeURIComponent(year)}`, {
      headers: { "User-Agent": "MLSynd Ladder (contact: mlsynd00@gmail.com)" },
    });

    if (!resp.ok) {
      return new Response(JSON.stringify({ error: `Squiggle returned ${resp.status}` }), {
        status: resp.status,
      });
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

    return new Response(JSON.stringify({ ladder }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
    });
  }
}
