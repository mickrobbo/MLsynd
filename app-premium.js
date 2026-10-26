// ===================== App premium layer (v186) =====================
// Platform-wide polish on top of the existing app, without rewriting it:
//  opening screen + skeleton loading, View Transitions between tabs,
//  pull-to-refresh, full-screen tier-up / badge celebrations, holographic
//  profile card (device tilt), tier rings on photos, a Monday "your week"
//  card with a shareable image, live presence ("who's in the Casino") and
//  a big-win ticker, rolling numbers, one sound switch for the whole app,
//  install prompt, press feedback, app-icon badge, screen wake lock during
//  Auto Play, and a lighter mode for data saver / reduced motion.
(function(){
  'use strict';
  const $ = (id) => document.getElementById(id);
  const LS = {
    get(k, d){ try{ const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }catch(e){ return d; } },
    set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
  };
  const safe = (fn, d) => { try{ return fn(); }catch(e){ return d; } };
  const reduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const saveData = !!(navigator.connection && navigator.connection.saveData);
  if(reduced || saveData) document.documentElement.classList.add('cp-lite');
  const casinoSettings = () => LS.get('cp-settings', { haptics: true });
  const buzz = (p) => { if(casinoSettings().haptics !== false && navigator.vibrate){ try{ navigator.vibrate(p); }catch(e){} } };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (v) => safe(() => homeMoney(v), '$' + Math.round(v));

  // ---------- 1. opening screen + skeleton loading ----------
  const splash = $('cpSplash');
  const t0 = Date.now();
  function hideSplash(){
    if(!splash || splash.classList.contains('gone')) return;
    splash.classList.add('gone');
    setTimeout(() => splash.remove(), 600);
  }
  const splashTimer = setInterval(() => {
    const gate = $('authGate');
    const gateUp = gate && getComputedStyle(gate).display !== 'none';
    const ready = safe(() => !!currentState, false) || gateUp;
    if((ready && Date.now() - t0 > 650) || Date.now() - t0 > 4000){ clearInterval(splashTimer); hideSplash(); }
  }, 120);
  function markSkeletons(root){
    (root || document).querySelectorAll('.empty').forEach(el => { if(/^\s*Loading…?\s*$/.test(el.textContent)) el.classList.add('cp-skel'); });
  }
  markSkeletons();
  new MutationObserver((muts) => {
    for(const m of muts) for(const n of m.addedNodes){ if(n.nodeType === 1){ if(n.classList && n.classList.contains('empty')) markSkeletons(n.parentNode); else if(n.querySelector && n.querySelector('.empty')) markSkeletons(n); } }
  }).observe(document.body, { childList: true, subtree: true });

  // ---------- 2. directional slide between tabs ----------
  // (The View Transitions API was tried here, but it defers the actual tab
  // switch by a frame, and plenty of code switches tab then immediately
  // opens a sub-view. So the switch stays synchronous and the motion is CSS.)
  const TAB_ORDER = ['balance', 'board', 'casino', 'tipping', 'afl'];
  if(typeof window.setActiveTab === 'function'){
    const origTab = window.setActiveTab;
    let lastTab = 'balance';
    window.setActiveTab = function(tab){
      const from = TAB_ORDER.indexOf(lastTab), to = TAB_ORDER.indexOf(tab);
      const changing = tab !== lastTab;
      lastTab = tab;
      const r = origTab.apply(this, arguments);
      if(changing){
        uiTick();
        const panel = document.querySelector('.tab-panel.active');
        // v214: no sideways slide between tabs; pages just switch
        if(false && panel && from > -1 && to > -1 && !document.documentElement.classList.contains('cp-lite')){
          panel.classList.remove('cp-in-fwd', 'cp-in-back'); void panel.offsetWidth;
          panel.classList.add(to < from ? 'cp-in-back' : 'cp-in-fwd');
          setTimeout(() => panel.classList.remove('cp-in-fwd', 'cp-in-back'), 260);
        }
      }
      return r;
    };
  }

  // ---------- 3. pull to refresh (Home + Board) ----------
  document.documentElement.style.overscrollBehaviorY = 'contain';
  let ptr = null;
  const ptrEl = document.createElement('div'); ptrEl.className = 'cp-ptr'; ptrEl.innerHTML = '<span class="cp-ptr-ring"></span>'; document.body.appendChild(ptrEl);
  const ptrTabOk = () => { const a = document.querySelector('.tab-panel.active'); return a && (a.id === 'tab-balance' || a.id === 'tab-board'); };
  window.addEventListener('touchstart', (e) => {
    if(window.scrollY > 2 || e.touches.length !== 1 || !ptrTabOk() || document.querySelector('.profile-modal.open, .cp-sheet-wrap.open')) return;
    ptr = { y0: e.touches[0].clientY, x0: e.touches[0].clientX, dy: 0, armed: false };
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if(!ptr) return;
    const dy = e.touches[0].clientY - ptr.y0, dx = Math.abs(e.touches[0].clientX - ptr.x0);
    if(dx > 30 && dx > dy){ ptr = null; ptrEl.style.cssText = ''; return; }
    ptr.dy = Math.max(0, dy);
    const pull = Math.min(110, ptr.dy * .5);
    ptrEl.style.transform = `translate(-50%, ${pull - 60}px) rotate(${ptr.dy * 2}deg)`;
    ptrEl.style.opacity = Math.min(1, ptr.dy / 90);
    const armed = ptr.dy > 140;
    if(armed !== ptr.armed){ ptr.armed = armed; ptrEl.classList.toggle('armed', armed); if(armed) buzz(10); }
  }, { passive: true });
  window.addEventListener('touchend', async () => {
    if(!ptr) return;
    const go = ptr.armed; ptr = null;
    if(!go){ ptrEl.style.cssText = ''; ptrEl.classList.remove('armed'); return; }
    ptrEl.classList.add('spinning'); ptrEl.style.transform = 'translate(-50%, 24px)'; ptrEl.style.opacity = 1;
    try{ await Promise.race([safe(() => refresh({ force: true }), Promise.resolve()), new Promise(r => setTimeout(r, 6000))]); }catch(e){}
    try{ if(typeof refreshNavBadges === 'function') refreshNavBadges(); }catch(e){}
    setTimeout(() => { ptrEl.classList.remove('spinning', 'armed'); ptrEl.style.cssText = ''; }, 350);
  });

  // ---------- 4. full-screen celebrations ----------
  function celebrate({ icon, iconHtml, kicker, title, sub }){
    let el = $('cpCelebrate');
    if(!el){ el = document.createElement('div'); el.id = 'cpCelebrate'; el.className = 'cp-celebrate'; document.body.appendChild(el); el.addEventListener('click', (e) => { if(e.target === el || e.target.closest('.cp-cel-btn')) el.classList.remove('open'); }); }
    el.innerHTML = `<div class="cp-cel-rays"></div><div class="cp-cel-card" role="dialog" aria-label="${esc(title)}">
      <div class="cp-cel-coin"><div class="cp-cel-coin-inner">${iconHtml || `<span>${esc(icon || '🏅')}</span>`}</div></div>
      <div class="cp-cel-kicker">${esc(kicker)}</div><div class="cp-cel-title">${esc(title)}</div><div class="cp-cel-sub">${esc(sub || '')}</div>
      <button type="button" class="pill-btn pill-btn-primary cp-cel-btn">Nice one</button></div>`;
    void el.offsetWidth; el.classList.add('open');
    buzz([40, 60, 40, 60, 180]);
    safe(() => bjPlayChime(true));
    safe(() => bjLaunchConfetti(el.querySelector('.cp-cel-card'), 48));
  }
  if(typeof window.showTierUpCelebration === 'function'){
    window.showTierUpCelebration = function(tier){
      celebrate({ iconHtml: `<span class="tier-badge tier-status-gem tier-${esc(tier.key)}" style="width:54px;height:54px;"></span>`, kicker: 'New tier', title: tier.name, sub: 'You\'ve climbed a tier across the Casino, the Board and Tipping.' });
    };
  }
  const BADGE_NAMES = { 'founding-player': ['🏛️', 'Founding Player'], 'jackpot-winner': ['💰', 'Jackpot Winner'] };
  safe(() => XP_MILESTONE_BADGES.forEach(b => { BADGE_NAMES[b.key] = [b.icon, b.name]; }));
  let badgeCheckAt = 0;
  async function checkNewBadges(){
    if(Date.now() - badgeCheckAt < 120000 || typeof getMyUnlockedCasinoBadgeIds !== 'function' || !safe(() => currentUserUid, null)) return;
    badgeCheckAt = Date.now();
    try{
      const { ids } = await getMyUnlockedCasinoBadgeIds();
      const key = 'cp-badges-' + currentUserUid; const seen = LS.get(key, null);
      LS.set(key, ids);
      if(!seen) return; // first look on this device: set the baseline, don't celebrate old badges
      const fresh = ids.find(id => !seen.includes(id));
      if(fresh && BADGE_NAMES[fresh]) celebrate({ icon: BADGE_NAMES[fresh][0], kicker: 'Badge unlocked', title: BADGE_NAMES[fresh][1], sub: 'It\'s on your profile now.' });
    }catch(e){}
  }
  window.addEventListener('cp:win', () => { badgeCheckAt = 0; setTimeout(checkNewBadges, 2500); });
  setTimeout(checkNewBadges, 8000);

  // ---------- 5. holographic profile card ----------
  const sheet = $('profileSheet');
  if(sheet){
    const head = sheet.querySelector('.profile-header');
    if(head) head.classList.add('cp-holo');
    let tiltOn = false;
    const setTilt = (x, y) => { if(!head) return; head.style.setProperty('--hx', (50 + x * 50).toFixed(1) + '%'); head.style.setProperty('--hy', (50 + y * 50).toFixed(1) + '%'); head.style.setProperty('--rx', (y * -6).toFixed(2) + 'deg'); head.style.setProperty('--ry', (x * 8).toFixed(2) + 'deg'); };
    const onOrient = (e) => { if(e.gamma == null) return; setTilt(Math.max(-1, Math.min(1, e.gamma / 30)), Math.max(-1, Math.min(1, (e.beta - 45) / 30))); };
    const startTilt = () => {
      if(tiltOn || document.documentElement.classList.contains('cp-lite')) return; tiltOn = true;
      const D = window.DeviceOrientationEvent;
      if(D && typeof D.requestPermission === 'function'){ D.requestPermission().then(r => { if(r === 'granted') window.addEventListener('deviceorientation', onOrient); }).catch(() => {}); }
      else if(D) window.addEventListener('deviceorientation', onOrient);
    };
    if(head){
      head.addEventListener('pointermove', (e) => { const r = head.getBoundingClientRect(); setTilt((e.clientX - r.left) / r.width * 2 - 1, (e.clientY - r.top) / r.height * 2 - 1); });
      head.addEventListener('pointerleave', () => setTilt(0, 0));
      head.addEventListener('click', startTilt);
    }
    // the tap that opens a profile counts as the permission gesture on iPhone
    document.addEventListener('click', (e) => { if(e.target.closest('[data-profile-name], .profile-link')) startTilt(); }, true);
  }

  // ---------- 6. tier rings on photos ----------
  const ringCache = {};
  async function ringFor(uid){
    if(!uid) return null;
    if(uid in ringCache) return ringCache[uid];
    ringCache[uid] = null;
    try{ ringCache[uid] = typeof getCasinoTierKey === 'function' ? await getCasinoTierKey(uid) : null; }catch(e){}
    return ringCache[uid];
  }
  function applyRings(root){
    root.querySelectorAll('[data-podium-uid], .hm-av[data-hm-uid]').forEach(async el => {
      const uid = el.dataset.podiumUid || el.dataset.hmUid; if(!uid) return;
      const k = await ringFor(uid);
      if(k){ el.classList.add('cp-ring'); el.dataset.ring = k; }
    });
  }
  ['homePodium', 'groupMultiArea'].forEach(id => { const el = $(id); if(el){ applyRings(el); new MutationObserver(() => applyRings(el)).observe(el, { childList: true }); } });

  // ---------- 7. Monday "your week" card ----------
  const weekKey = () => safe(() => currentIsoWeekKeyAEST(), new Date().toISOString().slice(0, 10));
  function myMember(st){ return (st.members || []).find(m => m.linkedUid === currentUserUid) || (st.members || []).find(m => m.name === currentUserName); }
  async function casinoWeekNet(){
    let net = 0, rounds = 0, best = 0;
    const days = [];
    for(let i = 1; i <= 7; i++){ const d = new Date(Date.now() - i * 86400000); days.push(new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(d)); }
    await Promise.all(days.map(async dk => {
      try{ const r = await authedFetch(`/xp/${currentUserUid}/activityIndex/${dk}.json`); const v = r.ok ? await r.json() : null; if(v) Object.values(v).forEach(e => { if(e && typeof e.amount === 'number'){ net += e.amount; rounds++; if(e.amount > best) best = e.amount; } }); }catch(e){}
    }));
    return { net, rounds, best };
  }
  async function renderWeekCard(force){
    const st = safe(() => currentState, null); if(!st || !st.members || !safe(() => currentUserUid, null)) return;
    const day = new Date().toLocaleDateString('en-AU', { weekday: 'long', timeZone: 'Australia/Melbourne' });
    if(!force && !['Monday', 'Tuesday', 'Wednesday'].includes(day)) return;
    const wk = weekKey(); if(!force && LS.get('cp-week-dismissed', '') === wk) return;
    const me = myMember(st); if(!me) return;
    const last = (st.history || [])[st.history.length - 1]; if(!last) return;
    const leg = (last.groupEntries || {})[me.name];
    const groupPl = safe(() => weekGroupPl(last), 0);
    const cas = await casinoWeekNet();
    const ranked = safe(() => rankedMembers(st.members), []); const pos = ranked.findIndex(m => m.name === me.name) + 1;
    const data = { week: last.label || 'Last week', first: String(me.name).split(' ')[0], leg, groupPl, cas, pos, of: ranked.length, pl: me.pl || 0 };
    let card = $('cpWeekCard');
    if(!card){
      card = document.createElement('section'); card.id = 'cpWeekCard'; card.className = 'cp-week';
      const anchor = document.getElementById('homeTopSlot') || document.querySelector('#homeSubview-overview .home-money'); // v199: sits up top with anything else that needs you
      if(!anchor) return; anchor.parentNode.insertBefore(card, anchor.nextSibling);
    }
    const legTxt = !leg ? 'No leg' : leg.result === 'Win' ? `Won @ ${Number(leg.odds || 0).toFixed(2)}` : leg.result === 'Loss' ? `Lost @ ${Number(leg.odds || 0).toFixed(2)}` : (leg.result || 'Running');
    card.innerHTML = `<div class="cp-week-head"><div><div class="cp-week-kicker">Your week</div><div class="cp-week-title">${esc(data.week)}</div></div><button type="button" class="cp-week-x" aria-label="Hide until next week">✕</button></div>
      <div class="cp-week-grid">
        <div><span>Your leg</span><b class="${leg && leg.result === 'Win' ? 'w' : leg && leg.result === 'Loss' ? 'l' : ''}">${esc(legTxt)}</b></div>
        <div><span>Syndicate week</span><b class="${groupPl >= 0 ? 'w' : 'l'}">${groupPl >= 0 ? '+' : ''}${esc(money(groupPl))}</b></div>
        <div><span>Casino, 7 days</span><b class="${cas.net >= 0 ? 'w' : 'l'}">${cas.net >= 0 ? '+' : '−'}${Math.abs(Math.round(cas.net)).toLocaleString('en-AU')} XP</b></div>
        <div><span>Board position</span><b>${pos ? pos + ' of ' + data.of : '—'}</b></div>
      </div>
      <button type="button" class="pill-btn cp-week-share">Share my week</button>`;
    card.querySelector('.cp-week-x').onclick = () => { LS.set('cp-week-dismissed', wk); card.remove(); };
    card.querySelector('.cp-week-share').onclick = () => shareWeek(data, legTxt);
  }
  async function shareWeek(d, legTxt){
    const c = document.createElement('canvas'); c.width = 1080; c.height = 1350; const x = c.getContext('2d');
    const g = x.createRadialGradient(540, 0, 50, 540, 300, 1100); g.addColorStop(0, '#1d2a1c'); g.addColorStop(1, '#0b0c0b');
    x.fillStyle = g; x.fillRect(0, 0, 1080, 1350);
    try{ await document.fonts.load('800 80px Manrope'); }catch(e){}
    const logo = new Image(); logo.src = '/banner-clear.webp';
    await new Promise(r => { logo.onload = r; logo.onerror = r; setTimeout(r, 1500); });
    if(logo.naturalWidth) x.drawImage(logo, 340, 70, 400, 400 * logo.naturalHeight / logo.naturalWidth);
    x.fillStyle = '#CDF464'; x.font = '800 44px Manrope, sans-serif'; x.fillText('MY WEEK', 90, 330);
    x.fillStyle = '#F3F4F0'; x.font = '800 92px Manrope, sans-serif'; x.fillText(d.week, 90, 430);
    const rows = [['My leg', legTxt], ['Syndicate week', (d.groupPl >= 0 ? '+' : '') + money(d.groupPl)], ['Casino, 7 days', (d.cas.net >= 0 ? '+' : '−') + Math.abs(Math.round(d.cas.net)).toLocaleString('en-AU') + ' XP'], ['Board position', d.pos ? `${d.pos} of ${d.of}` : '—']];
    rows.forEach(([k, v], i) => {
      const y = 540 + i * 170;
      x.fillStyle = '#171917'; roundRect(x, 90, y, 900, 140, 36); x.fill();
      x.fillStyle = '#8F9590'; x.font = '600 34px Manrope, sans-serif'; x.fillText(k, 140, y + 58);
      x.fillStyle = '#F3F4F0'; x.font = '800 52px Manrope, sans-serif'; x.fillText(v, 140, y + 116);
    });
    x.fillStyle = '#8F9590'; x.font = '600 30px Manrope, sans-serif'; x.fillText(d.first + ' · MLSynd', 90, 1290);
    c.toBlob(async (blob) => {
      if(!blob) return;
      const file = new File([blob], 'mlsynd-my-week.png', { type: 'image/png' });
      if(navigator.canShare && navigator.canShare({ files: [file] })){ try{ await navigator.share({ files: [file], text: `My week in MLSynd: ${d.week}` }); return; }catch(e){ if(e && e.name === 'AbortError') return; } }
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'mlsynd-my-week.png'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    }, 'image/png');
  }
  function roundRect(x, l, t, w, h, r){ x.beginPath(); x.moveTo(l + r, t); x.arcTo(l + w, t, l + w, t + h, r); x.arcTo(l + w, t + h, l, t + h, r); x.arcTo(l, t + h, l, t, r); x.arcTo(l, t, l + w, t, r); x.closePath(); }
  window.cpShowWeekCard = () => renderWeekCard(true);

  // ---------- 8. live presence + big-win ticker ----------
  // Stored under each member's own /xp/{uid} node (already writable by them
  // and readable by members), so no new database rules are needed.
  let myTab = 'balance';
  document.querySelectorAll('.tabbar .tab-btn').forEach(b => b.addEventListener('click', () => { myTab = b.dataset.tab; beat(); }));
  let lastBeat = 0;
  async function beat(extra){
    const uid = safe(() => currentUserUid, null); if(!uid || safe(() => currentUserRole, '') === 'readonly' || document.hidden) return;
    if(!extra && Date.now() - lastBeat < 20000) return;
    lastBeat = Date.now();
    try{ await authedFetch(`/xp/${uid}/presence.json`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ ts: { '.sv': 'timestamp' }, tab: myTab }, extra || {})) }); }catch(e){}
  }
  setInterval(() => beat(), 60000); setTimeout(() => beat(), 6000);
  document.addEventListener('visibilitychange', () => { if(!document.hidden) beat(); });
  window.addEventListener('cp:win', (e) => { const d = e.detail || {}; if(d.tier === 'big' || d.tier === 'mega') beat({ lastBigWin: { amount: Math.round(d.amount), game: d.game, ts: { '.sv': 'timestamp' } } }); });
  const seenWins = LS.get('cp-seen-wins', {});
  async function readPresence(){
    const st = safe(() => currentState, null); const me = safe(() => currentUserUid, null);
    if(!st || !me || document.hidden) return;
    const homeVisible = !!document.querySelector('#tab-balance.active');
    const others = (st.members || []).filter(m => m.linkedUid && m.linkedUid !== me);
    if(!others.length) return;
    const now = Date.now();
    const results = await Promise.all(others.map(async m => { try{ const r = await authedFetch(`/xp/${m.linkedUid}/presence.json`); return { m, p: r.ok ? await r.json() : null }; }catch(e){ return { m, p: null }; } }));
    const online = results.filter(x => x.p && x.p.ts && now - x.p.ts < 150000);
    const inCasino = online.filter(x => x.p.tab === 'casino');
    if(homeVisible) renderPresence(online, inCasino);
    results.forEach(({ m, p }) => {
      const w = p && p.lastBigWin; if(!w || !w.ts || now - w.ts > 10 * 60000) return;
      const id = m.linkedUid + ':' + w.ts; if(seenWins[id]) return;
      seenWins[id] = 1; LS.set('cp-seen-wins', seenWins);
      ticker(`${String(m.name).split(' ')[0]} just hit +${Number(w.amount).toLocaleString('en-AU')} XP on ${w.game}`);
    });
  }
  function renderPresence(online, inCasino){
    let row = $('cpPresence');
    const anchor = document.querySelector('#homeSubview-overview .home-greet');
    if(!anchor) return;
    if(!online.length){ if(row) row.remove(); return; }
    if(!row){ row = document.createElement('button'); row.type = 'button'; row.id = 'cpPresence'; row.className = 'cp-presence'; anchor.appendChild(row); row.addEventListener('click', () => { const b = document.querySelector('.tabbar [data-tab="casino"]'); if(b && row.dataset.casino === '1') b.click(); }); }
    const list = (inCasino.length ? inCasino : online).slice(0, 5);
    row.dataset.casino = inCasino.length ? '1' : '0';
    row.innerHTML = `<span class="cp-presence-faces">${list.map(x => `<span class="cp-presence-face" data-uid="${esc(x.m.linkedUid)}">${esc(String(x.m.name).charAt(0).toUpperCase())}</span>`).join('')}</span>
      <span class="cp-presence-txt"><i></i>${inCasino.length ? `${inCasino.length} in the Casino now` : `${online.length} online now`}</span>`;
    row.querySelectorAll('[data-uid]').forEach(el => { safe(() => getAvatarDataUri(el.dataset.uid).then(src => { if(src){ el.style.backgroundImage = `url("${src}")`; el.textContent = ''; } }).catch(() => {})); });
  }
  function ticker(text){
    let t = $('cpTicker');
    if(!t){ t = document.createElement('div'); t.id = 'cpTicker'; t.className = 'cp-ticker'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.innerHTML = `<span class="cp-ticker-dot"></span><span>${esc(text)}</span>`;
    void t.offsetWidth; t.classList.add('show'); buzz(20);
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 5200);
  }
  setInterval(readPresence, 75000); setTimeout(readPresence, 9000);

  // ---------- 9. rolling numbers ----------
  const ROLL_IDS = new Set(['balBank', 'balPlOverall', 'balPlWeekly', 'casinoXPBalance', 'homeXPBalanceDisplay']);
  if(typeof window.animateValue === 'function'){
    const origAnim = window.animateValue;
    window.animateValue = function(id, newVal){
      const el = $(id);
      if(el && ROLL_IDS.has(id) && el._rawVal != null && Math.abs(el._rawVal - newVal) > .004 && !document.documentElement.classList.contains('cp-lite')){
        el.classList.remove('cp-rolling', 'cp-rolled-up', 'cp-rolled-down'); void el.offsetWidth;
        el.classList.add('cp-rolling', newVal > el._rawVal ? 'cp-rolled-up' : 'cp-rolled-down');
        clearTimeout(el._rollT); el._rollT = setTimeout(() => el.classList.remove('cp-rolling'), 760);
      }
      return origAnim.apply(this, arguments);
    };
  }

  // ---------- 10. one sound switch for the whole app ----------
  let muted = LS.get('cp-sound-off', false);
  const ctxs = new Set();
  const AC = window.AudioContext || window.webkitAudioContext;
  if(AC){
    const Wrapped = function(opts){
      const c = opts ? new AC(opts) : new AC();
      ctxs.add(c);
      const origResume = c.resume.bind(c);
      c.resume = () => muted ? Promise.resolve() : origResume();
      if(muted) c.suspend().catch(() => {});
      return c;
    };
    Wrapped.prototype = AC.prototype;
    window.AudioContext = Wrapped; if(window.webkitAudioContext) window.webkitAudioContext = Wrapped;
  }
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function(){ if(muted) this.muted = true; else if(this._cpMutedByUs) this.muted = false; this._cpMutedByUs = muted; return origPlay.apply(this, arguments); };
  function setMuted(m){
    muted = m; LS.set('cp-sound-off', m);
    ctxs.forEach(c => { try{ m ? c.suspend() : c.state === 'suspended' && AC.prototype.resume.call(c); }catch(e){} });
    document.querySelectorAll('audio, video').forEach(a => { a.muted = m; a._cpMutedByUs = m; });
    const b = $('cpSoundBtn'); if(b){ b.textContent = m ? '🔇 Sound: Off' : '🔊 Sound: On'; b.setAttribute('aria-pressed', String(!m)); }
  }
  let uiCtx = null;
  function uiTick(){
    if(muted || document.documentElement.classList.contains('cp-lite')) return;
    try{
      if(!uiCtx) uiCtx = new (window.AudioContext)();
      if(uiCtx.state === 'suspended') uiCtx.resume();
      const o = uiCtx.createOscillator(), g = uiCtx.createGain(); const t = uiCtx.currentTime;
      o.type = 'sine'; o.frequency.setValueAtTime(1180, t); o.frequency.exponentialRampToValueAtTime(760, t + .05);
      g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.035, t + .006); g.gain.exponentialRampToValueAtTime(.0001, t + .07);
      o.connect(g).connect(uiCtx.destination); o.start(t); o.stop(t + .08);
    }catch(e){}
  }
  const acct = document.querySelector('.account-bar');
  if(acct){
    const b = document.createElement('button'); b.type = 'button'; b.id = 'cpSoundBtn'; b.className = 'pill-btn';
    acct.insertBefore(b, $('mainSignOutBtn') || null);
    b.addEventListener('click', () => { setMuted(!muted); if(!muted) uiTick(); });
  }
  setMuted(muted);

  // ---------- 11. phone-app polish: install prompt ----------
  const standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; setTimeout(showInstall, 4000); });
  function showInstall(){
    if(standalone || $('cpInstall') || Date.now() < LS.get('cp-install-snooze', 0)) return;
    // Don't cover the login screen's 'Forgot password?' link: wait until the person is signed in.
    const gate = $('authGate');
    if(gate && gate.getClientRects().length && getComputedStyle(gate).visibility !== 'hidden'){ setTimeout(showInstall, 3000); return; }
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
    if(!deferredPrompt && !ios) return;
    const bar = document.createElement('div'); bar.id = 'cpInstall'; bar.className = 'cp-install';
    bar.innerHTML = `<img src="/icon-192.png" alt=""><div class="cp-install-txt"><b>Add MLSynd to your home screen</b><span>${deferredPrompt ? 'Opens full screen, like a real app.' : 'Tap Share, then Add to Home Screen.'}</span></div>${deferredPrompt ? '<button type="button" class="pill-btn pill-btn-primary cp-install-go">Install</button>' : ''}<button type="button" class="cp-install-x" aria-label="Not now">✕</button>`;
    document.body.appendChild(bar); requestAnimationFrame(() => bar.classList.add('show'));
    const close = () => { bar.classList.remove('show'); setTimeout(() => bar.remove(), 400); LS.set('cp-install-snooze', Date.now() + 30 * 86400000); };
    bar.querySelector('.cp-install-x').onclick = close;
    const go = bar.querySelector('.cp-install-go');
    if(go) go.onclick = async () => { try{ deferredPrompt.prompt(); await deferredPrompt.userChoice; }catch(e){} deferredPrompt = null; close(); };
  }
  setTimeout(() => { if(/iphone|ipad|ipod/i.test(navigator.userAgent)) showInstall(); }, 20000);

  // ---------- 12. press feedback ----------
  document.addEventListener('pointerdown', (e) => {
    const t = e.target.closest('.pill-btn-primary, .tab-btn, .subnav-btn, .hm-leg, .home-quick-btn, .cp-bar-btn');
    if(t && !t.disabled) buzz(7);
  }, { passive: true });

  // ---------- modern platform extras ----------
  // App-icon badge: mirrors the dots on the bottom menu
  if(typeof window.setTabBadge === 'function' && 'setAppBadge' in navigator){
    const origBadge = window.setTabBadge;
    window.setTabBadge = function(){
      const r = origBadge.apply(this, arguments);
      try{ const n = document.querySelectorAll('.tabbar .tab-badge.on').length; n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); }catch(e){}
      return r;
    };
  }
  // Keep the screen awake while Auto Play runs
  let wake = null;
  async function wakeOn(){ try{ if('wakeLock' in navigator && !wake && !document.hidden){ wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } }catch(e){ wake = null; } }
  function wakeOff(){ try{ if(wake) wake.release(); }catch(e){} wake = null; }
  window.addEventListener('cp:autoplay', (e) => { (e.detail && e.detail.running) ? wakeOn() : wakeOff(); });
  document.addEventListener('visibilitychange', () => { if(!document.hidden && document.body.classList.contains('cp-autoplaying')) wakeOn(); });
  // Week card once data has arrived
  const weekTimer = setInterval(() => { if(safe(() => currentState && currentUserUid, false)){ clearInterval(weekTimer); renderWeekCard(false); } }, 1500);
  // Defer non-urgent warm-up work until the phone is idle
  (window.requestIdleCallback || ((f) => setTimeout(f, 2500)))(() => { ['/banner-clear.webp', '/icon-192.png'].forEach(src => { const i = new Image(); i.src = src; }); });

  // ---------- polish: no emoji bullets in headings, buttons and labels ----------
  // Emoji in front of a heading or button label reads cheap next to the new
  // type and line icons. Strips a LEADING emoji only, only when real text
  // follows (icon-only buttons keep theirs), and never inside game pieces.
  const EMO = /^\s*(?:(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})(?:️|⃣|\p{Emoji_Modifier}|‍\p{Extended_Pictographic})*\s*)+/u;
  const CHROME = 'h1, h2, h3, h4, button, .pill-btn, .amt, .win-badge, .home-section-title, .craps-section-label, label, .offseason-kicker, .tipping-comp-title, .casino-hub-tile-title, .hint b, .casino-social-tab, .hr-lb-title, .profile-cat-tab, .pp-payout-title, .section-title, .card-title';
  const KEEP = '.game-bubble, .game-bubble-icon, .table-chip, .playing-card, .tab-btn, #headerAdminBtn, #syndyFabBtn, .cp-cel-coin, .tier-badge, .vp-hold-pill, .slots-reel-window, .mines-tile, .bj-chip, .roulette-wheel-wrap, .dailyspin-wheel-wrap, .hm-leg, .profile-close, .emoji-ok, .admin-submode-btn, .casino-hub-tile-icon, .craps-bet-spot, .casino-num-spot, .chat-msg, .syndy-msg';
  function stripEmoji(root){
    const els = root.matches && root.matches(CHROME) ? [root] : [];
    root.querySelectorAll && root.querySelectorAll(CHROME).forEach(e => els.push(e));
    els.forEach(el => {
      if(el.closest(KEEP)) return;
      // a lone emoji in its own span at the very start of the label
      const fe = el.firstElementChild;
      if(fe && fe === [...el.childNodes].find(n => n.nodeType === 1 || (n.nodeType === 3 && n.nodeValue.trim())) && fe.children.length === 0 && EMO.test(fe.textContent) && !fe.textContent.replace(EMO, '').trim() && el.textContent.replace(fe.textContent, '').trim()) fe.classList.add('cp-hidden');
      const tn = [...el.childNodes].find(n => n.nodeType === 3 && n.nodeValue.trim());
      if(!tn || !EMO.test(tn.nodeValue)) return;
      const rest = tn.nodeValue.replace(EMO, '');
      const remaining = (rest + [...el.childNodes].filter(n => n !== tn).map(n => n.textContent).join('')).trim();
      if(remaining) tn.nodeValue = rest;
    });
    // emoji wrapped in its own little span at the start of a label
    (root.querySelectorAll ? root.querySelectorAll('.subnav-icon, .pp-pill-icon, .weekly-reminder-icon') : []).forEach(sp => sp.classList.add('cp-hidden'));
  }
  stripEmoji(document.body);
  let stripQ = new Set(), stripT = null;
  new MutationObserver((muts) => {
    muts.forEach(m => { if(m.type === 'characterData'){ if(m.target.parentNode) stripQ.add(m.target.parentNode); } else m.addedNodes.forEach(n => { if(n.nodeType === 1) stripQ.add(n); else if(n.nodeType === 3 && n.parentNode) stripQ.add(n.parentNode); }); });
    if(!stripT) stripT = requestAnimationFrame(() => { stripT = null; const q = stripQ; stripQ = new Set(); q.forEach(n => { try{ stripEmoji(n); }catch(e){} }); });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  // ---------- seasons: profile history + New Year moment ----------
  const TIER_NAME = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum', diamond: 'Diamond', sovereign: 'Sovereign', immortal: 'Immortal' };
  const nf = (n) => Math.round(Number(n) || 0).toLocaleString('en-AU');
  window.renderProfileSeasons = async function(uid, forName, seasonEarned, allTime){
    const cell = $('profileLifetimeXPCell'); if(!cell) return;
    const host = cell.parentNode; if(!host) return;
    let box = $('cpProfileSeasons');
    if(!box){ box = document.createElement('div'); box.id = 'cpProfileSeasons'; box.className = 'cp-seasons'; host.parentNode.insertBefore(box, host.nextSibling); }
    box.innerHTML = '';
    let seasons = null;
    try{ const r = await authedFetch(`/xp/${uid}/seasons.json`); seasons = r.ok ? await r.json() : null; }catch(e){}
    if($('profileModal').dataset.openName !== forName) return;
    const list = seasons ? Object.values(seasons).filter(Boolean).sort((a, b) => b.season - a.season) : [];
    const yr = new Date().toLocaleString('en-AU', { year: 'numeric', timeZone: 'Australia/Melbourne' });
    box.innerHTML = `<div class="cp-seasons-head"><span>Seasons</span><small>Balances reset to 10,000 XP every New Year. All-time XP keeps counting.</small></div>
      <div class="cp-season-row now"><b>${esc(yr)}</b><span>${nf(seasonEarned)} XP earned so far</span></div>
      ${list.map(x => `<div class="cp-season-row"><b>${esc(x.season)}</b><span>${nf(x.earned)} XP earned</span><span>Finished on ${nf(x.finalBalance)}</span>${x.tier && TIER_NAME[x.tier] ? `<i class="cp-season-tier" data-ring="${esc(x.tier)}">${TIER_NAME[x.tier]}</i>` : ''}</div>`).join('')}
      ${allTime && allTime.bestBalance ? `<div class="cp-seasons-best">Best finish ${nf(allTime.bestBalance)} XP · ${nf(allTime.seasons)} season${Number(allTime.seasons) === 1 ? '' : 's'} played</div>` : ''}`;
  };
  async function newSeasonMoment(){
    const uid = safe(() => currentUserUid, null); if(!uid || safe(() => currentUserRole, '') === 'readonly') return;
    const yr = Number(new Date().toLocaleString('en-AU', { year: 'numeric', timeZone: 'Australia/Melbourne' }));
    const key = 'cp-season-seen-' + uid;
    if(LS.get(key, 0) >= yr) return;
    try{
      const r = await authedFetch(`/xp/${uid}/seasons/${yr - 1}.json`); const last = r.ok ? await r.json() : null;
      if(!last){ return; }
      LS.set(key, yr);
      celebrate({ icon: '🎆', kicker: 'New season', title: String(yr), sub: `Everyone starts again on 10,000 XP. You finished ${yr - 1} on ${nf(last.finalBalance)} XP${last.tier && TIER_NAME[last.tier] ? ', ' + TIER_NAME[last.tier] + ' tier' : ''}. It's saved on your profile.` });
    }catch(e){}
  }
  setTimeout(newSeasonMoment, 7000);

  window.appPremium = { celebrate, ticker, renderWeekCard, setMuted, readPresence };
})();
