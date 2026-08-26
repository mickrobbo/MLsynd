// netlify/functions/puntersedge-sports-odds.js
// Fetches best-price sports odds from PuntersEdge for AFL/NRL/NBA/EPL and
// matches each event's selections back to its home/away team.

export default async function (request) {
  const apiKey = process.env.PUNTERSEDGE_API_KEY;

  if (!apiKey) {
    return new Response(JSON.stringify({ error: "PUNTERSEDGE_API_KEY not configured." }), {
      status: 500,
    });
  }

  const url = new URL(request.url);
  const sportParam = (url.searchParams.get("sport") || "").toLowerCase();

  // Map our app's internal sport keys to PuntersEdge's sport keys.
  // NFL / MLB / NHL / tennis aren't covered by PuntersEdge's sports odds API.
  const sportKeyMap = {
    afl: "afl",
    nrl: "nrl",
    nba: "basketball_nba",
    epl: "soccer_epl",
  };

  const peSportKey = sportKeyMap[sportParam];
  if (!peSportKey) {
    return new Response(JSON.stringify({ supported: false, sport: sportParam, events: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function normTeam(s) {
    return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }
  function matchesTeam(selName, teamName) {
    const a = normTeam(selName);
    const b = normTeam(teamName);
    if (!a || !b) return false;
    return a === b || a.includes(b) || b.includes(a);
  }

  try {
    const upstreamUrl = `https://puntersedge.online/api/v1/best-odds/${peSportKey}`;

    const resp = await fetch(upstreamUrl, {
      headers: { "X-API-Key": apiKey },
    });

    const rawText = await resp.text();

    if (!resp.ok) {
      return new Response(JSON.stringify({
        error: "Upstream PuntersEdge error",
        upstreamStatus: resp.status,
        upstreamBody: rawText.slice(0, 500),
      }), {
        status: resp.status,
      });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return new Response(JSON.stringify({ error: "Failed to parse upstream JSON" }), {
        status: 502,
      });
    }

    const rawEvents = Array.isArray(data) ? data : data.events || [];

    const events = rawEvents.map((ev) => {
      const selections = ev.selections || [];

      const homeMatches = selections.filter((s) => matchesTeam(s.name, ev.home_team));
      const awayMatches = selections.filter((s) => matchesTeam(s.name, ev.away_team));

      const bestOf = (arr) =>
        arr.reduce((best, s) => (best === null || s.best_price < best.best_price ? s : best), null);

      const home = bestOf(homeMatches);
      const away = bestOf(awayMatches);

      return {
        home_team: ev.home_team,
        away_team: ev.away_team,
        commence_time: ev.commence_time,
        home_best_price: home ? home.best_price : null,
        home_best_bookmaker: home ? home.best_bookmaker : null,
        away_best_price: away ? away.best_price : null,
        away_best_bookmaker: away ? away.best_bookmaker : null,
      };
    });

    return new Response(JSON.stringify({ supported: true, sport: sportParam, events }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
    });
  }
}
