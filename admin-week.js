// admin-week.js (v225)
// The whole week on one screen, at the top of Admin → Week. In order:
//   1 Slips     read this week's slips (fills legs, odds and selections)
//   2 Multi     every leg with Win / Loss / Void buttons
//   3 Bets      each individual bet with the same buttons, and the slip's
//               own result offered when the slip says how it went
//   4 Returns   the group return worked out from the legs, one tap to fill
//   5 Save week
// Every button drives the same controls further down the page, so drafts,
// returns, alerts and Save week behave exactly as before. The detailed
// panels stay below for anything unusual.
(function(){
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s));
  const st = () => (typeof currentState !== 'undefined' && currentState) ? currentState : {};
  const money = (v) => (typeof moneyAud === 'function' ? moneyAud(v) : '$' + Number(v).toFixed(2));
  const RES = [['Win', 'Win'], ['Loss', 'Loss'], ['Void', 'Void']];

  // ---------- reading the week ----------
  function legsNow(){
    const draft = st().groupEntryDraft || {};
    return Object.entries(draft)
      .filter(([, e]) => e && (e.result || Number(e.odds) > 0))
      .map(([name, e]) => ({ name, odds: Number(e.odds) || 0, result: e.result || null, pick: e.pick || null }))
      .sort((a, b) => ((a.pick && Number(a.pick.leg)) || 1e9) - ((b.pick && Number(b.pick.leg)) || 1e9));
  }
  // individual bets as they stand in the editor below (what Save uses)
  function betsNow(){
    let rows = [];
    try{ rows = adminReadWeeklyBetValues(); }catch(e){ rows = (st().weeklyIndividualBets || []).map(b => ({ ...b })); }
    return rows.map((r, i) => ({ ...r, row: i })).filter(r => r.name);
  }
  // what the slip says happened to an individual bet
  function slipSays(b){
    const p = b.pick; if(!p) return null;
    const legs = Array.isArray(p.legs) && p.legs.length ? p.legs : [p];
    const rs = legs.map(l => String(l.result || '').toLowerCase());
    if(rs.some(r => r === 'lost' || r === 'loss')) return 'Loss';
    if(rs.length && rs.every(r => r === 'won' || r === 'win')) return 'Win';
    if(rs.length && rs.every(r => r === 'void')) return 'Void';
    return null;
  }
  function groupReturn(legs){
    if(!legs.length || legs.some(l => !l.result)) return null;
    if(legs.some(l => l.result === 'Loss')) return 0;
    const counting = legs.filter(l => l.result === 'Win' && l.odds > 0);
    const out = Number(($('adminGMultiOut') || {}).value) || (typeof groupStakeSetting === 'function' ? groupStakeSetting() : 12.5);
    if(!counting.length) return out; // every leg void: stake back
    return Math.round(counting.reduce((m, l) => m * l.odds, 1) * out * 100) / 100;
  }

  // ---------- drawing ----------
  const resBtns = (kind, id, cur, sug) => `<span class="awk-res" role="group" aria-label="Result">${RES.map(([v, t]) =>
    `<button type="button" class="awk-r awk-r-${v.toLowerCase()}${cur === v ? ' on' : ''}${!cur && sug === v ? ' sug' : ''}" data-awk="${kind}" data-id="${esc(id)}" data-v="${v}" aria-pressed="${cur === v}">${t}</button>`).join('')}</span>`;

  function render(wrap, steps){
    const s = st();
    const legs = legsNow();
    const bets = betsNow();
    const weekSel = $('adminWeekLabel');
    const week = (weekSel && weekSel.value) || '';
    const stepDone = Object.fromEntries((steps || []).map(x => [x.key, x.done]));
    const doneCount = (steps || []).filter(x => x.done).length, total = (steps || []).length || 1;

    const marked = legs.filter(l => l.result).length;
    const betSugs = bets.filter(b => !b.result).map(b => ({ b, r: slipSays(b) })).filter(x => x.r);
    const gr = groupReturn(legs);
    const retEl = $('adminGMultiRet');
    const retNow = retEl && retEl.value !== '' ? Number(retEl.value) : null;
    const lastSavedAt = (s.history || []).length ? (s.history[s.history.length - 1].savedAt || 0) : 0;
    const slipsRead = legs.filter(l => l.pick && l.pick.sel).length;
    const slipsUp = (s.slips || []).filter(x => x && (x.addedAt || 0) > lastSavedAt).length;

    const stepHead = (n, title, done, sub) => `<div class="awk-step-head"><span class="awk-n${done ? ' done' : ''}">${done ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12.5l4 4L18 8"/></svg>' : n}</span><b>${title}</b><span class="awk-sub">${sub}</span></div>`;

    wrap.innerHTML = `<div class="awk">
      <div class="awk-top">
        <button type="button" class="awk-week" data-awk-go="adminPanelWeek">${week ? esc(week) : 'Pick the week'}</button>
        <span class="awk-prog" aria-label="${doneCount} of ${total} done"><i style="width:${Math.round(doneCount / total * 100)}%"></i></span>
        <span class="awk-count">${doneCount}/${total}</span>
      </div>

      <section class="awk-step">
        ${stepHead(1, 'Slips', slipsUp > 0 || slipsRead > 0, slipsRead ? `${slipsRead} leg${slipsRead === 1 ? '' : 's'} read from slips` : slipsUp ? `${slipsUp} uploaded` : 'Nothing read yet')}
        <div class="awk-actions">
          <button type="button" class="small" data-awk-act="read">Read slips</button>
          <button type="button" class="small awk-ghost" data-awk-go="adminPanelSlips">Upload</button>
        </div>
      </section>

      <section class="awk-step">
        ${stepHead(2, 'Group multi', !!stepDone.results, legs.length ? `${marked} of ${legs.length} marked` : 'No legs in yet')}
        ${legs.length ? `<div class="awk-rows">${legs.map(l => {
          return `<div class="awk-row${l.result ? ' is-' + l.result.toLowerCase() : ''}">
            <span class="awk-who"><b>${esc(l.name)}</b><span>${l.pick && l.pick.sel ? esc(l.pick.sel) : 'No selection'}${l.odds ? ` · @${l.odds.toFixed(2)}` : ''}</span></span>
            ${resBtns('leg', l.name, l.result, null)}
          </div>`;
        }).join('')}</div>` : `<div class="awk-empty">Read the multi slip, or type odds in Group multi below.</div>`}
      </section>

      <section class="awk-step">
        ${stepHead(3, 'Individual bets', !!stepDone.ind, bets.length ? `${bets.filter(b => b.result).length} of ${bets.length} marked` : 'None this week')}
        ${betSugs.length ? `<div class="awk-sugbar"><span>The slip${betSugs.length === 1 ? ' says how 1 bet went' : `s say how ${betSugs.length} bets went`}</span><button type="button" class="small adm-primary" data-awk-act="accept-bets">Accept ${betSugs.length}</button></div>` : ''}
        ${bets.length ? `<div class="awk-rows">${bets.map(b => {
          const sg = !b.result && slipSays(b);
          const p = b.pick; const legsN = p && Array.isArray(p.legs) ? p.legs.length : 0;
          const what = p ? (legsN > 1 ? `${legsN}-leg multi` : (p.sel || '')) : 'No slip read';
          return `<div class="awk-row${b.result ? ' is-' + String(b.result).toLowerCase() : ''}">
            <span class="awk-who"><b>${esc(b.name)}</b><span>${esc(what)}${Number(b.odds) > 0 ? ` · @${Number(b.odds).toFixed(2)}` : ''}${b.result && b.pl !== '' && b.pl != null ? ` · ${Number(b.pl) >= 0 ? '+' : '−'}${money(Math.abs(Number(b.pl)))}` : ''}</span>${sg ? `<em class="awk-sug awk-sug-${sg.toLowerCase()}">Slip says ${sg === 'Win' ? 'won' : sg === 'Loss' ? 'lost' : 'void'}</em>` : ''}</span>
            ${resBtns('bet', b.row, b.result || null, sg)}
          </div>`;
        }).join('')}</div>` : ''}
      </section>

      <section class="awk-step">
        ${stepHead(4, 'Returns', !!stepDone.fin, retNow != null ? `Group return ${money(retNow)}` : gr != null ? 'Ready to fill' : 'Waiting on results')}
        ${gr != null && retNow !== gr ? `<div class="awk-sugbar"><span>${gr > 0 ? `Multi pays ${money(gr)}` : 'Multi lost, return is $0'}</span><button type="button" class="small adm-primary" data-awk-act="fill-return" data-v="${gr}">Fill in ${money(gr)}</button></div>` : ''}
        <div class="awk-actions"><button type="button" class="small awk-ghost" data-awk-go="adminPanelFin">Lotto, SGM and bonus pot</button></div>
      </section>

      <button type="button" class="awk-save${doneCount === total ? ' ready' : ''}" data-awk-go="adminPanelSave">${doneCount === total ? 'All done. Save week' : `Save week (${doneCount} of ${total} done)`}</button>
    </div>`;
  }

  // ---------- actions ----------
  function setLeg(name, v){
    const sel = document.querySelector(`#adminGroupEntryRows .adminWkResult[data-name="${CSS.escape(name)}"]`);
    if(sel){ sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); return; }
    // not on the editor (e.g. listed as an individual bet too): write the draft directly
    const d = st().groupEntryDraft || (currentState.groupEntryDraft = {});
    d[name] = d[name] || {}; d[name].result = v;
    try{ adminGroupDraftDirty.add(name); groupDraftMirrorWrite(); scheduleAdminGroupDraftSave(); }catch(e){}
  }
  let betSaveT = null;
  function setBet(row, v){
    const sel = document.querySelector(`#adminWeeklyIndividualBetsEntry .adminWibResult[data-row="${row}"]`);
    if(!sel) return;
    sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true }));
    // the editor below saves on its own button; save for the admin here
    clearTimeout(betSaveT);
    betSaveT = setTimeout(() => { const b = $('adminSaveWeeklyBetsBtn'); if(b) b.click(); setTimeout(refresh, 1500); }, 400);
  }
  function go(id){
    const panel = $(id); if(!panel) return;
    panel.classList.remove('admin-panel-collapsed');
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    panel.classList.remove('wcl-flash'); void panel.offsetWidth; panel.classList.add('wcl-flash');
  }
  const refresh = () => { try{ updateWeeklyChecklist(); }catch(e){} };

  document.addEventListener('click', (e) => {
    const root = e.target.closest('#adminWeeklyChecklistRows'); if(!root) return;
    const r = e.target.closest('[data-awk]');
    if(r){
      e.stopPropagation();
      const v = r.classList.contains('on') ? '' : r.dataset.v; // tap again to clear
      if(r.dataset.awk === 'leg') setLeg(r.dataset.id, v); else setBet(Number(r.dataset.id), v);
      setTimeout(refresh, 60);
      return;
    }
    const a = e.target.closest('[data-awk-act]');
    if(a){
      e.stopPropagation();
      const act = a.dataset.awkAct;
      if(act === 'read'){ const b = $('slipScanBtn'); if(b){ b.click(); go('adminPanelSlips'); } else go('adminPanelSlips'); }
      else if(act === 'accept-bets'){
        // one at a time: each result can re-draw the editor (a win adds a bonus row)
        const todo = betsNow().filter(b => !b.result).map(b => ({ name: b.name, row: b.row, r: slipSays(b) })).filter(x => x.r);
        todo.forEach(x => { const now = betsNow().find(b => b.name === x.name && !b.result && slipSays(b) === x.r); if(now) setBet(now.row, x.r); });
      }
      else if(act === 'fill-return'){ const el = $('adminGMultiRet'); if(el){ el.value = a.dataset.v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } setTimeout(refresh, 60); }
      return;
    }
    const g = e.target.closest('[data-awk-go]');
    if(g){ e.stopPropagation(); go(g.dataset.awkGo); }
  }, true);

  window.adminWeekDesk = { render, legsNow, betsNow, groupReturn, slipSays };
})();
