// Fetches AFL scores server-side (never from the visitor's browser), per Squiggle API's terms.
// IMPORTANT: replace the email below with a real contact address before deploying —
// Squiggle requires a UserAgent with contact info and may block requests without one.
const USER_AGENT = 'MLSynd Dashboard - contact: your-email@example.com';

exports.handler = async function () {
  try {
    const year = new Date().getFullYear();
    const headers = { 'User-Agent': USER_AGENT };

    // First, try games currently in progress.
    let res = await fetch(`https://api.squiggle.com.au/?q=games;year=${year};live=1`, { headers });
    let games = [];
    if (res.ok) {
      const data = await res.json();
      games = data.games || [];
    }

    // If nothing's live, fall back to the most recent/upcoming games this round.
    if (games.length === 0) {
      const res2 = await fetch(`https://api.squiggle.com.au/?q=games;year=${year};complete=!100`, { headers });
      if (res2.ok) {
        const data2 = await res2.json();
        games = (data2.games || []).slice(0, 9);
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=45' // gentle caching — Squiggle asks callers not to hammer them
      },
      body: JSON.stringify({ games, fetchedAt: Date.now() })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message })
    };
  }
};
