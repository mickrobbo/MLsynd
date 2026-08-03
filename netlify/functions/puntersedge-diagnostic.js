// TEMPORARY DIAGNOSTIC — probes PuntersEdge's racing next-to-go endpoint to confirm
// the real response shape before wiring live prices into the racing tab properly.

exports.handler = async () => {
  const apiKey = process.env.PUNTERSEDGE_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'PUNTERSEDGE_API_KEY not configured.' }) };
  }

  const url = 'https://puntersedge.online/api/v1/racing/next-to-go?categories=horse';

  try {
    const res = await fetch(url, { headers: { 'X-API-Key': apiKey } });
    const text = await res.text();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upstreamStatus: res.status, upstreamBody: text.slice(0, 3000) })
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
