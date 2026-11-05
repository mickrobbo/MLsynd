// lotto-combine.js (v241)
// Admin → Lotto: pick the members who are in the lotto group, add several
// lotto ticket screenshots, and turn them into ONE tidy image that can be
// downloaded or shared straight into the separate lotto group chat.
// Everything happens on the phone: nothing is uploaded or sent anywhere, and
// nothing here touches the bank, the week or any other part of the platform.
// Only the group's name and member list are saved (to /state/lottoGroup).
(function(){
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s));
  const st = () => (typeof currentState !== 'undefined' && currentState) ? currentState : {};
  const BG = '#0d100d', PANEL = '#171c17', LIME = '#cdf464', CHALK = '#f1f3ee', MUTED = '#9aa396';
  const MAX_SIDE = 4096, MAX_AREA = 14e6, COL_W = 900, GAP = 24, PAD = 36;

  let tickets = []; // { id, name, img, url, w, h }
  let nextId = 1;
  let lastBlob = null, lastName = 'lotto-tickets.png';
  let renderTimer = null;

  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const prettyDate = (s) => { const d = new Date(s + 'T12:00:00'); return isNaN(d) ? '' : d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); };

  // ---------- who is in the lotto group ----------
  function group(){ const g = st().lottoGroup; return { name: (g && g.name) || 'Lotto Pigs', members: Array.isArray(g && g.members) ? g.members.slice() : [] }; }
  function allNames(){ return (st().members || []).map(m => m.name).filter(Boolean); }
  async function saveGroup(g){
    const status = $('lcGroupStatus');
    try{
      const res = await authedWrite('/state/lottoGroup.json', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: g.name || '', members: g.members }) });
      if(!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
      st().lottoGroup = { name: g.name || '', members: g.members };
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
  function renderList(){
    const list = $('lcList'); if(!list) return;
    $('lcCount').textContent = tickets.length ? `${tickets.length} ticket${tickets.length === 1 ? '' : 's'}` : '';
    list.innerHTML = tickets.map((t, i) => `<div class="lc-item" data-lc-id="${t.id}">
        <img src="${t.url}" alt="Ticket ${i + 1}">
        <span class="lc-item-n">${i + 1}</span>
        <div class="lc-item-btns">
          <button type="button" data-lc-act="up" aria-label="Move ticket ${i + 1} earlier" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" data-lc-act="down" aria-label="Move ticket ${i + 1} later" ${i === tickets.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" data-lc-act="rm" aria-label="Remove ticket ${i + 1}">✕</button>
        </div></div>`).join('');
    const has = tickets.length > 0;
    ['lcDownload', 'lcShare', 'lcClear'].forEach(id => { const b = $(id); if(b) b.disabled = !has; });
    $('lcPreviewWrap').hidden = !has;
  }

  // ---------- drawing ----------
  function wrapText(ctx, text, maxW){
    const words = String(text).split(/\s+/).filter(Boolean), lines = []; let line = '';
    words.forEach(w => { const t = line ? line + ' ' + w : w; if(ctx.measureText(t).width > maxW && line){ lines.push(line); line = w; } else line = t; });
    if(line) lines.push(line); return lines;
  }
  // Pick how many columns gives the most phone-friendly shape (close to 3:4 portrait).
  function planLayout(){
    const n = tickets.length; let best = null;
    const heights = tickets.map(t => Math.round(COL_W * t.h / t.w));
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
    const who = group().members, gName = group().name;
    const W = L.bodyW + PAD * 2;
    const m = document.createElement('canvas').getContext('2d');
    m.font = '600 34px Manrope, system-ui, sans-serif';
    const whoText = showWho && who.length ? (gName ? gName + ': ' : 'In: ') + who.join(', ') : '';
    const whoLines = whoText ? wrapText(m, whoText, W - PAD * 2) : [];
    const headH = showTitle && (title || date) ? 150 : 0;
    const footH = whoLines.length ? 40 + whoLines.length * 46 + 10 : 0;
    const H = PAD + headH + L.bodyH + (footH ? PAD + footH : 0) + PAD;
    let s = Math.min(1, MAX_SIDE / Math.max(W, H), Math.sqrt(MAX_AREA / (W * H)));
    canvas.width = Math.round(W * s); canvas.height = Math.round(H * s);
    const ctx = canvas.getContext('2d'); ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
    let y = PAD;
    if(headH){
      ctx.fillStyle = LIME; ctx.fillRect(PAD, y + 8, 8, 96);
      ctx.fillStyle = CHALK; ctx.font = '800 64px Manrope, system-ui, sans-serif'; ctx.textBaseline = 'top';
      ctx.fillText(title || 'Lotto Pigs', PAD + 32, y + 4, W - PAD * 2 - 32);
      ctx.fillStyle = MUTED; ctx.font = '600 34px Manrope, system-ui, sans-serif';
      ctx.fillText([date, `${tickets.length} ticket${tickets.length === 1 ? '' : 's'}`].filter(Boolean).join('  ·  '), PAD + 32, y + 80, W - PAD * 2 - 32);
      y += headH;
    }
    tickets.forEach((t, i) => {
      const p = L.place[i], x = PAD + p.col * (COL_W + GAP), yy = y + p.y;
      ctx.fillStyle = PANEL; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x - 6, yy - 6, COL_W + 12, p.h + 12, 22) : ctx.rect(x - 6, yy - 6, COL_W + 12, p.h + 12); ctx.fill();
      ctx.save(); ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, yy, COL_W, p.h, 16) : ctx.rect(x, yy, COL_W, p.h); ctx.clip();
      ctx.drawImage(t.img, x, yy, COL_W, p.h); ctx.restore();
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
        <div class="hint">Add all your lotto ticket screenshots. They're joined into one picture you can download or share. Nothing is uploaded; it all happens on your phone.</div>
        <input type="file" id="lcFile" accept="image/*" multiple hidden>
        <div class="lc-actions"><button type="button" class="small adm-primary" id="lcPick">Add ticket screenshots</button><span class="lc-count" id="lcCount"></span><button type="button" class="small" id="lcClear" disabled>Clear all</button></div>
        <div class="lc-list" id="lcList"></div>
        <div class="status-msg" id="lcStatus"></div>
        <div class="lc-opts">
          <label class="lc-field">Title<input type="text" id="lcTitle" value="Lotto Pigs" maxlength="50" autocomplete="off"></label>
          <label class="lc-field">Draw date<input type="date" id="lcDate"></label>
          <label class="lc-field">Layout<select id="lcCols"><option value="">Auto</option><option value="1">1 column</option><option value="2">2 columns</option><option value="3">3 columns</option></select></label>
          <label class="lc-check"><input type="checkbox" id="lcShowTitle" checked> Show title and date</label>
          <label class="lc-check"><input type="checkbox" id="lcShowWho" checked> Show who's in the group</label>
        </div>
        <div class="lc-actions"><button type="button" class="small adm-primary" id="lcDownload" disabled>Download picture</button><button type="button" class="small" id="lcShare" disabled>Share…</button></div>
        <div class="lc-preview" id="lcPreviewWrap" hidden><canvas id="lcCanvas" aria-label="Preview of the combined lotto picture"></canvas></div>
      </div>`;
    $('lcDate').value = todayStr();
    $('lcPick').addEventListener('click', () => $('lcFile').click());
    $('lcFile').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    $('lcClear').addEventListener('click', () => { tickets.forEach(t => URL.revokeObjectURL(t.url)); tickets = []; renderList(); });
    $('lcList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-lc-act]'); if(!b) return;
      const id = Number(b.closest('[data-lc-id]').dataset.lcId), i = tickets.findIndex(t => t.id === id);
      if(b.dataset.lcAct === 'rm'){ URL.revokeObjectURL(tickets[i].url); tickets.splice(i, 1); }
      else { const j = b.dataset.lcAct === 'up' ? i - 1 : i + 1; if(j < 0 || j >= tickets.length) return; [tickets[i], tickets[j]] = [tickets[j], tickets[i]]; }
      renderList(); scheduleRender();
    });
    ['lcTitle', 'lcDate', 'lcCols', 'lcShowTitle', 'lcShowWho'].forEach(id => { $(id).addEventListener('input', scheduleRender); $(id).addEventListener('change', scheduleRender); });
    $('lcDownload').addEventListener('click', download);
    $('lcShare').addEventListener('click', share);
    $('lcMembers').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-lc-member]'); if(!b) return;
      const g = group(), n = b.dataset.lcMember;
      g.members = g.members.includes(n) ? g.members.filter(x => x !== n) : g.members.concat(n);
      st().lottoGroup = { name: g.name, members: g.members }; // show the change at once
      renderMembers(); scheduleRender();
      await saveGroup(g);
    });
    const addExtra = async () => {
      const inp = $('lcExtraName'), n = inp.value.trim().replace(/\s+/g, ' '); if(!n) return;
      const g = group(); inp.value = '';
      if(!g.members.includes(n)) g.members.push(n);
      st().lottoGroup = { name: g.name, members: g.members };
      renderMembers(); scheduleRender(); await saveGroup(g);
    };
    $('lcExtraAdd').addEventListener('click', addExtra);
    $('lcExtraName').addEventListener('keydown', (e) => { if(e.key === 'Enter'){ e.preventDefault(); addExtra(); } });
    let nameTimer = null;
    $('lcGroupName').addEventListener('input', () => { clearTimeout(nameTimer); nameTimer = setTimeout(async () => { const g = group(); g.name = $('lcGroupName').value.trim(); st().lottoGroup = { name: g.name, members: g.members }; scheduleRender(); await saveGroup(g); }, 700); });
    renderMembers(); renderList();
  }
  function refresh(){ build(); const gn = $('lcGroupName'); if(gn && document.activeElement !== gn) gn.value = group().name; renderMembers(); }
  window.lottoCombineRefresh = refresh;
  document.addEventListener('DOMContentLoaded', build);
  if(document.readyState !== 'loading') build();
  // keep the member list current when the shared data changes or the tab opens
  const tabBtn = document.querySelector('#diagSubmodeRow [data-submode="lotto"]');
  if(tabBtn) tabBtn.addEventListener('click', () => setTimeout(refresh, 50));
})();
