// TEMPORARY DIAGNOSTIC — probes FormFav's race form/runners endpoint for one specific
// race so we can see the real response shape and required params before building the
// actual "favourites + form" feature. Delete once that's done.

exports.handler = async () => {
  const apiKey = process.env.FORMFAV_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'FORMFAV_API_KEY not configured.' }) };
  }

  // Using a real race from today's confirmed AU meetings list: Darwin, race 1.
  const today = new Date().toISOString().slice(0, 10);
  const attempts = [
    `https://api.formfav.com/v1/form?track=darwin&race=1&date=${today}&country=au`,
    `https://api.formfav.com/v1/form?track=darwin&race=1&date=${today}`,
    `https://api.formfav.com/v1/form?track=darwin&race=1`
  ];

  const results = [];
  for (const url of attempts) {
    try {
      const res = await fetch(url, { headers: { 'X-API-Key': apiKey } });
      const text = await res.text();
      results.push({ url, status: res.status, body: text.slice(0, 1500) });
    } catch (err) {
      results.push({ url, error: err.message });
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2)
  };
};
