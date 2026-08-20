// Returns { found: boolean, year, text } — matches exactly what
// DASHBOARD-index.html's renderOnThisDay() already expects, so this is a
// drop-in replacement with no client-side changes needed.
//
// Source: Wikipedia's official "On this day" REST API (no key needed).
// Docs: https://api.wikimedia.org/wiki/Feed_API/Reference/On_this_day
//
// Filters the day's events down to ones that actually look sport-related
// (keyword match against the event text/pages), then picks one — biased
// towards more "outrageous"/notable-sounding ones where possible (longer,
// more detailed entries tend to be the more significant events) rather
// than just taking the first match. If nothing sport-related turns up for
// today, returns found:false — the client already handles that
// gracefully ("Nothing suitably outrageous found for today").

const SPORT_KEYWORDS = [
  'olympic', 'championship', 'world cup', 'final', 'grand final', 'grand prix',
  'afl', 'nrl', 'cricket', 'rugby', 'football', 'soccer', 'tennis', 'golf',
  'boxing', 'wrestl', 'athlet', 'marathon', 'race', 'racing', 'derby',
  'basketball', 'baseball', 'hockey', 'swim', 'gymnast', 'medal', 'title',
  'league', 'tournament', 'match', 'stadium', 'coach', 'player', 'team',
  'nba', 'nfl', 'mlb', 'nhl', 'fifa', 'uefa', 'wimbledon', 'ashes', 'formula one', 'f1',
  'super bowl', 'ufc', 'motogp', 'cycling', 'tour de france'
];

function looksSporty(text){
  const t = text.toLowerCase();
  return SPORT_KEYWORDS.some(k => t.includes(k));
}

export default async () => {
  try{
    // AEST-based "today" — the app is Melbourne-based, and the date should
    // match what the room is actually experiencing, not the server's UTC day.
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Melbourne', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const month = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;

    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${month}/${day}`, {
      headers: { 'User-Agent': 'MLSynd-Dashboard/1.0 (private syndicate app)' }
    });
    if(!res.ok){
      return new Response(JSON.stringify({ found: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const data = await res.json();
    const events = Array.isArray(data.events) ? data.events : [];
    const sporty = events.filter(e => e && e.text && looksSporty(e.text));
    if(sporty.length === 0){
      return new Response(JSON.stringify({ found: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // Prefer longer/more detailed entries — a reasonable, cheap proxy for
    // "more interesting" without needing any actual notability scoring.
    sporty.sort((a, b) => b.text.length - a.text.length);
    const pick = sporty[0];
    return new Response(JSON.stringify({ found: true, year: pick.year, text: pick.text }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }catch(e){
    console.error('on-this-day failed:', e);
    return new Response(JSON.stringify({ found: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
};
