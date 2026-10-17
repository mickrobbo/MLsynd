// bet-facts.js (v216)
// A quick fact about what was backed, shown when a bet is opened on Home:
//   AFL                → ladder position and record (Squiggle, via afl-ladder)
//   NRL, NFL, NBA, MLB,
//   NHL, EPL, EFL      → standings position and record (ESPN, via espn-standings)
//   Horse racing       → the runner's barrier, jockey, recent form and career
//                        record (FormFav, via racing-race-form)
// Uses the same Netlify functions as the Sport tab. Answers are cached for
// the visit (and race form for the day) so opening bets doesn't cost calls.
(function(){
  'use strict';
  const mem = {};
  const LS = {
    get(k){ try{ const v = JSON.parse(localStorage.getItem(k)); return v && v.exp > Date.now() ? v.val : null; }catch(e){ return null; } },
    set(k, val, ms){ try{ localStorage.setItem(k, JSON.stringify({ val, exp: Date.now() + ms })); }catch(e){} },
  };
  const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const ord = (n) => { n = Number(n); const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
  async function getJson(url, cacheMs){
    if(mem[url]) return mem[url];
    const cached = cacheMs ? LS.get('bf:' + url) : null;
    if(cached) return (mem[url] = Promise.resolve(cached));
    mem[url] = fetch(url).then(r => r.ok ? r.json() : null).then(d => { if(d && cacheMs && !d.error) LS.set('bf:' + url, d, cacheMs); return d; }).catch(() => null);
    return mem[url];
  }

  // ---------- teams on a ladder ----------
  // a ladder name matches if its last word (nickname or city) or whole name
  // appears in what was backed, e.g. "Jacksonville Jaguars" ← "Jaguars"
  function findTeam(ladder, text){
    const t = ' ' + norm(text) + ' ';
    let best = null, bestLen = 0;
    (ladder || []).forEach(row => {
      const n = norm(row.name); if(!n) return;
      const words = n.split(' ');
      const keys = [n, words[words.length - 1], words[0], words.length > 2 ? words.slice(0, 2).join(' ') : null].filter(k => k && k.length >= 4);
      keys.forEach(k => { if(t.includes(' ' + k + ' ') && k.length > bestLen){ best = row; bestLen = k.length; } });
    });
    return best;
  }
  function teamsInEvent(event){
    return String(event || '').split(/\s+(?:v|vs|versus|@)\.?\s+/i).map(s => s.trim()).filter(Boolean);
  }
  function record(row){
    const w = Number(row.wins) || 0, l = Number(row.losses) || 0, d = Number(row.draws) || 0;
    return `${w}–${l}${d ? '–' + d : ''}`;
  }
  async function ladderFact(sport, pick){
    let ladder = null;
    const label = sport === 'AFL' || sport === 'NRL' ? 'on the ladder' : sport === 'Soccer' ? 'in the table' : 'in the standings';
    if(sport === 'AFL'){
      if(/\(w\)|aflw|women/i.test([pick.sel, pick.event, pick.market].join(' '))) return null; // AFLW isn't on this ladder
      const d = await getJson('/.netlify/functions/afl-ladder', 6 * 3600e3); ladder = d && d.ladder;
    } else {
      const key = { NRL: ['nrl'], 'American football': ['nfl'], Basketball: ['nba'], Baseball: ['mlb'], 'Ice hockey': ['nhl'], Soccer: ['epl', 'efl'] }[sport];
      if(!key) return null;
      for(const k of key){
        const d = await getJson(`/.netlify/functions/espn-standings?sport=${k}`, 6 * 3600e3);
        if(d && d.ladder && findTeam(d.ladder, [pick.team, pick.sel].join(' '))){ ladder = d.ladder; break; }
        if(!ladder && d && d.ladder) ladder = d.ladder;
      }
    }
    if(!ladder || !ladder.length) return null;
    const backed = findTeam(ladder, [pick.team, pick.sel].join(' '));
    const sides = teamsInEvent(pick.event).map(t => findTeam(ladder, t)).filter(Boolean);
    const describe = (row) => `${row.name} ${row.rank ? ord(row.rank) + (row.group && sport !== 'AFL' && sport !== 'NRL' ? ' in ' + row.group : '') : ''} (${record(row)})`.replace(/\s+/g, ' ');
    const grouped = sport !== 'AFL' && sport !== 'NRL' && (backed || sides[0] || {}).group;
    const tail = grouped ? '' : ' ' + label;
    if(backed){
      const opp = sides.find(r => r !== backed);
      return opp ? `${describe(backed)} v ${describe(opp)}${tail}` : `${describe(backed)}${tail}`;
    }
    if(sides.length === 2) return `${describe(sides[0])} v ${describe(sides[1])}${tail}`;
    return null;
  }

  // ---------- horse racing ----------
  // "7. Enfjaar" + "Caulfield Race 9" → that runner's form for the race
  function raceParts(pick){
    const ev = String(pick.event || '') + ' ' + String(pick.market || '');
    const m = ev.match(/^\s*(.+?)\s+(?:race|r)\s*(\d{1,2})\b/i) || ev.match(/\b([A-Z][A-Za-z' -]+?)\s+(?:race|r)\s*(\d{1,2})\b/);
    if(!m) return null;
    const track = m[1].replace(/\b(race|r)\b.*$/i, '').trim();
    const num = (String(pick.sel || '').match(/^\s*(\d{1,2})\s*[.)-]/) || [])[1] || null;
    const name = String(pick.sel || '').replace(/^\s*\d{1,2}\s*[.)-]\s*/, '').replace(/\s*\(.*\)\s*$/, '').trim();
    return track ? { track, race: m[2], num, name } : null;
  }
  function dateKey(d){ return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(d); }
  async function raceFact(pick){
    const rp = raceParts(pick); if(!rp) return null;
    // the race is usually today or in the last few days (slips are read after)
    for(let back = 0; back <= 3; back++){
      const date = dateKey(new Date(Date.now() - back * 864e5));
      const d = await getJson(`/.netlify/functions/racing-race-form?track=${encodeURIComponent(rp.track)}&race=${rp.race}&date=${date}`, 12 * 3600e3);
      if(!d || !Array.isArray(d.runners) || !d.runners.length) continue;
      const r = d.runners.find(x => (rp.num && String(x.number) === String(rp.num)) || norm(x.name) === norm(rp.name)) || null;
      if(!r) continue;
      const bits = [];
      if(r.barrier) bits.push(`barrier ${r.barrier}`);
      if(r.jockey) bits.push(r.jockey);
      if(r.form) bits.push(`form ${r.form}`);
      const line1 = `${r.name}: ${bits.join(' · ')}`;
      const line2 = r.starts ? `${r.wins || 0} wins from ${r.starts} starts${r.winPercent != null ? ` (${Math.round(r.winPercent)}%)` : ''}${r.placePercent != null ? `, places ${Math.round(r.placePercent)}%` : ''}${d.distance ? ` · ${d.distance}m` : ''}${d.condition ? ' ' + d.condition : ''}` : null;
      return [line1, line2].filter(Boolean).join('\n');
    }
    return null;
  }

  // ---------- public ----------
  async function factFor(pick){
    if(!pick || !(pick.sel || pick.team)) return null;
    const c = window.pickStats && window.pickStats.classify ? window.pickStats.classify(pick) : { sport: pick.sport };
    const sport = c.sport || pick.sport || 'Other';
    const p = { ...pick, team: pick.team || c.team };
    try{
      if(sport === 'Horse racing') return await raceFact(p);
      return await ladderFact(sport, p);
    }catch(e){ return null; }
  }
  // fills any element with data-bet-fact="<json pick>" once the fact arrives
  function fill(root){
    (root || document).querySelectorAll('[data-bet-fact]:not([data-bf-done])').forEach(async el => {
      el.dataset.bfDone = '1';
      let pick = null; try{ pick = JSON.parse(el.dataset.betFact); }catch(e){}
      const fact = await factFor(pick);
      if(!el.isConnected) return;
      if(fact){ el.innerHTML = fact.split('\n').map(t => `<span>${String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}</span>`).join(''); el.hidden = false; el.classList.add('ready'); }
      else el.remove();
    });
  }
  window.betFacts = { factFor, fill };
})();
