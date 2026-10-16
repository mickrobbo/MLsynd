// ===================== Casino Premium layer (v185) =====================
// One shared file that sits on top of every single-player game without
// rewriting them:
//  - win banner with a count-up, a "last 10" results strip per game
//  - phone vibration on wins / big wins / card deals (toggle)
//  - bet tools: half, double, and the last bet remembered per game
//  - Auto Play on every table, with stop rules (up X, down X, one big win)
//    and bet progression (double after a loss / reset after a win)
//  - Crash auto cash-out (manual rounds too)
//  - optional best-move hints for Blackjack and Video Poker
//  - a richer session summary (record, win rate, best streak, share)
// Games are driven through their own buttons, so every rule, balance
// check and payout stays exactly the game's own code.
(function(){
  'use strict';
  const $ = (id) => document.getElementById(id);
  const LS = {
    get(k, d){ try{ const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }catch(e){ return d; } },
    set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
  };
  const vis = (id) => { const el = typeof id === 'string' ? $(id) : id; if(!el || el.disabled) return false; if(el.offsetParent === null) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const press = (id) => { const el = $(id); if(el){ el.click(); return true; } return false; };
  const fmt = (n) => Math.round(Math.abs(n)).toLocaleString('en-AU');
  const safe = (fn, d) => { try{ return fn(); }catch(e){ return d; } };
  const maxBet = () => safe(() => CASINO_MAX_BET_PER_HAND, 250000);

  // ---------- per-game config ----------
  const GAMES = {
    blackjack:  { label: 'Blackjack',       re: /^Blackjack (win|loss)$/i,           bet: 'bjBetInput',      start: 'bjDealBtn',       err: 'bjBetError',      prog: true },
    baccarat:   { label: 'Baccarat',        re: /^Baccarat (win|loss)$/i,            bet: 'bacBetInput',     start: 'bacDealBtn',      err: 'bacBetError',     prog: true },
    roulette:   { label: 'Roulette',        re: /^Roulette (win|loss)$/i,            bet: 'rouletteBetInput',start: 'rouletteSpinBtn', err: 'rouletteBetError',prog: false },
    war:        { label: 'Casino War',      re: /^Casino War (win|loss)$/i,          bet: 'warBetInput',     start: 'warDealBtn',      err: 'warBetError',     prog: true },
    craps:      { label: 'Craps',           re: /^Craps (win|loss)$/i,               bet: 'crapsBetInput',   start: 'crapsRollBtn',    err: 'crapsBetError',   prog: false },
    slots:      { label: 'Slots',           re: null,                                bet: 'slotsBetInput',   start: 'slotsSpinBtn',    err: 'slotsBetError',   prog: true },
    videopoker: { label: 'Video Poker',     re: /^Video Poker (loss|gamble collect)$/i, bet: 'vpBetInput',   start: 'vpDealBtn',       err: 'vpBetError',      prog: true },
    plinko:     { label: 'Plinko',          re: /^Plinko (win|loss)$/i,              bet: 'plinkoBetInput',  start: 'plinkoDropBtn',   err: 'plinkoBetError',  prog: true },
    bigwheel:   { label: 'Big Wheel',       re: /^Big Wheel (win|loss)$/i,           bet: 'bigWheelBetInput',start: 'bigWheelSpinBtn', err: 'bigWheelBetError',prog: false },
    mines:      { label: 'Mines',           re: /^Mines (win|loss)$/i,               bet: 'minesBetInput',   start: 'minesStartBtn',   err: 'minesBetError',   prog: true },
    crash:      { label: 'Crash',           re: /^Crash (win|loss)$/i,               bet: 'crashBetInput',   start: 'crashStartBtn',   err: 'crashBetError',   prog: true },
    doubleornothing: { label: 'Double or Nothing', re: /^Double or Nothing (win|loss)$/i, bet: 'donBetInput', start: 'donHeadsBtn',   err: 'donBetError',     prog: true },
  };
  const PANEL = safe(() => CASINO_GAME_PANEL_IDS, {});
  let currentGame = null;
  let currentIsHr = false;

  // ---------- settings ----------
  const S = LS.get('cp-settings', { haptics: true, hints: false, crashAuto: false, crashTarget: 2 });
  const saveS = () => LS.set('cp-settings', S);
  const buzz = (p) => { if(S.haptics && navigator.vibrate){ try{ navigator.vibrate(p); }catch(e){} } };

  // ---------- session stats (feeds the richer recap) ----------
  let sess = null;
  const newSess = (game) => ({ game, start: Date.now(), rounds: 0, wins: 0, losses: 0, net: 0, best: 0, streak: 0, bestStreak: 0 });

  // ---------- round events ----------
  const history = LS.get('cp-history', {});
  function roundResult(game, amount){
    if(!GAMES[game]) return;
    const h = history[game] = (history[game] || []);
    h.unshift(Math.round(amount)); if(h.length > 10) h.length = 10;
    LS.set('cp-history', history);
    if(sess && sess.game === game){
      sess.rounds++;
      if(amount > 0){ sess.wins++; sess.streak++; sess.bestStreak = Math.max(sess.bestStreak, sess.streak); sess.best = Math.max(sess.best, amount); }
      else if(amount < 0){ sess.losses++; sess.streak = 0; }
    }
    // remember the stake for next time
    const inp = $(GAMES[game].bet); const v = inp && parseInt(inp.value, 10);
    if(v > 0 && !currentIsHr) LS.set('cp-bet-' + game, v);
    if(game === currentGame) renderStrip();
    if(amount > 0){
      const stake = AP.running && AP.game === game ? AP.bet : (v || 0);
      const tier = stake > 0 && amount >= stake * 25 ? 'mega' : stake > 0 && amount >= stake * 8 ? 'big' : 'win';
      showBanner(amount, tier, GAMES[game].label);
      try{ window.dispatchEvent(new CustomEvent('cp:win', { detail: { amount, tier, game: GAMES[game].label } })); }catch(e){}
      buzz(tier === 'mega' ? [60, 50, 60, 50, 160] : tier === 'big' ? [40, 40, 120] : 30);
    } else if(amount < 0){ buzz(12); }
    apOnResult(game, amount);
  }
  window.casinoPremiumRound = roundResult;

  function gameFromReason(reason){
    for(const k in GAMES){ const g = GAMES[k]; if(g.re && g.re.test(reason)) return k; }
    return null;
  }
  function onXP(amount, reason, hr){
    reason = String(reason || '').replace(/^\[Maxine's\] /, '');
    const isCasino = safe(() => CASINO_POT_REASON_PATTERN.test(reason), false) || /^(Slots|Video Poker)/.test(reason);
    if(isCasino && AP.running) AP.net += amount;
    if(isCasino && sess) sess.net += amount;
    const game = gameFromReason(reason);
    if(game) roundResult(game, amount);
  }
  if(typeof window.awardXP === 'function'){
    const orig = window.awardXP;
    window.awardXP = async function(amount, reason, opts){ const r = await orig.apply(this, arguments); try{ onXP(amount, reason, false); }catch(e){} return r; };
  }
  if(typeof window.awardHighRollerXP === 'function'){
    const origHr = window.awardHighRollerXP;
    window.awardHighRollerXP = async function(amount, reason){ const r = await origHr.apply(this, arguments); try{ onXP(amount, reason, true); }catch(e){} return r; };
  }

  // ---------- win banner ----------
  let bannerTimer = null, bannerRaf = null;
  function showBanner(amount, tier, label){
    let el = $('cpBanner');
    if(!el){ el = document.createElement('div'); el.id = 'cpBanner'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); document.body.appendChild(el); }
    el.className = 'cp-banner cp-' + tier;
    const title = tier === 'mega' ? 'Massive win' : tier === 'big' ? 'Big win' : label + ' win';
    el.innerHTML = `<span class="cp-banner-title">${title}</span><span class="cp-banner-amt">+<b>0</b> XP</span>`;
    const b = el.querySelector('b');
    const dur = tier === 'win' ? 650 : 1400; const t0 = performance.now();
    cancelAnimationFrame(bannerRaf);
    const step = (t) => { const p = Math.min(1, (t - t0) / dur); const e = 1 - Math.pow(1 - p, 3); b.textContent = fmt(amount * e); if(p < 1) bannerRaf = requestAnimationFrame(step); };
    bannerRaf = requestAnimationFrame(step);
    void el.offsetWidth; el.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => el.classList.remove('show'), tier === 'win' ? 1900 : 3200);
  }

  // ---------- per-game top bar: results strip + session + tools ----------
  function ensureBar(game){
    const panel = $(PANEL[game]); if(!panel || !GAMES[game]) return null;
    let bar = panel.querySelector(':scope > .cp-bar');
    if(!bar){
      bar = document.createElement('div'); bar.className = 'cp-bar';
      bar.innerHTML = `<div class="cp-strip" aria-label="Your last 10 rounds"></div>
        <button type="button" class="cp-bar-btn cp-auto-open" aria-label="Auto Play and table settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 0 1 13.7-5.6L20 9M20 4v5h-5M20 12a8 8 0 0 1-13.7 5.6L4 15M4 20v-5h5"/></svg><span>Auto</span></button>`;
      panel.insertBefore(bar, panel.firstChild);
      bar.querySelector('.cp-auto-open').addEventListener('click', () => openSheet(game));
    }
    return bar;
  }
  function renderStrip(){
    if(!currentGame) return;
    const bar = ensureBar(currentGame); if(!bar) return;
    const h = history[currentGame] || [];
    const strip = bar.querySelector('.cp-strip');
    strip.innerHTML = h.length
      ? h.map((v, i) => `<span class="cp-pip ${v > 0 ? 'w' : v < 0 ? 'l' : 'p'}${i === 0 ? ' new' : ''}">${v > 0 ? '+' : v < 0 ? '−' : ''}${compact(v)}</span>`).join('')
      : '<span class="cp-strip-empty">Your last 10 rounds show here</span>';
  }
  const compact = (v) => { const a = Math.abs(v); return a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'm' : a >= 1e4 ? Math.round(a / 1e3) + 'k' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'k' : String(a); };

  // ---------- bet tools ----------
  function addBetTools(){
    document.querySelectorAll('.chip-rail:not(.chip-rail-small)').forEach(rail => {
      if(rail.querySelector('.cp-bet-tool')) return;
      const target = rail.dataset.target; if(!target || /^mp|BuyIn/.test(target)) return;
      const clear = rail.querySelector('.chip-clear-btn');
      const mk = (label, fn, title) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'cp-bet-tool'; b.textContent = label; b.title = title; b.addEventListener('click', () => { const inp = $(target); if(!inp || inp.disabled) return; const cur = parseInt(inp.value, 10) || 0; inp.value = Math.max(0, Math.min(maxBet(), fn(cur))); inp.dispatchEvent(new Event('input')); buzz(8); }); return b; };
      const half = mk('½', c => Math.floor(c / 2), 'Halve the bet');
      const dbl = mk('×2', c => c * 2, 'Double the bet');
      if(clear){ rail.insertBefore(half, clear); rail.insertBefore(dbl, clear); } else { rail.appendChild(half); rail.appendChild(dbl); }
    });
  }
  function restoreBet(game){
    const g = GAMES[game]; if(!g || currentIsHr) return;
    const saved = LS.get('cp-bet-' + game, null); const inp = $(g.bet);
    if(saved > 0 && inp && !inp.disabled){ inp.value = saved; inp.dispatchEvent(new Event('input')); }
  }

  // ---------- entering / leaving a game ----------
  document.querySelectorAll('.game-bubble').forEach(btn => btn.addEventListener('click', () => {
    const game = btn.dataset.game;
    if(AP.running && AP.game !== game) apStop('Stopped: you left the table.');
    currentGame = GAMES[game] ? game : null;
    currentIsHr = btn.dataset.hrEntry === '1';
    if(!currentGame){ return; }
    if(!sess || sess.game !== game) sess = newSess(game);
    setTimeout(() => { ensureBar(game); renderStrip(); restoreBet(game); hintRefresh(); crashUiSync(); }, 60);
  }));
  // Leaving the Casino tab or the games list stops Auto Play.
  const casinoTabBtn = document.querySelector('.tabbar [data-tab="casino"]');
  document.querySelectorAll('.tabbar .tab-btn').forEach(b => b.addEventListener('click', () => { if(b !== casinoTabBtn && AP.running) apStop('Stopped: you left the Casino.'); }));
  if(typeof window.showCasinoView === 'function'){
    const origView = window.showCasinoView;
    window.showCasinoView = function(viewId){ if(viewId !== 'casinoGamesView' && AP.running) apStop('Stopped: you left the table.'); return origView.apply(this, arguments); };
  }

  // ---------- richer session recap ----------
  let recapSnap = null;
  if(typeof window.casinoSessionShowRecapIfAny === 'function'){
    const origRecapIf = window.casinoSessionShowRecapIfAny;
    window.casinoSessionShowRecapIfAny = function(){ recapSnap = sess ? Object.assign({}, sess) : null; const r = origRecapIf.apply(this, arguments); sess = null; return r; };
  }
  if(typeof window.showCasinoSessionRecap === 'function'){
    const origRecap = window.showCasinoSessionRecap;
    window.showCasinoSessionRecap = function(label, stats){
      const r = origRecap.apply(this, arguments);
      try{
        const s = recapSnap; const modal = $('sessionRecapModal'); if(!modal || !s) return r;
        let box = $('cpRecapExtra');
        if(!box){
          box = document.createElement('div'); box.id = 'cpRecapExtra'; box.className = 'cp-recap';
          const anchor = $('sessionRecapNiceOneBtn'); anchor.parentNode.insertBefore(box, anchor);
        }
        const decided = s.wins + s.losses; const mins = Math.max(1, Math.round((Date.now() - s.start) / 60000));
        box.innerHTML = `<div class="cp-recap-grid">
            <div><span>Record</span><b>${s.wins}–${s.losses}</b></div>
            <div><span>Win rate</span><b>${decided ? Math.round(s.wins / decided * 100) + '%' : '—'}</b></div>
            <div><span>Best streak</span><b>${s.bestStreak}</b></div>
            <div><span>Time</span><b>${mins} min</b></div>
          </div>
          ${navigator.share ? '<button type="button" class="pill-btn cp-recap-share">Share</button>' : ''}`;
        const sh = box.querySelector('.cp-recap-share');
        if(sh) sh.onclick = () => { navigator.share({ text: `${label} at the MLSynd casino: ${stats.hands} rounds, ${stats.net >= 0 ? '+' : '−'}${fmt(stats.net)} XP, best win +${fmt(stats.biggestWin)} XP, best streak ${s.bestStreak}.` }).catch(() => {}); };
      }catch(e){}
      return r;
    };
  }

  // ======================= strategy =======================
  const bjVal = (c) => c.rank === 'A' ? 11 : ['J', 'Q', 'K'].includes(c.rank) ? 10 : Number(c.rank);
  function bjBest(hand, up, canDouble, canSplit){
    const u = bjVal(up);
    if(canSplit && hand.length === 2 && bjVal(hand[0]) === bjVal(hand[1])){
      const p = bjVal(hand[0]);
      if(p === 11 || p === 8) return 'split';
      if(p === 9 && ![7, 10, 11].includes(u)) return 'split';
      if(p === 7 && u <= 7) return 'split';
      if(p === 6 && u <= 6) return 'split';
      if(p === 4 && (u === 5 || u === 6)) return 'split';
      if((p === 2 || p === 3) && u <= 7) return 'split';
    }
    let raw = 0, aces = 0; hand.forEach(c => { if(c.rank === 'A'){ aces++; raw += 1; } else raw += bjVal(c); });
    const soft = aces > 0 && raw + 10 <= 21; const t = soft ? raw + 10 : raw;
    const D = (yes) => yes ? (canDouble ? 'double' : 'hit') : null;
    if(soft){
      if(t >= 19) return 'stand';
      if(t === 18){ if(u >= 3 && u <= 6) return canDouble ? 'double' : 'stand'; return (u === 2 || u === 7 || u === 8) ? 'stand' : 'hit'; }
      if(t === 17) return D(u >= 3 && u <= 6) || 'hit';
      if(t === 15 || t === 16) return D(u >= 4 && u <= 6) || 'hit';
      return D(u === 5 || u === 6) || 'hit';
    }
    if(t >= 17) return 'stand';
    if(t >= 13) return u <= 6 ? 'stand' : 'hit';
    if(t === 12) return (u >= 4 && u <= 6) ? 'stand' : 'hit';
    if(t === 11) return D(u <= 10) || 'hit';
    if(t === 10) return D(u <= 9) || 'hit';
    if(t === 9) return D(u >= 3 && u <= 6) || 'hit';
    return 'hit';
  }
  const BJ_WORD = { hit: 'Hit', stand: 'Stand', double: 'Double', split: 'Split' };
  function bjAdvice(){
    if(!safe(() => bjHandActive, false)) return null;
    const hand = safe(() => bjIsSplit ? bjSplitHands[bjActiveHandIdx] : bjPlayerHand, null);
    const up = safe(() => bjDealerHand[0], null);
    if(!hand || !up) return null;
    return bjBest(hand, up, vis('bjDoubleBtn'), vis('bjSplitBtn'));
  }

  // Video Poker (Tens or Better): returns a held[] array
  const VR = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const rv = (c) => VR.indexOf(c.rank) + 2;
  function vpBestHold(hand){
    const n = hand.length; const all = Array(n).fill(true), none = Array(n).fill(false);
    const byRank = {}; hand.forEach((c, i) => (byRank[c.rank] = byRank[c.rank] || []).push(i));
    const groups = Object.values(byRank).sort((a, b) => b.length - a.length);
    const bySuit = {}; hand.forEach((c, i) => (bySuit[c.suit] = bySuit[c.suit] || []).push(i));
    const flushSuit = Object.values(bySuit).find(g => g.length === 5);
    const vals = hand.map(rv).sort((a, b) => a - b);
    const uniq = new Set(vals).size === 5;
    const straight = uniq && (vals[4] - vals[0] === 4 || vals.join() === '2,3,4,5,14');
    const hold = (idx) => hand.map((_, i) => idx.includes(i));
    if(flushSuit || straight || groups[0].length === 4 || (groups[0].length === 3 && groups[1].length === 2)) return all;
    const royal = ['10', 'J', 'Q', 'K', 'A'];
    for(const g of Object.values(bySuit)){ const r = g.filter(i => royal.includes(hand[i].rank)); if(r.length === 4) return hold(r); }
    if(groups[0].length === 3) return hold(groups[0]);
    // 4 to a straight flush
    for(const g of Object.values(bySuit)){ if(g.length >= 4){ const v = g.map(i => rv(hand[i])).sort((a, b) => a - b); for(let s = 0; s + 3 < v.length; s++){ if(v[s + 3] - v[s] <= 4) return hold(g); } } }
    if(groups[0].length === 2 && groups[1] && groups[1].length === 2) return hold(groups[0].concat(groups[1]));
    if(groups[0].length === 2 && rv(hand[groups[0][0]]) >= 10) return hold(groups[0]);
    for(const g of Object.values(bySuit)){ const r = g.filter(i => royal.includes(hand[i].rank)); if(r.length === 3) return hold(r); }
    for(const g of Object.values(bySuit)){ if(g.length === 4) return hold(g); }
    if(groups[0].length === 2) return hold(groups[0]);
    // 4 to an outside straight
    const uniqIdx = []; const seen = new Set(); hand.map((c, i) => [rv(c), i]).sort((a, b) => a[0] - b[0]).forEach(([v, i]) => { if(!seen.has(v)){ seen.add(v); uniqIdx.push([v, i]); } });
    for(let s = 0; s + 3 < uniqIdx.length; s++){ if(uniqIdx[s + 3][0] - uniqIdx[s][0] === 3 && uniqIdx[s][0] >= 2 && uniqIdx[s + 3][0] <= 13) return hold(uniqIdx.slice(s, s + 4).map(x => x[1])); }
    const high = hand.map((c, i) => [rv(c), i]).filter(([v]) => v >= 10);
    for(const g of Object.values(bySuit)){ const h = g.filter(i => rv(hand[i]) >= 10); if(h.length >= 2) return hold(h.slice(0, 2)); }
    if(high.length >= 2){ high.sort((a, b) => a[0] - b[0]); return hold(high.slice(0, 2).map(x => x[1])); }
    if(high.length === 1) return hold([high[0][1]]);
    return none;
  }
  function vpHoldWords(hand, held){
    const k = held.filter(Boolean).length;
    if(k === 5) return 'Hold all five';
    if(k === 0) return 'Draw five new cards';
    return 'Hold ' + hand.filter((_, i) => held[i]).map(c => c.rank + c.suit).join(' ');
  }

  // ---------- hint chips ----------
  function hintEl(id, anchorId){
    let el = $(id); if(el) return el;
    const anchor = $(anchorId); if(!anchor) return null;
    el = document.createElement('div'); el.id = id; el.className = 'cp-hint'; anchor.parentNode.insertBefore(el, anchor);
    return el;
  }
  function hintRefresh(){
    const bjH = hintEl('cpHintBj', 'bjHitBtn');
    if(bjH){
      const a = S.hints && currentGame === 'blackjack' ? bjAdvice() : null;
      bjH.style.display = a ? '' : 'none';
      if(a) bjH.innerHTML = `<span>Best move</span><b>${BJ_WORD[a]}</b>`;
      ['bjHitBtn', 'bjStandBtn', 'bjDoubleBtn', 'bjSplitBtn'].forEach(id => { const b = $(id); if(b) b.classList.toggle('cp-suggest', !!a && id === 'bj' + BJ_WORD[a] + 'Btn'); });
    }
    const vpH = hintEl('cpHintVp', 'vpDrawBtn');
    if(vpH){
      const live = S.hints && currentGame === 'videopoker' && safe(() => vpStage, '') === 'dealt' && !safe(() => vpPlayDealer, false);
      vpH.style.display = live ? '' : 'none';
      document.querySelectorAll('#vpHandRow .vp-hold-pill').forEach(p => p.classList.remove('cp-suggest'));
      if(live){
        const hand = safe(() => vpHand, []); const held = vpBestHold(hand);
        vpH.innerHTML = `<span>Best play</span><b>${vpHoldWords(hand, held)}</b>`;
        document.querySelectorAll('#vpHandRow .vp-hold-pill:not(.vp-extra-hold-pill)').forEach(p => { if(held[+p.dataset.idx]) p.classList.add('cp-suggest'); });
      }
    }
  }
  setInterval(() => { if(S.hints && (currentGame === 'blackjack' || currentGame === 'videopoker')) hintRefresh(); }, 400);

  // ======================= Crash auto cash-out =======================
  function crashUiSync(){
    const anchor = $('crashStartBtn'); if(!anchor) return;
    let row = $('cpCrashAuto');
    if(!row){
      row = document.createElement('div'); row.id = 'cpCrashAuto'; row.className = 'cp-crash-auto';
      row.innerHTML = `<label class="cp-switch"><input type="checkbox" id="cpCrashAutoOn"><span></span></label>
        <span class="cp-crash-auto-lbl">Auto cash-out at</span>
        <span class="cp-crash-auto-field"><input type="number" id="cpCrashTarget" inputmode="decimal" min="1.01" step="0.1"><span>x</span></span>`;
      const host = anchor.closest('.deal-row') || anchor.parentNode;
      host.parentNode.insertBefore(row, host);
      $('cpCrashAutoOn').addEventListener('change', (e) => { S.crashAuto = e.target.checked; saveS(); });
      $('cpCrashTarget').addEventListener('change', (e) => { const v = Math.max(1.01, parseFloat(e.target.value) || 2); S.crashTarget = Math.round(v * 100) / 100; e.target.value = S.crashTarget.toFixed(2); saveS(); });
    }
    $('cpCrashAutoOn').checked = !!S.crashAuto;
    $('cpCrashTarget').value = Number(S.crashTarget || 2).toFixed(2);
  }
  let crashCashedThisRound = false;
  setInterval(() => {
    const running = safe(() => crashRunning, false);
    if(!running){ crashCashedThisRound = false; return; }
    const autoOn = S.crashAuto || (AP.running && AP.game === 'crash');
    if(!autoOn || crashCashedThisRound || safe(() => crashCashedOut, true)) return;
    const target = AP.running && AP.game === 'crash' ? (AP.cfg.crashTarget || S.crashTarget || 2) : (S.crashTarget || 2);
    if(safe(() => crashCurrentMult, 0) >= target){
      const btn = vis('crashCashOutBtn') ? 'crashCashOutBtn' : (vis('crashCashOutTopBtn') ? 'crashCashOutTopBtn' : null);
      if(btn){ crashCashedThisRound = true; press(btn); }
    }
  }, 25);

  // ======================= Auto Play =======================
  const AP = { running: false, game: null, rounds: 0, target: 0, net: 0, base: 0, bet: 0, cfg: {}, bigHit: false, vpHeldFor: null, minesPicks: 0, waitUntil: 0 };
  const AP_DEFAULT = { rounds: 25, stopUp: 0, stopDown: 0, stopWin: 0, onLoss: 'same', onWin: 'same', minesTiles: 2, donWins: 1, crashTarget: 2 };
  const setBet = (game, amount) => { const inp = $(GAMES[game].bet); if(!inp) return; if(String(inp.value) !== String(amount)){ inp.value = amount; inp.dispatchEvent(new Event('input')); } };
  const sum = (o) => { if(o == null) return 0; if(typeof o === 'number') return o; if(typeof o === 'object') return Object.values(o).reduce((a, v) => a + sum(v), 0); return 0; };

  const ADAPT = {
    blackjack(ap){
      if(safe(() => bjStarting || bjActionBusy, false)) return 'busy';
      if(vis('bjInsuranceNoBtn')){ press('bjInsuranceNoBtn'); return 'acted'; }
      if(safe(() => bjHandActive, false)){
        const a = bjAdvice(); const id = a && 'bj' + BJ_WORD[a] + 'Btn';
        if(id && vis(id)){ press(id); return 'acted'; }
        if(vis('bjStandBtn')){ press('bjStandBtn'); return 'acted'; }
        return 'busy';
      }
      if(vis('bjNewHandBtn')){ press('bjNewHandBtn'); return 'acted'; }
      if(vis('bjDealBtn')){ setBet('blackjack', ap.bet); press('bjDealBtn'); return 'started'; }
      return 'busy';
    },
    baccarat(ap){
      if(safe(() => bacDealing, false)) return 'busy';
      if(vis('bacHitBtn')){ press('bacHitBtn'); return 'acted'; }
      if(vis('bacNewHandBtn')){ press('bacNewHandBtn'); return 'acted'; }
      if(vis('bacDealBtn')){ setBet('baccarat', ap.bet); press('bacDealBtn'); return 'started'; }
      return 'busy';
    },
    war(ap){
      if(safe(() => warDealing, false)) return 'busy';
      if(vis('warGoBtn')){ press('warGoBtn'); return 'acted'; }
      if(vis('warNewHandBtn')){ press('warNewHandBtn'); return 'acted'; }
      if(vis('warDealBtn')){ setBet('war', ap.bet); press('warDealBtn'); return 'started'; }
      return 'busy';
    },
    roulette(){
      if(safe(() => rouletteSpinning, false)) return 'busy';
      if(!safe(() => rouletteActiveBets.length, 0)){
        if(vis('rouletteSameBetBtn')){ press('rouletteSameBetBtn'); return 'acted'; }
        return { stop: 'Place your bets on the table first, then start Auto Play.' };
      }
      if(vis('rouletteSpinBtn')){ press('rouletteSpinBtn'); return 'started'; }
      return 'busy';
    },
    craps(ap){
      if(safe(() => crapsRolling, false)) return 'busy';
      const live = safe(() => sum(crapsLive) + sum(crapsPlace) + sum(crapsHardway) + sum(crapsStaged) + sum(crapsComePoints) + sum(crapsDontComePoints) + (crapsPassOdds || 0) + (crapsDontPassOdds || 0), 0);
      if(!live){
        // Same layout again, like a player re-placing their line bet each come-out
        if(ap.crapsSnap && sum(ap.crapsSnap) > 0 && safe(() => crapsPoint == null, true)){
          safe(() => { Object.keys(ap.crapsSnap).forEach(k => { crapsStaged[k] = JSON.parse(JSON.stringify(ap.crapsSnap[k])); }); crapsRenderBetSpots(); });
          return 'acted';
        }
        return { stop: 'Put a bet down on the table first, then start Auto Play.' };
      }
      if(vis('crapsRollBtn')){ press('crapsRollBtn'); return 'started'; }
      return 'busy';
    },
    slots(ap){
      if(vis('slotsGambleCollectBtn')){ press('slotsGambleCollectBtn'); return 'acted'; }
      if(safe(() => slotsFreeSpinsRemaining > 0 || slotsAutoSpinRunning || slotsGambleBusy, false)) return 'busy';
      if(vis('slotsSpinBtn')){ setBet('slots', ap.bet); press('slotsSpinBtn'); return 'started'; }
      return 'busy';
    },
    videopoker(ap){
      if(safe(() => vpGambleBusy, false)) return 'busy';
      if(vis('vpGambleCollectBtn')){ press('vpGambleCollectBtn'); return 'acted'; }
      const stage = safe(() => vpStage, 'idle');
      if(stage === 'dealt'){
        if(ap.vpHeldFor !== ap.rounds){
          ap.vpHeldFor = ap.rounds;
          const want = safe(() => vpPlayDealer, false) ? null : vpBestHold(safe(() => vpHand, []));
          if(want){
            document.querySelectorAll('#vpHandRow .vp-hold-pill:not(.vp-extra-hold-pill)').forEach(p => { const i = +p.dataset.idx; if(!!safe(() => vpHeld[i], false) !== want[i]) p.click(); });
            safe(() => vpExtraHands.forEach((eh, hi) => { const w = vpBestHold(eh.hand); document.querySelectorAll(`.vp-extra-hold-pill[data-hand="${hi}"]`).forEach(p => { const i = +p.dataset.idx; if(!!eh.held[i] !== w[i]) p.click(); }); }));
          }
          return 'acted';
        }
        if(vis('vpDrawBtn')){ press('vpDrawBtn'); return 'acted'; }
        return 'busy';
      }
      if(vis('vpDealBtn')){ setBet('videopoker', ap.bet); press('vpDealBtn'); return 'started'; }
      return 'busy';
    },
    plinko(ap){
      if(safe(() => plinkoDropping, false)) return 'busy';
      if(vis('plinkoDropBtn')){ setBet('plinko', ap.bet); press('plinkoDropBtn'); return 'started'; }
      return 'busy';
    },
    bigwheel(){
      if(safe(() => bigWheelSpinning, false)) return 'busy';
      if(!safe(() => sum(bigWheelStaged), 0)){
        if(vis('bigWheelSameBetBtn')){ press('bigWheelSameBetBtn'); return 'acted'; }
        return { stop: 'Put a bet on the wheel first, then start Auto Play.' };
      }
      if(vis('bigWheelSpinBtn')){ press('bigWheelSpinBtn'); return 'started'; }
      return 'busy';
    },
    mines(ap){
      if(safe(() => minesActionInFlight, false)) return 'busy';
      if(safe(() => minesRoundActive, false)){
        if(safe(() => minesRevealedCount, 0) >= (ap.cfg.minesTiles || 2)){
          const b = vis('minesCashOutBtn') ? 'minesCashOutBtn' : vis('minesCashOutTopBtn') ? 'minesCashOutTopBtn' : null;
          if(b){ press(b); return 'acted'; } return 'busy';
        }
        const tiles = [...document.querySelectorAll('#minesGrid .mines-tile:not(.revealed):not(.disabled)')];
        if(tiles.length){ tiles[Math.floor(Math.random() * tiles.length)].click(); return 'acted'; }
        return 'busy';
      }
      if(vis('minesNewGameBtn')){ press('minesNewGameBtn'); return 'acted'; }
      if(vis('minesStartBtn')){ setBet('mines', ap.bet); press('minesStartBtn'); return 'started'; }
      return 'busy';
    },
    crash(ap){
      if(safe(() => crashRunning, false)) return 'busy';
      if(vis('crashStartBtn')){ setBet('crash', ap.bet); press('crashStartBtn'); return 'started'; }
      return 'busy';
    },
    doubleornothing(ap){
      if(safe(() => donFlipping, false)) return 'busy';
      if(safe(() => donRoundActive, false)){
        if(safe(() => donStreak, 0) >= (ap.cfg.donWins || 1)){ if(vis('donBankBtn')){ press('donBankBtn'); return 'acted'; } return 'busy'; }
        const b = Math.random() < .5 ? 'donHeadsBtn' : 'donTailsBtn';
        if(vis(b)){ press(b); return 'acted'; } return 'busy';
      }
      const b = Math.random() < .5 ? 'donHeadsBtn' : 'donTailsBtn';
      if(vis(b)){ setBet('doubleornothing', ap.bet); press(b); return 'started'; }
      return 'busy';
    },
  };

  function apOnResult(game, amount){
    if(!AP.running || AP.game !== game) return;
    const c = AP.cfg;
    if(c.stopWin && amount >= c.stopWin) AP.bigHit = true;
    if(GAMES[game].prog){
      if(amount < 0 && c.onLoss === 'double') AP.bet = Math.min(maxBet(), AP.bet * 2);
      else if(amount > 0 && c.onWin === 'reset') AP.bet = AP.base;
      else if(amount > 0 && c.onWin === 'double') AP.bet = Math.min(maxBet(), AP.bet * 2);
      else if(amount < 0 && c.onLoss === 'reset') AP.bet = AP.base;
    }
    apBar();
  }
  function apStart(game, cfg){
    const g = GAMES[game]; if(!g || !ADAPT[game]) return;
    const inp = $(g.bet); const base = parseInt(inp && inp.value, 10) || 0;
    if(g.prog && base <= 0){ toastMsg('Add some chips first, then start Auto Play.'); return; }
    Object.assign(AP, { running: true, game, rounds: 0, target: cfg.rounds || 0, net: 0, base, bet: base, cfg, bigHit: false, vpHeldFor: null, waitUntil: 0, lastErr: '' });
    AP.crapsSnap = null;
    if(game === 'craps') safe(() => {
      const snap = JSON.parse(JSON.stringify(crapsStaged));
      if(!sum(snap)){ Object.keys(snap).forEach(k => { snap[k] = typeof snap[k] === 'object' ? Object.fromEntries(Object.keys(snap[k]).map(n => [n, 0])) : 0; }); snap.pass = crapsLive.pass || 0; snap.dontpass = crapsLive.dontpass || 0; }
      AP.crapsSnap = snap;
    });
    const err = $(g.err); AP.lastErr = err ? err.textContent : '';
    if(game === 'slots' && safe(() => slotsAutoSpinRunning, false)) press('slotsAutoSpinBtn');
    document.body.classList.add('cp-autoplaying');
    try{ window.dispatchEvent(new CustomEvent('cp:autoplay', { detail: { running: true } })); }catch(e){}
    apBar(); buzz(15);
  }
  function apStop(msg){
    if(!AP.running) return;
    AP.running = false;
    document.body.classList.remove('cp-autoplaying');
    try{ window.dispatchEvent(new CustomEvent('cp:autoplay', { detail: { running: false } })); }catch(e){}
    const bar = $('cpApBar'); if(bar) bar.classList.remove('show');
    if(msg) toastMsg(msg + (AP.rounds ? ` ${AP.rounds} round${AP.rounds === 1 ? '' : 's'}, ${AP.net >= 0 ? '+' : '−'}${fmt(AP.net)} XP.` : ''));
  }
  function apBar(){
    let bar = $('cpApBar');
    if(!bar){
      bar = document.createElement('div'); bar.id = 'cpApBar'; bar.className = 'cp-apbar';
      bar.innerHTML = `<span class="cp-apbar-dot"></span><div class="cp-apbar-txt"><b class="cp-apbar-title"></b><span class="cp-apbar-sub"></span></div><button type="button" class="cp-apbar-stop">Stop</button>`;
      document.body.appendChild(bar);
      bar.querySelector('.cp-apbar-stop').addEventListener('click', () => apStop('Auto Play stopped.'));
    }
    if(!AP.running){ bar.classList.remove('show'); return; }
    bar.querySelector('.cp-apbar-title').textContent = `Auto Play · ${GAMES[AP.game].label}`;
    bar.querySelector('.cp-apbar-sub').innerHTML = `${AP.rounds}${AP.target ? ' / ' + AP.target : ''} rounds <i class="${AP.net >= 0 ? 'w' : 'l'}">${AP.net >= 0 ? '+' : '−'}${fmt(AP.net)} XP</i>`;
    bar.classList.add('show');
  }
  function toastMsg(m){ if(typeof window.showToast === 'function'){ try{ window.showToast(m); return; }catch(e){} } let t = $('cpToast'); if(!t){ t = document.createElement('div'); t.id = 'cpToast'; t.className = 'cp-toast'; document.body.appendChild(t); } t.textContent = m; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3200); }

  setInterval(() => {
    if(!AP.running) return;
    if(document.hidden) return;
    if(currentGame !== AP.game){ apStop('Stopped: you left the table.'); return; }
    if(Date.now() < AP.waitUntil) return;
    const g = GAMES[AP.game]; const err = $(g.err);
    if(err && err.textContent && err.textContent !== AP.lastErr && err.offsetParent !== null){ apStop('Stopped: ' + err.textContent.trim()); return; }
    if(!(IN_PLAY[AP.game] && IN_PLAY[AP.game]())){ const hit = stopRuleHit(); if(hit){ apStop(hit); return; } }
    const res = ADAPT[AP.game](AP);
    if(res && res.stop){ apStop(res.stop); return; }
    if(res === 'started'){ AP.rounds++; AP.waitUntil = Date.now() + 500; apBar(); return; }
    if(res === 'acted'){ AP.waitUntil = Date.now() + 350; return; }
  }, 250);
  function stopRuleHit(){
    const c = AP.cfg;
    if(AP.target && AP.rounds >= AP.target) return `Auto Play finished.`;
    if(c.stopUp && AP.net >= c.stopUp) return `Target reached: up ${fmt(AP.net)} XP.`;
    if(c.stopDown && AP.net <= -c.stopDown) return `Loss limit reached.`;
    if(AP.bigHit) return `Stopped on a big win.`;
    return null;
  }
  // Stop rules run BEFORE the adapter, and only while nothing is in play.
  // Each game exposes "in play" differently:
  const IN_PLAY = {
    blackjack: () => safe(() => bjHandActive || bjStarting, false) || (!vis('bjNewHandBtn') && !vis('bjDealBtn')),
    baccarat: () => vis('bacHitBtn') || safe(() => bacDealing, false),
    war: () => vis('warGoBtn') || safe(() => warDealing, false),
    roulette: () => safe(() => rouletteSpinning, false),
    craps: () => safe(() => crapsRolling, false),
    slots: () => safe(() => slotsFreeSpinsRemaining > 0 || slotsGambleBusy, false) || vis('slotsGambleCollectBtn') || !vis('slotsSpinBtn'),
    videopoker: () => safe(() => vpStage === 'dealt' || vpGambleBusy, false) || vis('vpGambleCollectBtn'),
    plinko: () => safe(() => plinkoDropping, false),
    bigwheel: () => safe(() => bigWheelSpinning, false),
    mines: () => safe(() => minesRoundActive || minesActionInFlight, false),
    crash: () => safe(() => crashRunning, false),
    doubleornothing: () => safe(() => donRoundActive || donFlipping, false),
  };
  // ---------- Auto Play / table settings sheet ----------
  function openSheet(game){
    const g = GAMES[game]; if(!g) return;
    const cfg = Object.assign({}, AP_DEFAULT, LS.get('cp-ap-' + game, {}));
    let sh = $('cpSheet');
    if(!sh){ sh = document.createElement('div'); sh.id = 'cpSheet'; sh.className = 'cp-sheet-wrap'; document.body.appendChild(sh); sh.addEventListener('click', (e) => { if(e.target === sh) sh.classList.remove('open'); }); }
    const seg = (name, opts, val) => `<div class="cp-seg" data-name="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${String(v) === String(val) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    const num = (name, val, ph) => `<input type="number" inputmode="numeric" min="0" data-name="${name}" value="${val || ''}" placeholder="${ph}">`;
    const running = AP.running && AP.game === game;
    sh.innerHTML = `<div class="cp-sheet" role="dialog" aria-label="Auto Play">
      <div class="cp-sheet-grab"></div>
      <div class="cp-sheet-head"><h3>Auto Play</h3><span>${g.label}</span></div>
      ${running ? `<div class="cp-sheet-running">Running: ${AP.rounds}${AP.target ? ' / ' + AP.target : ''} rounds, ${AP.net >= 0 ? '+' : '−'}${fmt(AP.net)} XP</div>` : ''}
      <div class="cp-field"><label>Rounds</label>${seg('rounds', [[10, '10'], [25, '25'], [50, '50'], [100, '100'], [0, 'No limit']], cfg.rounds)}</div>
      ${game === 'crash' ? `<div class="cp-field"><label>Cash out at</label><span class="cp-num-x">${`<input type="number" inputmode="decimal" step="0.1" min="1.01" data-name="crashTarget" value="${Number(cfg.crashTarget || 2).toFixed(2)}">`}<i>x</i></span></div>` : ''}
      ${game === 'mines' ? `<div class="cp-field"><label>Tiles to open, then cash out</label>${seg('minesTiles', [[1, '1'], [2, '2'], [3, '3'], [5, '5'], [8, '8']], cfg.minesTiles)}</div>` : ''}
      ${game === 'doubleornothing' ? `<div class="cp-field"><label>Bank after</label>${seg('donWins', [[1, '1 win'], [2, '2 wins'], [3, '3 wins']], cfg.donWins)}</div>` : ''}
      ${['roulette', 'craps', 'bigwheel'].includes(game) ? `<div class="cp-note">Uses the bets you've put on the table, every round.</div>` : ''}
      ${game === 'blackjack' ? `<div class="cp-note">Plays every hand by the book (basic strategy). Insurance is always declined.</div>` : ''}
      ${game === 'videopoker' ? `<div class="cp-note">Holds the best cards for you on every hand and collects any win.</div>` : ''}
      <div class="cp-sub">Stop when</div>
      <div class="cp-grid2">
        <div class="cp-field"><label>Up by (XP)</label>${num('stopUp', cfg.stopUp, 'Off')}</div>
        <div class="cp-field"><label>Down by (XP)</label>${num('stopDown', cfg.stopDown, 'Off')}</div>
      </div>
      <div class="cp-field"><label>A single win of at least (XP)</label>${num('stopWin', cfg.stopWin, 'Off')}</div>
      ${g.prog ? `<div class="cp-sub">Bet changes</div>
      <div class="cp-field"><label>After a loss</label>${seg('onLoss', [['same', 'Same bet'], ['double', 'Double it'], ['reset', 'Back to start']], cfg.onLoss)}</div>
      <div class="cp-field"><label>After a win</label>${seg('onWin', [['same', 'Same bet'], ['reset', 'Back to start'], ['double', 'Double it']], cfg.onWin)}</div>` : ''}
      <div class="cp-sub">Table</div>
      <div class="cp-toggle-row"><span>Vibration</span><label class="cp-switch"><input type="checkbox" data-set="haptics" ${S.haptics ? 'checked' : ''}><span></span></label></div>
      ${(game === 'blackjack' || game === 'videopoker') ? `<div class="cp-toggle-row"><span>Show best-move hints</span><label class="cp-switch"><input type="checkbox" data-set="hints" ${S.hints ? 'checked' : ''}><span></span></label></div>` : ''}
      <div class="cp-sheet-actions">
        ${running ? '<button type="button" class="pill-btn cp-stop-btn">Stop Auto Play</button>' : '<button type="button" class="pill-btn pill-btn-primary cp-go-btn">Start Auto Play</button>'}
      </div>
    </div>`;
    sh.querySelectorAll('.cp-seg').forEach(s => s.addEventListener('click', (e) => { const b = e.target.closest('button'); if(!b) return; s.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); }));
    sh.querySelectorAll('[data-set]').forEach(i => i.addEventListener('change', () => { S[i.dataset.set] = i.checked; saveS(); hintRefresh(); }));
    const read = () => {
      const out = Object.assign({}, cfg);
      sh.querySelectorAll('.cp-seg').forEach(s => { const on = s.querySelector('button.on'); if(on){ const v = on.dataset.v; out[s.dataset.name] = isNaN(+v) ? v : +v; } });
      sh.querySelectorAll('input[data-name]').forEach(i => { out[i.dataset.name] = parseFloat(i.value) || 0; });
      if(out.crashTarget && out.crashTarget < 1.01) out.crashTarget = 1.01;
      return out;
    };
    const go = sh.querySelector('.cp-go-btn');
    if(go) go.addEventListener('click', () => { const c = read(); LS.set('cp-ap-' + game, c); sh.classList.remove('open'); apStart(game, c); });
    const st = sh.querySelector('.cp-stop-btn');
    if(st) st.addEventListener('click', () => { sh.classList.remove('open'); apStop('Auto Play stopped.'); });
    requestAnimationFrame(() => sh.classList.add('open'));
  }

  // ---------- deal haptics + plinko trail ----------
  new MutationObserver((muts) => {
    if(!S.haptics) return;
    for(const m of muts){ for(const n of m.addedNodes){ if(n.nodeType === 1 && (n.classList.contains('pc-dealt') || (n.querySelector && n.querySelector('.pc-dealt')))){ buzz(6); return; } } }
  }).observe(document.body, { childList: true, subtree: true });
  let trailRaf = null;
  function plinkoTrail(){
    const wrap = $('plinkoBoardWrap');
    if(wrap && currentGame === 'plinko'){
      const balls = wrap.querySelectorAll('.plinko-ball');
      if(balls.length){
        const wr = wrap.getBoundingClientRect();
        balls.forEach(b => {
          const r = b.getBoundingClientRect(); if(!r.width) return;
          const x = r.left - wr.left + r.width / 2, y = r.top - wr.top + r.height / 2;
          if(b._lx != null && Math.hypot(x - b._lx, y - b._ly) < 3) return;
          b._lx = x; b._ly = y;
          const d = document.createElement('span'); d.className = 'cp-trail'; d.style.left = x + 'px'; d.style.top = y + 'px';
          wrap.appendChild(d); setTimeout(() => d.remove(), 420);
        });
      }
    }
    trailRaf = requestAnimationFrame(plinkoTrail);
  }
  if(!window.matchMedia || !matchMedia('(prefers-reduced-motion: reduce)').matches) trailRaf = requestAnimationFrame(plinkoTrail);

  // ---------- hide the old per-game auto controls (Auto Play covers every table now) ----------
  ['bacAutoPlayBtn', 'bacAutoPlayCountRow', 'slotsAutoSpinBtn', 'slotsAutoSpinCountRow'].forEach(id => {
    const el = $(id); if(!el) return; el.classList.add('cp-hidden');
    const prev = el.previousElementSibling; if(/CountRow$/.test(id) && prev && prev.classList.contains('craps-section-label')) prev.classList.add('cp-hidden');
  });
  // While Auto Play runs, the per-round Pot / streak toasts would pile up;
  // the running bar already shows the score, so those stay quiet.
  if(typeof window.showToast === 'function'){
    const origToast = window.showToast;
    window.showToast = function(msg){ if(AP.running && /^(🎰 Pot|🔥 \d+ in a row)/.test(String(msg || ''))) return; return origToast.apply(this, arguments); };
  }

  addBetTools();
  window.casinoPremium = { AP, apStart, apStop, vpBestHold, bjBest, settings: S, history };
})();
