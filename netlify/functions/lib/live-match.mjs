// lib/live-match.mjs (v225)
// Pure helpers for live legs: match a multi leg to a real game, then say how
// that leg is travelling from the score. No network or database here, so the
// rules can be tested on their own (tests/live-match.test.mjs).
//
// A leg looks like the picks the slip reader stores:
//   { sel, market, event, sport, team, kind }
// A game is normalised to:
//   { id, league, home, away, homeNames[], awayNames[], hs, as, state, clock, start }
//   state: 'pre' | 'live' | 'final'

// Nicknames and short names people and bookies use, keyed by the name the
// score feeds use. Anything not listed still matches on its own name.
const ALIASES = {
  // AFL (Squiggle names)
  'adelaide': ['crows'], 'brisbane lions': ['brisbane', 'lions'], 'carlton': ['blues'], 'collingwood': ['magpies', 'pies'],
  'essendon': ['bombers', 'dons'], 'fremantle': ['dockers', 'freo'], 'geelong': ['cats'], 'gold coast': ['suns'],
  'greater western sydney': ['gws', 'giants', 'gws giants'], 'hawthorn': ['hawks'], 'melbourne': ['demons', 'dees'],
  'north melbourne': ['kangaroos', 'roos'], 'port adelaide': ['power', 'port'], 'richmond': ['tigers'], 'st kilda': ['saints'],
  'sydney': ['swans'], 'west coast': ['eagles'], 'western bulldogs': ['bulldogs', 'dogs'],
};

export const norm = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9+.\- ]/g, ' ').replace(/\s+/g, ' ').trim();

// Every name a side can be called, longest first
export function namesFor(...raw){
  const out = new Set();
  for(const r of raw){
    const n = norm(r); if(!n) continue;
    out.add(n);
    (ALIASES[n] || []).forEach(a => out.add(a));
  }
  // (ESPN sides are passed in with their full name, short name, nickname
  // and place, e.g. "Penrith Panthers", "Panthers", "Penrith", so words are
  // never split here: splitting would make "Manchester" match both clubs)
  return [...out].filter(x => x.length >= 3).sort((a, b) => b.length - a.length);
}

// Where in `text` a side is named (index of the longest name found), or -1.
// Longest names first, and whole words only, so "North Melbourne" never
// counts as "Melbourne".
const wordRe = (name) => new RegExp(`(^|[^a-z])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z])`, 'g');
// longer club names that contain a shorter one ("north melbourne" holds
// "melbourne", "port adelaide" holds "adelaide")
const LONGER = (name) => Object.keys(ALIASES).filter(k => k !== name && k.length > name.length && wordRe(name).test(k));
function findName(text, names){
  for(const name of names){
    let t = text;
    for(const longer of LONGER(name)) t = t.replace(wordRe(longer), (m) => ' '.repeat(m.length));
    const m = wordRe(name).exec(t);
    if(m) return { at: m.index, len: name.length };
  }
  return null;
}

// Which side of `game` the leg is about: 'home', 'away', null (both teams
// named but no side, e.g. a total), or undefined (not this game).
export function sideOf(leg, game){
  const ev = norm(leg.event);
  const team = norm(leg.team);
  const sel = norm(leg.sel);
  const hEv = findName(ev, game.homeNames), aEv = findName(ev, game.awayNames);
  const hT = findName(team || sel, game.homeNames), aT = findName(team || sel, game.awayNames);
  const eventMatches = hEv && aEv;
  if(!eventMatches && !(hT || aT)) return undefined;
  // with only a team to go on, make sure it isn't a bare word like "power"
  // that happens to sit inside an unrelated selection
  if(!eventMatches && !(team && (hT || aT))){
    const h = findName(sel, game.homeNames), a = findName(sel, game.awayNames);
    if(!(h && a) && !(h && h.len >= 5) && !(a && a.len >= 5)) return undefined;
  }
  if(hT && aT){ return hT.len === aT.len ? (hT.at < aT.at ? 'home' : 'away') : (hT.len > aT.len ? 'home' : 'away'); }
  if(hT) return 'home';
  if(aT) return 'away';
  return eventMatches ? null : undefined;
}

// Pick the game this leg belongs to: right league, a side named, and the
// one closest to now if the same teams play twice in the window.
export function matchLeg(leg, games, now = Date.now()){
  let best = null;
  for(const g of games){
    if(leg.league && g.league !== leg.league) continue;
    const side = sideOf(leg, g);
    if(side === undefined) continue;
    const dist = Math.abs((g.start || now) - now);
    if(!best || dist < best.dist) best = { game: g, side, dist };
  }
  return best ? { game: best.game, side: best.side } : null;
}

// League for a leg, from the slip reader's sport (or a guess from names)
export function leagueOf(leg){
  const s = norm(leg.sport);
  if(/afl|aussie rules|australian rules/.test(s)) return 'afl';
  if(/nrl|rugby league/.test(s)) return 'nrl';
  if(/american football|nfl/.test(s)) return 'nfl';
  if(/basketball|nba/.test(s)) return 'nba';
  if(/baseball|mlb/.test(s)) return 'mlb';
  if(/hockey|nhl/.test(s)) return 'nhl';
  if(/soccer|epl|premier league/.test(s)) return 'epl';
  if(s) return null; // racing, tennis, cricket... not tracked live
  const t = norm([leg.sel, leg.event, leg.team, leg.market].join(' '));
  if(/disposals|afl|goals? kicked/.test(t) || Object.keys(ALIASES).some(k => t.includes(k))) return 'afl';
  return null;
}

const KIND_RE = {
  total: /\b(over|under)\b\s*(\d+(\.\d+)?)/,
  line: /([+-]\d+(\.\d+)?)\s*$|([+-]\d+(\.\d+)?)\b/,
};
export function kindOf(leg){
  if(leg.kind) return leg.kind;
  const t = norm([leg.sel, leg.market].join(' '));
  if(/head to head|h2h|to win|match result|money ?line/.test(t)) return 'head_to_head';
  if(KIND_RE.total.test(t)) return 'total';
  if(/line|handicap|margin/.test(t) || /[+-]\d+(\.\d)?\b/.test(norm(leg.sel))) return 'line';
  return 'other';
}

// How the leg stands right now.
//   verdict: 'winning' | 'losing' | 'level' | null (can't tell from a score)
//   suggest: 'Win' | 'Loss' | null    only once it's settled for sure
//   note:    short words for the card, e.g. "+12.5 line · ahead by 4 with it"
export function judge(leg, game, side){
  const out = { verdict: null, suggest: null, note: '' };
  if(!game || game.state === 'pre' || game.hs == null || game.as == null) return out;
  const hs = Number(game.hs), as = Number(game.as);
  if(!Number.isFinite(hs) || !Number.isFinite(as)) return out;
  const final = game.state === 'final';
  const kind = kindOf(leg);
  const mine = side === 'home' ? hs : as, theirs = side === 'home' ? as : hs;
  const verdictOf = (d) => d > 0 ? 'winning' : d < 0 ? 'losing' : 'level';

  if(kind === 'head_to_head' && side){
    const d = mine - theirs;
    out.verdict = verdictOf(d);
    out.note = d === 0 ? 'Scores level' : `${d > 0 ? 'Up' : 'Down'} by ${Math.abs(d)}`;
    if(final && d !== 0) out.suggest = d > 0 ? 'Win' : 'Loss';
    return out;
  }
  if(kind === 'line' && side){
    const m = norm(leg.sel).match(/([+-]\d+(\.\d+)?)/) || norm(leg.market).match(/([+-]\d+(\.\d+)?)/);
    if(!m) return out;
    const line = Number(m[1]);
    const d = mine + line - theirs;
    out.verdict = verdictOf(d);
    out.note = `${d > 0 ? 'Covering' : d < 0 ? 'Short' : 'Level'} with the ${m[1]}${d ? ` by ${+Math.abs(d).toFixed(1)}` : ''}`;
    if(final && d !== 0) out.suggest = d > 0 ? 'Win' : 'Loss';
    return out;
  }
  if(kind === 'total'){
    const m = norm([leg.sel, leg.market].join(' ')).match(KIND_RE.total);
    if(!m) return out;
    const over = m[1] === 'over', mark = Number(m[2]), tot = hs + as;
    const d = over ? tot - mark : mark - tot;
    out.verdict = verdictOf(d);
    out.note = `${tot} scored, ${over ? 'over' : 'under'} ${mark}`;
    // an over is home the moment it's passed; an under is gone the same way
    if(tot > mark) out.suggest = over ? 'Win' : 'Loss';
    else if(final && tot !== mark) out.suggest = over ? 'Loss' : 'Win';
    return out;
  }
  return out;
}
