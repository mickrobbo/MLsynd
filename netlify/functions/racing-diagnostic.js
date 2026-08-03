// TEMPORARY DIAGNOSTIC FUNCTION — not the final racing feature.
// Just proxies FormFav's meetings endpoint so we can see the real response shape
// before building the actual normalizer. Delete/replace once that's done.

exports.handler = async () => {
  const apiKey = process.env.FORMFAV_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'FORMFAV_API_KEY not configured.' }) };
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const url = `https://api.formfav.com/v1/form/meetings?country=AU&date=${today}`;

  try {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    const text = await res.text();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestedUrl: url,
        upstreamStatus: res.status,
        upstreamBody: text
      })
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
