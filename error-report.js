// error-report.js (v211)
// Catches errors on members' phones and records them at /clientErrors so
// Admin → Tools → Errors can show what broke, where, and for whom, before
// anyone has to report it. Loaded first so it sees startup errors too.
// Light on purpose: at most 8 reports per visit, each distinct error once,
// and nothing is sent until the app has signed in.
(function(){
  'use strict';
  const MAX = 8;
  const seen = new Set();
  const queue = [];
  let sent = 0, flushing = false, tries = 0;

  const IGNORE = [
    /ResizeObserver loop/i,
    /^Script error\.?$/i,             // cross-origin, no detail to act on
    /extension:\/\//i, /chrome-extension/i, /moz-extension/i, /safari-web-extension/i,
    /AbortError/i, /The operation was aborted/i,
    /Non-Error promise rejection captured/i,
    /Failed to fetch|Load failed|NetworkError|network error/i,   // phone lost signal, not a bug

  ];
  const short = (s, n) => String(s == null ? '' : s).slice(0, n);
  const fileOf = (src) => { try{ return short(String(src || '').split('?')[0].split('/').pop(), 80); }catch(e){ return ''; } };

  function activeTab(){
    try{
      const t = document.querySelector('.tab-panel.active');
      const id = t ? t.id.replace(/^tab-/, '') : '';
      const sub = document.querySelector('#diagSubmodeRow .admin-submode-btn.active');
      return short(id === 'balance' ? 'home' : id, 30) + (id && sub && document.getElementById('homeSubview-diag') && document.getElementById('homeSubview-diag').style.display !== 'none' ? ' / admin ' + sub.dataset.submode : '');
    }catch(e){ return ''; }
  }
  function record(msg, src, line, col, stack){
    msg = short(msg, 300).trim();
    if(!msg || IGNORE.some(re => re.test(msg) || re.test(src || '') || re.test(stack || ''))) return;
    const key = msg + '|' + fileOf(src) + '|' + (line || 0);
    if(seen.has(key) || sent + queue.length >= MAX) return;
    seen.add(key);
    queue.push({
      msg, file: fileOf(src), line: Number(line) || 0, col: Number(col) || 0,
      stack: short(stack, 900),
      tab: activeTab(),
      ua: short(navigator.userAgent.replace(/Mozilla\/5\.0 /, ''), 160),
      online: navigator.onLine !== false,
    });
    setTimeout(flush, 1500);
  }
  async function flush(){
    if(flushing || !queue.length) return;
    // wait until the app has loaded and signed in
    if(typeof authedFetch !== 'function' || typeof currentUserEmail === 'undefined' || !currentUserEmail){
      if(++tries < 40) setTimeout(flush, 3000);
      return;
    }
    flushing = true;
    try{
      while(queue.length && sent < MAX){
        const r = queue.shift();
        r.ver = typeof APP_VERSION !== 'undefined' ? APP_VERSION : '';
        r.who = short((typeof currentUserName !== 'undefined' && currentUserName) || currentUserEmail.split('@')[0], 40);
        r.at = { '.sv': 'timestamp' };
        sent++;
        try{ await authedFetch('/clientErrors.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) }); }catch(e){}
      }
    }finally{ flushing = false; }
  }
  window.addEventListener('error', (e) => {
    if(e && e.target && e.target !== window && (e.target.src || e.target.href)) return; // missing image etc.
    record(e.message || (e.error && e.error.message), e.filename, e.lineno, e.colno, e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    const msg = r && (r.message || (typeof r === 'string' ? r : '')) || '';
    if(!msg) return;
    record('Unhandled: ' + msg, (r && r.fileName) || '', (r && r.lineNumber) || 0, 0, r && r.stack);
  });
  // lets other code report something it caught and handled, if useful
  window.reportAppError = (msg, extra) => record(msg, extra && extra.file, 0, 0, extra && extra.stack);
})();
