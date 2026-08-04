// netlify/functions/puntersedge-sports-odds.js
// Fetches best-price sports odds from PuntersEdge for AFL/NRL/NBA/EPL.
// First-pass version: passes through the upstream response mostly as-is so
// we can confirm the real field names before writing the cleanup logic
// (same approach we used for the racing prices function).

exports.handler = async function (event) {
  const apiKey = process.env.PUNTERSEDGE_API_KEY;

  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "PUNTERSEDGE_API_KEY not configured." }),
    };
  }

  const sportParam = ((event.queryStringParameters || {}).sport || "").toLowerCase();

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
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ supported: false, sport: sportParam, events: [] }),
    };
  }

  try {
    const upstreamUrl = `https://puntersedge.online/api/v1/best-odds/${peSportKey}`;

    const resp = await fetch(upstreamUrl, {
      headers: { "X-API-Key": apiKey },
    });

    const rawText = await resp.text();

    if (!resp.ok) {
      return {
        statusCode: resp.status,
        body: JSON.stringify({
          error: "Upstream PuntersEdge error",
          upstreamStatus: resp.status,
          upstreamBody: rawText.slice(0, 800),
        }),
      };
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "Failed to parse upstream JSON", raw: rawText.slice(0, 800) }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ supported: true, sport: sportParam, raw: data }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
