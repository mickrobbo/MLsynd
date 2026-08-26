// netlify/functions/on-this-day.mjs
//
// Migrated to the modern Netlify Functions format (ES Modules, Request/
// Response) — this was the one function blocking the last several
// deploys, since new (never-before-deployed) functions are the ones that
// actually get checked against AWS Lambda's 4KB environment-variable
// ceiling on classic Lambda compatibility mode. Every other function in
// the repo stays on the legacy format for now (Netlify supports both
// side by side), migrated one at a time rather than all at once.
//
// .mjs extension (not .js) is required — ES Module syntax like the
// `export default` below isn't valid in a plain .js file unless the
// whole project's package.json sets "type": "module", which would touch
// every other still-CommonJS function. Renaming just this file avoids
// that entirely.
//
// Response contract is unchanged: { found: boolean, year, text } — the
// client (renderOnThisDay in DASHBOARD-index.html) doesn't need to
// change for this.

// Melbourne-local "today", not the server's UTC day — the app's audience
// is Melbourne-based, and the date should match what the room is
// actually experiencing.
function getMelbourneMonthDay(){
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Australia/Melbourne', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  return {
    month: parts.find(p => p.type === 'month').value,
    day: parts.find(p => p.type === 'day').value
  };
}

// A deliberately broad net across every sport reasonably likely to turn
// up in a general history feed — horse racing and greyhound racing
// included by name, alongside every major code and the Olympics/
// Commonwealth Games umbrella events. Deliberately avoids bare, generic
// single words like "race", "match", "team", "coach", "title", or
// "stadium" — tested and confirmed those false-positive on real
// non-sport history ("the Space Race", "the Arms Race", a political
// "coach", an election "race", a bombed "stadium"), which is exactly
// the class of bug this function exists to fix, not reintroduce.
const SPORT_KEYWORDS = [
  // Aussie/NZ codes
  'afl', 'australian football league', 'vfl', 'nrl', 'rugby league', 'rugby union',
  'super rugby', 'state of origin', 'bledisloe', 'netball',
  // Football codes worldwide
  'football', 'soccer', 'fifa', 'uefa', 'world cup', 'premier league', 'champions league',
  'europa league', 'la liga', 'serie a', 'bundesliga', 'ligue 1', 'mls', 'a-league',
  'copa america', 'european championship',
  // Cricket
  'cricket', 'ashes', 'test match', ' odi ', 'twenty20', 't20', 'ipl', 'big bash', 'wisden',
  // Racquet/court sports
  'tennis', 'wimbledon', 'us open tennis', 'french open', 'australian open tennis',
  'roland garros', 'davis cup', 'atp tour', 'wta tour', 'badminton', 'squash', 'table tennis',
  // Golf
  'golf', 'masters tournament', 'pga tour', 'ryder cup', 'open championship',
  // Combat sports
  'boxing', 'heavyweight title', 'ufc', 'mixed martial arts', 'wrestling', 'wwe',
  'judo', 'karate', 'taekwondo',
  // Olympics / multi-sport
  'olympic', 'olympics', 'paralympic', 'commonwealth games', 'asian games',
  // Athletics
  'athletics', 'marathon', 'decathlon', 'high jump', 'long jump', 'track and field',
  // Aquatic/water
  'swimming', 'diving championship', 'water polo', 'rowing', 'sailing race', 'surfing',
  // Winter/board
  'skiing', 'snowboard', 'figure skating', 'ice hockey', 'nhl', 'bobsled',
  // Cycling
  'cycling', 'tour de france', 'giro d', 'vuelta a espana',
  // Motorsport
  'formula one', 'formula 1', 'grand prix', 'nascar', 'indycar', 'motogp', 'le mans',
  // Racing (explicitly requested)
  'horse racing', 'melbourne cup', 'kentucky derby', 'grand national', 'the derby stakes',
  'ascot', 'breeders\u2019 cup', 'breeders cup', 'greyhound racing', 'greyhound derby',
  // US major leagues
  'nba', 'basketball', 'baseball', 'mlb', 'world series', 'super bowl',
  // Misc precision/target sports
  'snooker', 'darts championship', 'billiards', 'gymnastics', 'triathlon', 'weightlifting'
];
function looksSporty(text){
  const t = text.toLowerCase();
  return SPORT_KEYWORDS.some(k => t.includes(k));
}

export default async () => {
  try{
    const { month, day } = getMelbourneMonthDay();
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
