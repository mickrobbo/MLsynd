// netlify/functions/motogp.js
// MotoGP standings + most recent race's podium. ESPN doesn't cover MotoGP at
// all (their own racing page only lists NASCAR, F1, and IndyCar), so this
// uses MotoGP's own API instead — unofficial/reverse-engineered (not
// affiliated with MotoGP or Dorna), but genuinely documented and working,
// same category of source as Jolpica-F1. Base: api.motogp.pulselive.com
//
// Needs a few chained lookups since standings/results are keyed by UUID,
// not a simple "current season" shortcut like Jolpica has:
//   1. /results/seasons -> find the current season's UUID
//   2. /results/categories?seasonUuid=... -> find the "MotoGP" category UUID
//      (as opposed to Moto2/Moto3/MotoE, which also run this endpoint)
//   3. /results/standings?seasonUuid=...&categoryUuid=... -> championship table
//   4. /results/events?seasonUuid=...&isFinished=true -> most recent finished
//      event, then /results/sessions for that event to find the Race session,
//      then /results/session/{id}/classification for the podium

const BASE = "https://api.motogp.pulselive.com/motogp/v1";

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MotoGP API returned ${res.status} for ${url}`);
  return res.json();
}

exports.handler = async function () {
  try {
    const seasons = await getJson(`${BASE}/results/seasons`);
    const current = seasons.find((s) => s.current) || seasons[0];
    if (!current) {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ standings: [], podium: null }) };
    }
    const seasonUuid = current.id;

    const categories = await getJson(`${BASE}/results/categories?seasonUuid=${seasonUuid}`);
    const motogpCategory = categories.find((c) => c.name && c.name.replace(/[™\s]/g, "").toLowerCase() === "motogp") || categories[0];
    const categoryUuid = motogpCategory ? motogpCategory.id : null;

    let standings = [];
    if (categoryUuid) {
      const standingsData = await getJson(`${BASE}/results/standings?seasonUuid=${seasonUuid}&categoryUuid=${categoryUuid}`);
      standings = (standingsData.classification || []).map((r) => ({
        position: r.position,
        name: r.rider ? r.rider.full_name : "",
        team: r.team ? r.team.name : null,
        constructor: r.constructor ? r.constructor.name : null,
        points: r.points,
      }));
    }

    // Most recent finished event's Race session, for the podium
    let podium = null;
    let eventName = null;
    if (categoryUuid) {
      const events = await getJson(`${BASE}/results/events?seasonUuid=${seasonUuid}&isFinished=true`);
      if (events.length > 0) {
        const lastEvent = events[events.length - 1];
        eventName = lastEvent.name || lastEvent.sponsored_name || null;
        const sessions = await getJson(`${BASE}/results/sessions?eventUuid=${lastEvent.id}&categoryUuid=${categoryUuid}`);
        const raceSession = sessions.find((s) => s.type === "RAC");
        if (raceSession) {
          const classification = await getJson(`${BASE}/results/session/${raceSession.id}/classification`);
          podium = (classification.classification || [])
            .filter((r) => r.position <= 3)
            .sort((a, b) => a.position - b.position)
            .map((r) => ({
              position: r.position,
              name: r.rider ? r.rider.full_name : "",
              team: r.team ? r.team.name : null,
            }));
        }
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        season: current.year,
        standings,
        eventName,
        podium,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
