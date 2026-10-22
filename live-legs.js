// live-legs.js (v225)
// Match-day mode for the group multi on Home. The server
// (live-legs-scheduled.mjs) follows each leg's game every few minutes and
// writes /liveLegs; this reads it and shows:
//   - a coloured ring on each face while their game is on (green winning,
//     red losing, amber level) with a pulse while it's live
//   - a "Match day" panel: score, clock and how each leg is going
//   - "Looks home" / "Looks gone" on a finished leg until the admin marks it
//   - the same live line inside a leg when its face is tapped
// Results are never set from here; the admin confirms them in Admin → Week.
(function(){
  'use strict';
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s));
  const st = () => (typeof currentState !== 'undefined' && currentState) ? currentState : {};
  let data = null, timer = null, sig = '';

  const forThisWeek = () => {
    const s = st();
    return !!(data && data.legs && !s.groupMultiCleared && data.week === (s.weekLabelDraft || 'week'));
  };
  const legFor = (name) => (forThisWeek() && data.legs[name] && data.legs[name].tracked) ? data.legs[name] : null;
  const draftResult = (name) => { const e = (st().groupEntryDraft || {})[name]; return e && e.result || null; };

  function startText(t){
    if(!t) return '';
    const d = new Date(t), now = new Date();
    const time = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '').toLowerCase();
    if(d.toDateString() === now.toDateString()) return time;
    if(d - now < 6 * 86400000) return `${d.toLocaleDateString('en-AU', { weekday: 'short' })} ${time}`;
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  }
  // the state words for one leg
  function describe(name, L){
    const res = draftResult(name);
    if(L.state === 'pre') return { cls: 'pre', tag: startText(L.start) || 'Not started', score: '', note: '' };
    const score = L.hs != null ? `${L.hs}–${L.as}` : '';
    if(res) return { cls: res === 'Win' ? 'winning' : res === 'Loss' ? 'losing' : 'level', tag: res === 'Win' ? 'Won' : res === 'Loss' ? 'Lost' : res, score, note: L.note || '' };
    if(L.suggest) return { cls: L.suggest === 'Win' ? 'winning' : 'losing', tag: L.suggest === 'Win' ? 'Looks home' : 'Looks gone', score, note: L.note || '', waiting: true };
    return { cls: L.verdict || 'live', tag: L.state === 'final' ? 'Full time' : (L.clock || 'Live'), score, note: L.note || '', live: L.state === 'live' };
  }

  // ---------- drawing ----------
  function decorate(){
    const area = document.getElementById('groupMultiArea');
    if(!area) return;
    const legs = window.__hmLegs || [];
    const editable = window.__hmMulti && window.__hmMulti.editable;
    // faces
    area.querySelectorAll('.hm-leg[data-leg]').forEach(btn => {
      btn.classList.remove('lv', 'lv-on', 'lv-winning', 'lv-losing', 'lv-level', 'lv-live');
      const L = editable ? legFor(btn.dataset.leg) : null;
      if(!L || L.state === 'pre' || draftResult(btn.dataset.leg)) return;
      const d = describe(btn.dataset.leg, L);
      btn.classList.add('lv', 'lv-' + d.cls);
      if(L.state === 'live') btn.classList.add('lv-on');
    });
    // panel
    let panel = document.getElementById('hmLive');
    const rows = editable ? legs.map(l => ({ l, L: legFor(l.name) })).filter(x => x.L && !(x.l.result && x.L.state === 'final')) : [];
    const anyLive = rows.some(x => x.L.state === 'live');
    const showPanel = rows.some(x => x.L.state !== 'pre' || (x.L.start && x.L.start - Date.now() < 36 * 3600e3));
    if(!showPanel){ if(panel) panel.remove(); }
    else{
      if(!panel){
        panel = document.createElement('div'); panel.id = 'hmLive'; panel.className = 'hm-live';
        const track = area.querySelector('.hm-track');
        (track || area.firstElementChild).after(panel);
      }
      // live games first, then finished-awaiting-admin, then upcoming by start
      const order = (x) => x.L.state === 'live' ? 0 : x.L.state === 'final' ? 1 : 2;
      rows.sort((a, b) => order(a) - order(b) || (a.L.start || 0) - (b.L.start || 0));
      const ago = data.updatedAt ? Math.max(0, Math.round((Date.now() - data.updatedAt) / 60000)) : null;
      panel.classList.toggle('on', anyLive);
      panel.innerHTML = `<div class="hm-live-head">
          <span class="hm-live-title">${anyLive ? '<i class="hm-live-dot" aria-hidden="true"></i>Live' : 'Match day'}</span>
          <span class="hm-live-upd">${ago == null ? '' : ago < 1 ? 'Updated just now' : `Updated ${ago} min ago`}</span>
        </div>
        ${rows.map(({ l, L }) => {
          const d = describe(l.name, L);
          const game = `${L.home} v ${L.away}`;
          return `<button type="button" class="hm-live-row lv-${d.cls}${d.live ? ' is-live' : ''}" data-live-leg="${esc(l.name)}">
            <span class="hm-live-who"><b>${esc(String(l.name).split(' ')[0])}</b><span>${esc(l.pick && l.pick.sel || game)}</span></span>
            <span class="hm-live-score">${d.score ? `<b>${esc(d.score)}</b>` : ''}<span class="hm-live-tag${d.waiting ? ' wait' : ''}">${esc(d.tag)}</span></span>
            ${d.note || L.state !== 'pre' ? `<span class="hm-live-note">${esc([L.state !== 'pre' ? game : '', d.note].filter(Boolean).join(' · '))}${d.waiting ? ' · waiting on admin' : ''}</span>` : ''}
          </button>`;
        }).join('')}`;
    }
    // status pill
    const statusEl = document.getElementById('homeMultiStatus');
    if(statusEl && editable && anyLive && !(window.__hmMulti || {}).losers){
      const n = rows.filter(x => x.L.state === 'live').length;
      statusEl.innerHTML = `<i class="hm-live-dot" aria-hidden="true"></i>${n} in play`;
      statusEl.className = 'hm-status running live';
    }
    detail();
  }
  // the live line inside an opened leg
  function detail(){
    const box = document.getElementById('homeMultiDetail');
    if(!box) return;
    const old = box.querySelector('.hm-live-line'); if(old) old.remove();
    const name = window.__hmSel; const L = name && (window.__hmMulti || {}).editable ? legFor(name) : null;
    if(!L) return;
    const d = describe(name, L);
    const line = document.createElement('div');
    line.className = `hm-live-line lv-${d.cls}`;
    line.innerHTML = L.state === 'pre'
      ? `<span>${esc(L.home)} v ${esc(L.away)}</span><b>${esc(d.tag)}</b>`
      : `<span>${esc(L.home)} <b>${esc(L.hs)}</b> – <b>${esc(L.as)}</b> ${esc(L.away)}</span><b>${esc(d.tag)}</b>${d.note ? `<em>${esc(d.note)}${d.waiting ? ' · waiting on admin' : ''}</em>` : ''}`;
    const pick = box.querySelector('.hm-pick');
    if(pick) pick.after(line); else box.appendChild(line);
  }

  document.addEventListener('click', (e) => {
    const row = e.target.closest('#hmLive [data-live-leg]'); if(!row) return;
    const btn = document.querySelector(`#groupMultiArea .hm-leg[data-leg="${CSS.escape(row.dataset.liveLeg)}"]`);
    if(btn && !btn.classList.contains('sel')) btn.click();
    const box = document.getElementById('homeMultiDetail'); if(box) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  // ---------- fetching ----------
  // every 30s while a game is on, otherwise every 3 minutes; paused when the
  // app is in the background
  async function poll(){
    clearTimeout(timer);
    if(!document.hidden && typeof authedFetch === 'function'){
      try{
        const r = await authedFetch('/liveLegs.json');
        if(r.ok){
          const d = await r.json();
          const s = JSON.stringify(d);
          if(s !== sig){ sig = s; data = d; decorate(); try{ if(document.getElementById('adminWeeklyChecklistRows') && typeof updateWeeklyChecklist === 'function') updateWeeklyChecklist(); }catch(e){} }
        }
      }catch(e){}
    }
    timer = setTimeout(poll, data && data.live ? 30000 : 180000);
  }
  document.addEventListener('visibilitychange', () => { if(!document.hidden) poll(); });
  const start = () => setTimeout(poll, 2500);
  if(document.readyState === 'complete') start(); else window.addEventListener('load', start);

  window.liveLegs = { decorate, detail, get data(){ return data; }, set data(d){ data = d; sig = JSON.stringify(d); decorate(); }, legFor, poll };
})();
