// Fetches live/recent scores from ESPN's public (unofficial, undocumented) scoreboard
// endpoints. No API key required. These endpoints aren't officially published or
// supported by ESPN, so keep polling gentle and add error handling — they can change
// or go down without notice.

const ESPN_ENDPOINTS = {
  nrl: 'https://site.api.espn.com/apis/site/v2/sports/rugby-league/3/scoreboard',
  nfl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
  nba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
  mlb: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
  nhl: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard',
  epl: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard'
};

exports.handler = async (event) => {
  const sport = ((event.queryStringParameters && event.queryStringParameters.sport) || '').toLowerCase();
  const url = ESPN_ENDPOINTS[sport];

  if (!url) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `Unknown or unsupported sport: "${sport}"` })
    };
  }

  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'MLSynd Ledger (private syndicate app)' } });
    if (!res.ok) throw new Error(`ESPN responded ${res.status}`);
    const data = await res.json();

    const games = (data.events || []).map(ev => {
      const comp = (ev.competitions && ev.competitions[0]) || {};
      const competitors = comp.competitors || [];
      const home = competitors.find(c => c.homeAway === 'home') || {};
      const away = competitors.find(c => c.homeAway === 'away') || {};
      const statusType = (ev.status && ev.status.type) || {};

      return {
        hteam: (home.team && (home.team.shortDisplayName || home.team.displayName)) || 'TBC',
        hscore: home.score !== undefined ? home.score : null,
        ateam: (away.team && (away.team.shortDisplayName || away.team.displayName)) || 'TBC',
        ascore: away.score !== undefined ? away.score : null,
        venue: (comp.venue && comp.venue.fullName) || '',
        complete: statusType.completed ? 100 : (statusType.state === 'in' ? 50 : 0),
        live: statusType.state === 'in',
        timestr: statusType.shortDetail || statusType.detail || statusType.description || ''
      };
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ games })
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Could not reach ESPN: ' + err.message })
    };
  }
};
