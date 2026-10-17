// casino-luxe.js (v198)
// The casino as a proper online casino: a lobby of artwork tiles with
// categories and a live jackpot banner, every game opening full screen
// under its own top bar (back, game name, balance, rules), a richer table
// look (felt, rail, cards, slot cabinet), and a light particle layer for
// wins. Works on top of the existing games: it restyles and rearranges
// what's already there and never changes how a game settles.
(function(){
  'use strict';
  const $ = (id) => document.getElementById(id);
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lite = () => document.documentElement.classList.contains('cp-lite') || document.body.classList.contains('cp-lite');

  // ---------- game catalogue ----------
  // cat: tables | slots | instant | live | skill
  const GAMES = {
    blackjack:       { name: 'Blackjack',        cat: 'tables',  tag: 'Classic',  a: '#0f7a4f', b: '#03291b', icon: 'bj' },
    baccarat:        { name: 'Baccarat',         cat: 'tables',  tag: '',         a: '#8c1830', b: '#22050c', icon: 'bac' },
    roulette:        { name: 'Roulette',         cat: 'tables',  tag: 'American', a: '#7a1218', b: '#180405', icon: 'rou' },
    war:             { name: 'Casino War',       cat: 'tables',  tag: '',         a: '#2d3f9c', b: '#080d2b', icon: 'war' },
    craps:           { name: 'Craps',            cat: 'tables',  tag: '',         a: '#0e7466', b: '#03221d', icon: 'craps' },
    slots:           { name: 'Slots',            cat: 'slots',   tag: 'Jackpot',  a: '#a86b00', b: '#2a1500', icon: 'slots' },
    videopoker:      { name: 'Video Poker',      cat: 'slots',   tag: '',         a: '#1a4fa0', b: '#050f26', icon: 'vp' },
    plinko:          { name: 'Plinko',           cat: 'instant', tag: '',         a: '#7a25a8', b: '#1a0628', icon: 'plinko' },
    bigwheel:        { name: 'Big Wheel',        cat: 'instant', tag: '',         a: '#b04a06', b: '#2a0e00', icon: 'wheel' },
    mines:           { name: 'Mines',            cat: 'instant', tag: '',         a: '#16725a', b: '#04140f', icon: 'mines' },
    crash:           { name: 'Crash',            cat: 'instant', tag: 'Hot',      a: '#1569b8', b: '#03122a', icon: 'crash' },
    doubleornothing: { name: 'Double or Nothing',cat: 'instant', tag: '',         a: '#8f7a08', b: '#211b00', icon: 'coin' },
    pong:            { name: 'Pong',             cat: 'skill',   tag: '',         a: '#3a4a58', b: '#0b1117', icon: 'pong' },
    minigolf:        { name: 'Mini Golf',        cat: 'skill',   tag: '',         a: '#3f8a2a', b: '#0b2207', icon: 'golf' },
  };
  const EXTRA = { // bubbles without data-game
    hubHoldemBtn:     { name: "Hold'em",        cat: 'live',  tag: 'Live', a: '#9a1c2a', b: '#1d0408', icon: 'chip' },
    hubMpBjBtn:       { name: 'Live Blackjack', cat: 'live',  tag: 'Live', a: '#0d6a62', b: '#021a18', icon: 'livebj' },
    hubChallengesBtn: { name: 'Challenges',     cat: 'live',  tag: '',     a: '#5a2a9c', b: '#12062a', icon: 'vs' },
    hubBountiesBtn:   { name: 'Bounties',       cat: 'skill', tag: '',     a: '#9c2a5a', b: '#26061a', icon: 'target' },
  };
  const CATS = [['all', 'All games'], ['tables', 'Tables'], ['slots', 'Slots & poker'], ['instant', 'Instant'], ['live', 'Live'], ['skill', 'Skill']];

  // ---------- icon sprite ----------
  const G = 'url(#czGold)';
  const ICONS = {
    bj: `<rect x="9" y="10" width="20" height="28" rx="3" transform="rotate(-12 19 24)" fill="#fff" opacity=".9"/><rect x="19" y="9" width="20" height="28" rx="3" transform="rotate(10 29 23)" fill="#fff"/><text x="30" y="27" font-size="11" font-weight="800" text-anchor="middle" fill="#111" transform="rotate(10 29 23)">A</text><path d="M30 29.5c-2 2-4 3.4-4 5a2 2 0 0 0 3.4 1.4L29 38h2l-.4-2.1A2 2 0 0 0 34 34.5c0-1.6-2-3-4-5z" fill="#111" transform="rotate(10 29 23) translate(0 -4) scale(.8) translate(7 6)"/>`,
    bac: `<rect x="8" y="11" width="19" height="27" rx="3" transform="rotate(-10 17 24)" fill="#fff"/><rect x="21" y="11" width="19" height="27" rx="3" transform="rotate(10 30 24)" fill="#fff"/><text x="17" y="29" font-size="13" font-weight="800" text-anchor="middle" fill="#c8202f" transform="rotate(-10 17 24)">9</text><text x="30" y="29" font-size="13" font-weight="800" text-anchor="middle" fill="#111" transform="rotate(10 30 24)">K</text>`,
    rou: `<circle cx="24" cy="24" r="17" fill="${G}"/><circle cx="24" cy="24" r="14" fill="#1a0f0a"/><circle cx="24" cy="24" r="12.5" fill="none" stroke="#c8202f" stroke-width="5" stroke-dasharray="3.27 3.27"/><circle cx="24" cy="24" r="12.5" fill="none" stroke="#111" stroke-width="5" stroke-dasharray="3.27 3.27" stroke-dashoffset="3.27"/><circle cx="24" cy="24" r="6" fill="${G}"/><circle cx="31" cy="14.5" r="2.2" fill="#fff"/>`,
    war: `<rect x="10" y="10" width="18" height="26" rx="3" transform="rotate(-22 19 23)" fill="#fff"/><rect x="20" y="10" width="18" height="26" rx="3" transform="rotate(22 29 23)" fill="#fff"/><path d="M24 17l2 4 4 .6-3 2.9.7 4.2L24 26.6l-3.7 2.1.7-4.2-3-2.9 4-.6z" fill="${G}"/>`,
    craps: `<rect x="7" y="15" width="18" height="18" rx="4" transform="rotate(-14 16 24)" fill="#fff"/><rect x="23" y="12" width="18" height="18" rx="4" transform="rotate(12 32 21)" fill="#fff"/><g fill="#c8202f" transform="rotate(-14 16 24)"><circle cx="11.5" cy="19.5" r="1.7"/><circle cx="16" cy="24" r="1.7"/><circle cx="20.5" cy="28.5" r="1.7"/></g><g fill="#111" transform="rotate(12 32 21)"><circle cx="27.5" cy="16.5" r="1.7"/><circle cx="36.5" cy="16.5" r="1.7"/><circle cx="27.5" cy="25.5" r="1.7"/><circle cx="36.5" cy="25.5" r="1.7"/></g>`,
    slots: `<rect x="7" y="9" width="30" height="31" rx="5" fill="${G}"/><rect x="10" y="15" width="24" height="15" rx="2.5" fill="#160b00"/><g font-size="11" font-weight="900" text-anchor="middle" fill="#ff3b45"><text x="14.5" y="26.5">7</text><text x="22" y="26.5">7</text><text x="29.5" y="26.5">7</text></g><rect x="10" y="33" width="24" height="3" rx="1.5" fill="#160b00" opacity=".6"/><path d="M39 13v13" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="39" cy="11.5" r="3" fill="#ff3b45"/>`,
    vp: `<g transform="translate(24 30)"><rect x="-8" y="-20" width="16" height="23" rx="2.5" transform="rotate(-28) translate(-2 0)" fill="#fff"/><rect x="-8" y="-20" width="16" height="23" rx="2.5" transform="rotate(-10)" fill="#fff"/><rect x="-8" y="-20" width="16" height="23" rx="2.5" transform="rotate(10)" fill="#fff"/><rect x="-8" y="-20" width="16" height="23" rx="2.5" transform="rotate(28) translate(2 0)" fill="#fff"/><text x="0" y="-10" font-size="9" font-weight="900" text-anchor="middle" fill="#c8202f" transform="rotate(28) translate(2 0)">A</text></g>`,
    plinko: `<g fill="#fff" opacity=".85"><circle cx="24" cy="14" r="1.8"/><circle cx="19" cy="20" r="1.8"/><circle cx="29" cy="20" r="1.8"/><circle cx="14" cy="26" r="1.8"/><circle cx="24" cy="26" r="1.8"/><circle cx="34" cy="26" r="1.8"/><circle cx="9" cy="32" r="1.8"/><circle cx="19" cy="32" r="1.8"/><circle cx="29" cy="32" r="1.8"/><circle cx="39" cy="32" r="1.8"/></g><rect x="6" y="36" width="36" height="5" rx="2" fill="${G}"/><circle cx="21.5" cy="23" r="3.2" fill="#ff4fa3"/>`,
    wheel: `<circle cx="24" cy="26" r="16" fill="${G}"/><circle cx="24" cy="26" r="13.5" fill="#fff"/><path d="M24 26V12.5A13.5 13.5 0 0 1 35.7 19.3zM24 26l11.7 6.7A13.5 13.5 0 0 1 24 39.5zM24 26 12.3 32.7A13.5 13.5 0 0 1 12.3 19.3z" fill="#e8590c"/><circle cx="24" cy="26" r="3.5" fill="${G}"/><path d="M24 4l3.5 6h-7z" fill="#fff"/>`,
    mines: `<path d="M24 8l12 9-12 23-12-23z" fill="#7ff0c8"/><path d="M12 17h24L24 40z" fill="#2ec795"/><path d="M18 17l6-9 6 9z" fill="#c8fff0"/><path d="M12 17l6 0 6 23z" fill="#1fa77b" opacity=".7"/>`,
    crash: `<path d="M7 38c10-2 18-8 24-21" stroke="${G}" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M29 9c4-1.5 8-1.2 10-.6.6 2 .9 6-.6 10l-5.5 5.5-9.4-9.4z" fill="#fff"/><path d="M23.5 14.5l-4.5.6-3.5 4.2 6.2.5zM33.5 24.5l-.6 4.5-4.2 3.5-.5-6.2z" fill="#ff4f5e"/><circle cx="33.5" cy="14.5" r="2.4" fill="#1569b8"/><path d="M22 27l-4 6 6-4z" fill="#ffb03b"/>`,
    coin: `<circle cx="24" cy="24" r="16" fill="${G}"/><circle cx="24" cy="24" r="12.5" fill="none" stroke="#5a4400" stroke-width="1.5" stroke-dasharray="2 2.2"/><text x="24" y="29.5" font-size="14" font-weight="900" text-anchor="middle" fill="#3d2e00">×2</text>`,
    pong: `<rect x="9" y="12" width="5" height="18" rx="2.5" fill="#fff"/><rect x="34" y="20" width="5" height="18" rx="2.5" fill="#fff"/><circle cx="26" cy="22" r="3.5" fill="${G}"/><path d="M24 8v32" stroke="#fff" stroke-width="1.5" stroke-dasharray="3 3" opacity=".5"/>`,
    golf: `<ellipse cx="24" cy="38" rx="15" ry="4" fill="#2f7a1e"/><ellipse cx="27" cy="38" rx="3.5" ry="1.4" fill="#0b1a07"/><path d="M27 38V9" stroke="#fff" stroke-width="2"/><path d="M27 9l12 5-12 5z" fill="#ff3b45"/><circle cx="16" cy="35" r="2.6" fill="#fff"/>`,
    chip: `<circle cx="24" cy="24" r="16" fill="#c8202f"/><circle cx="24" cy="24" r="16" fill="none" stroke="#fff" stroke-width="5" stroke-dasharray="5 7.57"/><circle cx="24" cy="24" r="10" fill="#9a1622" stroke="${G}" stroke-width="1.5"/><path d="M24 18.5c-2.6 2.6-5 4.3-5 6.4a2.5 2.5 0 0 0 4.3 1.8L22.6 30h2.8l-.7-3.3A2.5 2.5 0 0 0 29 24.9c0-2.1-2.4-3.8-5-6.4z" fill="#fff"/>`,
    livebj: `<rect x="10" y="12" width="17" height="24" rx="3" transform="rotate(-10 18 24)" fill="#fff"/><rect x="20" y="12" width="17" height="24" rx="3" transform="rotate(10 28 24)" fill="#fff"/><text x="28" y="28" font-size="10" font-weight="900" text-anchor="middle" fill="#c8202f" transform="rotate(10 28 24)">21</text><circle cx="39" cy="10" r="4" fill="#ff3b45"/>`,
    vs: `<path d="M10 12l10 10M38 12 28 22M14 36l6-6M34 36l-6-6" stroke="#fff" stroke-width="3" stroke-linecap="round"/><text x="24" y="31" font-size="12" font-weight="900" text-anchor="middle" fill="${G}">VS</text>`,
    target: `<circle cx="24" cy="24" r="16" fill="#fff"/><circle cx="24" cy="24" r="11.5" fill="#c8202f"/><circle cx="24" cy="24" r="7" fill="#fff"/><circle cx="24" cy="24" r="3" fill="#c8202f"/><path d="M24 24l13-13M33 8l4 3 3 4" stroke="${G}" stroke-width="2.5" stroke-linecap="round" fill="none"/>`,
    gift: `<rect x="9" y="20" width="30" height="20" rx="3" fill="#c8202f"/><rect x="7" y="15" width="34" height="7" rx="2" fill="#e0303f"/><rect x="21.5" y="15" width="5" height="25" fill="${G}"/><path d="M24 15c-3-6-10-6-9-1 1 3 6 1 9 1zm0 0c3-6 10-6 9-1-1 3-6 1-9 1z" fill="${G}"/>`,
  };
  function iconSvg(key, cls){
    return `<svg class="${cls || 'cz-ic'}" viewBox="0 0 48 48" aria-hidden="true"><use href="#czi-${key}"/></svg>`;
  }
  function injectSprite(){
    if($('czSprite')) return;
    const div = document.createElement('div');
    div.innerHTML = `<svg id="czSprite" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">
      <defs><linearGradient id="czGold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE9A8"/><stop offset=".45" stop-color="#F2C14E"/><stop offset="1" stop-color="#A8741E"/></linearGradient></defs>
      ${Object.entries(ICONS).map(([k, v]) => `<symbol id="czi-${k}" viewBox="0 0 48 48">${v}</symbol>`).join('')}
    </svg>`;
    document.body.appendChild(div.firstElementChild);
  }

  // ---------- lobby ----------
  function fmt(n){ return Math.round(Number(n) || 0).toLocaleString('en-AU'); }
  function jackpotNow(){
    try{ if(typeof slotsJackpotAmount === 'number' && slotsJackpotAmount > 0) return slotsJackpotAmount; }catch(e){}
    const el = $('slotsJackpotLobbyVal') || $('slotsJackpotVal');
    const n = el ? parseInt(String(el.textContent).replace(/[^\d]/g, ''), 10) : 0;
    return n || 5000;
  }
  let shownJackpot = 0, jackpotRaf = null;
  function tickJackpot(){
    const el = $('czJackpotVal'); if(!el) return;
    const target = jackpotNow();
    if(reduceMotion() || !shownJackpot){ shownJackpot = target; el.textContent = fmt(target); return; }
    cancelAnimationFrame(jackpotRaf);
    const from = shownJackpot, t0 = performance.now(), dur = 900;
    const step = (t) => { const k = Math.min(1, (t - t0) / dur); const v = from + (target - from) * (1 - Math.pow(1 - k, 3)); el.textContent = fmt(v); if(k < 1) jackpotRaf = requestAnimationFrame(step); else shownJackpot = target; };
    jackpotRaf = requestAnimationFrame(step);
  }

  function tileHtml(meta, extraHtml){
    return `<span class="cz-tile-art" style="--a:${meta.a};--b:${meta.b}">${iconSvg(meta.icon, 'cz-tile-ic')}</span>
      ${meta.tag ? `<span class="cz-tile-tag${meta.tag === 'Live' ? ' live' : meta.tag === 'Hot' ? ' hot' : meta.tag === 'Jackpot' ? ' jp' : ''}">${meta.tag}</span>` : ''}
      <span class="cz-tile-name">${meta.name}</span>${extraHtml || ''}`;
  }
  function buildLobby(){
    const grid = $('casinoGamesGridPanel'); if(!grid || grid.dataset.cz) return;
    grid.dataset.cz = '1';
    const row = grid.querySelector('.game-bubble-row');
    // hero: progressive jackpot
    const hero = document.createElement('div');
    hero.className = 'cz-hero';
    hero.innerHTML = `<div class="cz-hero-glow"></div>
      <div class="cz-hero-kicker">Progressive jackpot</div>
      <div class="cz-hero-amt"><span id="czJackpotVal">${fmt(jackpotNow())}</span><small>XP</small></div>
      <div class="cz-hero-sub">Five 7s on a payline takes the lot</div>
      <button type="button" class="cz-hero-cta" id="czHeroPlay">Play Slots</button>
      ${iconSvg('slots', 'cz-hero-ic')}`;
    grid.insertBefore(hero, grid.firstChild);
    hero.querySelector('#czHeroPlay').addEventListener('click', () => { const b = document.querySelector('.game-bubble[data-game="slots"]'); b && b.click(); });
    // category chips
    const chips = document.createElement('div');
    chips.className = 'cz-cats'; chips.setAttribute('role', 'tablist');
    chips.innerHTML = CATS.map(([k, l], i) => `<button type="button" class="cz-cat${i === 0 ? ' on' : ''}" data-cat="${k}" role="tab" aria-selected="${i === 0}">${l}</button>`).join('');
    grid.insertBefore(chips, row);
    chips.addEventListener('click', (e) => {
      const b = e.target.closest('.cz-cat'); if(!b) return;
      chips.querySelectorAll('.cz-cat').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
      const c = b.dataset.cat;
      row.querySelectorAll('.game-bubble').forEach(t => { t.hidden = !(c === 'all' || t.dataset.czCat === c); });
      try{ localStorage.setItem('cz-cat', c); }catch(_){}
    });
    // tiles
    row.classList.add('cz-tiles');
    row.querySelectorAll('.game-bubble').forEach(btn => {
      const meta = btn.dataset.game ? GAMES[btn.dataset.game] : EXTRA[btn.id];
      if(!meta) return;
      const badges = [...btn.querySelectorAll('.casino-hub-badge')];
      btn.innerHTML = tileHtml(meta);
      badges.forEach(bd => btn.appendChild(bd));
      btn.classList.add('cz-tile');
      btn.dataset.czCat = meta.cat;
      btn.setAttribute('aria-label', meta.name);
    });
    // daily spin as a promo banner
    const wide = grid.querySelector('.game-bubble-wide[data-game="dailyspin"]');
    if(wide){
      wide.classList.add('cz-promo');
      wide.innerHTML = `${iconSvg('gift', 'cz-promo-ic')}<span class="cz-promo-txt"><b>Free spin</b><span>Spin the Wheel for free XP every 2 days</span></span><span class="cz-promo-go">Spin</span>`;
      grid.insertBefore(wide, row);
    }
    try{ const c = localStorage.getItem('cz-cat'); if(c && c !== 'all'){ const b = chips.querySelector(`[data-cat="${c}"]`); b && b.click(); } }catch(_){}
  }

  // featured strip on the casino home, so a game is one tap away
  function buildFeatured(){
    const hub = $('casinoHubPanel'); if(!hub || $('czFeatured')) return;
    const wrap = document.createElement('div');
    wrap.id = 'czFeatured'; wrap.className = 'cz-featured';
    const pick = ['slots', 'blackjack', 'roulette', 'crash', 'videopoker', 'mines', 'baccarat', 'plinko'];
    wrap.innerHTML = `<div class="cz-featured-head"><span>Popular games</span><button type="button" class="cz-link" id="czAllGames">All games</button></div>
      <div class="cz-featured-row">${pick.map(g => `<button type="button" class="cz-ftile" data-cz-open="${g}">${tileHtml(GAMES[g])}</button>`).join('')}</div>`;
    hub.insertBefore(wrap, hub.firstChild);
    const openGames = async (g) => {
      try{ if(typeof showCasinoView === 'function') await showCasinoView('casinoGamesView'); }catch(e){}
      if(g){ const b = document.querySelector(`.game-bubble[data-game="${g}"]`); b && b.click(); }
      try{ if(typeof navPushSoon === 'function') navPushSoon(); }catch(e){}
    };
    wrap.addEventListener('click', (e) => {
      const t = e.target.closest('[data-cz-open]'); if(t){ openGames(t.dataset.czOpen); return; }
      if(e.target.closest('#czAllGames')) openGames(null);
    });
  }

  function hubIcons(){
    const map = { hubGamesBtn: 'chip', hubXpBtn: 'coin', hubBadgesBtn: 'target', hubBookBtn: 'bac' };
    Object.entries(map).forEach(([id, ic]) => { const el = document.querySelector('#' + id + ' .casino-hub-icon'); if(el && !el.dataset.cz){ el.dataset.cz = '1'; el.innerHTML = iconSvg(ic, 'cz-hub-ic'); } });
  }

  // ---------- full-screen game mode ----------
  let activeGame = null;
  function buildBar(){
    const view = $('casinoGamesView'); if(!view || $('czBar')) return;
    const bar = document.createElement('div');
    bar.id = 'czBar'; bar.className = 'cz-bar';
    bar.innerHTML = `<button type="button" class="cz-bar-back" id="czBack" aria-label="Back to the lobby"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
      <span class="cz-bar-title"><span id="czBarIcon"></span><span id="czBarName">Game</span></span>
      <span class="cz-bar-bal" id="czBarBal" aria-live="polite"><i></i><b>—</b><small>XP</small></span>
      <button type="button" class="cz-bar-info" id="czRules" aria-label="Rules"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.2"/></svg></button>`;
    view.insertBefore(bar, view.firstChild);
    $('czBack').addEventListener('click', () => {
      try{ if(typeof navCloseOpenGame === 'function') navCloseOpenGame(); }catch(e){}
      try{ if(typeof navPushSoon === 'function') navPushSoon(); }catch(e){}
      window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    });
    $('czRules').addEventListener('click', () => {
      const panel = activeGame && document.querySelector('.casino-game-panel[style*="block"]');
      const btn = panel && panel.querySelector('.casino-rules-btn'); btn && btn.click();
    });
  }
  function syncBalance(){
    const src = $('xpBalanceDisplay'); const dst = $('czBarBal'); if(!src || !dst) return;
    const b = dst.querySelector('b'); const v = src.textContent.trim();
    if(b.textContent !== v){ b.textContent = v; dst.classList.remove('bump'); void dst.offsetWidth; dst.classList.add('bump'); }
  }
  const PANEL_TO_GAME = {};
  function mapPanels(){
    try{ Object.entries(CASINO_GAME_PANEL_IDS).forEach(([g, id]) => { PANEL_TO_GAME[id] = g; }); }catch(e){}
  }
  function syncGameMode(){
    const view = $('casinoGamesView'), tab = $('tab-casino');
    const inGames = !!(view && view.classList.contains('active') && tab && tab.classList.contains('active'));
    const open = inGames ? [...view.querySelectorAll('.casino-game-panel')].find(p => p.style.display && p.style.display !== 'none') : null;
    if(tab) tab.classList.toggle('cz-lobby', inGames && !open);
    const g = open ? (PANEL_TO_GAME[open.id] || open.id) : null;
    if(g === activeGame) return;
    activeGame = g;
    const tabEl = $('tab-casino'); if(tabEl) tabEl.classList.toggle('cz-game', !!g);
    if(g){
      document.body.dataset.czGame = g;
      const meta = GAMES[g] || (g === 'dailyspin' ? { name: 'Spin the Wheel', icon: 'gift' } : { name: 'Game', icon: 'chip' });
      $('czBarName').textContent = meta.name;
      $('czBarIcon').innerHTML = iconSvg(meta.icon, 'cz-bar-ic');
      syncBalance();
      if(window.scrollY > 0) window.scrollTo(0, 0);
      if(g === 'slots') decorateSlots();
      open.classList.remove('cz-enter'); void open.offsetWidth; open.classList.add('cz-enter');
    } else {
      delete document.body.dataset.czGame;
    }
  }

  // ---------- slot cabinet marquee ----------
  function decorateSlots(){
    const rail = $('slotsTableRail'); if(!rail || rail.querySelector('.cz-marquee')) return;
    const m = document.createElement('div');
    m.className = 'cz-marquee';
    m.innerHTML = `<span class="cz-bulbs" aria-hidden="true"></span><span class="cz-marquee-title">MLSYND <em>777</em></span><span class="cz-marquee-jp">Jackpot <b id="czCabJp">${fmt(jackpotNow())}</b></span>`;
    rail.insertBefore(m, rail.firstChild);
  }

  // ---------- win particles ----------
  let fx = null;
  function fxLayer(){
    if(fx) return fx;
    const c = document.createElement('canvas');
    c.id = 'czFx'; c.setAttribute('aria-hidden', 'true');
    document.body.appendChild(c);
    const ctx = c.getContext('2d');
    fx = { c, ctx, parts: [], raf: null, dpr: Math.min(2, window.devicePixelRatio || 1) };
    const size = () => { fx.c.width = innerWidth * fx.dpr; fx.c.height = innerHeight * fx.dpr; };
    size(); addEventListener('resize', size, { passive: true });
    return fx;
  }
  function burst(tier){
    if(reduceMotion() || lite()) return;
    const f = fxLayer();
    const n = tier === 'mega' ? 140 : tier === 'big' ? 90 : 28;
    const W = innerWidth, H = innerHeight;
    for(let i = 0; i < n; i++){
      const coin = tier !== 'win' && Math.random() < .7;
      f.parts.push(tier === 'win'
        ? { x: W / 2 + (Math.random() - .5) * 60, y: H * .32, vx: (Math.random() - .5) * 7, vy: -Math.random() * 7 - 2, r: 2 + Math.random() * 2.5, life: 1, coin: false, hue: Math.random() < .5 ? 46 : 140, rot: 0, vr: 0 }
        : { x: Math.random() * W, y: -20 - Math.random() * H * .5, vx: (Math.random() - .5) * 2, vy: 2 + Math.random() * 4, r: coin ? 7 + Math.random() * 6 : 3 + Math.random() * 3, life: 1, coin, hue: 46, rot: Math.random() * 6.28, vr: (Math.random() - .5) * .3 });
    }
    if(!f.raf) f.raf = requestAnimationFrame(step);
    if(tier !== 'win'){
      let fl = $('czFlash'); if(!fl){ fl = document.createElement('div'); fl.id = 'czFlash'; fl.setAttribute('aria-hidden', 'true'); document.body.appendChild(fl); }
      fl.classList.remove('on'); void fl.offsetWidth; fl.classList.add('on');
    }
  }
  function step(){
    const f = fx; const { ctx, dpr } = f;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const H = innerHeight;
    f.parts = f.parts.filter(p => p.life > 0 && p.y < H + 30);
    for(const p of f.parts){
      p.x += p.vx; p.y += p.vy; p.vy += p.coin ? .12 : .22; p.rot += p.vr;
      if(!p.coin) p.life -= .018;
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      if(p.coin){
        const w = Math.abs(Math.cos(p.rot)) * p.r;
        const g = ctx.createLinearGradient(p.x - w, p.y - p.r, p.x + w, p.y + p.r);
        g.addColorStop(0, '#FFF1BE'); g.addColorStop(.5, '#F2C14E'); g.addColorStop(1, '#9C6A16');
        ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(p.x, p.y, Math.max(1, w), p.r, 0, 0, 6.283); ctx.fill();
      } else {
        ctx.fillStyle = `hsl(${p.hue} 95% 62%)`; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    if(f.parts.length){ f.raf = requestAnimationFrame(step); }
    else { f.raf = null; ctx.clearRect(0, 0, innerWidth, innerHeight); }
  }

  // ---------- performance helpers ----------
  // Heavy panels below the fold inside games skip layout and paint until
  // scrolled near; hidden tabs pause all their CSS animations.
  function perfHints(){
    document.querySelectorAll('#slotsPaytable, #vpPaytable, .roulette-recent, #crapsBetGrid ~ .hint').forEach(el => el.classList.add('cz-cv'));
  }

  // ---------- wiring ----------
  function init(){
    injectSprite();
    mapPanels();
    buildLobby();
    buildFeatured();
    hubIcons();
    buildBar();
    perfHints();
    // one observer for every game panel's open/close, whatever opened it
    const mo = new MutationObserver(() => { syncGameMode(); });
    document.querySelectorAll('.casino-game-panel').forEach(p => mo.observe(p, { attributes: true, attributeFilter: ['style'] }));
    const view = $('casinoGamesView'); if(view) mo.observe(view, { attributes: true, attributeFilter: ['class'] });
    const bal = $('xpBalanceDisplay');
    if(bal) new MutationObserver(syncBalance).observe(bal, { childList: true, characterData: true, subtree: true });
    // jackpot: follow the lobby/slots values when they change
    ['slotsJackpotLobbyVal', 'slotsJackpotVal'].forEach(id => { const el = $(id); if(el) new MutationObserver(() => { tickJackpot(); const cab = $('czCabJp'); if(cab) cab.textContent = fmt(jackpotNow()); }).observe(el, { childList: true, characterData: true, subtree: true }); });
    window.addEventListener('cp:win', (e) => burst((e.detail && e.detail.tier) || 'win'));
    // leaving the casino tab closes game mode visually
    const tab = $('tab-casino');
    let wasActive = tab && tab.classList.contains('active');
    if(tab) new MutationObserver(() => { const nowActive = tab.classList.contains('active'); if(nowActive === wasActive) return; wasActive = nowActive; (() => { if(!tab.classList.contains('active')){ tab.classList.remove('cz-game', 'cz-lobby'); activeGame = null; } else syncGameMode(); })(); }).observe(tab, { attributes: true, attributeFilter: ['class'] });
    syncGameMode();
    tickJackpot();
    document.body.classList.add('cz-ready');
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.casinoLuxe = { burst, syncGameMode };
})();
