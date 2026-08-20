// Fetches today's Australian thoroughbred race meetings from FormFav.
// Note: FormFav's country param doesn't reliably filter server-side, so we filter
// for country === 'au' ourselves after fetching.

// Uses actual Australian date rather than UTC — otherwise, during AU morning and
// early afternoon, the UTC date is still "yesterday" and this pulls the wrong day.
function todayAU() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

export default async function (request) {
  const apiKey = process.env.FORMFAV_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'FORMFAV_API_KEY not configured.' }), {
      status: 500,
    });
  }

  const url = new URL(request.url);
  const requestedDate = url.searchParams.get("date");
  const date = requestedDate || todayAU();
  const apiUrl = `https://api.formfav.com/v1/form/meetings?country=AU&date=${date}`;

  try {
    const res = await fetch(apiUrl, { headers: { 'X-API-Key': apiKey } });
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

    return new Response(JSON.stringify({ date, meetings: auMeetings }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
    });
  }
}
