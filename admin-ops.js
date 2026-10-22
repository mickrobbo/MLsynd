// admin-ops.js (v211)
// Admin → Tools: Backups and Errors.
//   Backups: the nightly copies made by backup-scheduled.mjs, plus Back up
//   now and Restore. Restoring takes a safety copy of the current data
//   first, so a restore can itself be undone.
//   Errors: what has gone wrong on members' phones (from error-report.js),
//   grouped so the same error shows once with a count.
(function(){
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s));
  const isAdmin = () => typeof currentUserEmail !== 'undefined' && currentUserEmail && typeof ADMIN_EMAIL !== 'undefined' && currentUserEmail.toLowerCase() === ADMIN_EMAIL.toLowerCase();
  const when = (t) => t ? new Date(t).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  const ago = (t) => (typeof timeAgo === 'function' ? timeAgo(t) : when(t));
  const kb = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  async function getJson(path){ const r = await authedFetch(path); if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
  async function putJson(path, v){ const r = await authedFetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) }); if(!r.ok) throw new Error('HTTP ' + r.status); }
  const rulesHint = (e) => /40[13]/.test(String(e && e.message)) ? ' Publish the latest Firebase rules first (see firebase-rules.json).' : '';

  function buildUi(){
    const tools = document.querySelector('[data-submode-panel="repair"]');
    if(!tools || $('adminBackupsPanel')) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="panel" id="adminBackupsPanel">
        <h2>Backups</h2>
        <div class="hint">Every night the app saves a full copy of the season (members, weeks, dues, drafts and settings) and keeps 30 days of them. Restoring puts a copy back exactly as it was; a safety copy of the current data is taken first, so a restore can be undone.</div>
        <div class="ao-row"><button type="button" id="aoBackupNow" class="small">Back up now</button><button type="button" id="aoBackupRefresh" class="small btn-secondary">Refresh</button></div>
        <div class="status-msg" id="aoBackupStatus"></div>
        <div id="aoBackupList" class="ao-list"><div class="empty">Open this tab to load backups.</div></div>
      </div>
      <div class="panel" id="adminTipFineFixPanel">
        <h2>Tip fines after the season</h2>
        <div class="hint">After the 2026 comp was archived, the fines check went back over 2026 games from before the comp started and charged everyone Missed Tip fines. That check is fixed. This finds those fines (any tip fine charged after the season was archived), shows what each person lost, and gives it back.</div>
        <div class="ao-row"><button type="button" id="aoTfCheck" class="small btn-secondary">Find them</button><button type="button" id="aoTfRefund" class="small" hidden>Refund everyone</button></div>
        <div class="status-msg" id="aoTfStatus"></div>
        <div id="aoTfList" class="ao-list"></div>
      </div>
      <div class="panel" id="adminErrorsPanel">
        <h2>Phone errors</h2>
        <div class="hint">Anything that has gone wrong on someone's phone in the last 30 days. The same error is grouped, with how many times it happened, who saw it and on which version. Lost signal is ignored.</div>
        <div class="ao-row"><button type="button" id="aoErrRefresh" class="small btn-secondary">Refresh</button><button type="button" id="aoErrClear" class="small btn-secondary">Clear all</button></div>
        <div class="status-msg" id="aoErrStatus"></div>
        <div id="aoErrList" class="ao-list"><div class="empty">Open this tab to load errors.</div></div>
      </div>`;
    tools.prepend(...wrap.children);
    $('aoBackupNow').addEventListener('click', backupNow);
    $('aoBackupRefresh').addEventListener('click', loadBackups);
    $('aoBackupList').addEventListener('click', onBackupClick);
    $('aoErrRefresh').addEventListener('click', loadErrors);
    $('aoErrClear').addEventListener('click', clearErrors);
    $('aoTfCheck').addEventListener('click', findBadFines);
    $('aoTfRefund').addEventListener('click', refundBadFines);
    $('aoErrList').addEventListener('click', (e) => { const r = e.target.closest('.ao-err'); if(r) r.classList.toggle('open'); });
    const btn = document.querySelector('#diagSubmodeRow .admin-submode-btn[data-submode="repair"]');
    if(btn) btn.addEventListener('click', () => { loadBackups(); loadErrors(); });
  }

  // ---------- backups ----------
  let backups = [];
  async function loadBackups(){
    if(!isAdmin()) return;
    const list = $('aoBackupList');
    try{
      const idx = await getJson('/backupIndex.json') || {};
      backups = Object.entries(idx).map(([key, v]) => ({ key, ...v })).filter(b => b.at).sort((a, b) => b.at - a.at);
      if(!backups.length){ list.innerHTML = '<div class="empty">No backups yet. The first nightly one runs at about 2am, or tap Back up now.</div>'; return; }
      list.innerHTML = backups.map(b => `<div class="ao-bk" data-key="${esc(b.key)}">
          <div class="ao-bk-main"><b>${esc(when(b.at))}</b><span>${b.kind === 'nightly' ? 'Nightly' : b.kind === 'manual' ? 'Backed up by hand' : b.kind === 'before-restore' ? 'Safety copy before a restore' : esc(b.kind)} · ${b.weeks || 0} week${b.weeks === 1 ? '' : 's'}${b.lastWeek ? ' · last ' + esc(b.lastWeek) : ''} · ${kb(b.bytes || 0)}</span></div>
          <button type="button" class="small btn-secondary ao-restore" data-key="${esc(b.key)}">Restore</button>
        </div>`).join('');
    }catch(e){ list.innerHTML = `<div class="empty">Couldn't load backups.${esc(rulesHint(e))}</div>`; }
  }
  async function takeCopy(kind){
    const res = await authedFetch('/state.json');
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const state = JSON.parse(text);
    const at = Date.now();
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
    const key = `${d}-${kind}-${at}`;
    const hist = Array.isArray(state && state.history) ? state.history : [];
    await putJson(`/backups/${key}.json`, { at, kind, state });
    await putJson(`/backupIndex/${key}.json`, { at, kind, bytes: text.length, weeks: hist.length, lastWeek: hist.length ? (hist[hist.length - 1].label || null) : null, members: Array.isArray(state && state.members) ? state.members.length : 0 });
    return key;
  }
  async function backupNow(){
    const st = $('aoBackupStatus'); const btn = $('aoBackupNow');
    btn.disabled = true; st.className = 'status-msg'; st.textContent = 'Backing up…';
    try{ await takeCopy('manual'); st.className = 'status-msg ok'; st.textContent = 'Backed up.'; loadBackups(); }
    catch(e){ st.className = 'status-msg error'; st.textContent = "Couldn't back up." + rulesHint(e); }
    finally{ btn.disabled = false; }
  }
  // Restore needs two taps: the first arms the button for 5 seconds.
  let armed = null, armTimer = null;
  async function onBackupClick(e){
    const btn = e.target.closest('.ao-restore'); if(!btn) return;
    const key = btn.dataset.key; const b = backups.find(x => x.key === key); if(!b) return;
    if(armed !== key){
      document.querySelectorAll('.ao-restore.armed').forEach(x => { x.classList.remove('armed'); x.textContent = 'Restore'; });
      armed = key; btn.classList.add('armed'); btn.textContent = 'Tap again to restore';
      clearTimeout(armTimer); armTimer = setTimeout(() => { armed = null; btn.classList.remove('armed'); btn.textContent = 'Restore'; }, 5000);
      return;
    }
    clearTimeout(armTimer); armed = null;
    const st = $('aoBackupStatus');
    document.querySelectorAll('.ao-restore').forEach(x => { x.disabled = true; });
    try{
      st.className = 'status-msg'; st.textContent = 'Taking a safety copy of the current data…';
      await takeCopy('before-restore');
      st.textContent = `Restoring the copy from ${when(b.at)}…`;
      const full = await getJson(`/backups/${key}.json`);
      if(!full || !full.state || typeof full.state !== 'object') throw new Error('That backup is empty.');
      await putJson('/state.json', full.state);
      st.className = 'status-msg ok'; st.textContent = 'Restored. Reloading the app…';
      if(typeof showToast === 'function') showToast(`Restored the backup from ${when(b.at)}`);
      setTimeout(() => location.reload(), 1200);
    }catch(e){
      st.className = 'status-msg error'; st.textContent = "Couldn't restore: " + (e.message || 'try again') + '.' + rulesHint(e) + ' Nothing was changed unless a safety copy shows above.';
      document.querySelectorAll('.ao-restore').forEach(x => { x.disabled = false; });
      loadBackups();
    }
  }

  // ---------- errors ----------
  async function loadErrors(){
    if(!isAdmin()) return;
    const list = $('aoErrList');
    try{
      const raw = await getJson('/clientErrors.json') || {};
      const all = Object.values(raw).filter(r => r && r.msg);
      if(!all.length){ list.innerHTML = '<div class="empty">No errors reported. All quiet.</div>'; $('aoErrStatus').textContent = ''; return; }
      const groups = {};
      all.forEach(r => {
        const k = r.msg + '|' + (r.file || '') + '|' + (r.line || 0);
        const g = groups[k] || (groups[k] = { ...r, n: 0, who: new Set(), ver: new Set(), tabs: new Set(), last: 0, first: Infinity });
        g.n++; if(r.who) g.who.add(r.who); if(r.ver) g.ver.add(r.ver); if(r.tab) g.tabs.add(r.tab);
        if(r.at > g.last){ g.last = r.at; g.stack = r.stack; g.ua = r.ua; } if(r.at < g.first) g.first = r.at;
      });
      const rows = Object.values(groups).sort((a, b) => b.last - a.last);
      $('aoErrStatus').className = 'status-msg'; $('aoErrStatus').textContent = `${all.length} report${all.length === 1 ? '' : 's'}, ${rows.length} different error${rows.length === 1 ? '' : 's'}.`;
      list.innerHTML = rows.map(g => `<div class="ao-err" role="button" tabindex="0">
          <div class="ao-err-top"><b>${esc(g.msg)}</b><span class="ao-err-n">${g.n}×</span></div>
          <div class="ao-err-meta">${esc(ago(g.last))} · ${esc([...g.who].slice(0, 4).join(', ') || 'unknown')}${g.who.size > 4 ? ' +' + (g.who.size - 4) : ''}${g.tabs.size ? ' · ' + esc([...g.tabs].slice(0, 2).join(', ')) : ''}</div>
          <div class="ao-err-more">
            <div>${g.file ? esc(g.file) + (g.line ? ':' + g.line : '') + ' · ' : ''}version ${esc([...g.ver].join(', ') || '?')}</div>
            ${g.stack ? `<pre>${esc(g.stack)}</pre>` : ''}
            ${g.ua ? `<div class="ao-err-ua">${esc(g.ua)}</div>` : ''}
          </div>
        </div>`).join('');
    }catch(e){ list.innerHTML = `<div class="empty">Couldn't load errors.${esc(rulesHint(e))}</div>`; }
  }
  let clearArmed = false, clearTimer = null;
  async function clearErrors(){
    const btn = $('aoErrClear');
    if(!clearArmed){ clearArmed = true; btn.textContent = 'Tap again to clear'; clearTimer = setTimeout(() => { clearArmed = false; btn.textContent = 'Clear all'; }, 4000); return; }
    clearTimeout(clearTimer); clearArmed = false; btn.textContent = 'Clear all';
    try{ const r = await authedFetch('/clientErrors.json', { method: 'DELETE' }); if(!r.ok) throw new Error('HTTP ' + r.status); loadErrors(); }
    catch(e){ $('aoErrStatus').className = 'status-msg error'; $('aoErrStatus').textContent = "Couldn't clear." + rulesHint(e); }
  }

  // ---------- refund tip fines charged after the season ----------
  const FINE_PERSONAL_SHARE = 0.10; // matches casino-pot-tipping-fines-scheduled.js
  const TIP_FINES = ['Missed Tip Fine', 'Wrong Tip Fine'];
  let badFines = null;
  function weekKeyFor(ts){
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date(ts));
    const g = (t) => parts.find(p => p.type === t).value;
    const wd = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[g('weekday')];
    const mon = new Date(Date.UTC(+g('year'), +g('month') - 1, +g('day')) - wd * 86400000);
    return `${mon.getUTCFullYear()}-${String(mon.getUTCMonth() + 1).padStart(2, '0')}-${String(mon.getUTCDate()).padStart(2, '0')}`;
  }
  async function findBadFines(){
    const st = $('aoTfStatus'), list = $('aoTfList'), btn = $('aoTfRefund');
    btn.hidden = true; st.className = 'status-msg'; st.textContent = 'Looking…'; list.innerHTML = '';
    try{
      const done = await getJson('/casinoPot/offseasonRefund.json');
      const archives = await getJson('/tippingArchive.json') || {};
      const cutoff = Math.max(0, ...Object.values(archives).map(a => (a && a.archivedAt) || 0));
      if(!cutoff){ st.textContent = 'No archived season found, so there is nothing to refund.'; return; }
      const events = await getJson('/casinoPot/fineEvents.json') || {};
      const hits = Object.entries(events).filter(([, e]) => e && TIP_FINES.includes(e.category) && e.ts >= cutoff - 60000);
      if(!hits.length){ st.className = 'status-msg ok'; st.textContent = done ? `Already refunded on ${when(done.at)}. Nothing left to give back.` : 'No tip fines since the season was archived. Nothing to refund.'; return; }
      const byUid = {};
      hits.forEach(([key, e]) => {
        const b = byUid[e.uid] || (byUid[e.uid] = { uid: e.uid, name: e.name || e.uid, missed: 0, wrong: 0, refund: 0, pot: 0, keys: [], weeks: {} });
        if(e.category === 'Missed Tip Fine') b.missed++; else b.wrong++;
        const amt = Number(e.amount) || 0, personal = amt - Math.round(amt * (1 - FINE_PERSONAL_SHARE));
        b.refund += personal; b.pot += amt - personal; b.keys.push(key);
        const wk = weekKeyFor(e.ts); b.weeks[wk] = (b.weeks[wk] || 0) + (amt - personal);
      });
      badFines = { cutoff, people: Object.values(byUid).sort((a, b) => b.refund - a.refund) };
      const total = badFines.people.reduce((a, b) => a + b.refund, 0);
      const fines = hits.length;
      st.className = 'status-msg'; st.textContent = `${fines} fine${fines === 1 ? '' : 's'} charged since the season was archived (${when(cutoff)}). Refunding gives back ${total.toLocaleString()} XP in total.`;
      list.innerHTML = badFines.people.map(b => `<div class="ao-bk"><div class="ao-bk-main"><b>${esc(b.name)}</b><span>${b.missed} missed${b.wrong ? `, ${b.wrong} wrong` : ''} · gets back ${b.refund.toLocaleString()} XP</span></div></div>`).join('');
      btn.hidden = false;
    }catch(e){ st.className = 'status-msg error'; st.textContent = "Couldn't check: " + (e.message || '') + rulesHint(e); }
  }
  let refundArmed = false, refundTimer = null;
  async function refundBadFines(){
    const st = $('aoTfStatus'), btn = $('aoTfRefund');
    if(!badFines || !badFines.people.length) return;
    if(!refundArmed){ refundArmed = true; btn.textContent = 'Tap again to refund'; refundTimer = setTimeout(() => { refundArmed = false; btn.textContent = 'Refund everyone'; }, 5000); return; }
    clearTimeout(refundTimer); refundArmed = false; btn.disabled = true; btn.textContent = 'Refunding…';
    let doneN = 0, total = 0;
    try{
      for(const b of badFines.people){
        // give back what came off their balance, with a line in their history
        const bal = Number(await getJson(`/xp/${b.uid}/balance.json`)) || 0;
        const newBal = bal + b.refund;
        await putJson(`/xp/${b.uid}/balance.json`, newBal);
        await authedFetch(`/xp/${b.uid}/log.json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: b.refund, reason: `Refund: ${b.missed + b.wrong} tip fines charged after the season ended`, balanceAfter: newBal, ts: Date.now() }) });
        // fine counts on their profile
        for(const [field, n] of [['missedTips', b.missed], ['wrongTips', b.wrong]]){
          if(!n) continue;
          const cur = Number(await getJson(`/casinoPot/fineHistory/${b.uid}/${field}.json`)) || 0;
          await putJson(`/casinoPot/fineHistory/${b.uid}/${field}.json`, Math.max(0, cur - n));
        }
        // the fines list
        const patch = {}; b.keys.forEach(k => { patch[k] = null; });
        await authedFetch('/casinoPot/fineEvents.json', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
        doneN++; total += b.refund;
        st.className = 'status-msg'; st.textContent = `Refunded ${doneN} of ${badFines.people.length}…`;
      }
      // take the pot's share back out of any week that hasn't paid out yet
      const weeks = {};
      badFines.people.forEach(b => Object.entries(b.weeks).forEach(([wk, v]) => { weeks[wk] = (weeks[wk] || 0) + v; }));
      let potFixed = 0, potPaid = 0;
      for(const [wk, v] of Object.entries(weeks)){
        const cur = await getJson(`/casinoPot/months/${wk}/fines.json`);
        if(cur == null){ potPaid += v; continue; }
        await putJson(`/casinoPot/months/${wk}/fines.json`, Math.max(0, Number(cur) - v));
        potFixed += Math.min(Number(cur), v);
      }
      await putJson('/casinoPot/offseasonRefund.json', { at: Date.now(), people: doneN, xp: total, potRemoved: potFixed, potAlreadyPaid: potPaid });
      st.className = 'status-msg ok';
      st.textContent = `Done. ${total.toLocaleString()} XP given back to ${doneN} people.` + (potFixed ? ` ${potFixed.toLocaleString()} XP taken back out of the pot.` : '') + (potPaid ? ` ${potPaid.toLocaleString()} XP from these fines had already gone into a pot that paid out, so it stays paid.` : '');
      btn.hidden = true; $('aoTfList').innerHTML = ''; badFines = null;
      if(typeof showToast === 'function') showToast('Tip fines refunded');
    }catch(e){
      st.className = 'status-msg error'; st.textContent = `Stopped after ${doneN} people: ${e.message || 'error'}. Tap Find them again; anyone already refunded won't show up twice.` + rulesHint(e);
      btn.disabled = false; btn.textContent = 'Refund everyone';
    }
  }

  function init(){ buildUi(); }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.adminOps = { loadBackups, loadErrors, takeCopy };
})();
