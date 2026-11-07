// lotto-combine.js (v241)
// Admin → Lotto: pick the members who are in the lotto group, add several
// lotto ticket screenshots, and turn them into ONE tidy image that can be
// downloaded or shared straight into the separate lotto group chat.
// Everything happens on the phone: nothing is uploaded or sent anywhere, and
// nothing here touches the bank, the week or any other part of the platform.
// Saved in its OWN place in the database, /lottoPigs (the group at
// /lottoPigs/group, the profit and loss book at /lottoPigs/ledger/{id}). It is
// deliberately not inside /state, so the syndicate's Save week, Recalculate,
// Reset season, Restore and the Ledger app can never touch it. The rules only
// let the admin write it and only the group's members (and the admin) read it.
(function(){
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s));
  const st = () => (typeof currentState !== 'undefined' && currentState) ? currentState : {};
  const BG = '#0d100d', PANEL = '#171c17', LIME = '#cdf464', CHALK = '#f1f3ee', MUTED = '#9aa396';
  const MAX_SIDE = 4096, MAX_AREA = 14e6, COL_W = 900, GAP = 24, PAD = 36, PART_GAP = 6;

  // brand graphics for the shared picture (loaded once; the picture still works if they can't load)
  const art = {}; ['icon:lotto-pigs-icon.webp', 'mark:lotto-pigs-mark.webp', 'logo:logo-icon.webp?v=269'].forEach(x => { const [k, f] = x.split(':'); const im = new Image(); im.onload = () => { art[k] = im; try{ scheduleRender(); }catch(e){} }; im.src = f; });
  let tickets = []; // { id, name, img, url, w, h }
  let nextId = 1;
  // which group these tickets are for: 'pigs' (Lotto Pigs) or 'ml' (the MLSynd syndicate)
  let tgt = 'pigs'; try{ if(localStorage.getItem('mlsynd-lotto-target') === 'ml') tgt = 'ml'; }catch(e){}
  const ML = { meta: {}, loaded: false };
  const DEFAULT_TITLES = ['', 'Lotto Pigs', 'MLSynd', 'MLSynd Lotto'];
  let info = null; // ticket details read from the screenshots: { tickets: [...], warnings: [] }
  let lastBlob = null, lastName = 'lotto-tickets.png';
  let renderTimer = null;

  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const prettyDate = (s) => { const d = new Date(s + 'T12:00:00'); return isNaN(d) ? '' : d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); };

  // ---------- who is in the lotto group ----------
  const LP = { group: null, ledger: {}, allowed: false, loaded: false, loading: null };
  function group(){ const g = LP.group; return { name: (g && g.name) || 'Lotto Pigs', members: Array.isArray(g && g.members) ? g.members.slice() : [] }; }
  // the platform logins of the people ticked, so the database rules can let exactly them read it
  function uidsFor(members){ const u = {}; (st().members || []).forEach(m => { if(m.linkedUid && members.includes(m.name)) u[m.linkedUid] = true; }); return u; }
  function setGroup(g){ LP.group = { name: g.name || '', members: g.members.slice(), uids: uidsFor(g.members) }; }
  const isAdminUser = () => { try{ return !!(currentUserEmail && currentUserEmail.toLowerCase() === ADMIN_EMAIL.toLowerCase()); }catch(e){ return false; } };
  async function lpLoad(force){
    if(LP.loaded && !force) return LP;
    if(LP.loading) return LP.loading;
    LP.loading = (async () => {
      try{
        const res = await authedFetch('/lottoPigs.json');
        if(res.ok){
          const d = (await res.json()) || {};
          LP.allowed = true; LP.group = d.group || null; LP.ledger = d.ledger && typeof d.ledger === 'object' ? d.ledger : {};
          if(isAdminUser()) await migrateOld();
        }else{ LP.allowed = false; LP.group = null; LP.ledger = {}; }
      }catch(e){ /* offline: keep what we have */ }
      LP.loaded = true; LP.loading = null;
      try{ syncHeader(); refreshAll(); }catch(e){}
      return LP;
    })();
    return LP.loading;
  }
  // Earlier test versions kept this inside /state. Move it out once, then clear it from /state.
  async function migrateOld(){
    const g = st().lottoGroup, l = st().lottoLedger;
    if(!g && !l) return;
    try{
      if(g && !LP.group){ setGroup({ name: g.name, members: Array.isArray(g.members) ? g.members : [] }); await authedWrite('/lottoPigs/group.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(LP.group) }); }
      if(l && !Object.keys(LP.ledger).length){ await authedWrite('/lottoPigs/ledger.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(l) }); LP.ledger = l; }
      if(g) await authedWrite('/state/lottoGroup.json', { method: 'DELETE' });
      if(l) await authedWrite('/state/lottoLedger.json', { method: 'DELETE' });
      delete st().lottoGroup; delete st().lottoLedger;
    }catch(e){}
  }
  function allNames(){ return (st().members || []).map(m => m.name).filter(Boolean); }
  async function saveGroup(g){
    const status = $('lcGroupStatus');
    try{
      setGroup(g);
      const res = await authedWrite('/lottoPigs/group.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(LP.group) });
      if(!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
      status.className = 'status-msg ok'; status.textContent = 'Saved.';
    }catch(e){
      status.className = 'status-msg error'; status.textContent = 'Could not save the group. Check your connection and try again.';
    }
  }
  function renderMembers(){
    const wrap = $('lcMembers'); if(!wrap) return;
    const g = group(), plat = allNames();
    const names = plat.concat(g.members.filter(n => !plat.includes(n))); // plus Lotto Pigs people who aren't on the platform
    if(!names.length){ wrap.innerHTML = '<div class="empty">No members yet.</div>'; return; }
    wrap.innerHTML = names.map(n => `<button type="button" class="lc-chip${g.members.includes(n) ? ' on' : ''}" data-lc-member="${esc(n)}" aria-pressed="${g.members.includes(n)}">${g.members.includes(n) ? '✓ ' : ''}${esc(n)}</button>`).join('');
    const c = $('lcMemberCount'); if(c) c.textContent = g.members.length ? `${g.members.length} in` : 'Nobody picked yet';
  }

  // ---------- tickets ----------
  const loadImage = (file) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => resolve({ img, url, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
    img.src = url;
  });
  async function addFiles(files){
    const status = $('lcStatus'); let bad = 0;
    for(const f of Array.from(files)){
      if(!/^image\//.test(f.type)){ bad++; continue; }
      try{ const r = await loadImage(f); tickets.push({ id: nextId++, name: f.name, ...r }); }catch(e){ bad++; }
    }
    status.className = bad ? 'status-msg error' : 'status-msg';
    status.textContent = bad ? `${bad} file${bad === 1 ? '' : 's'} couldn't be read as a picture and ${bad === 1 ? 'was' : 'were'} skipped.` : '';
    renderList(); scheduleRender();
  }
  // Several screenshots can be ONE ticket (a long ticket scrolled in parts).
  // A screenshot marked `join` belongs to the ticket above it.
  function groups(){ const g = []; tickets.forEach((t, i) => { if(i > 0 && t.join) g[g.length - 1].push(t); else g.push([t]); }); return g; }
  function splitInto(n){
    const k = Math.max(1, Math.min(n, tickets.length)), per = tickets.length / k; let start = 0;
    const cut = new Set(); for(let j = 0; j < k; j++){ cut.add(Math.round(start)); start += per; }
    tickets.forEach((t, i) => { t.join = i > 0 && !cut.has(i); });
  }
  function renderList(){
    const list = $('lcList'); if(!list) return;
    const gs = groups(), nt = gs.length;
    $('lcCount').textContent = tickets.length ? `${nt} ticket${nt === 1 ? '' : 's'}${tickets.length !== nt ? ` · ${tickets.length} screenshots` : ''}` : '';
    const sp = $('lcSplit'), spw = $('lcSplitWrap');
    if(sp){ sp.innerHTML = Array.from({ length: tickets.length }, (_, k) => `<option value="${k + 1}">${k + 1} ticket${k ? 's' : ''}${k + 1 === tickets.length ? ' (one per screenshot)' : ''}</option>`).join(''); sp.hidden = tickets.length < 2; sp.value = String(nt); if(spw) spw.hidden = tickets.length < 2; }
    let gi = 0;
    list.innerHTML = tickets.map((t, i) => {
      const head = (i === 0 || !t.join) ? `<div class="lc-grp-h">Ticket ${++gi}</div>` : '';
      return head + `<div class="lc-item${t.join ? ' lc-joined' : ''}" data-lc-id="${t.id}">
        <img src="${t.url}" alt="Screenshot ${i + 1}">
        <span class="lc-item-n">${i + 1}</span>
        <div class="lc-item-btns">
          ${i > 0 ? `<button type="button" class="lc-join${t.join ? ' on' : ''}" data-lc-act="join" aria-pressed="${!!t.join}">${t.join ? 'Same ticket ✓' : 'Same as above'}</button>` : ''}
          <button type="button" data-lc-act="up" aria-label="Move screenshot ${i + 1} earlier" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" data-lc-act="down" aria-label="Move screenshot ${i + 1} later" ${i === tickets.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" data-lc-act="rm" aria-label="Remove screenshot ${i + 1}">✕</button>
        </div></div>`; }).join('');
    const has = tickets.length > 0;
    const rd = $('lcRead'); if(rd) rd.hidden = !has;
    ['lcDownload', 'lcShare', 'lcClear'].forEach(id => { const b = $(id); if(b) b.disabled = !has; });
    $('lcPreviewWrap').hidden = !has; syncAttach();
  }

  async function smallDataUrl(img){
    const k = Math.min(1, 1100 / img.naturalWidth), c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.82);
  }
  function staleInfo(){ if(info && info.tickets && groups().length !== info.tickets.length){ info = null; renderInfo(); const rs = $('lcReadStatus'); if(rs){ rs.className = 'status-msg'; rs.textContent = 'The tickets changed, so tap Read tickets again.'; } } }
  function renderInfo(){
    const wrap = $('lcInfo'); if(!wrap) return;
    if(!info || !info.tickets || !info.tickets.length){ wrap.innerHTML = ''; return; }
    wrap.innerHTML = info.tickets.map((t, i) => `<div class="lc-info-card">
        <div class="lc-info-h"><b>Ticket ${i + 1}${t.game ? ' · ' + esc(t.game) : ''}</b><span>${[t.draw_number ? 'Draw ' + esc(t.draw_number) : '', t.draw_date ? esc(fmtDay(t.draw_date)) : '', t.entry_type ? esc(t.entry_type) : '', t.price != null ? fmtMoney(t.price) : ''].filter(Boolean).join(' · ')}</span></div>
        ${t.entries.map(e => `<div class="lc-info-row"><i>${esc(e.label || '')}</i>${e.numbers.map(n => `<em>${n}</em>`).join('')}${e.extra.map(n => `<em class="x">${n}</em>`).join('')}</div>`).join('')}
        <div class="lc-res"><div class="lc-res-h">Result (after the draw)</div>
          <label>Winning numbers<input type="text" inputmode="numeric" data-lc-win="${i}" placeholder="e.g. 4 9 17 25 28 36 41" value="${t.result && t.result.winning_numbers ? t.result.winning_numbers.join(' ') : ''}"></label>
          <label>Powerball / extra<input type="text" inputmode="numeric" data-lc-winx="${i}" placeholder="e.g. 7" value="${t.result && t.result.winning_extra ? t.result.winning_extra.join(' ') : ''}"></label>
          <label>Prize won ($)<input type="number" inputmode="decimal" min="0" step="0.01" data-lc-prize="${i}" placeholder="0 if nothing" value="${t.result && t.result.prize ? t.result.prize : ''}"></label>
        </div>
        <label class="lc-jp">Jackpot / first division prize ($)<input type="number" inputmode="decimal" min="0" step="1" data-lc-jp="${i}" value="${t.jackpot || ''}" placeholder="e.g. 50000000"></label>
        ${t.result && t.result.prize != null ? `<div class="lc-info-res">${(t.result.prize || 0) > 0 ? 'Won ' + fmtMoney(t.result.prize) : 'No prize'}</div>` : ''}
      </div>`).join('') + (() => { const w = (info.warnings || []).filter(x => !/jackpot|quick ?pick|result|labelled|labeled|letters|not shown/i.test(x)); return w.length ? `<div class="lc-info-warn">${w.map(x => '⚠ ' + esc(x)).join('<br>')}</div>` : ''; })()
      + `<div class="lc-actions"><button type="button" class="small adm-primary" id="lcInfoFill">Fill the draw form with these</button><button type="button" class="small" id="lcInfoClear">Clear</button></div>
         <div class="hint">Check the numbers against the screenshots before sharing. If one is wrong, tap Read tickets again.</div>`;
    wrap.querySelectorAll('[data-lc-jp]').forEach(inp => inp.addEventListener('input', () => { const t = info.tickets[+inp.dataset.lcJp]; if(t){ t.jackpot = parseFloat(inp.value) > 0 ? parseFloat(inp.value) : null; scheduleRender(); } }));
    const nums = (v) => (String(v).match(/\d+/g) || []).map(Number).filter(n => n >= 0 && n <= 99);
    const setRes = (i) => {
      const t = info.tickets[i], g = (a) => wrap.querySelector(`[data-lc-${a}="${i}"]`);
      const wn = nums(g('win').value), wx = nums(g('winx').value), pz = parseFloat(g('prize').value);
      t.result = (wn.length || wx.length || pz > 0 || g('prize').value !== '') ? { status: pz > 0 ? 'won' : (wn.length || g('prize').value !== '' ? 'lost' : 'pending'), prize: pz > 0 ? pz : 0, winning_numbers: wn, winning_extra: wx } : null;
      scheduleRender();
    };
    wrap.querySelectorAll('[data-lc-win],[data-lc-winx],[data-lc-prize]').forEach(inp => inp.addEventListener('input', () => setRes(+(inp.dataset.lcWin ?? inp.dataset.lcWinx ?? inp.dataset.lcPrize))));
    $('lcInfoFill').addEventListener('click', fillFromInfo);
    $('lcInfoClear').addEventListener('click', () => { info = null; renderInfo(); scheduleRender(); });
  }
  function fillFromInfo(){
    if(!info || !info.tickets.length) return;
    const t0 = info.tickets[0], games = [...new Set(info.tickets.map(t => t.game).filter(Boolean))];
    const set = (id, v) => { const el = $(id); if(el && v != null && v !== '') el.value = v; };
    set('lcLLabel', games.join(' + ') + (info.tickets.length > 1 ? ` (${info.tickets.length} tickets)` : '')); set('lcLDate', t0.draw_date); set('lcDate', t0.draw_date); set('lcTitle', games.join(' + '));
    const total = info.tickets.reduce((a, t) => a + (t.price || 0), 0); if(total > 0) set('lcLTicket', total);
    const jp = Math.max(...info.tickets.map(t => t.jackpot || 0)); if(jp > 0) set('lcLJackpot', jp);
    ['lcLTicket', 'lcLJackpot'].forEach(id => { const el = $(id); if(el) el.dispatchEvent(new Event('input', { bubbles: true })); });
    scheduleRender(); const rs = $('lcReadStatus'); rs.className = 'status-msg ok'; rs.textContent = 'Draw form filled in below. Add who bought in, then save the draw.';
  }
  async function readTickets(force){
    const rs = $('lcReadStatus'), btn = $('lcReadBtn'); if(!tickets.length) return;
    btn.disabled = true; rs.className = 'status-msg'; rs.textContent = `Reading ${tickets.length} screenshot${tickets.length === 1 ? '' : 's'}… about 10–20 seconds.`;
    try{
      const images = []; for(const t of tickets) images.push(await smallDataUrl(t.img));
      const auth = typeof getValidAuth === 'function' ? await getValidAuth() : null; if(!auth) throw new Error('Sign in again, then try.');
      const res = await fetch('/.netlify/functions/scan-lotto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: auth.idToken, images, groups: groups().map(g => g.length), force: !!force }) });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || `The ticket reader failed (HTTP ${res.status}).`);
      if(!data.tickets || !data.tickets.length) throw new Error('No ticket numbers found. Try a clearer, uncropped screenshot.');
      // saved copies lose empty lists, so fill them back in before anything reads them
      data.tickets.forEach(t => { t.entries = (t.entries || []).map(e => ({ ...e, numbers: e.numbers || [], extra: e.extra || [] })).filter(e => e.numbers.length); if(t.result){ t.result.winning_numbers = t.result.winning_numbers || []; t.result.winning_extra = t.result.winning_extra || []; } });
      data.warnings = data.warnings || [];
      info = data; renderInfo(); scheduleRender();
      rs.className = 'status-msg ok'; rs.textContent = `Found ${data.tickets.length} ticket${data.tickets.length === 1 ? '' : 's'}${data.cached ? ' (read before, so free)' : ''}. Check the numbers below.`;
    }catch(e){ rs.className = 'status-msg error'; rs.textContent = e.message || 'Could not read the tickets.'; }
    finally{ btn.disabled = false; }
  }

  // ---------- drawing ----------
  function wrapText(ctx, text, maxW){
    const words = String(text).split(/\s+/).filter(Boolean), lines = []; let line = '';
    words.forEach(w => { const t = line ? line + ' ' + w : w; if(ctx.measureText(t).width > maxW && line){ lines.push(line); line = w; } else line = t; });
    if(line) lines.push(line); return lines;
  }
  // ---------- ticket details (read from the screenshots) ----------
  const GOLD = '#e8c14f';
  const infoFor = (i) => { const on = $('lcShowInfo'); return (info && info.tickets && info.tickets[i] && (!on || on.checked)) ? info.tickets[i] : null; };
  const BALL = 44, BSTEP = 52;
  function stripH(t){ if(!t) return 0; return 22 + 54 + t.entries.length * 60 + (t.result && (t.result.prize != null || t.result.status) ? 56 : 0) + 14; }
  const fmtDay = (d) => { const x = new Date(d + 'T12:00:00'); return isNaN(x) ? '' : x.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }); };
  const fmtMoney = (v) => '$' + Number(v).toLocaleString('en-AU', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  function ball(ctx, cx, cy, n, o){
    ctx.beginPath(); ctx.arc(cx, cy, BALL / 2, 0, Math.PI * 2);
    ctx.fillStyle = o.hit ? (o.gold ? GOLD : LIME) : '#232a23'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = o.gold ? GOLD : LIME; ctx.globalAlpha = o.dim ? .45 : 1; ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = o.hit ? '#0d100d' : CHALK; ctx.font = '800 22px Manrope, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(n), cx, cy + 1); ctx.textAlign = 'left';
  }
  function drawStrip(ctx, t, x, y, w){
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const meta = [t.draw_number ? 'Draw ' + t.draw_number : '', t.draw_date ? fmtDay(t.draw_date) : '', t.price != null ? fmtMoney(t.price) : ''].filter(Boolean).join('  ·  ');
    let yy = y + 22 + 27;
    ctx.fillStyle = LIME; ctx.font = '800 32px Manrope, system-ui, sans-serif'; ctx.fillText(t.game || 'Lotto ticket', x + 22, yy, w - 44);
    const gw = Math.min(ctx.measureText(t.game || 'Lotto ticket').width, w - 44);
    ctx.fillStyle = MUTED; ctx.font = '600 24px Manrope, system-ui, sans-serif'; ctx.fillText(meta, x + 22 + gw + 20, yy + 1, Math.max(60, w - 44 - gw - 20));
    yy += 27 + 6;
    const win = t.result && t.result.winning_numbers.length ? new Set(t.result.winning_numbers) : null;
    const winX = t.result && t.result.winning_extra.length ? new Set(t.result.winning_extra) : null;
    t.entries.forEach((e) => {
      const cy = yy + 30;
      ctx.fillStyle = MUTED; ctx.font = '800 24px Manrope, system-ui, sans-serif'; ctx.fillText(e.label || '', x + 22, cy);
      let bx = x + 70 + BALL / 2;
      e.numbers.forEach(n => { ball(ctx, bx, cy, n, { hit: win ? win.has(n) : false, dim: !!win && !win.has(n) }); bx += BSTEP; });
      if(e.extra.length){ bx += 10; e.extra.forEach(n => { ball(ctx, bx, cy, n, { gold: true, hit: winX ? winX.has(n) : false, dim: !!winX && !winX.has(n) }); bx += BSTEP; }); }
      yy += 60;
    });
    if(t.result && (t.result.prize != null || t.result.status)){
      const won = t.result.status === 'won' || (t.result.prize || 0) > 0;
      ctx.fillStyle = won ? 'rgba(77,235,142,.16)' : 'rgba(255,255,255,.06)'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x + 22, yy + 6, w - 44, 44, 22) : ctx.rect(x + 22, yy + 6, w - 44, 44); ctx.fill();
      ctx.fillStyle = won ? '#4DEB8E' : MUTED; ctx.font = '800 24px Manrope, system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(won ? 'Won ' + fmtMoney(t.result.prize || 0) : (t.result.status === 'pending' ? 'Draw pending' : 'No prize'), x + w / 2, yy + 29); ctx.textAlign = 'left';
    }
  }

  // ---------- clean ticket card (drawn from the read details instead of the screenshots) ----------
  const GAME_COL = { powerball: '#3a6df0', 'oz lotto': '#f2b705', ozlotto: '#f2b705', 'tattslotto': '#e0343b', "saturday lotto": '#e0343b', 'set for life': '#7a5cf0', 'weekday windfall': '#19a974', 'monday lotto': '#e0343b', 'wednesday lotto': '#e0343b' };
  const accentFor = (g) => { const k = String(g || '').toLowerCase().replace(/[^a-z ]/g, '').trim(); for(const n in GAME_COL) if(k.includes(n)) return GAME_COL[n]; return LIME; };
  const cleanOn = () => { const sel = $('lcStyle'); return !sel || sel.value !== 'shots'; };
  const CROW = 54, CBALL = 35, CSTEP = 43;
  function cardMeta(t){
    return [['Total cost', t.price != null ? fmtMoney(t.price) : null], ['Purchased', t.purchased], ['Ticket no.', t.serial], ['Commission', t.commission ? fmtMoney(t.commission) : null]].filter(x => x[1]);
  }
  // "1 Draw, 36 Game Standard entry" -> pills: 36 games, 1 draw, Standard entry
  function chipsFor(t){
    const et = String(t.entry_type || ''), c = [];
    const g = /(\d+)\s*game/i.exec(et), d = /(\d+)\s*draw/i.exec(et), k = /(standard|system\s*\d*|quick\s*pick|mega|flexi|super)[a-z ]*?(entry|ticket)?(?=,|$)/i.exec(et);
    const n = g ? +g[1] : t.entries.length; c.push(n + ' game' + (n === 1 ? '' : 's'));
    const dr = d ? +d[1] : (t.draws || 1); c.push(dr + ' draw' + (dr === 1 ? '' : 's'));
    if(k) c.push(k[0].trim().replace(/^./, m => m.toUpperCase())); else if(et && !g && !d) c.push(et);
    if(t.quick_pick) c.push('Quick Pick');
    return c;
  }
  const bigMoney = (v) => v >= 1e6 ? '$' + (Math.round(v / 1e5) / 10).toString().replace(/\.0$/, '') + ' Million' : fmtMoney(v);
  function cardH(t){
    const rows = t.entries.length > 8 ? Math.ceil(t.entries.length / 2) : t.entries.length;
    const metaRows = Math.ceil(cardMeta(t).length / 2);
    return 100 + 18 + 66 + (t.jackpot ? 88 : 0) + metaRows * 62 + 30 + rows * CROW + 30 + (t.result && (t.result.prize != null || t.result.status) ? 64 : 0);
  }
  function drawCard(ctx, t, x, y, w, n, total){
    const acc = accentFor(t.game), h = cardH(t);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    // header band in the game's colour
    ctx.save(); ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, 20) : ctx.rect(x, y, w, h); ctx.clip();
    ctx.fillStyle = PANEL; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = acc; ctx.fillRect(x, y, w, 96);
    ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(x, y + 96, w, 4);
    const dark = acc === '#f2b705' || acc === LIME; const ink = dark ? '#0d100d' : '#ffffff';
    if(total > 1){ ctx.fillStyle = dark ? 'rgba(13,16,13,.65)' : 'rgba(255,255,255,.78)'; ctx.font = '800 20px Manrope, system-ui, sans-serif'; ctx.fillText('TICKET ' + n, x + 28, y + 24); }
    ctx.fillStyle = ink; ctx.font = '800 40px Manrope, system-ui, sans-serif'; ctx.fillText(t.game || 'Lotto ticket', x + 28, y + (total > 1 ? 62 : 48), w * 0.5);
    ctx.textAlign = 'right';
    ctx.font = '800 30px Manrope, system-ui, sans-serif'; ctx.fillText(t.draw_number ? 'Draw ' + t.draw_number : '', x + w - 28, y + 34);
    ctx.font = '700 26px Manrope, system-ui, sans-serif'; ctx.fillStyle = dark ? 'rgba(13,16,13,.8)' : 'rgba(255,255,255,.9)'; ctx.fillText(t.draw_date ? fmtDay(t.draw_date) + ' ' + new Date(t.draw_date + 'T12:00:00').getFullYear() : '', x + w - 28, y + 70);
    ctx.textAlign = 'left';
    // details grid
    let yy = y + 100 + 18;
    // ticket type pills
    let px = x + 28; ctx.font = '800 22px Manrope, system-ui, sans-serif'; ctx.textBaseline = 'middle';
    chipsFor(t).forEach(c => { const tw = ctx.measureText(c).width + 30; if(px + tw > x + w - 20) return; ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(px, yy + 6, tw, 40, 20) : ctx.rect(px, yy + 6, tw, 40); ctx.fill(); ctx.fillStyle = CHALK; ctx.textAlign = 'left'; ctx.fillText(c, px + 15, yy + 27); px += tw + 10; });
    yy += 66;
    // prize money
    if(t.jackpot){
      ctx.fillStyle = 'rgba(232,193,79,.13)'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x + 28, yy + 2, w - 56, 74, 16) : ctx.rect(x + 28, yy + 2, w - 56, 74); ctx.fill();
      ctx.strokeStyle = 'rgba(232,193,79,.55)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.textAlign = 'left'; ctx.fillStyle = GOLD; ctx.font = '800 21px Manrope, system-ui, sans-serif'; ctx.fillText(/lotto|saturday|monday|wednesday|windfall/i.test(t.game || '') && !/oz|power/i.test(t.game || '') ? 'FIRST DIVISION PRIZE' : 'JACKPOT', x + 50, yy + 40);
      ctx.textAlign = 'right'; ctx.fillStyle = '#f6d36b'; ctx.font = '800 40px Manrope, system-ui, sans-serif'; ctx.fillText(bigMoney(t.jackpot), x + w - 50, yy + 40); ctx.textAlign = 'left';
      yy += 88;
    }
    const meta = cardMeta(t), LW = Math.round((w - 56) * 0.5), cw = LW;
    meta.forEach((m, i) => {
      const cx = x + 28 + (i % 2) * LW, cy = yy + Math.floor(i / 2) * 62, cwi = i % 2 ? (w - 56) - LW : LW;
      ctx.fillStyle = MUTED; ctx.font = '700 20px Manrope, system-ui, sans-serif'; ctx.fillText(m[0].toUpperCase(), cx, cy + 10);
      ctx.fillStyle = m[0] === 'Total cost' ? LIME : CHALK; ctx.font = '800 28px Manrope, system-ui, sans-serif'; ctx.fillText(String(m[1]), cx, cy + 40, cwi - 14);
    });
    yy += Math.ceil(meta.length / 2) * 62 + 14;
    ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(x + 28, yy, w - 56, 2); yy += 16;
    // games, in two columns when there are many
    const two = t.entries.length > 8, per = two ? Math.ceil(t.entries.length / 2) : t.entries.length, gw = two ? (w - 56) / 2 : w - 56;
    const win = t.result && t.result.winning_numbers.length ? new Set(t.result.winning_numbers) : null, winX = t.result && t.result.winning_extra.length ? new Set(t.result.winning_extra) : null;
    t.entries.forEach((e, i) => {
      const col = two ? Math.floor(i / per) : 0, row = two ? i % per : i, gx = x + 28 + col * gw, cy = yy + row * CROW + CROW / 2;
      if(row % 2 === 0){ ctx.fillStyle = 'rgba(255,255,255,.03)'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(gx - 8, cy - CROW / 2 + 3, gw - 4, CROW - 6, 12) : ctx.rect(gx - 8, cy - CROW / 2 + 3, gw - 4, CROW - 6); ctx.fill(); }
      ctx.fillStyle = MUTED; ctx.font = '800 22px Manrope, system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillText(e.label || String(i + 1), gx + 2, cy);
      let bx = gx + 44 + CBALL / 2;
      e.numbers.forEach(nn => { ballS(ctx, bx, cy, nn, { hit: win ? win.has(nn) : false, dim: !!win && !win.has(nn) }, CBALL); bx += CSTEP; });
      if(e.extra.length){ bx += 6; e.extra.forEach(nn => { ballS(ctx, bx, cy, nn, { gold: true, hit: winX ? winX.has(nn) : false, dim: !!winX && !winX.has(nn) }, CBALL); bx += CSTEP; }); }
    });
    yy += per * CROW + 12;
    if(t.result && (t.result.prize != null || t.result.status)){
      const won = t.result.status === 'won' || (t.result.prize || 0) > 0;
      ctx.fillStyle = won ? 'rgba(77,235,142,.16)' : 'rgba(255,255,255,.06)'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x + 28, yy + 6, w - 56, 46, 23) : ctx.rect(x + 28, yy + 6, w - 56, 46); ctx.fill();
      ctx.fillStyle = won ? '#4DEB8E' : MUTED; ctx.font = '800 26px Manrope, system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(won ? 'Won ' + fmtMoney(t.result.prize || 0) : (t.result.status === 'pending' ? 'Draw pending' : 'No prize'), x + w / 2, yy + 30); ctx.textAlign = 'left';
    }
    ctx.restore();
  }
  function ballS(ctx, cx, cy, n, o, d){
    ctx.beginPath(); ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
    ctx.fillStyle = o.hit ? (o.gold ? GOLD : LIME) : (o.gold ? '#2a2412' : '#232a23'); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = o.gold ? GOLD : LIME; ctx.globalAlpha = o.dim ? .45 : 1; ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = o.hit ? '#0d100d' : CHALK; ctx.font = '800 19px Manrope, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(n), cx, cy + 1); ctx.textAlign = 'left';
  }

  // Pick how many columns gives the most phone-friendly shape (close to 3:4 portrait).
  function planLayout(){
    const gs = groups(), n = gs.length; let best = null;
    const heights = gs.map((g, i) => (infoFor(i) && cleanOn()) ? cardH(infoFor(i)) : g.reduce((a, t) => a + Math.round(COL_W * t.h / t.w), 0) + (g.length - 1) * PART_GAP + stripH(infoFor(i)));
    for(let c = 1; c <= Math.min(n, 4); c++){
      const colH = new Array(c).fill(0), place = [];
      heights.forEach((h, i) => { const k = colH.indexOf(Math.min(...colH)); place.push({ col: k, y: colH[k], h }); colH[k] += h + GAP; });
      const bodyH = Math.max(...colH) - GAP, bodyW = c * COL_W + (c - 1) * GAP;
      const score = Math.abs(Math.log((bodyW / (bodyH + 300)) / 0.75));
      if(!best || score < best.score) best = { c, place, bodyW, bodyH, score };
    }
    const forced = parseInt(($('lcCols') || {}).value, 10);
    if(forced && forced <= Math.max(1, n)){
      const c = Math.min(forced, n), colH = new Array(c).fill(0), place = [];
      heights.forEach((h) => { const k = colH.indexOf(Math.min(...colH)); place.push({ col: k, y: colH[k], h }); colH[k] += h + GAP; });
      best = { c, place, bodyW: c * COL_W + (c - 1) * GAP, bodyH: Math.max(...colH) - GAP };
    }
    return best;
  }
  function draw(){
    const canvas = $('lcCanvas'); if(!canvas || !tickets.length) return null;
    const L = planLayout(), showTitle = $('lcShowTitle').checked, showWho = $('lcShowWho').checked;
    const title = ($('lcTitle').value || '').trim(), date = prettyDate($('lcDate').value);
    const who = tgt === 'ml' ? allNames() : group().members, gName = tgt === 'ml' ? 'MLSynd' : group().name;
    const W = L.bodyW + PAD * 2;
    const m = document.createElement('canvas').getContext('2d');
    m.font = '600 34px Manrope, system-ui, sans-serif';
    const whoText = showWho && who.length ? (gName ? gName + ': ' : 'In: ') + who.join(', ') : '';
    const whoLines = whoText ? wrapText(m, whoText, W - PAD * 2) : [];
    const headH = showTitle && (title || date) ? 190 : 0;
    const footH = whoLines.length ? 40 + whoLines.length * 46 + 10 : 0;
    const H = PAD + headH + L.bodyH + (footH ? PAD + footH : 0) + PAD;
    let s = Math.min(1, MAX_SIDE / Math.max(W, H), Math.sqrt(MAX_AREA / (W * H)));
    canvas.width = Math.round(W * s); canvas.height = Math.round(H * s);
    const ctx = canvas.getContext('2d'); ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
    let y = PAD;
    if(headH){
      const ml = tgt === 'ml', D = 150, ic = ml ? null : art.icon, mk = ml ? null : art.mark;
      const LH = 120, logoW = ml && art.logo ? Math.min(380, Math.round(LH * art.logo.naturalWidth / art.logo.naturalHeight)) : 0;
      const tx = PAD + (ic ? D + 28 : logoW ? logoW + 30 : 32);
      if(ic){
        ctx.save(); ctx.beginPath(); ctx.arc(PAD + D / 2, y + D / 2, D / 2, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(ic, PAD, y, D, D); ctx.restore();
        ctx.lineWidth = 4; ctx.strokeStyle = '#c9a24a'; ctx.beginPath(); ctx.arc(PAD + D / 2, y + D / 2, D / 2 - 2, 0, Math.PI * 2); ctx.stroke();
      }else if(logoW){ ctx.drawImage(art.logo, PAD, y + (D - LH) / 2, logoW, LH);
      }else{ ctx.fillStyle = LIME; ctx.fillRect(PAD, y + 8, 8, 96); }
      const badge = mk ? 130 : 0, textW = W - tx - PAD - (badge ? badge + 20 : 0);
      ctx.fillStyle = CHALK; ctx.font = '800 64px Manrope, system-ui, sans-serif'; ctx.textBaseline = 'top';
      ctx.fillText(title || (ml ? 'MLSynd' : 'Lotto Pigs'), tx, y + 22, textW);
      ctx.fillStyle = MUTED; ctx.font = '600 34px Manrope, system-ui, sans-serif';
      ctx.fillText([date, `${groups().length} ticket${groups().length === 1 ? '' : 's'}`].filter(Boolean).join('  ·  '), tx, y + 98, textW);
      if(badge){ ctx.save(); ctx.beginPath(); ctx.arc(W - PAD - badge / 2, y + D / 2, badge / 2, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(mk, W - PAD - badge, y + D / 2 - badge / 2, badge, badge); ctx.restore(); }
      y += headH;
    }
    const gs = groups();
    gs.forEach((g, i) => {
      const p = L.place[i], x = PAD + p.col * (COL_W + GAP), yy = y + p.y;
      if(infoFor(i) && cleanOn()){ drawCard(ctx, infoFor(i), x, yy, COL_W, i + 1, gs.length); return; }
      ctx.fillStyle = PANEL; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x - 6, yy - 6, COL_W + 12, p.h + 12, 22) : ctx.rect(x - 6, yy - 6, COL_W + 12, p.h + 12); ctx.fill();
      ctx.save(); ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, yy, COL_W, p.h, 16) : ctx.rect(x, yy, COL_W, p.h); ctx.clip();
      let py = yy;
      g.forEach((t) => { const h = Math.round(COL_W * t.h / t.w); ctx.drawImage(t.img, x, py, COL_W, h); py += h + PART_GAP; });
      ctx.restore();
      const it = infoFor(i); if(it) drawStrip(ctx, it, x, py, COL_W);
      if(gs.length > 1){ // small "Ticket N" tab so the groups are obvious
        ctx.font = '800 30px Manrope, system-ui, sans-serif'; ctx.textBaseline = 'middle';
        const label = `Ticket ${i + 1}`, tw = ctx.measureText(label).width + 36;
        ctx.fillStyle = 'rgba(13,16,13,.88)'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x + 14, yy + 14, tw, 48, 24) : ctx.rect(x + 14, yy + 14, tw, 48); ctx.fill();
        ctx.fillStyle = LIME; ctx.fillText(label, x + 32, yy + 39);
      }
    });
    y += L.bodyH;
    if(footH){
      y += PAD;
      ctx.fillStyle = PANEL; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(PAD, y, W - PAD * 2, footH, 22) : ctx.rect(PAD, y, W - PAD * 2, footH); ctx.fill();
      ctx.fillStyle = CHALK; ctx.font = '600 34px Manrope, system-ui, sans-serif'; ctx.textBaseline = 'top';
      whoLines.forEach((ln, i) => ctx.fillText(ln, PAD + 28, y + 24 + i * 46, W - PAD * 2 - 56));
    }
    return canvas;
  }
  function scheduleRender(){ clearTimeout(renderTimer); renderTimer = setTimeout(() => { try{ draw(); lastBlob = null; }catch(e){ const s = $('lcStatus'); s.className = 'status-msg error'; s.textContent = 'Could not build the image: ' + e.message; } }, 120); }
  function toBlob(){
    return new Promise((resolve, reject) => {
      const canvas = draw(); if(!canvas) return reject(new Error('Add at least one ticket first.'));
      canvas.toBlob((png) => {
        if(png && png.size <= 6.5e6){ lastName = `lotto-tickets-${$('lcDate').value || todayStr()}.png`; return resolve(png); }
        canvas.toBlob((jpg) => { if(!jpg) return reject(new Error('Could not make the image.')); lastName = `lotto-tickets-${$('lcDate').value || todayStr()}.jpg`; resolve(jpg); }, 'image/jpeg', 0.92);
      }, 'image/png');
    });
  }
  async function download(){
    const status = $('lcStatus');
    try{
      const blob = await toBlob(); lastBlob = blob;
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = lastName; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      status.className = 'status-msg ok'; status.textContent = `Saved ${lastName} to your downloads (${(blob.size / 1048576).toFixed(1)} MB).`;
    }catch(e){ status.className = 'status-msg error'; status.textContent = e.message; }
  }
  async function share(){
    const status = $('lcStatus');
    try{
      const blob = await toBlob(); const file = new File([blob], lastName, { type: blob.type });
      if(navigator.canShare && navigator.canShare({ files: [file] })){ await navigator.share({ files: [file], title: ($('lcTitle').value || 'Lotto Pigs') }); status.className = 'status-msg ok'; status.textContent = 'Shared.'; }
      else { await download(); status.textContent += ' Sharing isn\'t available in this browser, so it was downloaded instead.'; }
    }catch(e){ if(e && e.name === 'AbortError') return; status.className = 'status-msg error'; status.textContent = e.message || 'Could not share.'; }
  }


  // ---------- Lotto Pigs profit and loss ----------
  // Each draw: a price per share (it changes ticket to ticket), and how many
  // shares each person bought. Only people with shares are in that draw, and
  // winnings are split by shares. Someone who didn't buy in gets nothing.
  const money = (v) => { const n = Math.round((Number(v) || 0) * 100) / 100, a = Math.abs(n); return (n < 0 ? '-' : '') + '$' + a.toLocaleString('en-AU', { minimumFractionDigits: a % 1 ? 2 : 0, maximumFractionDigits: 2 }); };
  const moneyShort = (v) => { const a = Math.abs(Number(v) || 0); return a >= 1e9 ? '$' + (a / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B' : a >= 1e6 ? '$' + (a / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M' : money(v); };
  const signed = (v) => (Math.round((Number(v) || 0) * 100) > 0 ? '+' : '') + money(v);
  const PRICE_KEY = 'mlsynd-lotto-share-price';
  let editingId = null, draftShares = {};
  const lastPrice = () => { try{ const v = parseFloat(localStorage.getItem(PRICE_KEY)); return v > 0 ? v : 25; }catch(e){ return 25; } };
  // one shape for every saved draw (older entries without shares count as one share each)
  function norm(e){
    let shares = {};
    if(e.shares && typeof e.shares === 'object') Object.entries(e.shares).forEach(([n, c]) => { if(Number(c) > 0) shares[n] = Number(c); });
    else if(Array.isArray(e.members)) e.members.forEach(n => { shares[n] = 1; });
    const total = Object.values(shares).reduce((x, y) => x + y, 0);
    const costMode = e.costMode === 'total' ? 'total' : 'share';
    const price = Number(e.price) > 0 ? Number(e.price) : (total ? (Number(e.cost) || 0) / total : 0);
    const cost = e.shares ? (costMode === 'total' && Number(e.cost) > 0 ? Number(e.cost) : total * price) : (Number(e.cost) || 0);
    const covered = Math.min(cost, Math.max(0, Number(e.covered) || 0));
    const pend = e.won == null || e.won === '';
    const entrants = Object.keys(shares).length, topUp = Math.max(0, cost - covered);
    return { entrants, topUp, each: covered > 0 && entrants ? topUp / entrants : null, shares, total, price, cost, covered, costMode, pend, won: pend ? 0 : Number(e.won) || 0, jackpot: Number(e.jackpot) > 0 ? Number(e.jackpot) : 0, hasTicket: !!e.hasTicket };
  }
  function entries(){
    const o = LP.ledger || {};
    return Object.entries(o).filter(([, e]) => e && typeof e === 'object').map(([id, e]) => ({ id, ...e }))
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
  }
  // Winnings from one draw that were put toward the next ticket. Linked by choice, or matched by amount.
  function rollLinks(list){
    const out = { from: {}, into: {} };
    list.forEach(e => {
      const n = norm(e); if(!(n.covered > 0)) return;
      let src = e.coveredFrom && list.find(x => x.id === e.coveredFrom);
      if(!src) src = list.filter(x => x.id !== e.id && Math.abs(norm(x).won - n.covered) < 0.005 && norm(x).won > 0 && (x.date || '') <= (e.date || '')).sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
      if(src){ out.from[e.id] = src; (out.into[src.id] = out.into[src.id] || []).push(e); }
    });
    return out;
  }
  function totals(list){
    let spent = 0, won = 0, pending = 0, covered = 0; const per = {};
    list.forEach(e => {
      const n = norm(e); spent += n.cost; won += n.won; covered += n.covered; if(n.pend) pending++;
      Object.entries(n.shares).forEach(([name, c]) => {
        const r = per[name] || (per[name] = { spent: 0, cash: 0, won: 0, draws: 0, shares: 0 });
        const f = n.total ? c / n.total : 0, eq = n.covered > 0 && n.entrants; // winnings used on a ticket: the rest is topped up equally per member
        r.spent += eq ? n.cost / n.entrants : n.cost * f; r.cash += eq ? n.topUp / n.entrants : (n.cost - n.covered) * f; r.won += n.won * f; r.draws++; r.shares += c;
      });
    });
    return { spent, won, covered, cash: spent - covered, net: won - spent, pending, per, draws: list.length };
  }
  function summaryText(list){
    const t = totals(list), g = group();
    return `${g.name || 'Lotto Pigs'}: ${t.draws} draw${t.draws === 1 ? '' : 's'}, spent ${money(t.spent)}, won ${money(t.won)}, net ${signed(t.net)}${t.pending ? ` (${t.pending} awaiting result)` : ''}.${t.covered > 0 ? ` Paid in cash ${money(t.cash)}, ${money(t.covered)} from winnings.` : ''}` +
      Object.entries(t.per).map(([n, r]) => `\n${n}: in ${money(r.spent)}, back ${money(r.won)}, net ${signed(r.won - r.spent)}`).join('');
  }
  function syncFrom(){
    const sel = $('lcLFrom'); if(!sel) return; const prev = sel.value;
    sel.innerHTML = '<option value="">—</option>' + entries().filter(e => norm(e).won > 0 && e.id !== editingId).map(e => `<option value="${esc(e.id)}">${esc(e.label || 'Lotto draw')} · ${esc(prettyDate(e.date))} · ${money(norm(e).won)}</option>`).join('');
    if(prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
  }
  function renderShares(){
    const box = $('lcShares'); if(!box) return;
    const g = group(), price = parseFloat($('lcLPrice').value) || 0, tcost = parseFloat($('lcLTicket').value) || 0, cov = parseFloat($('lcLCovered').value) || 0;
    const names = g.members.slice(); Object.keys(draftShares).forEach(n => { if(!names.includes(n)) names.push(n); });
    const total = names.reduce((x, n) => x + (draftShares[n] || 0), 0), entrants = names.filter(n => draftShares[n] > 0).length;
    box.innerHTML = names.length ? names.map(n => `<div class="lc-share-row"><span>${esc(n)}</span>
        <button type="button" data-lc-sh="-1" data-lc-n="${esc(n)}" aria-label="One less share for ${esc(n)}" ${draftShares[n] > 0 ? '' : 'disabled'}>−</button>
        <b>${draftShares[n] || 0}</b>
        <button type="button" data-lc-sh="1" data-lc-n="${esc(n)}" aria-label="One more share for ${esc(n)}">+</button></div>`).join('')
      : '<div class="hint">Pick the Lotto Pigs members above first.</div>';
    if(!total){ $('lcLTotal').textContent = 'Tap + for each share someone buys. No shares means they\'re not in this draw.'; return; }
    const cost = tcost > 0 ? tcost : total * price, pay = Math.max(0, cost - cov);
    $('lcLTotal').textContent = `${total} share${total === 1 ? '' : 's'} · ${entrants} in · ticket ${money(cost)}${tcost > 0 ? ` (${money(cost / total)} a share)` : ` (${total} × ${money(price)})`}` +
      (cov > 0 ? ` · winnings cover ${money(Math.min(cov, cost))} · members pay ${money(pay)}${pay > 0 && entrants ? ` (${money(pay / entrants)} each, split equally)` : ''}` : ` · members pay ${money(pay)}`);
  }
  function renderLedger(){
    const box = $('lcLedger'); if(!box) return;
    const list = entries(), t = totals(list);
    $('lcSummary').innerHTML = list.length ? `
      <div class="lc-sum"><span>Spent</span><b>${money(t.spent)}</b></div>
      <div class="lc-sum"><span>Won</span><b>${money(t.won)}</b></div>
      <div class="lc-sum ${t.net >= 0 ? 'pos' : 'neg'}"><span>Net</span><b>${signed(t.net)}</b></div>
      <div class="lc-sum"><span>Draws</span><b>${t.draws}</b></div>` : '';
    $('lcLedgerNote').textContent = (t.covered > 0 ? `Members paid ${money(t.cash)} in cash; ${money(t.covered)} of the tickets came out of winnings. ` : '') + (t.pending ? `${t.pending} draw${t.pending === 1 ? ' is' : 's are'} still awaiting a result, counted as $0 won until you enter it.` : '');
    const links = rollLinks(list);
    $('lcEntries').innerHTML = list.length ? list.map(e => {
      const n = norm(e), who = Object.entries(n.shares).map(([name, c]) => `${name} ${c}`).join(', ');
      return `<div class="lc-entry" data-lc-eid="${esc(e.id)}">
        <div class="lc-entry-main"><b>${esc(e.label || 'Lotto draw')}</b><span>${esc(prettyDate(e.date))}</span></div>
        <div class="lc-entry-who">${n.total} share${n.total === 1 ? '' : 's'} · ${n.costMode === 'total' ? money(n.price || (n.total ? n.cost / n.total : 0)) + ' each' : '× ' + money(n.price)} · ${esc(who)}</div>
        ${n.covered > 0 ? `<div class="lc-entry-who">Winnings covered ${money(n.covered)}${links.from[e.id] ? ' (from ' + esc(links.from[e.id].label || 'an earlier draw') + ')' : ''} · members top up ${money(n.cost - n.covered)}${n.each != null && n.topUp > 0 ? ` · ${money(n.each)} each` : ''}</div>` : ''}
        ${links.into[e.id] ? `<div class="lc-entry-who">Winnings rolled into ${esc(links.into[e.id].map(x => x.label || 'next draw').join(', '))}</div>` : ''}
        <div class="lc-entry-nums"><span>Cost ${money(n.cost)}</span><span>${n.pend ? 'Awaiting result' : 'Won ' + money(n.won)}</span><b class="${n.pend ? '' : (n.won - n.cost >= 0 ? 'pos' : 'neg')}">${n.pend ? '–' : signed(n.won - n.cost)}</b></div>
        ${n.jackpot ? `<div class="lc-entry-who">Top prize ${money(n.jackpot)} · ${money(n.jackpot / n.total)} a share</div>` : ''}
        <div class="lc-entry-btns">${n.hasTicket ? `<button type="button" class="small" data-lc-view="${esc(e.id)}">View ticket</button>` : ''}<button type="button" class="small" data-lc-edit="${esc(e.id)}">${n.pend ? 'Enter result' : 'Edit'}</button>${n.hasTicket ? `<button type="button" class="small" data-lc-unattach="${esc(e.id)}">Remove ticket</button>` : ''}<button type="button" class="small danger" data-lc-del="${esc(e.id)}">Delete</button></div>
      </div>`; }).join('') : '<div class="empty">No draws yet. Add the first one above.</div>';
    const names = Object.keys(t.per);
    $('lcPerMember').innerHTML = names.length ? `<h3 class="lc-h3">Per person (winnings split by shares)</h3>` + names.map(n => { const r = t.per[n], net = r.won - r.spent; return `<div class="lc-pm"><span>${esc(n)}${t.covered > 0 ? `<small>cash in ${money(r.cash)}</small>` : ''}</span><span>in ${money(r.spent)}</span><span>back ${money(r.won)}</span><b class="${net >= 0 ? 'pos' : 'neg'}">${signed(net)}</b></div>`; }).join('') : '';
    $('lcCopy').disabled = !list.length; syncAttach(); syncFrom();
  }
  function resetForm(){
    editingId = null; draftShares = {};
    $('lcLDate').value = todayStr(); $('lcLLabel').value = ''; $('lcLPrice').value = lastPrice(); $('lcLTicket').value = ''; $('lcLCovered').value = ''; $('lcLWon').value = ''; $('lcLJackpot').value = ''; if($('lcLFrom')) $('lcLFrom').value = '';
    $('lcLSave').textContent = 'Add draw'; $('lcLCancel').hidden = true; renderShares();
  }
  async function saveEntry(){
    const status = $('lcLStatus');
    const wonRaw = $('lcLWon').value.trim(), tcost = parseFloat($('lcLTicket').value), covered = parseFloat($('lcLCovered').value) || 0;
    const costMode = tcost > 0 ? 'total' : 'share';
    const total = Object.values(draftShares).reduce((x, y) => x + y, 0);
    if(!total){ status.className = 'status-msg error'; status.textContent = 'Add at least one share for someone.'; return; }
    const price = costMode === 'total' ? tcost / total : parseFloat($('lcLPrice').value);
    if(!(price > 0)){ status.className = 'status-msg error'; status.textContent = 'Enter the price of one share, or the total ticket cost.'; return; }
    const fullCost = costMode === 'total' ? tcost : total * price;
    if(covered < 0 || covered > fullCost + 0.005){ status.className = 'status-msg error'; status.textContent = `"Covered by winnings" can't be more than the ticket cost (${money(fullCost)}).`; return; }
    const won = wonRaw === '' ? null : parseFloat(wonRaw);
    if(won !== null && (isNaN(won) || won < 0)){ status.className = 'status-msg error'; status.textContent = 'Winnings must be a number, or leave it blank until the result is in.'; return; }
    const old = editingId ? (LP.ledger || {})[editingId] : null;
    const id = editingId || ('l' + Date.now());
    const shares = {}; Object.entries(draftShares).forEach(([n, c]) => { if(c > 0) shares[n] = c; });
    const entry = { date: $('lcLDate').value || todayStr(), label: $('lcLLabel').value.trim() || 'Lotto draw', price: Math.round(price * 10000) / 10000, shares, costMode, covered: Math.round(covered * 100) / 100,
      cost: Math.round(fullCost * 100) / 100, won: won == null ? null : Math.round(won * 100) / 100, createdAt: old ? old.createdAt || Date.now() : Date.now() };
    if(covered > 0 && $('lcLFrom').value) entry.coveredFrom = $('lcLFrom').value;
    const jp = parseFloat($('lcLJackpot').value); if(jp > 0) entry.jackpot = Math.round(jp * 100) / 100;
    if(old && old.hasTicket) entry.hasTicket = true;
    const btn = $('lcLSave'); btn.disabled = true;
    try{
      const res = await authedWrite(`/lottoPigs/ledger/${id}.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) });
      if(!res.ok) throw new Error('HTTP ' + res.status);
      try{ if(costMode === 'share') localStorage.setItem(PRICE_KEY, String(entry.price)); }catch(e){}
      (LP.ledger = LP.ledger || {})[id] = entry;
      status.className = 'status-msg ok'; status.textContent = editingId ? 'Draw updated.' : 'Draw added.';
      resetForm(); renderLedger();
    }catch(e){ status.className = 'status-msg error'; status.textContent = 'Could not save. Check your connection and try again.'; }
    btn.disabled = false;
  }
  async function deleteEntry(id){
    const e = (LP.ledger || {})[id]; if(!e) return;
    if(!confirm(`Delete "${e.label || 'Lotto draw'}" (${prettyDate(e.date)})? It comes out of the Lotto Pigs profit and loss.`)) return;
    const status = $('lcLStatus');
    try{
      const res = await authedWrite(`/lottoPigs/ledger/${id}.json`, { method: 'DELETE' });
      if(!res.ok) throw new Error('HTTP ' + res.status);
      delete LP.ledger[id]; if(editingId === id) resetForm();
      status.className = 'status-msg ok'; status.textContent = 'Deleted.'; renderLedger();
    }catch(err){ status.className = 'status-msg error'; status.textContent = 'Could not delete. Try again.'; }
  }
  function startEdit(id){
    const e = (LP.ledger || {})[id]; if(!e) return;
    const n = norm(e);
    editingId = id; draftShares = { ...n.shares };
    $('lcLDate').value = e.date || todayStr(); $('lcLLabel').value = e.label || ''; $('lcLPrice').value = n.costMode === 'share' && n.price ? n.price : lastPrice(); $('lcLTicket').value = n.costMode === 'total' ? n.cost : ''; $('lcLCovered').value = n.covered || ''; $('lcLWon').value = n.pend ? '' : n.won; $('lcLJackpot').value = n.jackpot || ''; syncFrom(); $('lcLFrom').value = e.coveredFrom || '';
    $('lcLSave').textContent = 'Save changes'; $('lcLCancel').hidden = false; renderShares();
    $('lcLWon').focus(); $('lcLForm').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }


  // ---------- ticket pictures kept with a draw ----------
  // Stored apart from the draws (/lottoPigsTickets) so loading the profit and loss stays light.
  const ticketCache = {};
  function syncAttach(){
    const sel = $('lcAttachSel'), btn = $('lcAttach'); if(!sel || !btn) return;
    const lab = sel.closest('label'); if(lab) lab.hidden = tgt === 'ml';
    btn.textContent = tgt === 'ml' ? 'Save to MLSynd' : 'Save to draw';
    const mh = $('lcMlHint'); if(mh) mh.hidden = tgt !== 'ml';
    const mm = $('lcMlManage'); if(mm) mm.hidden = tgt !== 'ml';
    if(tgt === 'ml') renderMlAdmin();
    if(tgt === 'ml'){ btn.disabled = !tickets.length; return; }
    const prev = sel.value, list = entries();
    sel.innerHTML = '<option value="">Choose a draw…</option>' + list.map(e => `<option value="${esc(e.id)}">${esc(e.label || 'Lotto draw')} · ${esc(prettyDate(e.date))}${e.hasTicket ? ' (has a ticket)' : ''}</option>`).join('');
    if(prev && list.some(e => e.id === prev)) sel.value = prev;
    btn.disabled = !(tickets.length && sel.value);
  }
  function ticketDataUrl(){
    const c = draw(); if(!c) throw new Error('Add at least one ticket first.');
    const maxW = 1600, k = Math.min(1, maxW / c.width), out = document.createElement('canvas');
    out.width = Math.round(c.width * k); out.height = Math.round(c.height * k);
    const x = out.getContext('2d'); x.fillStyle = '#0d100d'; x.fillRect(0, 0, out.width, out.height); x.drawImage(c, 0, 0, out.width, out.height);
    let q = 0.82, url = out.toDataURL('image/jpeg', q);
    while(url.length > 3.2e6 && q > 0.45){ q -= 0.1; url = out.toDataURL('image/jpeg', q); }
    return url;
  }
  function renderMlAdmin(){
    const sel = $('lcMlReplace'), list = $('lcMlList'); if(!sel || !list) return;
    const items = Object.keys(ML.meta).map(id => ({ id, ...ML.meta[id] })).sort((a, b) => (b.at || 0) - (a.at || 0));
    const prev = sel.value;
    sel.innerHTML = '<option value="">Save as a new ticket</option>' + items.map(m => `<option value="${esc(m.id)}">Replace: ${esc(m.label || 'MLSynd lotto')} · ${esc(prettyDate(m.date))}</option>`).join('');
    if(prev && items.some(m => m.id === prev)) sel.value = prev;
    list.innerHTML = items.length ? items.map(m => `<div class="lc-ml-row"><span><b>${esc(m.label || 'MLSynd lotto')}</b><i>${esc(prettyDate(m.date))}${m.games ? ' · ' + esc(m.games) : ''}</i></span><button type="button" class="small danger" data-lc-mlrm="${esc(m.id)}">Remove</button></div>`).join('') : '<div class="hint">Nothing saved yet. Saved tickets show on Home → Overview until you remove them.</div>';
  }
  async function removeMl(id){
    const m = ML.meta[id] || {}; if(!confirm(`Remove "${m.label || 'this ticket'}" from the Overview?`)) return;
    const st2 = $('lcAttachStatus');
    try{
      await authedWrite(`/mlsyndLotto/img/${id}.json`, { method: 'DELETE' });
      const r = await authedWrite(`/mlsyndLotto/meta/${id}.json`, { method: 'DELETE' }); if(!r.ok) throw new Error('HTTP ' + r.status);
      delete ML.meta[id]; delete ticketCache['ml:' + id]; renderMlHome(); renderMlAdmin();
      st2.className = 'status-msg ok'; st2.textContent = 'Removed from the Overview.';
    }catch(e){ st2.className = 'status-msg error'; st2.textContent = 'Could not remove it. Try again.'; }
  }
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-lc-mlrm]'); if(b) removeMl(b.dataset.lcMlrm); });
  async function attachMl(){
    const st2 = $('lcAttachStatus'), btn = $('lcAttach'); if(!tickets.length) return;
    btn.disabled = true; st2.className = 'status-msg'; st2.textContent = 'Saving…';
    try{
      const rep = $('lcMlReplace') ? $('lcMlReplace').value : '';
      const img = ticketDataUrl(), id = rep && ML.meta[rep] ? rep : 'm' + Date.now().toString(36);
      const games = info && info.tickets ? [...new Set(info.tickets.map(t => t.game).filter(Boolean))].join(' + ') : '';
      const meta = { label: ($('lcTitle').value || '').trim() || 'MLSynd lotto', date: $('lcDate').value || todayStr(), n: groups().length, games, at: Date.now() };
      let r = await authedWrite(`/mlsyndLotto/img/${id}.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ img }) });
      if(!r.ok) throw new Error('HTTP ' + r.status);
      r = await authedWrite(`/mlsyndLotto/meta/${id}.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) });
      if(!r.ok) throw new Error('HTTP ' + r.status);
      ML.meta[id] = meta; ticketCache['ml:' + id] = img; renderMlHome(); renderMlAdmin();
      st2.className = 'status-msg ok'; st2.textContent = 'Saved. MLSynd members can view it on Home → Overview.';
    }catch(e){ st2.className = 'status-msg error'; st2.textContent = 'Could not save the picture. Check the new Firebase rules are published, then try again.'; }
    syncAttach();
  }
  async function attachTicket(){
    if(tgt === 'ml') return attachMl();
    const st2 = $('lcAttachStatus'), id = $('lcAttachSel').value, btn = $('lcAttach');
    if(!id || !tickets.length) return;
    btn.disabled = true; st2.className = 'status-msg'; st2.textContent = 'Saving…';
    try{
      const img = ticketDataUrl();
      let r = await authedWrite(`/lottoPigsTickets/${id}.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ img, at: Date.now() }) });
      if(!r.ok) throw new Error('HTTP ' + r.status);
      r = await authedWrite(`/lottoPigs/ledger/${id}/hasTicket.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: 'true' });
      if(!r.ok) throw new Error('HTTP ' + r.status);
      if(info && info.tickets && info.tickets.length){ try{ await authedWrite(`/lottoPigs/ledger/${id}/ticketInfo.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(info.tickets) }); (LP.ledger[id] || (LP.ledger[id] = {})).ticketInfo = info.tickets; }catch(e){} }
      (LP.ledger[id] || (LP.ledger[id] = {})).hasTicket = true; ticketCache[id] = img;
      st2.className = 'status-msg ok'; st2.textContent = 'Saved. Group members can now view it on that draw.'; renderLedger();
    }catch(e){ st2.className = 'status-msg error'; st2.textContent = 'Could not save the picture. Check the new Firebase rules are published, then try again.'; }
    syncAttach();
  }
  async function unattachTicket(id){
    if(!confirm('Remove the ticket picture from this draw?')) return;
    const st2 = $('lcLStatus');
    try{
      await authedWrite(`/lottoPigsTickets/${id}.json`, { method: 'DELETE' });
      await authedWrite(`/lottoPigs/ledger/${id}/hasTicket.json`, { method: 'DELETE' });
      if(LP.ledger[id]) delete LP.ledger[id].hasTicket; delete ticketCache[id];
      renderLedger(); renderHome();
    }catch(e){ st2.className = 'status-msg error'; st2.textContent = 'Could not remove it. Try again.'; }
  }
  async function getTicket(id, kind){
    const ck = kind === 'ml' ? 'ml:' + id : id;
    if(ticketCache[ck]) return ticketCache[ck];
    const res = await authedFetch(kind === 'ml' ? `/mlsyndLotto/img/${id}.json` : `/lottoPigsTickets/${id}.json`);
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json(); if(!d || !d.img) throw new Error('missing');
    return (ticketCache[ck] = d.img);
  }
  async function viewTicket(id, kind){
    const ck = kind === 'ml' ? 'ml:' + id : id;
    const e = (kind === 'ml' ? ML.meta[id] : (LP.ledger || {})[id]) || {};
    let ov = $('lcViewer'); if(ov) ov.remove();
    ov = document.createElement('div'); ov.id = 'lcViewer'; ov.className = 'lc-viewer';
    ov.innerHTML = `<div class="lc-viewer-bar"><div><b>${esc(e.label || 'Lotto draw')}</b><span>${esc(prettyDate(e.date))}</span></div><button type="button" data-lc-vclose aria-label="Close">✕</button></div>
      <div class="lc-viewer-body"><div class="lc-viewer-msg">Loading ticket…</div></div>
      <div class="lc-viewer-foot"><button type="button" class="small" data-lc-vsave disabled>Download</button><button type="button" class="small" data-lc-vshare disabled>Share…</button></div>`;
    document.body.appendChild(ov);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (ev) => { if(ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', async (ev) => {
      if(ev.target === ov || ev.target.closest('[data-lc-vclose]')) return close();
      const url = ticketCache[ck]; if(!url) return;
      const blob = await (await fetch(url)).blob(), name = `${(e.label || 'lotto').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${e.date || ''}.jpg`;
      if(ev.target.closest('[data-lc-vsave]')){ const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
      if(ev.target.closest('[data-lc-vshare]')){ const f = new File([blob], name, { type: blob.type }); try{ if(navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title: e.label || 'Lotto ticket' }); else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); } }catch(err){} }
    });
    try{
      const url = await getTicket(id, kind);
      ov.querySelector('.lc-viewer-body').innerHTML = `<img src="${url}" alt="Ticket for ${esc(e.label || 'this draw')}">`;
      ov.querySelectorAll('[data-lc-vsave],[data-lc-vshare]').forEach(b => b.disabled = false);
    }catch(err){ const m = ov.querySelector('.lc-viewer-msg'); if(m) m.textContent = 'Could not load the ticket. Check your connection and try again.'; }
  }
  document.addEventListener('click', (e) => {
    const mv = e.target.closest('[data-lc-mlview]'); if(mv) return viewTicket(mv.dataset.lcMlview, 'ml');
    const b = e.target.closest('[data-lc-view]'); if(b) return viewTicket(b.dataset.lcView);
    const sb = e.target.closest('[data-lc-series]');
    if(sb){ const k = sb.dataset.lcSeries; if(chartHidden.has(k)) chartHidden.delete(k); else if(visibleKeys().length > 1) chartHidden.add(k); const holder = $('lcPlChart'); if(holder){ const tmp = document.createElement('div'); tmp.innerHTML = plChart(entries()); holder.replaceWith(tmp.firstElementChild); wireChart(); } return; }
    const fb = e.target.closest('[data-lc-fold]');
    if(fb){ const k = fb.dataset.lcFold, on = !openFolds.has(k); on ? openFolds.add(k) : openFolds.delete(k); fb.parentElement.classList.toggle('open', on); fb.setAttribute('aria-expanded', String(on)); return; }
    const t = e.target.closest('[data-lc-toggle]'); if(!t) return;
    const id = t.dataset.lcToggle, card = t.closest('.lc-draw'), on = !openDraws.has(id);
    on ? openDraws.add(id) : openDraws.delete(id); card.classList.toggle('open', on); t.setAttribute('aria-expanded', String(on));
  });

  // ---------- MLSynd lotto tickets on Home → Overview ----------
  function renderMlHome(){
    const anchor = $('homeIndSection'); if(!anchor) return;
    let box = $('homeMlLotto');
    if(!box){ box = document.createElement('div'); box.id = 'homeMlLotto'; box.className = 'home-block home-ml-lotto'; box.hidden = true; anchor.parentNode.insertBefore(box, anchor); }
    const list = Object.keys(ML.meta).map(id => ({ id, ...ML.meta[id] })).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 3);
    box.hidden = !list.length;
    box.innerHTML = list.length ? `<div class="home-block-title">Lotto tickets</div>` + list.map(m => `<div class="mll-row"><div class="mll-t"><b>${esc(m.label || 'MLSynd lotto')}</b><span>${[prettyDate(m.date), m.n ? m.n + ' ticket' + (m.n === 1 ? '' : 's') : '', m.games ? esc(m.games) : ''].filter(Boolean).join(' · ')}</span></div><button type="button" class="mll-go" data-lc-mlview="${esc(m.id)}">View ticket</button></div>`).join('') : '';
  }
  async function loadMl(){
    try{ const r = await authedFetch('/mlsyndLotto/meta.json'); if(!r.ok) return; const d = await r.json(); ML.meta = d && typeof d === 'object' ? d : {}; ML.loaded = true; renderMlHome(); renderMlAdmin(); }catch(e){}
  }

  // ---------- Home → Lotto: what the group's members see (read only) ----------
  // Only people in the Lotto Pigs group (and the admin) get the Lotto button on Home.
  // Nothing can be changed here; adding draws and picking members stays in Admin.
  function meName(){ const me = (st().members || []).find(m => m.linkedUid && m.linkedUid === (typeof currentUserUid !== 'undefined' ? currentUserUid : null)); return me ? me.name : null; }
  function inGroup(){ const n = meName(); return !!(n && group().members.includes(n)); }

  // ---------- charts: running profit and loss, and profit and loss by ticket type ----------
  function ticketType(label){
    const l = (label || '').toLowerCase();
    const known = [[/power\s*ball/, 'Powerball'], [/oz\s*lotto/, 'Oz Lotto'], [/set\s*for\s*life/, 'Set for Life'], [/saturday|\bsat\b/, 'Saturday Lotto'], [/monday|\bmon\b/, 'Monday Lotto'], [/wednesday|\bwed\b/, 'Wednesday Lotto'], [/lotto\s*strike|strike/, 'Lotto Strike']];
    for(const [re, name] of known) if(re.test(l)) return name;
    const c = (label || '').replace(/^\s*\$?[\d.,]+\s*(m|mil|million|k)?\b\s*/i, '').trim();
    return c ? c.charAt(0).toUpperCase() + c.slice(1) : 'Other';
  }
  const shortDate = (d) => { try{ return new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }); }catch(e){ return d || ''; } };
  const axisMoney = (v) => { const a = Math.abs(v), t = a >= 1e6 ? (a / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : a >= 1e4 ? Math.round(a / 1e3) + 'k' : String(Math.round(a)); return (v < 0 ? '−' : '') + '$' + t; };
  let chartPts = [];
  function smoothPath(pts){ // monotone cubic, so the line never overshoots a draw
    const n = pts.length; if(n < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    const dx = [], m = [], t = [];
    for(let i = 0; i < n - 1; i++){ dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]; }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for(let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for(let i = 0; i < n - 1; i++){ if(m[i] === 0){ t[i] = 0; t[i + 1] = 0; continue; } const a = t[i] / m[i], b = t[i + 1] / m[i], h = Math.hypot(a, b); if(h > 3){ t[i] = 3 * a / h * m[i]; t[i + 1] = 3 * b / h * m[i]; } }
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for(let i = 0; i < n - 1; i++){ const h = dx[i] / 3; d += ` C${(pts[i][0] + h).toFixed(1)} ${(pts[i][1] + t[i] * h).toFixed(1)} ${(pts[i + 1][0] - h).toFixed(1)} ${(pts[i + 1][1] - t[i + 1] * h).toFixed(1)} ${pts[i + 1][0].toFixed(1)} ${pts[i + 1][1].toFixed(1)}`; }
    return d;
  }
  const CH = { W: 340, H: 176, L: 44, R: 16, T: 14, B: 24 };
  const TYPE_COL = { 'Powerball': '#3987e5', 'Oz Lotto': '#199e70', 'Saturday Lotto': '#9085e9', 'Set for Life': '#c98500' };
  const FALLBACK_COL = ['#c98500', '#9085e9', '#199e70', '#3987e5'];
  const chartHidden = new Set(), openFolds = new Set();
  let chartSeries = [];
  const visibleKeys = () => chartSeries.filter(sr => !chartHidden.has(sr.key)).map(sr => sr.key);
  function chartScale(){
    const keys = visibleKeys(), vals = [0];
    chartPts.forEach(p => keys.forEach(k => vals.push(k === 'Total' ? p.v : (p.t[k] || 0))));
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if(hi === lo){ hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.12; if(hi > 0) hi += pad; if(lo < 0) lo -= pad;
    return { hi, lo, x: (i) => CH.L + (chartPts.length === 1 ? 0 : i * (CH.W - CH.L - CH.R) / (chartPts.length - 1)), y: (v) => CH.T + (hi - v) / (hi - lo) * (CH.H - CH.T - CH.B) };
  }
  function plChart(list){
    const settled = list.filter(e => !norm(e).pend).sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.createdAt || 0) - (b.createdAt || 0));
    const pending = list.filter(e => norm(e).pend), inPlay = pending.reduce((x, e) => x + norm(e).cost, 0);
    if(!settled.length) return '';
    // one running line per ticket type (up to four, biggest spend first) plus the group total
    const spend = {}; settled.forEach(e => { const t = ticketType(e.label); spend[t] = (spend[t] || 0) + norm(e).cost; });
    const typeNames = Object.keys(spend).sort((a, b) => spend[b] - spend[a]).slice(0, 4), used = new Set(), cols = {};
    typeNames.forEach(t => { if(TYPE_COL[t] && !used.has(TYPE_COL[t])){ cols[t] = TYPE_COL[t]; used.add(cols[t]); } });
    typeNames.forEach(t => { if(!cols[t]){ cols[t] = FALLBACK_COL.find(c => !used.has(c)) || '#9085e9'; used.add(cols[t]); } });
    let run = 0, spent = 0, won = 0; const cum = {}; chartPts = [{ label: 'Start', date: '', v: 0, t: {} }];
    settled.forEach(e => { const n = norm(e), t = ticketType(e.label); run += n.won - n.cost; spent += n.cost; won += n.won; cum[t] = (cum[t] || 0) + n.won - n.cost;
      const tt = {}; typeNames.forEach(k => { tt[k] = Math.round((cum[k] || 0) * 100) / 100; });
      chartPts.push({ label: e.label || 'Lotto draw', date: e.date, v: Math.round(run * 100) / 100, d: n.won - n.cost, t: tt }); });
    const last = chartPts[chartPts.length - 1], pos = last.v >= 0, totalCol = pos ? '#4DEB8E' : '#FF6A5E';
    chartSeries = [{ key: 'Total', name: 'Group total', col: totalCol }].concat(typeNames.map(t => ({ key: t, name: t, col: cols[t] })));
    if(chartSeries.every(sr => chartHidden.has(sr.key))) chartHidden.clear();
    const { hi, lo, x, y } = chartScale(), { W, H, L, R, T, B } = CH, vis = visibleKeys();
    const val = (p, k) => k === 'Total' ? p.v : (p.t[k] || 0);
    const ticks = [hi, 0, lo].filter((v, i, a) => a.indexOf(v) === i);
    const showTotal = vis.includes('Total'), tl = smoothPath(chartPts.map((p, i) => [x(i), y(p.v)]));
    const tArea = `${tl} L${x(chartPts.length - 1).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`;
    const lines = chartSeries.filter(sr => sr.key !== 'Total' && vis.includes(sr.key)).map(sr => {
      const xy = chartPts.map((p, i) => [x(i), y(val(p, sr.key))]);
      return `<path d="${smoothPath(xy)}" fill="none" stroke="${sr.col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${xy[xy.length - 1][0].toFixed(1)}" cy="${xy[xy.length - 1][1].toFixed(1)}" r="3.8" fill="${sr.col}" stroke="var(--surface)" stroke-width="2"/>`; }).join('');
    const ex = x(chartPts.length - 1).toFixed(1), ey = y(last.v).toFixed(1);
    const chips = chartSeries.map(sr => `<button type="button" class="lc-lg${vis.includes(sr.key) ? '' : ' off'}" data-lc-series="${esc(sr.key)}" aria-pressed="${vis.includes(sr.key)}"><i style="background:${sr.col}"></i><span>${esc(sr.name)}</span><b data-lc-sv="${esc(sr.key)}" data-base="${signed(val(last, sr.key))}">${signed(val(last, sr.key))}</b></button>`).join('');
    return `<div class="lc-chart" id="lcPlChart">
      <div class="lc-ch-head">
        <div class="lc-ch-read"><span class="lc-ch-lbl" id="lcChLbl">Group profit / loss</span><b class="lc-ch-val ${pos ? 'pos' : 'neg'}" id="lcChVal">${signed(last.v)}</b></div>
        ${inPlay > 0 ? `<span class="lc-play"><i></i>${money(inPlay)} in play</span>` : ''}
      </div>
      <div class="lc-plot" id="lcPlot"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Running profit and loss across ${settled.length} settled draws, now ${signed(last.v)}">
        <defs>
          <linearGradient id="lcAreaG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${totalCol}" stop-opacity="${pos ? .3 : .02}"/><stop offset="1" stop-color="${totalCol}" stop-opacity="${pos ? .02 : .3}"/></linearGradient>
          <filter id="lcGlow" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="3.5"/></filter>
        </defs>
        ${ticks.map(v => `<line class="${v === 0 ? 'lc-zero' : 'lc-grid'}" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="lc-ylab" x="${L - 8}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${axisMoney(v)}</text>`).join('')}
        ${showTotal ? `<path d="${tArea}" fill="url(#lcAreaG)"/><path d="${tl}" fill="none" stroke="${totalCol}" stroke-width="5" stroke-linecap="round" opacity=".35" filter="url(#lcGlow)"/><path d="${tl}" fill="none" stroke="${totalCol}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
        ${lines}
        <line class="lc-guide" id="lcGuide" x1="0" x2="0" y1="${T}" y2="${H - B}" opacity="0"/>
        ${showTotal ? `<circle cx="${ex}" cy="${ey}" r="9" fill="${totalCol}" opacity=".18"/><circle cx="${ex}" cy="${ey}" r="4.5" fill="${totalCol}" stroke="var(--surface)" stroke-width="2"/>` : ''}
        <text class="lc-xlab" x="${L}" y="${H - 6}" text-anchor="start">${esc(shortDate(settled[0].date))}</text>
        ${chartPts.length > 2 ? `<text class="lc-xlab" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(shortDate(settled[settled.length - 1].date))}</text>` : ''}
      </svg></div>
      <div class="lc-legend" role="group" aria-label="Lines on the chart">${chips}</div>
      <div class="lc-ch-hint" id="lcChHint">Drag across the chart · tap a name to show or hide a line</div>
      <div class="lc-fold${openFolds.has('stats') ? ' open' : ''}">
        <button type="button" class="lc-fold-h" data-lc-fold="stats" aria-expanded="${openFolds.has('stats')}"><span>Stats &amp; ticket types</span><svg class="lc-chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>
        <div class="lc-fold-b">
          <div class="lc-stats"><div><span>Spent</span><b>${money(spent)}</b></div><div><span>Won</span><b>${money(won)}</b></div><div><span>Draws</span><b>${settled.length}${pending.length ? `<small> +${pending.length} open</small>` : ''}</b></div></div>
          ${typeBars(list)}
        </div>
      </div>
    </div>`;
  }
  function typeBars(list){
    const by = {};
    list.forEach(e => { const n = norm(e); if(n.pend) return; const t = ticketType(e.label), r = by[t] || (by[t] = { spent: 0, won: 0, draws: 0 }); r.spent += n.cost; r.won += n.won; r.draws++; });
    const rows = Object.entries(by).map(([t, r]) => ({ t, ...r, net: r.won - r.spent })).sort((a, b) => b.net - a.net);
    if(!rows.length) return '';
    const max = Math.max(...rows.map(r => Math.abs(r.net)), 1);
    return `<div class="lc-types"><div class="lc-types-t">By ticket type</div>${rows.map(r => { const w = Math.max(r.net === 0 ? 0 : 3, Math.abs(r.net) / max * 100);
      return `<div class="lc-ty"><div class="lc-ty-top"><span class="lc-ty-n">${esc(r.t)}</span><b class="${r.net >= 0 ? 'pos' : 'neg'}">${signed(r.net)}</b></div>
        <div class="lc-ty-track"><i class="lc-ty-mid"></i>${r.net ? `<i class="lc-ty-bar ${r.net >= 0 ? 'pos' : 'neg'}" style="width:${(w / 2).toFixed(1)}%"></i>` : ''}</div>
        <div class="lc-ty-sub">${r.draws} draw${r.draws === 1 ? '' : 's'} · in ${money(r.spent)} · back ${money(r.won)}</div></div>`; }).join('')}</div>`;
  }
  function wireChart(){
    const plot = $('lcPlot'); if(!plot || chartPts.length < 2) return;
    const svg = plot.querySelector('svg'), vb = svg.viewBox.baseVal, { x: xs, y: ys } = chartScale();
    const lbl = $('lcChLbl'), val = $('lcChVal'), guide = $('lcGuide'), hint = $('lcChHint');
    let lastIdx = -1; const base = { l: lbl.textContent, v: val.textContent, c: val.className };
    const chipVals = [...document.querySelectorAll('#lcPlChart [data-lc-sv]')], dots = [];
    const mk = (col) => { const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); c.setAttribute('r', 6); c.setAttribute('fill', col); c.setAttribute('stroke', 'var(--surface)'); c.setAttribute('stroke-width', 2.5); c.setAttribute('opacity', 0); svg.appendChild(c); return c; };
    const dotFor = {}; chartSeries.forEach(sr => { if(!chartHidden.has(sr.key)) dotFor[sr.key] = mk(sr.col); });
    const show = (clientX) => {
      const r = svg.getBoundingClientRect(), px = (clientX - r.left) / r.width * vb.width;
      let best = 0, bd = 1e9; chartPts.forEach((p, i) => { const d = Math.abs(xs(i) - px); if(d < bd){ bd = d; best = i; } });
      const p = chartPts[best];
      guide.setAttribute('x1', xs(best)); guide.setAttribute('x2', xs(best)); guide.setAttribute('opacity', '1');
      Object.entries(dotFor).forEach(([k, d]) => { d.setAttribute('cx', xs(best)); d.setAttribute('cy', ys(k === 'Total' ? p.v : (p.t[k] || 0))); d.setAttribute('opacity', 1); });
      chipVals.forEach(b => { const k = b.dataset.lcSv; b.textContent = signed(k === 'Total' ? p.v : (p.t[k] || 0)); });
      if(best !== lastIdx){ lastIdx = best; try{ const st = JSON.parse(localStorage.getItem('cp-settings') || '{}'); if(st.haptics !== false && navigator.vibrate) navigator.vibrate(4); }catch(e){} }
      lbl.textContent = best ? `${p.label} · ${shortDate(p.date)} (${signed(p.d)})` : 'Start';
      val.textContent = signed(p.v); val.className = 'lc-ch-val ' + (p.v >= 0 ? 'pos' : 'neg'); if(hint) hint.style.opacity = 0;
    };
    const reset = () => { lastIdx = -1; guide.setAttribute('opacity', '0'); Object.values(dotFor).forEach(d => d.setAttribute('opacity', 0)); chipVals.forEach(b => { b.textContent = b.dataset.base; }); lbl.textContent = base.l; val.textContent = base.v; val.className = base.c; if(hint) hint.style.opacity = 1; };
    plot.addEventListener('pointerdown', (e) => { plot.setPointerCapture && plot.setPointerCapture(e.pointerId); show(e.clientX); });
    plot.addEventListener('pointermove', (e) => { if(e.pressure > 0 || e.pointerType === 'mouse') show(e.clientX); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => plot.addEventListener(ev, reset));
  }
  const openDraws = new Set();
  let homeSig = '';
  function renderHome(){
    const root = $('homeLottoRoot'); if(!root) return;
    // the app redraws often; only rebuild when the Lotto Pigs data (or who's looking) really changed
    const sig = JSON.stringify([LP.group, LP.ledger, meName(), root.clientWidth]);
    if(sig === homeSig && root.firstChild) return;
    homeSig = sig;
    const g = group(), list = entries(), t = totals(list), me = meName();
    const mine = me && t.per[me];
    const netMe = mine ? mine.won - mine.spent : 0;
    const perRows = Object.entries(t.per).map(([n, r]) => { const net = r.won - r.spent; return `<div class="lc-pp${n === me ? ' me' : ''}"><div class="lc-pp-l"><span class="lc-av">${esc(n.charAt(0))}</span><div><div class="lc-pp-name">${esc(n)}${n === me ? ' <em>you</em>' : ''}</div><div class="lc-pp-sub">${r.shares} share${r.shares === 1 ? '' : 's'} · in ${money(r.spent)} · back ${money(r.won)}</div></div></div><b class="${net >= 0 ? 'pos' : 'neg'}">${signed(net)}</b></div>`; }).join('');
    const links = rollLinks(list);
    const drawCards = list.length ? list.map(e => {
      const n = norm(e), yours = me && n.shares[me], per = n.total ? 1 / n.total : 0;
      const eq = n.covered > 0 && n.entrants, src = links.from[e.id], into = links.into[e.id];
      const roll = eq ? `<div class="lc-roll"><div class="lc-roll-r"><span>Ticket</span><b>${money(n.cost)}</b></div><div class="lc-roll-r"><span>${src ? 'Winnings from ' + esc(src.label || 'the last draw') : 'Winnings applied'}</span><b class="pos">−${money(n.covered)}</b></div><div class="lc-roll-r tot"><span>Top-up · ${n.entrants} × ${money(n.each)}</span><b>${money(n.topUp)}</b></div></div>` : '';
      const rolledOut = into ? `<div class="lc-roll src">Winnings of <b>${money(into.reduce((x, y) => x + norm(y).covered, 0))}</b> rolled into <b>${esc(into.map(x => x.label || 'the next draw').join(', '))}</b></div>` : '';
      const cell = (k, v, t) => `<div><span>${k}</span><b${t ? ` title="${esc(t)}"` : ''}>${v}</b></div>`;
      const youCells = yours ? (eq ? cell('You pay', n.topUp > 0 ? money(n.each) : '$0') : cell('Paid', money(n.cost * per * yours))) + (n.pend ? (n.jackpot ? cell('Top prize', moneyShort(n.jackpot * per * yours), money(n.jackpot * per * yours)) : '') : cell('Back', money(n.won * per * yours))) : '';
      const youLine = yours ? `<div class="lc-dr-you"><div class="lc-you-t">Your ${yours} share${yours === 1 ? '' : 's'}</div><div class="lc-you-g c${(youCells.match(/<div>/g) || []).length}">${youCells}</div></div>` : '';
      const open = openDraws.has(e.id);
      return `<div class="lc-draw${open ? ' open' : ''}">
        <button type="button" class="lc-dr-head" data-lc-toggle="${esc(e.id)}" aria-expanded="${open}" aria-label="${esc(e.label || 'Lotto draw')}, ${open ? 'hide' : 'show'} details"><div class="lc-dr-hl"><div class="lc-dr-title">${esc(e.label || 'Lotto draw')}</div><div class="lc-dr-sub">${esc(prettyDate(e.date))} · ${n.total} share${n.total === 1 ? '' : 's'}${into ? ' · rolled over' : ''}</div></div>
          <span class="lc-chip-st ${n.pend ? 'wait' : (n.won - n.cost >= 0 ? 'win' : 'loss')}">${n.pend ? 'Awaiting result' : signed(n.won - n.cost)}</span><svg class="lc-chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>
        <div class="lc-dr-body">
        ${n.hasTicket ? `<button type="button" class="lc-dr-ticket" data-lc-view="${esc(e.id)}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9a2 2 0 0 0 0 6v3h18v-3a2 2 0 0 1 0-6V6H3z"/><path d="M13 6v12" stroke-dasharray="2 3"/></svg>View ticket</button>` : ''}
        <div class="lc-dr-grid">
          <div><span>Share value</span><b>${money(n.cost * per)}</b></div>
          <div><span>${n.pend ? 'Top prize / share' : 'Won / share'}</span><b${n.pend && n.jackpot ? ` title="${esc(money(n.jackpot * per))}"` : ''}>${n.pend ? (n.jackpot ? moneyShort(n.jackpot * per) : '–') : money(n.won * per)}</b></div>
        </div>
        ${roll}${rolledOut}
        ${youLine}
        <div class="lc-dr-who">${Object.entries(n.shares).map(([x, c]) => `<span${x === me ? ' class="me"' : ''}>${esc(x)} ×${c}</span>`).join('')}</div>
      </div></div>`; }).join('') : '<div class="lc-empty">No draws yet. Your first one will show up here.</div>';
    root.innerHTML = `
      <div class="lc-home">
        <div class="lc-top">
          <div class="lc-hero"><img src="lotto-pigs-emblem.webp" alt="" width="190" height="190" decoding="async"></div>
          <h2 class="lc-hero-title">${esc(g.name || 'Lotto Pigs')}</h2>
          <div class="lc-tag">Your group's results · kept separate from the syndicate</div>
        </div>
        ${mine ? `<div class="lc-me ${netMe >= 0 ? 'pos' : 'neg'}">
            <span class="lc-me-k">Your net</span>
            <b class="lc-me-v">${signed(netMe)}</b>
            <div class="lc-me-row"><div><span>You put in</span><b>${money(mine.spent)}</b></div><div><span>Your share back</span><b>${money(mine.won)}</b></div><div><span>Your shares</span><b>${mine.shares}</b></div></div>
          </div>` : (me && list.length ? '<div class="lc-empty">You haven\'t bought into a draw yet.</div>' : '')}
        ${plChart(list) ? `<div class="lc-sec"><h3>Profit &amp; loss</h3><span>${list.length} draw${list.length === 1 ? '' : 's'}</span></div>${plChart(list)}` : ''}
        <div class="lc-sec"><h3>Draws</h3><span>${list.length}</span></div>
        <div id="lcHomeEntries" class="lc-home-entries">${drawCards}</div>
        ${perRows ? `<div class="lc-sec"><h3>Each person</h3><span>winnings split by shares</span></div><div class="lc-fold lc-fold-card${openFolds.has('people') ? ' open' : ''}"><button type="button" class="lc-fold-h" data-lc-fold="people" aria-expanded="${openFolds.has('people')}"><span>${Object.keys(t.per).length} members</span><svg class="lc-chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button><div class="lc-fold-b"><div class="lc-people">${perRows}</div></div></div>` : ''}
      </div>`;
    try{ wireChart(); }catch(e){}
  }
  // The round pig button in the header, next to Syndy: only for people ticked in the group.
  function syncHeader(){
    const hb = $('lottoHeaderBtn'); if(!hb) return;
    hb.style.display = (LP.allowed && inGroup()) ? '' : 'none';
    placeHeaderBtn();
    const view = $('homeSubview-lotto');
    if(!(LP.allowed && (inGroup() || isAdminUser())) && view && view.style.display !== 'none' && typeof navShowHomeSub === 'function') navShowHomeSub('overview');
    if(view && view.style.display !== 'none') renderHome();
  }
  // sit just to the left of the Syndy button (or the cog when Syndy isn't showing)
  function placeHeaderBtn(){
    const hb = $('lottoHeaderBtn'), head = hb && hb.parentElement; if(!hb || hb.style.display === 'none' || !head) return;
    const vis = (e) => e && e.style.display !== 'none' && e.offsetParent !== null;
    const anchor = vis($('syndyFabBtn')) ? $('syndyFabBtn') : (vis($('headerAdminBtn')) ? $('headerAdminBtn') : null);
    const hr = head.getBoundingClientRect();
    const right = anchor ? Math.round(hr.right - anchor.getBoundingClientRect().left + 8) : 54;
    hb.style.right = right + 'px';
  }
  window.addEventListener('resize', () => { try{ placeHeaderBtn(); }catch(e){} });
  function openHome(){
    if(typeof setActiveTab === 'function') setActiveTab('balance');
    const tb = $('homeLottoSubBtn'); if(tb) tb.style.display = '';
    if(typeof navShowHomeSub === 'function') navShowHomeSub('lotto');
    renderHome(); window.scrollTo(0, 0);
    lpLoad(true).then(renderHome);
  }
  function refreshAll(){ try{ if($('lottoRoot') && $('lottoRoot').dataset.built) refresh(); }catch(e){} }
  let hooked = false;
  function syncHome(){ // called whenever the app redraws
    if(!hooked){ hooked = true; lpLoad(); setTimeout(loadMl, 2500); }
    if(ML.loaded && !$('homeMlLotto')) renderMlHome();
    syncHeader();
    const tb = $('homeLottoSubBtn'), view = $('homeSubview-lotto');
    if(tb && view && view.style.display === 'none') tb.style.display = 'none'; // the tab only shows while you're on it
  }
  window.lottoHomeSync = syncHome;
  window.lottoReload = () => lpLoad(true);
  (function hook(){
    const orig = window.render;
    if(typeof orig === 'function' && !orig.__lotto){
      const wrapped = function(){ const r = orig.apply(this, arguments); try{ syncHome(); }catch(e){} return r; };
      wrapped.__lotto = true; window.render = wrapped;
    }
    const hb = $('lottoHeaderBtn'); if(hb) hb.addEventListener('click', openHome);
    const tb = $('homeLottoSubBtn'); if(tb) tb.addEventListener('click', () => { renderHome(); lpLoad(true).then(renderHome); });
    // members only see changes the admin makes when they reload; refresh quietly now and then while looking at it
    setInterval(() => { const v = $('homeSubview-lotto'); if(v && v.style.display !== 'none' && !document.hidden) lpLoad(true).then(renderHome); }, 60000);
  })();

  // ---------- UI ----------
  function build(){
    const root = $('lottoRoot'); if(!root || root.dataset.built) return; root.dataset.built = '1';
    root.innerHTML = `
      <div class="panel">
        <h2>Lotto group</h2>
        <div class="hint">Tap the members who are in your lotto group. Their names go on the combined picture. Saved for next time.</div>
        <label class="lc-field">Group name<input type="text" id="lcGroupName" placeholder="Lotto Pigs" maxlength="40" autocomplete="off"></label>
        <div class="lc-count" id="lcMemberCount"></div>
        <div class="lc-chips" id="lcMembers"></div>
        <div class="lc-actions"><input type="text" id="lcExtraName" placeholder="Someone not on the platform" maxlength="30" autocomplete="off" style="flex:1; min-height:40px;"><button type="button" class="small" id="lcExtraAdd">Add</button></div>
        <div class="status-msg" id="lcGroupStatus"></div>
      </div>
      <div class="panel">
        <h2>Lotto tickets to one picture</h2>
        <div class="lc-seg" id="lcTgt" role="group" aria-label="Which group are these tickets for"><button type="button" data-lc-tgt="pigs">Lotto Pigs</button><button type="button" data-lc-tgt="ml">MLSynd</button></div>
        <div class="hint">Add all your lotto ticket screenshots. They're joined into one picture you can download or share. Nothing is uploaded; it all happens on your phone.</div>
        <input type="file" id="lcFile" accept="image/*" multiple hidden>
        <div class="lc-actions"><button type="button" class="small adm-primary" id="lcPick">Add ticket screenshots</button><span class="lc-count" id="lcCount"></span><button type="button" class="small" id="lcClear" disabled>Clear all</button></div>
        <div class="lc-read" id="lcRead" hidden>
          <div><b>Read the ticket details</b><span>Reads the game, draw, price and every game's numbers off the screenshots, and shows them on the picture for the group.</span></div>
          <button type="button" class="small adm-primary" id="lcReadBtn">Read tickets</button>
        </div>
        <div class="status-msg" id="lcReadStatus"></div>
        <div id="lcInfo"></div>
        <label class="lc-field lc-split" id="lcSplitWrap" hidden>How many tickets are these?<select id="lcSplit" hidden></select></label>
        <div class="lc-list" id="lcList"></div>
        <div class="status-msg" id="lcStatus"></div>
        <div class="lc-opts">
          <label class="lc-field">Title<input type="text" id="lcTitle" value="Lotto Pigs" maxlength="50" autocomplete="off"></label>
          <label class="lc-field">Draw date<input type="date" id="lcDate"></label>
          <label class="lc-field">Layout<select id="lcCols"><option value="">Auto</option><option value="1">1 column</option><option value="2">2 columns</option><option value="3">3 columns</option></select></label>
          <label class="lc-field">Ticket style<select id="lcStyle"><option value="clean">Clean ticket card (from the read details)</option><option value="shots">Original screenshots</option></select></label>
          <label class="lc-check"><input type="checkbox" id="lcShowTitle" checked> Show title and date</label>
          <label class="lc-check"><input type="checkbox" id="lcShowWho" checked> Show who's in the group</label>
          <label class="lc-check"><input type="checkbox" id="lcShowInfo" checked> Show ticket numbers on the picture</label>
        </div>
        <div class="lc-actions"><button type="button" class="small adm-primary" id="lcDownload" disabled>Download picture</button><button type="button" class="small" id="lcShare" disabled>Share…</button></div>
        <div class="lc-attach"><label class="lc-field">Keep this picture with a draw (so members can view it)<select id="lcAttachSel"></select></label><button type="button" class="small adm-primary" id="lcAttach" disabled>Save to draw</button></div>
        <div class="hint" id="lcMlHint" hidden>MLSynd tickets are saved for every syndicate member to view on Home → Overview. The picture uses the MLSynd logo and lists all members.</div>
        <div id="lcMlManage" hidden>
          <label class="lc-field">When saving<select id="lcMlReplace"></select></label>
          <div class="lc-ml-h">Saved on Overview</div><div id="lcMlList"></div>
        </div>
        <div class="status-msg" id="lcAttachStatus"></div>
        <div class="lc-preview" id="lcPreviewWrap" hidden><canvas id="lcCanvas" aria-label="Preview of the combined lotto picture"></canvas></div>
      </div>
      <div class="panel" id="lcLedger">
        <h2>Lotto Pigs profit and loss</h2>
        <div class="hint">Add each draw you buy tickets for: what it cost and what came back. Kept separate from the syndicate's money.</div>
        <div class="lc-summary" id="lcSummary"></div>
        <div class="hint" id="lcLedgerNote"></div>
        <div id="lcLForm" class="lc-form">
          <label class="lc-field">Draw<input type="text" id="lcLLabel" placeholder="e.g. Powerball $100M" maxlength="60" autocomplete="off"></label>
          <label class="lc-field">Draw date (past dates are fine)<input type="date" id="lcLDate"></label>
          <label class="lc-field">Price per share ($)<input type="number" id="lcLPrice" inputmode="decimal" step="0.01" min="0"></label>
          <label class="lc-field">Or total ticket cost ($)<input type="number" id="lcLTicket" inputmode="decimal" step="0.01" min="0" placeholder="divided by shares"></label>
          <label class="lc-field">Covered by winnings ($)<input type="number" id="lcLCovered" inputmode="decimal" step="0.01" min="0" placeholder="0 = members pay"></label>
          <label class="lc-field">Top prize ($, optional)<input type="number" id="lcLJackpot" inputmode="decimal" step="1" min="0" placeholder="e.g. 100000000"></label>
          <label class="lc-field">Winnings came from<select id="lcLFrom"><option value="">—</option></select></label>
          <label class="lc-field">Won ($)<input type="number" id="lcLWon" inputmode="decimal" step="0.01" min="0" placeholder="blank until result"></label>
        </div>
        <h3 class="lc-h3">Who bought in (shares)</h3>
        <div id="lcShares" class="lc-shares"></div>
        <div class="lc-count" id="lcLTotal"></div>
        <div class="lc-actions"><button type="button" class="small adm-primary" id="lcLSave">Add draw</button><button type="button" class="small" id="lcLCancel" hidden>Cancel</button></div>
        <div class="status-msg" id="lcLStatus"></div>
        <div id="lcEntries"></div>
        <div id="lcPerMember"></div>
        <div class="lc-actions"><button type="button" class="small" id="lcCopy" disabled>Copy summary for the group chat</button></div>
      </div>`;
    $('lcDate').value = todayStr();
    $('lcPick').addEventListener('click', () => $('lcFile').click());
    $('lcFile').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    $('lcClear').addEventListener('click', () => { tickets.forEach(t => URL.revokeObjectURL(t.url)); tickets = []; info = null; renderInfo(); renderList(); });
    $('lcList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-lc-act]'); if(!b) return;
      const id = Number(b.closest('[data-lc-id]').dataset.lcId), i = tickets.findIndex(t => t.id === id);
      if(b.dataset.lcAct === 'join'){ tickets[i].join = !tickets[i].join; }
      else if(b.dataset.lcAct === 'rm'){ URL.revokeObjectURL(tickets[i].url); tickets.splice(i, 1); }
      else { const j = b.dataset.lcAct === 'up' ? i - 1 : i + 1; if(j < 0 || j >= tickets.length) return; [tickets[i], tickets[j]] = [tickets[j], tickets[i]]; }
      if(tickets[0]) tickets[0].join = false;
      staleInfo(); renderList(); scheduleRender();
    });
    $('lcReadBtn').addEventListener('click', () => readTickets());
    const setTgt = (t) => {
      tgt = t === 'ml' ? 'ml' : 'pigs'; try{ localStorage.setItem('mlsynd-lotto-target', tgt); }catch(e){}
      document.querySelectorAll('#lcTgt [data-lc-tgt]').forEach(b => { const on = b.dataset.lcTgt === tgt; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
      const ti = $('lcTitle'); if(ti && DEFAULT_TITLES.includes(ti.value.trim())) ti.value = tgt === 'ml' ? 'MLSynd' : 'Lotto Pigs';
      if(tgt === 'ml' && !ML.loaded) loadMl().then(renderMlAdmin);
      syncAttach(); scheduleRender();
    };
    $('lcTgt').addEventListener('click', (e) => { const b = e.target.closest('[data-lc-tgt]'); if(b) setTgt(b.dataset.lcTgt); });
    setTgt(tgt);
    $('lcSplit').addEventListener('change', (e) => { splitInto(parseInt(e.target.value, 10) || 1); staleInfo(); renderList(); scheduleRender(); });
    ['lcTitle', 'lcDate', 'lcCols', 'lcShowTitle', 'lcShowWho', 'lcShowInfo', 'lcStyle'].forEach(id => { $(id).addEventListener('input', scheduleRender); $(id).addEventListener('change', scheduleRender); });
    $('lcAttach').addEventListener('click', attachTicket); $('lcAttachSel').addEventListener('change', syncAttach);
    $('lcDownload').addEventListener('click', download);
    $('lcShare').addEventListener('click', share);
    $('lcMembers').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-lc-member]'); if(!b) return;
      const g = group(), n = b.dataset.lcMember;
      g.members = g.members.includes(n) ? g.members.filter(x => x !== n) : g.members.concat(n);
      setGroup(g); // show the change at once
      renderMembers(); scheduleRender(); renderShares();
      await saveGroup(g);
    });
    const addExtra = async () => {
      const inp = $('lcExtraName'), n = inp.value.trim().replace(/\s+/g, ' '); if(!n) return;
      const g = group(); inp.value = '';
      if(!g.members.includes(n)) g.members.push(n);
      setGroup(g);
      renderMembers(); scheduleRender(); await saveGroup(g);
    };
    $('lcExtraAdd').addEventListener('click', addExtra);
    $('lcExtraName').addEventListener('keydown', (e) => { if(e.key === 'Enter'){ e.preventDefault(); addExtra(); } });
    let nameTimer = null;
    $('lcGroupName').addEventListener('input', () => { clearTimeout(nameTimer); nameTimer = setTimeout(async () => { const g = group(); g.name = $('lcGroupName').value.trim(); setGroup(g); scheduleRender(); await saveGroup(g); }, 700); });
    $('lcShares').addEventListener('click', (e) => { const b = e.target.closest('[data-lc-sh]'); if(!b) return; const n = b.dataset.lcN, d = Number(b.dataset.lcSh); draftShares[n] = Math.max(0, (draftShares[n] || 0) + d); if(!draftShares[n]) delete draftShares[n]; renderShares(); });
    ['lcLPrice', 'lcLTicket', 'lcLCovered'].forEach(id => $(id).addEventListener('input', renderShares));
    $('lcLFrom').addEventListener('change', () => { const src = (LP.ledger || {})[$('lcLFrom').value]; if(src){ $('lcLCovered').value = norm(src).won; renderShares(); } });
    $('lcLSave').addEventListener('click', saveEntry);
    $('lcLCancel').addEventListener('click', resetForm);
    $('lcEntries').addEventListener('click', (e) => { const ed = e.target.closest('[data-lc-edit]'), del = e.target.closest('[data-lc-del]'); const un = e.target.closest('[data-lc-unattach]'); if(un) unattachTicket(un.dataset.lcUnattach); else if(ed) startEdit(ed.dataset.lcEdit); else if(del) deleteEntry(del.dataset.lcDel); });
    $('lcCopy').addEventListener('click', async () => { const st2 = $('lcLStatus'); try{ await navigator.clipboard.writeText(summaryText(entries())); st2.className = 'status-msg ok'; st2.textContent = 'Copied. Paste it into the group chat.'; }catch(e){ st2.className = 'status-msg error'; st2.textContent = 'Could not copy on this browser.'; } });
    resetForm(); renderLedger();
    renderMembers(); renderList();
  }
  function refresh(){ build(); const gn = $('lcGroupName'); if(gn && document.activeElement !== gn) gn.value = group().name; renderMembers(); renderLedger(); renderShares(); }
  window.lottoCombineRefresh = refresh;
  document.addEventListener('DOMContentLoaded', build);
  if(document.readyState !== 'loading') build();
  // keep the member list current when the shared data changes or the tab opens
  const tabBtn = document.querySelector('#diagSubmodeRow [data-submode="lotto"]');
  if(tabBtn) tabBtn.addEventListener('click', () => { setTimeout(refresh, 50); lpLoad(true); });
})();
