// tests/harness.cjs
// Runs the built app (dist/) in a headless phone-sized Chromium against an
// in-memory copy of Firebase, so tests never touch the real database.
// Signed in as the admin account. Each test gets a fresh database.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIST = path.join(__dirname, '..', 'dist');
const UID = 'adminUid';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function sampleDb(){
  const names = ['Billy', 'Zak', 'Murph', 'Brad', 'Damon', 'Josh'];
  const picks = ['Collingwood', 'Carlton', 'Collingwood -12.5', 'Nick Daicos 30+ disposals', 'Collingwood', 'Over 165.5'];
  return {
    users: { [UID]: { status: 'approved', role: 'full', name: 'Mick', email: 'mlsynd00@gmail.com' } },
    state: {
      members: names.map((n, i) => ({ name: n, pl: [42, -18, -30, 64, -12, 5][i], legs: 0, wins: [9, 3, 6, 8, 5, 4][i], losses: [4, 10, 6, 5, 7, 6][i], dues: 0, duesPaid: 0, duesOwed: i === 0 ? 50 : 0, duesCommitment: 840, linkedUid: i === 0 ? UID : 'u' + i })),
      group: { lottoOut: 483, lottoRet: 120, multiOut: 75, multiRet: 150, bonus: 60, sgmWin: 0 },
      history: [1, 2, 3, 4, 5, 6].map(i => ({ label: 'Week ' + (25 + i), savedAt: 1700000000000 + i * 6e8, group: { multiOut: 12.5, multiRet: i % 3 === 0 ? 150 : 0, lottoOut: 80.5, lottoRet: 0, bonus: 10 },
        groupEntries: { Billy: { legs: 1, odds: 1.9 + i / 10, result: i % 3 ? 'Win' : 'Loss', pick: { sel: picks[i - 1], market: 'Head to Head', event: 'AFL Round ' + i, sport: 'AFL' } }, Zak: { legs: 1, odds: 1.22, result: i % 2 ? 'Loss' : 'Win', pick: { sel: 'Penrith', market: 'Head to Head', event: 'NRL' } } },
        individualEntries: { Murph: { indWin: 1, indLoss: 0, pl: 425, outlay: 50, picks: [{ sel: 'Brisbane Lions', market: 'Head to Head', sport: 'AFL', odds: 2.4, result: 'Win', stake: 50 }] } },
        individualBets: [{ name: 'Murph', result: 'Win', pl: 425 }] })),
      groupMultiCleared: false,
      weekLabelDraft: 'Week 32',
      slips: [{ label: 'Multi', imageId: 'sA', addedAt: Date.now() - 3600e3 }],
      groupEntryDraft: { Billy: { odds: 2.1, result: 'Win', pick: { sel: 'Collingwood', market: 'Head to Head', event: 'Collingwood v Carlton' } }, Brad: { odds: 1.65, result: 'Win' }, Damon: { odds: 2.4, result: 'Void' }, Mick: { odds: 1.5 } },
      weeklyIndividualBets: [
        { name: 'Josh', result: 'Win', pl: 750, stake: 50, odds: 16, pick: { sel: '3-leg multi', market: 'Collingwood, Penrith -6.5, Nick Daicos 30+', legs: [{ sel: 'Collingwood', odds: 1.8, result: 'won' }, { sel: 'Penrith -6.5', odds: 1.9, result: 'won' }, { sel: 'Nick Daicos 30+', odds: 4.7, result: 'won' }] } },
        { name: 'Zak', odds: 2.4, pick: { sel: 'Brisbane Lions', market: 'Head to Head', event: 'Brisbane v Geelong' } },
      ],
    },
    slipImages: { sA: PNG },
    xp: { [UID]: { balance: 1000 } },
    tipping: { config: { year: 2027 } },
    apiUsage: { otherCosts: { netlify: 19, domain: 1.5, other: 0 }, anthropic: { totalCalls: 3, totalCostUsd: 0.06, byMonth: {} } },
  };
}

function serve(){
  return new Promise((resolve) => {
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.webmanifest': 'application/json' };
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if(p === '/') p = '/index.html';
      const file = path.join(DIST, p);
      if(!file.startsWith(DIST)){ res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, buf) => {
        if(err){ res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// Opens the app with a fresh mock database. `fns` maps a Netlify function
// name to a handler (body) => response object.
async function openApp(browser, port, { db = sampleDb(), fns = {}, log = [] } = {}){
  const getPath = (p) => p.split('/').filter(Boolean).reduce((o, k) => o == null ? undefined : o[k], db);
  const setPath = (p, v) => { const ks = p.split('/').filter(Boolean); let o = db; for(const k of ks.slice(0, -1)){ if(o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if(v === null || v === undefined) delete o[ks.at(-1)]; else o[ks.at(-1)] = v; };
  const resolveSv = (v) => { if(v && typeof v === 'object'){ if(v['.sv'] === 'timestamp') return Date.now(); for(const k of Object.keys(v)) v[k] = resolveSv(v[k]); } return v; };
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.addInitScript(([uid]) => {
    try{
      localStorage.setItem('mlsynd_auth', JSON.stringify({ idToken: 'tok', refreshToken: 'r', uid, email: 'mlsynd00@gmail.com', expiresAt: Date.now() + 3600e3 }));
      localStorage.setItem('mlsynd-onboarded', '1');
    }catch(e){}
  }, [UID]);
  await ctx.route('**/*', async (route) => {
    const req = route.request(); const url = new URL(req.url());
    if(url.host === `127.0.0.1:${port}`){
      const fn = url.pathname.match(/^\/\.netlify\/functions\/([\w-]+)/);
      if(fn){
        const h = fns[fn[1]];
        const body = req.postData() ? JSON.parse(req.postData()) : null;
        log.push({ fn: fn[1], body });
        const out = h ? await h(body) : (fn[1] === 'afl-fixtures' ? { year: 2027, games: [] } : {});
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(out) });
      }
      return route.continue();
    }
    if(url.host === 'mlsynd-default-rtdb.firebaseio.com'){
      const p = decodeURIComponent(url.pathname).replace(/\.json$/, '');
      const m = req.method(); const cur = getPath(p);
      const etag = '"' + Buffer.from(JSON.stringify(cur === undefined ? null : cur)).toString('base64').slice(0, 40) + '"';
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'ETag' };
      if(m === 'OPTIONS') return route.fulfill({ status: 200, headers: { ...cors, 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' } });
      if(m === 'GET'){
        let body = cur === undefined ? null : cur;
        if(url.searchParams.get('shallow') && body && typeof body === 'object') body = Object.fromEntries(Object.keys(body).map(k => [k, true]));
        return route.fulfill({ status: 200, headers: { ...cors, ETag: etag }, contentType: 'application/json', body: JSON.stringify(body) });
      }
      const ifm = req.headers()['if-match'];
      if(ifm && ifm !== etag) return route.fulfill({ status: 412, headers: cors, body: 'null' });
      const body = req.postData() ? resolveSv(JSON.parse(req.postData())) : null;
      log.push({ method: m, path: p, body });
      let reply = body;
      if(m === 'PUT') setPath(p, body);
      else if(m === 'PATCH'){ for(const [k, v] of Object.entries(body || {})) setPath(p + '/' + k, v); }
      else if(m === 'DELETE') setPath(p, null);
      else if(m === 'POST'){ const k = '-k' + Date.now() + Math.random().toString(36).slice(2, 6); setPath(p + '/' + k, body); reply = { name: k }; }
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(reply) });
    }
    return route.abort();
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => typeof currentState !== 'undefined' && currentState && currentState.members, null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    document.querySelectorAll('[id*=nboarding], .tier-celebrate, .cp-celebrate').forEach(e => { e.classList.remove('open'); e.remove && e.id !== 'onboardingModal' && e.remove(); });
    const cl = document.getElementById('changelogBanner'); if(cl) cl.style.display = 'none';
  });
  return { ctx, page, db, log, errors };
}

module.exports = { serve, openApp, sampleDb, UID };
