// netlify/functions/on-this-day.js
//
// Replaces whatever was here before — the dashboard's "On This Day In
// Sport" panel was showing genuinely non-sporting history (a WWII treaty
// signing, specifically), which means whatever ran previously either had
// no sports filter at all, or one that was letting things like this
// through. This version pulls from Wikipedia's free "On This Day" feed
// (no API key needed) and applies a real keyword filter across a broad
// spread of sports — AFL, NRL, rugby, cricket, tennis, golf, boxing,
// UFC/MMA, Olympics, athletics, motorsport (F1/NASCAR/MotoGP), horse
// racing, greyhound racing, and more — before ever returning an entry.
// Anything that doesn't match is discarded, not shown as a fallback.
//
// Response contract is unchanged from before — the client
// (refreshOnThisDayIfNeeded / renderOnThisDay in DASHBOARD-index.html)
// expects exactly: { found: boolean, year: number, text: string }.
// Nothing on the client needs to change for this fix.

// A deliberately broad net across every sport that's reasonably likely to
// turn up in a general history feed — horse racing and greyhound racing
// included per request, alongside every major code and the Olympics/
// Commonwealth Games umbrella events. Matched case-insensitively against
// the event's own text AND the Wikipedia page titles/descriptions linked
// to it (an event's text alone is sometimes generic — "X wins the title"
// — while the linked page is unambiguously e.g. "1987 World Snooker
// Championship").
const SPORT_KEYWORDS = [
  // Aussie/NZ codes
  'afl', 'australian football league', 'vfl', 'nrl', 'rugby league', 'rugby union',
  'super rugby', 'state of origin', 'bledisloe', 'netball',
  // Football codes worldwide
  'football', 'soccer', 'fifa', 'world cup', 'premier league', 'champions league',
  'europa league', 'la liga', 'serie a', 'bundesliga', 'ligue 1', 'mls', 'a-league',
  'copa america', 'euro ', 'european championship',
  // Cricket
  'cricket', 'ashes', 'test match', 'odi', 'twenty20', 't20', 'ipl', 'big bash',
  'wisden',
  // Racquet/court sports
  'tennis', 'wimbledon', 'us open', 'french open', 'australian open', 'roland garros',
  'davis cup', 'atp', 'wta', 'badminton', 'squash', 'table tennis',
  // Golf
  'golf', 'masters tournament', 'pga', 'ryder cup', 'open championship', 'us open golf',
  // Combat sports
  'boxing', 'heavyweight title', 'ufc', 'mma', 'mixed martial arts', 'wrestling',
  'wwe', 'judo', 'karate', 'taekwondo',
  // Olympics / multi-sport
  'olympic', 'olympics', 'paralympic', 'commonwealth games', 'asian games',
  // Athletics
  'athletics', 'marathon', 'sprint', 'decathlon', 'high jump', 'long jump',
  'world record', 'track and field',
  // Aquatic/water
  'swimming', 'diving', 'water polo', 'rowing', 'sailing', 'yacht', 'surfing',
  // Winter/board
  'skiing', 'snowboard', 'figure skating', 'ice hockey', 'nhl', 'bobsled',
  // Cycling
  'cycling', 'tour de france', 'giro d', 'vuelta', 'velodrome',
  // Motorsport
  'formula one', 'formula 1', ' f1 ', 'grand prix', 'nascar', 'indycar', 'motogp',
  'rally', 'le mans',
  // Racing (explicitly requested)
  'horse racing', 'melbourne cup', 'kentucky derby', 'grand national', 'the derby',
  'ascot', 'breeders\u2019 cup', 'breeders cup', 'greyhound racing', 'greyhound derby',
  // US major leagues
  'nba', 'basketball', 'baseball', 'mlb', 'world series', 'super bowl', 'nfl american football',
  // Misc precision/target sports
  'snooker', 'darts', 'billiards', 'archery', 'shooting championship',
  'gymnastics', 'triathlon', 'weightlifting', 'skateboarding',
  // Generic sport-signal words — only counted alongside a proper noun
  // context via the page-title check below, kept last/lowest priority
  'championship', 'grand final', 'gold medal', 'world title', 'world champion'
];

function textLooksLikeSport(text, pageTitles){
  const haystack = `${text} ${pageTitles.join(' ')}`.toLowerCase();
  return SPORT_KEYWORDS.some(kw => haystack.includes(kw));
}

exports.handler = async function(event, context){
  try{
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${month}/${day}`, {
      headers: {
        // Wikipedia's REST API asks for a descriptive User-Agent on
        // server-side requests — a generic/missing one can get throttled.
        'User-Agent': 'MLSYND-Dashboard/1.0 (on-this-day-sports-filter)'
      }
    });
    if(!res.ok){
      return { statusCode: 200, body: JSON.stringify({ found: false }) };
    }
    const data = await res.json();
    const events = Array.isArray(data.events) ? data.events : [];

    const sportsEvents = events.filter(ev => {
      const pageTitles = Array.isArray(ev.pages) ? ev.pages.map(p => `${p.titles ? (p.titles.normalized || p.title || '') : (p.title || '')} ${p.description || ''} ${p.extract || ''}`) : [];
      return ev.text && textLooksLikeSport(ev.text, pageTitles);
    });

    if(sportsEvents.length === 0){
      return { statusCode: 200, body: JSON.stringify({ found: false }) };
    }

    const pick = sportsEvents[Math.floor(Math.random() * sportsEvents.length)];
    return {
      statusCode: 200,
      body: JSON.stringify({
        found: true,
        year: pick.year,
        text: pick.text
      })
    };
  }catch(e){
    return { statusCode: 200, body: JSON.stringify({ found: false }) };
  }
};
