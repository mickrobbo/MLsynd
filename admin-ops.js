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
      <div class="panel" id="adminErrorsPanel">
        <h2>Errors</h2>
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

  function init(){ buildUi(); }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.adminOps = { loadBackups, loadErrors, takeCopy };
})();
