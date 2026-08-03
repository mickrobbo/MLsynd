// netlify/functions/puntersedge-prices.js
// Fetches live AU racing prices from PuntersEdge and returns a cleaned,
// AU-only, best-price-first payload for the dashboard's Racing tab.

exports.handler = async function (event) {
  const apiKey = process.env.PUNTERSEDGE_API_KEY;

  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "PUNTERSEDGE_API_KEY not configured." }),
    };
  }

  try {
    const upstreamUrl =
      "https://puntersedge.online/v1/racing/next-to-go?categories=horse";

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
          upstreamBody: rawText.slice(0, 500),
        }),
      };
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "Failed to parse upstream JSON" }),
      };
    }

    const races = Array.isArray(data) ? data : data.races || [];

    // AU only
    const auRaces = races.filter((r) => r.country === "AU");

    // Clean up each race: for every runner, find the best (highest) win
    // price across bookmakers, and the best place price too.
    const cleaned = auRaces.map((race) => {
      const runners = (race.runners || []).map((runner) => {
        const bookmakers = runner.bookmakers || [];

        let bestWin = null;
        let bestWinBookmaker = null;
        let bestPlace = null;
        let bestPlaceBookmaker = null;

        for (const bm of bookmakers) {
          if (typeof bm.win_price === "number") {
            if (bestWin === null || bm.win_price > bestWin) {
              bestWin = bm.win_price;
              bestWinBookmaker = bm.key;
            }
          }
          if (typeof bm.place_price === "number") {
            if (bestPlace === null || bm.place_price > bestPlace) {
              bestPlace = bm.place_price;
              bestPlaceBookmaker = bm.key;
            }
          }
        }

        return {
          name: runner.name,
          number: runner.number,
          best_win_price: bestWin,
          best_win_bookmaker: bestWinBookmaker,
          best_place_price: bestPlace,
          best_place_bookmaker: bestPlaceBookmaker,
          bookmaker_count: bookmakers.length,
        };
      });

      return {
        race_id: race.race_id,
        venue: race.venue,
        race_number: race.race_number,
        start_time: race.start_time,
        runners,
      };
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ races: cleaned, count: cleaned.length }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
