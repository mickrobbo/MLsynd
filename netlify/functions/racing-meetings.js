// Fetches today's Australian thoroughbred race meetings from FormFav.
// Note: FormFav's country param doesn't reliably filter server-side, so we filter
// for country === 'au' ourselves after fetching.

// Uses actual Australian date rather than UTC — otherwise, during AU morning and
// early afternoon, the UTC date is still "yesterday" and this pulls the wrong day.
function todayAU(){
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

exports.handler = async (event) => {
  const apiKey = process.env.FORMFAV_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'FORMFAV_API_KEY not configured.' }) };
  }

  const requestedDate = (event.queryStringParameters || {}).date;
  const date = requestedDate || todayAU();
  const url = `https://api.formfav.com/v1/form/meetings?country=AU&date=${date}`;

  try {
    const res = await fetch(url, { headers: { 'X-API-Key': apiKey } });
    if (!res.ok) throw new Error(`FormFav responded ${res.status}`);
    const data = await res.json();

    const auMeetings = (data.meetings || [])
      .filter(m => m.country === 'au')
      .map(m => ({
        track: m.track,
        slug: m.slug,
        abandoned: m.abandoned,
        races: (m.races || []).map(r => ({
          raceNumber: r.raceNumber,
          raceName: r.raceName,
          distance: r.distance,
          raceClass: r.raceClass,
          condition: r.condition,
          weather: r.weather,
          startTime: r.startTime,
          timezone: r.timezone,
          prizeMoney: r.prizeMoney,
          numberOfRunners: r.numberOfRunners
        }))
      }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, meetings: auMeetings })
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
