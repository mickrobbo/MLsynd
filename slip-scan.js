// slip-scan.js (v203)
// Admin → Week → Bet slips: "Read slips" sends Sportsbet screenshots to
// the scan-slip function, shows what it found, and on Apply fills in the
// group multi (odds, results, stake, return) or an individual bet. Nothing
// is written until Apply is tapped, and everything still goes through the
// normal draft and Save week flow.
(function(){
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s));
  const money = (v) => v == null ? '–' : '$' + Number(v).toLocaleString('en-AU', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const LS = { get(k, d){ try{ const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; }catch(e){ return d; } }, set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} } };
  const LEGMAP_KEY = 'mlsynd-slip-legmap';
  const st = () => (typeof currentState !== 'undefined' && currentState) ? currentState : {};

  // ---------- higher-resolution copies of freshly uploaded slips ----------
  // Stored slips are shrunk to 1000px for the Slips tab, which can make the
  // small print on a tall screenshot hard to read. Slips uploaded in this
  // session keep a sharper copy here for scanning.
  const hiRes = {};
  function captureUploads(){
    const input = $('adminSlipFileInput'); if(!input) return;
    input.addEventListener('change', async (e) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      if(!files.length) return;
      const t0 = Date.now();
      const copies = [];
      for(const f of files){ try{ copies.push(await compressImageForChat(f, 2000, 0.85)); }catch(err){ copies.push(null); } }
      // pair them with the slips the upload handler adds, in order
      for(let i = 0; i < 60; i++){
        const fresh = (st().slips || []).filter(s => s.imageId && s.addedAt >= t0 - 1000);
        if(fresh.length >= files.length){ fresh.slice(-files.length).forEach((s, k) => { if(copies[k]) hiRes[s.imageId] = copies[k]; }); break; }
        await new Promise(r => setTimeout(r, 500));
      }
      showOffer(true);
    });
  }

  // ---------- UI ----------
  function buildUi(){
    const panel = $('adminPanelSlips'); if(!panel || $('slipScanBox')) return;
    const box = document.createElement('div');
    box.id = 'slipScanBox'; box.className = 'ss-box';
    box.innerHTML = `<div class="ss-head">
        <div><b>Read slips automatically</b><span>Reads this week's Sportsbet slips and fills in odds, results, stake and return for you to check.</span></div>
        <button type="button" class="small" id="slipScanBtn">Read slips</button>
      </div>
      <div class="ss-pick" id="slipScanPick" hidden></div>
      <div class="status-msg" id="slipScanStatus"></div>
      <div id="slipScanResults"></div>`;
    const area = $('adminSlipsArea');
    panel.insertBefore(box, area);
    $('slipScanBtn').addEventListener('click', () => openPicker());
  }
  function showOffer(on){
    const btn = $('slipScanBtn'); if(btn) btn.classList.toggle('ss-pulse', !!on);
  }
  function recentSlips(){
    const slips = (st().slips || []).filter(s => s.imageId);
    const weekAgo = Date.now() - 6 * 864e5;
    return slips.filter(s => (s.addedAt || 0) >= weekAgo).slice(-8);
  }
  function openPicker(){
    const pick = $('slipScanPick');
    const list = recentSlips();
    const all = (st().slips || []).filter(s => s.imageId).slice(-8);
    const use = list.length ? list : all;
    if(!use.length){ setStatus('error', 'Upload a slip screenshot first.'); return; }
    pick.hidden = false;
    pick.innerHTML = `<div class="ss-pick-title">Which screenshots? Pick the ones that belong together (a long multi split over two counts as one).</div>
      <div class="ss-pick-grid">${use.slice().reverse().map((s, i) => `<label class="ss-thumb"><input type="checkbox" value="${esc(s.imageId)}" ${i < 2 ? 'checked' : ''}><img data-slip-img="${esc(s.imageId)}" alt="${esc(s.label || 'Slip')}"><span>${esc(s.label || 'Slip')}</span></label>`).join('')}</div>
      <div class="ss-pick-actions"><button type="button" class="small" id="slipScanGo">Read selected</button><button type="button" class="small ss-ghost" id="slipScanCancel">Cancel</button></div>`;
    pick.querySelectorAll('img[data-slip-img]').forEach(img => { const id = img.dataset.slipImg; const src = hiRes[id]; if(src) img.src = src; else if(typeof loadSlipImage === 'function') loadSlipImage(id).then(s => { if(s) img.src = s; }); });
    $('slipScanCancel').addEventListener('click', () => { pick.hidden = true; pick.innerHTML = ''; });
    $('slipScanGo').addEventListener('click', () => {
      const ids = [...pick.querySelectorAll('input:checked')].map(i => i.value).slice(0, 4);
      if(!ids.length){ setStatus('error', 'Tick at least one screenshot.'); return; }
      pick.hidden = true; scan(ids);
    });
  }
  function setStatus(cls, txt){ const s = $('slipScanStatus'); if(s){ s.className = 'status-msg' + (cls ? ' ' + cls : ''); s.textContent = txt || ''; } }

  let lastIds = null;
  async function scan(ids, force){
    lastIds = ids;
    showOffer(false);
    const btn = $('slipScanBtn'); if(btn) btn.disabled = true;
    setStatus('', `Reading ${ids.length} screenshot${ids.length === 1 ? '' : 's'}… this takes about 10–20 seconds.`);
    $('slipScanResults').innerHTML = '<div class="ss-skel"></div>';
    try{
      const images = [];
      for(const id of ids){ const src = hiRes[id] || (typeof loadSlipImage === 'function' ? await loadSlipImage(id) : null); if(src) images.push(src); }
      if(!images.length) throw new Error("Couldn't load those screenshots. Check your connection.");
      const auth = await getValidAuth();
      if(!auth) throw new Error('Sign in again, then try.');
      const res = await fetch('/.netlify/functions/scan-slip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: auth.idToken, images, force: !!force }) });
      const data = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(data.error || `The slip reader failed (HTTP ${res.status}).`);
      if(!data.bets || !data.bets.length) throw new Error("No bets found on those screenshots. Try a clearer, uncropped one.");
      setStatus('ok', `Found ${data.bets.length} bet${data.bets.length === 1 ? '' : 's'}. Check each one, choose where it goes, then Apply.`);
      render(data);
      if(data.cached){
        const note = document.createElement('div');
        note.className = 'ss-cached';
        note.innerHTML = `This slip was read before${data.cachedAt ? ' (' + new Date(data.cachedAt).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) + ')' : ''}, so this is the saved result and there was no charge. If the bet has settled since, <button type="button" class="ss-fresh">read it fresh</button>.`;
        $('slipScanResults').prepend(note);
        note.querySelector('.ss-fresh').addEventListener('click', () => scan(lastIds, true));
      }
    }catch(e){
      setStatus('error', e.message || 'Something went wrong reading the slip.');
      $('slipScanResults').innerHTML = '';
    }finally{ if(btn) btn.disabled = false; }
  }

  // ---------- results ----------
  const RES_LABEL = { won: 'Won', lost: 'Lost', void: 'Void', pending: 'Running' };
  const STATUS_LABEL = { won: 'Won', lost: 'Lost', void: 'Void', pending: 'Running', cashed_out: 'Cashed out', partial: 'Partly settled' };
  function groupNames(){
    return [...document.querySelectorAll('#adminGroupEntryRows [data-admin-wk-name]')].map(r => r.dataset.adminWkName);
  }
  function allNames(){ return (st().members || []).map(m => m.name); }
  const legKey = (l) => String(l.selection || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function guessPerson(leg, idx, used){
    const map = LS.get(LEGMAP_KEY, { bySel: {}, order: [] });
    const names = groupNames();
    const bySel = map.bySel[legKey(leg)];
    if(bySel && names.includes(bySel) && !used.has(bySel)) return bySel;
    const byOrder = map.order[idx];
    if(byOrder && names.includes(byOrder) && !used.has(byOrder)) return byOrder;
    return '';
  }
  function render(data){
    const out = $('slipScanResults');
    const isMultiLike = (b) => b.legs.length > 1 || b.type === 'multi';
    out.innerHTML = (data.warnings && data.warnings.length ? `<div class="ss-warn">${data.warnings.map(esc).join('<br>')}</div>` : '') +
      data.bets.map((b, bi) => {
        const used = new Set();
        const people = groupNames();
        const legsHtml = b.legs.map((l, li) => {
          const g = isMultiLike(b) ? guessPerson(l, li, used) : ''; if(g) used.add(g);
          return `<div class="ss-leg">
            <div class="ss-leg-main"><b>${esc(l.selection || 'Leg ' + (li + 1))}</b><span>${esc([l.market, l.event].filter(Boolean).join(' · '))}</span></div>
            <span class="ss-odds">${l.odds != null ? '@' + Number(l.odds).toFixed(2) : '–'}</span>
            <span class="ss-res r-${l.result || 'none'}">${RES_LABEL[l.result] || '?'}</span>
            <select class="ss-person" data-leg="${li}" aria-label="Whose leg is ${esc(l.selection)}"><option value="">Whose?</option>${people.map(n => `<option${n === g ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>
          </div>`;
        }).join('');
        const kind = isMultiLike(b) ? 'group' : 'ind';
        return `<div class="ss-bet" data-bet="${bi}">
          <div class="ss-bet-head">
            <div><b>${b.type === 'same_game_multi' ? 'Same game multi' : b.legs.length > 1 ? 'Multi' : 'Single'}${b.combined_odds ? ' @ ' + Number(b.combined_odds).toFixed(2) : ''}</b>
              <span>${b.legs.length} leg${b.legs.length === 1 ? '' : 's'} · Stake ${money(b.stake)}${b.bonus_bet ? ' (bonus bet)' : ''} · ${b.status === 'won' || b.status === 'cashed_out' ? 'Paid ' + money(b.paid_return != null ? b.paid_return : b.potential_return) : b.status === 'lost' ? 'Paid $0' : 'Returns ' + money(b.potential_return)}</span></div>
            <span class="ss-status s-${esc(b.status)}">${STATUS_LABEL[b.status] || esc(b.status)}</span>
          </div>
          <div class="ss-legs">${legsHtml}</div>
          <div class="ss-apply">
            <div class="ss-seg" role="radiogroup" aria-label="Where this bet goes">
              <button type="button" class="ss-seg-btn${kind === 'group' ? ' on' : ''}" data-kind="group" role="radio" aria-checked="${kind === 'group'}">Group multi</button>
              <button type="button" class="ss-seg-btn${kind === 'ind' ? ' on' : ''}" data-kind="ind" role="radio" aria-checked="${kind === 'ind'}">Individual bet</button>
            </div>
            <select class="ss-ind-person" aria-label="Whose individual bet" ${kind === 'ind' ? '' : 'hidden'}><option value="">Whose bet?</option>${allNames().map(n => `<option>${esc(n)}</option>`).join('')}</select>
            <button type="button" class="small ss-apply-btn">Apply</button>
          </div>
          <div class="status-msg ss-bet-status"></div>
        </div>`;
      }).join('');
    out.querySelectorAll('.ss-bet').forEach(card => {
      const b = data.bets[+card.dataset.bet];
      const setKind = (k) => {
        card.querySelectorAll('.ss-seg-btn').forEach(x => { const on = x.dataset.kind === k; x.classList.toggle('on', on); x.setAttribute('aria-checked', on); });
        card.querySelector('.ss-ind-person').hidden = k !== 'ind';
        card.querySelectorAll('.ss-person').forEach(s => { s.hidden = k !== 'group'; });
        card.dataset.kind = k;
      };
      setKind(card.querySelector('.ss-seg-btn.on').dataset.kind);
      card.querySelectorAll('.ss-seg-btn').forEach(x => x.addEventListener('click', () => setKind(x.dataset.kind)));
      card.querySelector('.ss-apply-btn').addEventListener('click', () => {
        const st = card.querySelector('.ss-bet-status');
        try{
          const msg = card.dataset.kind === 'group' ? applyGroup(b, card) : applyIndividual(b, card);
          st.className = 'status-msg ok ss-bet-status'; st.textContent = msg;
          card.classList.add('ss-done');
          if(typeof showToast === 'function') showToast('Filled in from the slip');
          if(typeof updateWeeklyChecklist === 'function') try{ updateWeeklyChecklist(); }catch(e){}
        }catch(e){ st.className = 'status-msg error ss-bet-status'; st.textContent = e.message; }
      });
    });
  }

  // ---------- apply ----------
  const RESULT_TO_APP = { won: 'Win', lost: 'Loss', void: 'Void' };
  function settledReturn(b){
    if(b.status === 'lost') return 0;
    if(b.status === 'won' || b.status === 'cashed_out') return b.paid_return != null ? b.paid_return : b.potential_return;
    if(b.status === 'void') return b.stake;
    return null;
  }
  function fire(el){ el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
  function applyGroup(b, card){
    const picks = [...card.querySelectorAll('.ss-person')].map(s => ({ leg: b.legs[+s.dataset.leg], name: s.value }));
    const chosen = picks.filter(p => p.name);
    if(!chosen.length) throw new Error('Pick whose leg each one is first.');
    const names = chosen.map(p => p.name);
    const dupe = names.find((n, i) => names.indexOf(n) !== i);
    if(dupe) throw new Error(`${dupe} is picked for two legs.`);
    const wrap = $('adminGroupEntryRows');
    let filled = 0;
    chosen.forEach(({ leg, name }) => {
      const odds = wrap.querySelector(`.adminWkOdds[data-name="${CSS.escape(name)}"]`);
      const result = wrap.querySelector(`.adminWkResult[data-name="${CSS.escape(name)}"]`);
      if(!odds || !result) return;
      if(leg.odds != null){ odds.value = Number(leg.odds).toFixed(2); fire(odds); }
      const r = RESULT_TO_APP[leg.result];
      if(r){ result.value = r; fire(result); }
      // v204: keep the selection so Home can show what each person picked
      try{
        const d = currentState.groupEntryDraft[name] || (currentState.groupEntryDraft[name] = {});
        d.pick = { sel: leg.selection || '', market: leg.market || null, event: leg.event || null, sport: leg.sport || null, team: leg.team || null, kind: leg.kind || null };
        adminGroupDraftDirty.add(name);
      }catch(e){}
      filled++;
    });
    try{ scheduleAdminGroupDraftSave(); }catch(e){}
    const out = $('adminGMultiOut'), ret = $('adminGMultiRet');
    if(out && b.stake != null && !b.bonus_bet){ out.value = b.stake; fire(out); }
    const r = settledReturn(b);
    if(ret && r != null){ ret.value = Math.round(r * 100) / 100; fire(ret); }
    // remember who had which leg, to pre-fill next week
    const map = LS.get(LEGMAP_KEY, { bySel: {}, order: [] });
    picks.forEach((p, i) => { if(p.name){ map.bySel[legKey(p.leg)] = p.name; map.order[i] = p.name; } });
    const keys = Object.keys(map.bySel); if(keys.length > 200) keys.slice(0, keys.length - 200).forEach(k => delete map.bySel[k]);
    LS.set(LEGMAP_KEY, map);
    const skipped = picks.length - chosen.length;
    return `Filled ${filled} leg${filled === 1 ? '' : 's'}${b.stake != null && !b.bonus_bet ? ', stake ' + money(b.stake) : ''}${r != null ? ' and return ' + money(r) : ''}. It's saved as a draft; Save week still commits it.${skipped ? ` ${skipped} leg${skipped === 1 ? ' was' : 's were'} left without a name.` : ''}`;
  }
  function applyIndividual(b, card){
    const name = card.querySelector('.ss-ind-person').value;
    if(!name) throw new Error('Pick whose bet this is first.');
    const r = settledReturn(b);
    const result = b.status === 'won' || b.status === 'cashed_out' ? 'Win' : b.status === 'lost' ? 'Loss' : '';
    // Returns (the detailed table Save week uses)
    if(typeof adminReadIndividualValues === 'function' && typeof renderAdminFinIndRows === 'function'){
      const rows = adminReadIndividualValues();
      let i = rows.findIndex(v => v.name === name);
      if(i < 0) i = rows.findIndex(v => !v.name);
      if(i < 0){ rows.push({ name: '', outlay: '', ret: '' }); i = rows.length - 1; }
      rows[i] = { name, outlay: b.stake != null && !b.bonus_bet ? String(b.stake) : (b.bonus_bet ? '0' : rows[i].outlay), ret: r != null ? String(Math.round(r * 100) / 100) : '' };
      renderAdminFinIndRows(rows);
      if(typeof renderAdminGroupEntry === 'function') renderAdminGroupEntry();
      if(typeof scheduleAdminIndDraftSave === 'function') scheduleAdminIndDraftSave();
    }
    // the public "who's on an individual bet" list on Home
    if(typeof adminReadWeeklyBetValues === 'function' && typeof renderAdminWeeklyIndividualBetsEntry === 'function'){
      const rows = adminReadWeeklyBetValues();
      // slip details travel with the bet so Home can show them
      const leg = b.legs[0] || {};
      const pick = { sel: b.legs.length > 1 ? `${b.legs.length}-leg ${b.type === 'same_game_multi' ? 'same game multi' : 'multi'}` : (leg.selection || ''), market: b.legs.length > 1 ? b.legs.map(l => l.selection).filter(Boolean).join(', ').slice(0, 120) : (leg.market || null), event: leg.event || null };
      if(b.legs.length === 1){ pick.sport = leg.sport || null; pick.team = leg.team || null; pick.kind = leg.kind || null; }
      else pick.legs = b.legs.map(l => ({ sel: l.selection || '', market: l.market || null, event: l.event || null, sport: l.sport || null, team: l.team || null, kind: l.kind || null, odds: l.odds, result: l.result }));
      const ex = { pick, stake: b.bonus_bet ? null : b.stake, bonus: !!b.bonus_bet, odds: b.combined_odds || leg.odds || null, ret: b.potential_return };
      window.slipIndExtras = window.slipIndExtras || {};
      window.slipIndExtras[name] = ex;
      // v211: which row this slip belongs on. The same bet read again (now
      // settled) updates its own row; a different bet for someone who already
      // has one (their bonus bet after a win) goes on their next row.
      const same = (p) => p && p.sel === pick.sel && (p.market || null) === (pick.market || null);
      const mine = rows.map((v, k) => ({ v, k })).filter(x => x.v.name === name);
      let i = (mine.find(x => same(x.v.pick)) || mine.find(x => !x.v.pick) || {}).k;
      if(i == null) i = rows.findIndex(v => !v.name);
      if(i == null || i < 0){ rows.push({}); i = rows.length - 1; }
      const pl = r != null && b.stake != null ? Math.round((r - (b.bonus_bet ? 0 : b.stake)) * 100) / 100 : '';
      rows[i] = { ...rows[i], name, result, pl: result ? pl : '', placed: true, pick: ex.pick, odds: ex.odds, ret: ex.ret, bonus: ex.bonus };
      if(ex.stake != null) rows[i].stake = ex.stake; else delete rows[i].stake;
      renderAdminWeeklyIndividualBetsEntry(rows);
      const save = $('adminSaveWeeklyBetsBtn'); if(save) save.click();
    }
    return `${name}'s bet filled in: stake ${b.bonus_bet ? 'bonus bet' : money(b.stake)}${r != null ? ', return ' + money(r) : ', still running'}. Save week still commits it to the season.`;
  }

  function init(){ buildUi(); captureUploads(); }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
