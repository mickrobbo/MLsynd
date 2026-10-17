// pick-stats.js (v205)
// Stat sheets built from every leg read off a slip: which sports, teams and
// bet types each person backs, and how they go. Two views:
//   - Board → Stat sheet: the whole group (people, teams, sports)
//   - a person's profile: a Picks section with their own breakdown
// Data comes from saved weeks (history groupEntries[].pick and
// individualEntries[].picks) plus this week's live draft, so it grows on
// its own as slips are read. Nothing new is stored here.
(function(){
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s));
  const st = () => (typeof currentState !== 'undefined' && currentState) ? currentState : {};

  // ---------- classification (used when the slip reader didn't say) ----------
  const AFL = ['adelaide', 'crows', 'brisbane', 'lions', 'carlton', 'blues', 'collingwood', 'magpies', 'essendon', 'bombers', 'fremantle', 'dockers', 'geelong', 'cats', 'gold coast', 'suns', 'gws', 'giants', 'hawthorn', 'hawks', 'melbourne', 'demons', 'north melbourne', 'kangaroos', 'port adelaide', 'power', 'richmond', 'tigers', 'st kilda', 'saints', 'sydney', 'swans', 'west coast', 'eagles', 'western bulldogs', 'bulldogs'];
  const NRL = ['broncos', 'raiders', 'bulldogs', 'sharks', 'dolphins', 'titans', 'sea eagles', 'storm', 'knights', 'cowboys', 'eels', 'panthers', 'rabbitohs', 'dragons', 'roosters', 'warriors', 'wests tigers'];
  const SPORT_HINTS = [
    ['Horse racing', /\b(r\d{1,2}\b|race \d|win\/place|each way|fixed win|barrier|trifecta|quinella|exacta|first four)/i],
    ['Greyhounds', /greyhound|\bgr\b/i],
    ['Soccer', /\b(fc|united|city|epl|premier league|a-league|la liga|serie a|bundesliga|champions league|both teams to score|btts|draw)\b/i],
    ['Basketball', /\b(nba|nbl|points\s*\+|rebounds|assists|lakers|celtics|warriors)\b/i],
    ['Cricket', /\b(bbl|test match|wickets|runs scored|innings|t20|odi)\b/i],
    ['Tennis', /\b(set betting|sets|atp|wta|tennis)\b/i],
    ['American football', /\b(nfl|touchdown|passing yards)\b/i],
    ['Motorsport', /\b(f1|grand prix|motogp|supercars|podium finish)\b/i],
    ['Combat sports', /\b(ufc|mma|boxing|by ko|by submission)\b/i],
  ];
  function guessSport(p){
    if(p.sport) return normSport(p.sport);
    const text = [p.sel, p.market, p.event, p.team].filter(Boolean).join(' ').toLowerCase();
    if(/disposals|goals?\b|behinds|afl/.test(text) || AFL.some(t => text.includes(t)) && !NRL.some(t => text.includes(t))) return 'AFL';
    if(/\btries?\b|try scorer|nrl/.test(text) || NRL.some(t => text.includes(t))) return 'NRL';
    for(const [sport, re] of SPORT_HINTS) if(re.test(text)) return sport;
    return 'Other';
  }
  function normSport(s){
    const t = String(s).toLowerCase();
    if(/afl|aussie rules|australian rules/.test(t)) return 'AFL';
    if(/nrl|rugby league/.test(t)) return 'NRL';
    if(/greyhound/.test(t)) return 'Greyhounds';
    if(/harness|trot/.test(t)) return 'Harness racing';
    if(/horse|racing|thoroughbred/.test(t)) return 'Horse racing';
    if(/soccer|football \(soccer\)|epl|a-league/.test(t)) return 'Soccer';
    if(/basketball|nba|nbl/.test(t)) return 'Basketball';
    if(/cricket/.test(t)) return 'Cricket';
    if(/tennis/.test(t)) return 'Tennis';
    if(/nfl|american football/.test(t)) return 'American football';
    if(/baseball|mlb/.test(t)) return 'Baseball';
    if(/hockey|nhl/.test(t)) return 'Ice hockey';
    if(/rugby/.test(t)) return 'Rugby union';
    if(/golf/.test(t)) return 'Golf';
    if(/f1|motor|racing car|supercars|motogp/.test(t)) return 'Motorsport';
    if(/ufc|mma|boxing|combat/.test(t)) return 'Combat sports';
    return String(s).replace(/^\w/, c => c.toUpperCase());
  }
  const KIND_LABEL = { head_to_head: 'Head to head', line: 'Line', total: 'Totals', player: 'Player bets', racing: 'Racing', other: 'Other' };
  function guessKind(p){
    if(p.kind && KIND_LABEL[p.kind]) return p.kind;
    const t = [p.sel, p.market].filter(Boolean).join(' ').toLowerCase();
    if(/head to head|h2h|to win|match result|money ?line/.test(t)) return 'head_to_head';
    if(/line|handicap|margin|[+-]\d+(\.\d)?\b/.test(t)) return 'line';
    if(/over|under|total/.test(t)) return 'total';
    if(/disposals|goals|tries|scorer|points|rebounds|assists|marks|tackles|wickets|\d+\+/.test(t)) return 'player';
    if(/win|place|each way|barrier/.test(t)) return 'racing';
    return 'other';
  }
  function guessTeam(p){
    if(p.team) return String(p.team).trim();
    const k = guessKind(p);
    if(k === 'total') return null;
    let t = String(p.sel || '').replace(/\s*[+-]\d+(\.\d+)?\s*$/, '').replace(/\b(to win|win|h2h)\b/ig, '').replace(/\s*\d+\+.*$/, '').trim();
    return t || null;
  }

  // ---------- gather every tracked leg ----------
  function gather(){
    const s = st(); const out = [];
    const push = (name, p, extra) => {
      if(!p || !(p.sel || p.team)) return;
      out.push({ name, sel: p.sel || '', market: p.market || '', event: p.event || '', sport: guessSport(p), kind: guessKind(p), team: guessTeam(p), ...extra });
    };
    (s.history || []).forEach(w => {
      Object.entries(w.groupEntries || {}).forEach(([name, e]) => { if(e && e.pick) push(name, e.pick, { odds: Number(e.odds) || null, result: e.result || null, week: w.label || '', src: 'multi' }); });
      Object.entries(w.individualEntries || {}).forEach(([name, e]) => {
        (e && Array.isArray(e.picks) ? e.picks : []).forEach(p => {
          if(Array.isArray(p.legs) && p.legs.length) p.legs.forEach(l => push(name, l, { odds: Number(l.odds) || null, result: l.result === 'won' ? 'Win' : l.result === 'lost' ? 'Loss' : l.result === 'void' ? 'Void' : (p.result || null), week: w.label || '', src: 'individual' }));
          else push(name, p, { odds: Number(p.odds) || null, result: p.result || null, week: w.label || '', src: 'individual' });
        });
      });
    });
    // this week, not saved yet
    const savedLabels = new Set((s.history || []).map(w => w.label));
    if(!savedLabels.has(s.weekLabelDraft)){
      Object.entries(s.groupEntryDraft || {}).forEach(([name, e]) => { if(e && e.pick) push(name, e.pick, { odds: Number(e.odds) || null, result: e.result || null, week: s.weekLabelDraft || 'This week', src: 'multi', live: true }); });
      (s.weeklyIndividualBets || []).forEach(b => {
        if(!b || !b.pick) return;
        if(Array.isArray(b.pick.legs) && b.pick.legs.length) b.pick.legs.forEach(l => push(b.name, l, { odds: Number(l.odds) || null, result: l.result === 'won' ? 'Win' : l.result === 'lost' ? 'Loss' : l.result === 'void' ? 'Void' : (b.result || null), week: 'This week', src: 'individual', live: true }));
        else push(b.name, b.pick, { odds: Number(b.odds) || null, result: b.result || null, week: 'This week', src: 'individual', live: true });
      });
    }
    return out;
  }

  // ---------- summarise ----------
  function tally(legs, keyFn){
    const map = {};
    legs.forEach(l => { const k = keyFn(l); if(!k) return; const t = map[k] || (map[k] = { key: k, n: 0, w: 0, l: 0, v: 0, odds: 0, oddsN: 0 }); t.n++; if(l.result === 'Win') t.w++; else if(l.result === 'Loss') t.l++; else if(l.result === 'Void') t.v++; if(l.odds > 0){ t.odds += l.odds; t.oddsN++; } });
    return Object.values(map).map(t => ({ ...t, pct: t.w + t.l ? Math.round(t.w / (t.w + t.l) * 100) : null, avgOdds: t.oddsN ? t.odds / t.oddsN : null })).sort((a, b) => b.n - a.n || (b.pct || 0) - (a.pct || 0));
  }
  function summary(legs){
    const decided = legs.filter(l => l.result === 'Win' || l.result === 'Loss');
    const wins = decided.filter(l => l.result === 'Win');
    const withOdds = legs.filter(l => l.odds > 0);
    const bestWin = wins.filter(l => l.odds > 0).sort((a, b) => b.odds - a.odds)[0] || null;
    const teams = tally(legs, l => l.team);
    const minN = (t) => t.w + t.l >= 3;
    return {
      n: legs.length, decided: decided.length, wins: wins.length,
      pct: decided.length ? Math.round(wins.length / decided.length * 100) : null,
      avgOdds: withOdds.length ? withOdds.reduce((a, l) => a + l.odds, 0) / withOdds.length : null,
      sports: tally(legs, l => l.sport), kinds: tally(legs, l => KIND_LABEL[l.kind] || 'Other'), teams,
      bestWin,
      money: teams.filter(minN).sort((a, b) => (b.pct - a.pct) || (b.w - a.w))[0] || null,
      bogey: teams.filter(t => t.l >= 2).sort((a, b) => (b.l - a.l) || (a.pct - b.pct))[0] || null,
    };
  }
  const pct = (v) => v == null ? '–' : v + '%';
  const rec = (t) => `${t.w}–${t.l}${t.v ? `–${t.v}` : ''}`;
  const odds = (v) => v == null ? '–' : '@' + v.toFixed(2);

  // ---------- profile section ----------
  function profileSection(name){
    const legs = gather().filter(l => l.name === name);
    if(!legs.length) return `<div class="ps-sec"><div class="ps-h">Picks</div><div class="ps-empty">No tracked picks yet. Every leg read from a slip is counted here.</div></div>`;
    const s = summary(legs);
    const bar = s.sports.slice(0, 5);
    const total = bar.reduce((a, t) => a + t.n, 0) || 1;
    const COLORS = ['#CDF464', '#7FB6FF', '#F2C14E', '#FF8A80', '#C58CFF'];
    return `<div class="ps-sec">
      <div class="ps-h">Picks<span>${s.n} tracked leg${s.n === 1 ? '' : 's'}</span></div>
      <div class="ps-kpis">
        <div><b>${pct(s.pct)}</b><span>Win rate</span></div>
        <div><b>${odds(s.avgOdds)}</b><span>Average odds</span></div>
        <div><b>${s.bestWin ? odds(s.bestWin.odds) : '–'}</b><span>Best winner</span></div>
      </div>
      <div class="ps-bar" role="img" aria-label="Sports: ${bar.map(t => `${t.key} ${t.n}`).join(', ')}">${bar.map((t, i) => `<span style="flex:${t.n};background:${COLORS[i]}"></span>`).join('')}</div>
      <div class="ps-legend">${bar.map((t, i) => `<span><i style="background:${COLORS[i]}"></i>${esc(t.key)} ${Math.round(t.n / total * 100)}%</span>`).join('')}</div>
      ${s.teams.length ? `<div class="ps-sub">Most backed</div>${s.teams.slice(0, 5).map(t => `<div class="ps-row"><span>${esc(t.key)}</span><span class="ps-rec">${rec(t)}</span><span class="ps-n">${t.n}×</span></div>`).join('')}` : ''}
      <div class="ps-sub">Bet types</div>${s.kinds.slice(0, 4).map(t => `<div class="ps-row"><span>${esc(t.key)}</span><span class="ps-rec">${pct(t.pct)}</span><span class="ps-n">${t.n}×</span></div>`).join('')}
      ${s.money || s.bogey ? `<div class="ps-chips">${s.money ? `<span class="ps-chip good">Money team: ${esc(s.money.key)} (${rec(s.money)})</span>` : ''}${s.bogey ? `<span class="ps-chip bad">Bogey team: ${esc(s.bogey.key)} (${rec(s.bogey)})</span>` : ''}</div>` : ''}
    </div>`;
  }
  function hookProfile(){
    if(typeof window.openBoardProfile !== 'function') return;
    const orig = window.openBoardProfile;
    window.openBoardProfile = function(m, name){
      const r = orig.apply(this, arguments);
      try{
        const sheet = document.querySelector('#profileModal .profile-sheet'); if(!sheet) return r;
        let box = $('profilePickStats');
        if(!box){ box = document.createElement('div'); box.id = 'profilePickStats'; sheet.appendChild(box); }
        box.innerHTML = profileSection((m && m.name) || name);
      }catch(e){}
      return r;
    };
  }

  // ---------- group stat sheet ----------
  function buildModal(){
    if($('pickStatsModal')) return;
    const m = document.createElement('div');
    m.id = 'pickStatsModal'; m.className = 'profile-modal';
    m.innerHTML = `<div class="profile-sheet ps-sheet">
      <button type="button" class="profile-close" id="pickStatsCloseBtn" aria-label="Close">✕</button>
      <h2 class="ps-title">Stat sheet</h2>
      <div class="ps-note" id="pickStatsNote"></div>
      <div class="ps-tabs" role="tablist">
        <button type="button" class="ps-tab on" data-ps="people" role="tab" aria-selected="true">People</button>
        <button type="button" class="ps-tab" data-ps="teams" role="tab" aria-selected="false">Teams</button>
        <button type="button" class="ps-tab" data-ps="sports" role="tab" aria-selected="false">Sports</button>
      </div>
      <div id="pickStatsBody"></div>
    </div>`;
    document.body.appendChild(m);
    $('pickStatsCloseBtn').addEventListener('click', () => m.classList.remove('open'));
    m.addEventListener('click', (e) => {
      if(e.target === m){ m.classList.remove('open'); return; }
      const tab = e.target.closest('.ps-tab'); if(tab){ m.querySelectorAll('.ps-tab').forEach(t => { const on = t === tab; t.classList.toggle('on', on); t.setAttribute('aria-selected', on); }); renderBody(tab.dataset.ps); return; }
      const person = e.target.closest('[data-ps-person]'); if(person && typeof openProfile === 'function'){ m.classList.remove('open'); openProfile(person.dataset.psPerson); }
    });
  }
  function renderBody(view){
    const legs = gather(); const body = $('pickStatsBody');
    $('pickStatsNote').textContent = legs.length ? `${legs.length} legs tracked from read slips${legs.some(l => l.live) ? ', including this week' : ''}.` : '';
    if(!legs.length){ body.innerHTML = `<div class="ps-empty">Nothing tracked yet. Every leg read from a slip (Admin → Week → Bet slips → Read slips) is counted here, and it builds up week by week.</div>`; return; }
    if(view === 'teams'){
      const t = tally(legs, l => l.team);
      body.innerHTML = `<div class="ps-table"><div class="ps-tr ps-th"><span>Team or player</span><span>Backed</span><span>W–L</span><span>Win %</span></div>${t.slice(0, 40).map(x => {
        const by = tally(legs.filter(l => l.team === x.key), l => l.name).slice(0, 3).map(b => b.key.split(' ')[0]).join(', ');
        return `<div class="ps-tr"><span><b>${esc(x.key)}</b><small>${esc(by)}</small></span><span>${x.n}</span><span>${rec(x)}</span><span>${pct(x.pct)}</span></div>`; }).join('')}</div>`;
      return;
    }
    if(view === 'sports'){
      const sp = tally(legs, l => l.sport);
      body.innerHTML = sp.map(x => {
        const fans = tally(legs.filter(l => l.sport === x.key), l => l.name).slice(0, 3);
        const kinds = tally(legs.filter(l => l.sport === x.key), l => KIND_LABEL[l.kind] || 'Other').slice(0, 3);
        return `<div class="ps-card"><div class="ps-card-h"><b>${esc(x.key)}</b><span>${x.n} leg${x.n === 1 ? '' : 's'} · ${rec(x)} · ${pct(x.pct)}</span></div>
          <div class="ps-card-r"><span>Most into it</span><span>${fans.map(f => `${esc(f.key.split(' ')[0])} ${f.n}`).join(', ')}</span></div>
          <div class="ps-card-r"><span>Usual bets</span><span>${kinds.map(k => `${esc(k.key)} ${k.n}`).join(', ')}</span></div></div>`;
      }).join('');
      return;
    }
    const people = tally(legs, l => l.name).map(p => ({ p, s: summary(legs.filter(l => l.name === p.key)) })).sort((a, b) => (b.s.pct || 0) - (a.s.pct || 0) || b.s.n - a.s.n);
    body.innerHTML = `<div class="ps-table ps-people"><div class="ps-tr ps-th"><span>Person</span><span>Legs</span><span>Win %</span><span>Avg odds</span></div>${people.map(({ p, s }) => `
      <button type="button" class="ps-tr ps-tr-btn" data-ps-person="${esc(p.key)}">
        <span><b>${esc(p.key)}</b><small>${esc([s.sports[0] && s.sports[0].key, s.teams[0] && s.teams[0].key, s.kinds[0] && s.kinds[0].key].filter(Boolean).join(' · '))}</small></span>
        <span>${s.n}</span><span>${pct(s.pct)}</span><span>${odds(s.avgOdds)}</span>
      </button>`).join('')}</div><div class="ps-foot">Tap a name for their full breakdown.</div>`;
  }
  function open(){ buildModal(); renderBody('people'); const m = $('pickStatsModal'); m.querySelectorAll('.ps-tab').forEach((t, i) => { t.classList.toggle('on', i === 0); t.setAttribute('aria-selected', i === 0); }); m.classList.add('open'); }

  function init(){
    hookProfile();
    const btn = $('pickStatsOpenBtn'); if(btn) btn.addEventListener('click', open);
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.pickStats = { gather, summary, open };
})();
