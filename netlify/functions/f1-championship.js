// netlify/functions/f1-championship.js
// F1 season Drivers' Championship standings + the top-3 podium for every
// race this season. Sourced from Jolpica-F1 (api.jolpi.ca) — the actively
// maintained, free, open-source successor to the Ergast API, which shut
// down at the end of 2024. Same team, same backwards-compatible schema.
// Verified against live responses before building this (2026-08-07).

exports.handler = async function () {
  try {
    const [standingsRes, resultsRes] = await Promise.all([
      fetch("https://api.jolpi.ca/ergast/f1/current/driverstandings.json"),
      fetch("https://api.jolpi.ca/ergast/f1/current/results.json?limit=500"),
    ]);

    if (!standingsRes.ok || !resultsRes.ok) {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "Jolpica returned an error" }),
      };
    }

    const standingsData = await standingsRes.json();
    const resultsData = await resultsRes.json();

    const standingsList = (standingsData.MRData.StandingsTable.StandingsLists || [])[0];
    const standings = standingsList
      ? standingsList.DriverStandings.map((d) => ({
          position: parseInt(d.position, 10),
          points: d.points,
          wins: d.wins,
          name: `${d.Driver.givenName} ${d.Driver.familyName}`,
          constructor: d.Constructors && d.Constructors[0] ? d.Constructors[0].name : null,
        }))
      : [];

    const races = resultsData.MRData.RaceTable.Races || [];
    const podiums = races
      .map((race) => ({
        round: parseInt(race.round, 10),
        raceName: race.raceName,
        date: race.date,
        podium: (race.Results || [])
          .filter((r) => parseInt(r.position, 10) <= 3)
          .sort((a, b) => parseInt(a.position, 10) - parseInt(b.position, 10))
          .map((r) => ({
            position: parseInt(r.position, 10),
            name: `${r.Driver.givenName} ${r.Driver.familyName}`,
            constructor: r.Constructor ? r.Constructor.name : null,
          })),
      }))
      .sort((a, b) => b.round - a.round); // most recent race first

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        season: standingsData.MRData.StandingsTable.season || null,
        standings,
        podiums,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
