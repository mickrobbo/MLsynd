// tests/run.cjs
// End-to-end checks for the main flows. Run after `npm run build`:
//   node tests/run.cjs
// Needs the `playwright` package and a Chromium (the GitHub workflow
// installs both). Exits non-zero if anything fails.
const assert = require('assert/strict');
const { chromium } = require('playwright');
const { serve, openApp, sampleDb } = require('./harness.cjs');

const tests = [];
const test = (name, fn, opts) => tests.push({ name, fn, opts });
const text = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); return el ? el.innerText.replace(/\s+/g, ' ').trim() : null; }, sel);
const goHome = (page) => page.evaluate(() => { setActiveTab('balance'); try{ navShowHomeSub('overview'); }catch(e){} window.scrollTo(0, 0); });
const goAdmin = async (page, sub) => {
  await page.evaluate((sub) => { setActiveTab('diag'); const b = document.querySelector(`#diagSubmodeRow .admin-submode-btn[data-submode="${sub}"]`); if(b) b.click(); }, sub);
  await page.waitForTimeout(1200);
};

// ---------------------------------------------------------------------------
test('Home loads with the multi and individual bets, no result buttons', async ({ page, errors }) => {
  await goHome(page); await page.waitForTimeout(800);
  const multi = await text(page, '#groupMultiArea');
  assert.ok(multi && multi.length > 0, 'group multi card is empty');
  assert.equal(await page.locator('.hm-tick').count(), 0, 'Home still shows Won/Lost buttons');
  assert.ok(await page.locator('#weeklyIndividualBetsArea [data-ind-open]').count() >= 2, 'individual bet tiles missing');
  assert.deepEqual(errors, []);
});

test('Group multi heading shows what the group stake pays', async ({ page }) => {
  await goHome(page); await page.waitForTimeout(600);
  const t = await page.evaluate(() => document.body.innerText);
  assert.match(t, /\$12\.50 (pays|paid|was paying) \$/);
});

test('Tapping an individual bet shows every leg, odds, stake and return', async ({ page }) => {
  await goHome(page); await page.waitForTimeout(600);
  await page.click('#weeklyIndividualBetsArea [data-ind-open="0"]');
  const t = await text(page, '#weeklyIndividualBetsArea [data-ind-open="0"]');
  for(const s of ['Collingwood', 'Penrith -6.5', '@1.80', 'Multi @16.00', 'Stake $50', 'Paid $800']) assert.ok(t.includes(s), `missing "${s}" in: ${t}`);
  const z = await text(page, '#weeklyIndividualBetsArea [data-ind-open="1"]');
  assert.ok(z.includes('$50 stake') && z.includes('pays $120'), `default $50 stake not used: ${z}`);
});

test('Every main tab opens without errors', async ({ page, errors }) => {
  for(const tab of ['balance', 'board', 'casino', 'tipping', 'diag']){
    await page.evaluate((t) => { try{ setActiveTab(t); }catch(e){ const b = document.querySelector(`[data-tab="${t}"]`); if(b) b.click(); } }, tab);
    await page.waitForTimeout(700);
  }
  assert.deepEqual(errors, []);
});

test('Marking an individual bet in Admin fills the amount and the returns table', async ({ page, db }) => {
  await goAdmin(page, 'entry');
  await page.evaluate(() => renderAdminWeeklyIndividualBetsEntry());
  const line = await text(page, '#adminWeeklyIndividualBetsEntry');
  assert.ok(line.includes('Brisbane Lions'), 'selection not shown in Admin');
  await page.evaluate(() => { const s = document.querySelector('.adminWibResult[data-row="1"]'); s.value = 'Win'; s.dispatchEvent(new Event('change')); });
  assert.equal(await page.evaluate(() => document.querySelector('.adminWibAmount[data-row="1"]').value), '70');
  await page.evaluate(() => document.getElementById('adminSaveWeeklyBetsBtn').click());
  await page.waitForTimeout(1500);
  const zak = db.state.weeklyIndividualBets.filter(b => b.name === 'Zak');
  assert.equal(zak[0].result, 'Win'); assert.equal(zak[0].pl, 70);
  assert.ok(zak.length === 2 && !zak[1].pick, 'bonus-bet row should start without a selection');
  assert.equal((db.state.individualBetDraft || []).find(r => r.name === 'Zak').ret, '120');
});

test('Stakes saved in Admin change the payout figures', async ({ page, db }) => {
  await goAdmin(page, 'money');
  await page.fill('#adminStakeInd', '60'); await page.fill('#adminStakeGroup', '15');
  await page.click('#adminStakesSaveBtn'); await page.waitForTimeout(800);
  assert.deepEqual(db.state.stakeSettings, { individual: 60, group: 15 });
  await goHome(page); await page.waitForTimeout(600);
  const t = await page.evaluate(() => document.body.innerText);
  assert.match(t, /\$15 (pays|paid|was paying)/);
  assert.match(await text(page, '#weeklyIndividualBetsArea [data-ind-open="1"]'), /\$60 stake · pays \$144/);
});

test('Stat sheet counts group multi legs only', async ({ page }) => {
  await page.evaluate(() => setActiveTab('board')); await page.waitForTimeout(600);
  await page.click('#pickStatsOpenBtn'); await page.waitForTimeout(500);
  const t = await text(page, '#pickStatsBody');
  assert.ok(t.includes('Billy') && t.includes('Zak'), t);
  assert.ok(!t.includes('Murph'), 'individual bets are still counted');
});

test('Reading a slip fills the multi, and a repeat read says it was free', async ({ page, log }) => {
  await goAdmin(page, 'entry');
  await page.evaluate(() => document.getElementById('slipScanBtn').scrollIntoView({ block: 'center' }));
  await page.click('#slipScanBtn'); await page.waitForTimeout(600);
  await page.click('#slipScanGo'); await page.waitForTimeout(1500);
  assert.ok(log.some(l => l.fn === 'scan-slip' && l.body.images.length === 1), 'slip not sent');
  assert.ok(await page.locator('.ss-cached').count() === 1, 'cached note missing');
  await page.click('.ss-fresh'); await page.waitForTimeout(1200);
  assert.ok(log.some(l => l.fn === 'scan-slip' && l.body.force === true), 'read it fresh did not force');
}, { fns: { 'scan-slip': (b) => ({ bets: [{ type: 'single', status: 'pending', stake: 50, bonus_bet: false, combined_odds: 2.5, potential_return: 125, paid_return: null, legs: [{ selection: 'Fremantle', market: 'Head to Head', event: 'Fremantle v Richmond', odds: 2.5, result: 'pending' }] }], warnings: [], cached: !b.force, cachedAt: Date.now() - 3600e3 }) } });

test('A bonus-bet slip goes on the person\'s second row', async ({ page, db }) => {
  await goAdmin(page, 'entry');
  await page.evaluate(() => { const rows = adminReadWeeklyBetValues(); rows.push({ name: 'Zak' }); renderAdminWeeklyIndividualBetsEntry(rows); });
  await page.click('#slipScanBtn'); await page.waitForTimeout(600);
  await page.click('#slipScanGo'); await page.waitForTimeout(1500);
  await page.evaluate(() => { const c = document.querySelector('.ss-bet[data-bet="0"]'); c.querySelector('.ss-seg-btn[data-kind="ind"]').click(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { const s = document.querySelector('.ss-bet[data-bet="0"] .ss-ind-person'); s.value = 'Zak'; s.dispatchEvent(new Event('change')); });
  await page.click('.ss-bet[data-bet="0"] .ss-apply-btn'); await page.waitForTimeout(2000);
  const zak = db.state.weeklyIndividualBets.filter(b => b.name === 'Zak');
  assert.equal(zak.length, 2);
  assert.equal(zak[0].pick.sel, 'Brisbane Lions', 'first bet was overwritten');
  assert.equal(zak[1].pick.sel, 'Fremantle', 'second bet did not get the slip');
}, { fns: { 'scan-slip': () => ({ bets: [{ type: 'single', status: 'pending', stake: 50, bonus_bet: false, combined_odds: 2.5, potential_return: 125, paid_return: null, legs: [{ selection: 'Fremantle', market: 'Head to Head', event: 'Fremantle v Richmond', odds: 2.5, result: 'pending' }] }], warnings: [] }) } });

test('Back up now, then restore it', async ({ page, db }) => {
  await goAdmin(page, 'repair');
  await page.click('#aoBackupNow'); await page.waitForTimeout(1200);
  const keys = Object.keys(db.backupIndex || {});
  assert.equal(keys.length, 1, 'no backup written');
  assert.equal(db.backups[keys[0]].state.weekLabelDraft, 'Week 32');
  db.state.weekLabelDraft = 'CHANGED';
  await page.click('.ao-restore'); await page.click('.ao-restore');
  await page.waitForTimeout(2500);
  assert.equal(db.state.weekLabelDraft, 'Week 32', 'restore did not put the data back');
  assert.ok(Object.values(db.backupIndex).some(b => b.kind === 'before-restore'), 'no safety copy before restore');
});

test('Errors on a phone are reported and listed in Admin', async ({ page, db }) => {
  await page.evaluate(() => setTimeout(() => { throw new Error('Test explosion'); }, 0));
  await page.waitForTimeout(3500);
  const reports = Object.values(db.clientErrors || {});
  assert.ok(reports.some(r => r.msg.includes('Test explosion') && r.ver && r.at), 'error not recorded');
  await goAdmin(page, 'repair'); await page.waitForTimeout(800);
  assert.ok((await text(page, '#aoErrList')).includes('Test explosion'));
}, { allowErrors: true });

test('Running costs include Anthropic', async ({ page }) => {
  await goAdmin(page, 'money');
  await page.evaluate(async () => { try{ await renderSyndyUsage(); }catch(e){} await renderRunningCosts(); });
  const t = await text(page, '#runningCostsArea');
  assert.ok(t.includes('Anthropic') && t.includes('3 scans'), t);
});


// v225/v226 one-screen admin week
test('Admin week on one screen: mark legs and bets, fill the return', async ({ page, db }) => {
  await goAdmin(page, 'entry');
  await page.evaluate(() => { renderAdminWeeklyIndividualBetsEntry(); updateWeeklyChecklist(); });
  const desk = await text(page, '#adminWeeklyChecklistRows');
  for(const s of ['Slips', 'Group multi', 'Individual bets', 'Returns']) assert.ok(desk.includes(s), `missing "${s}" in: ${desk}`);
  assert.ok(!/scoreboard/i.test(desk), 'scoreboard suggestions still shown');
  await page.click('.awk-r[data-awk="leg"][data-id="Mick"][data-v="Loss"]'); await page.waitForTimeout(2500);
  assert.equal(db.state.groupEntryDraft.Mick.result, 'Loss', 'leg button did not mark');
  await page.click('.awk-r[data-awk="bet"][data-id="1"][data-v="Win"]'); await page.waitForTimeout(2500);
  const zak = db.state.weeklyIndividualBets.find(b => b.name === 'Zak');
  assert.equal(zak.result, 'Win'); assert.equal(zak.pl, 70);
  await page.evaluate(() => updateWeeklyChecklist());
  await page.click('[data-awk-act="fill-return"]'); await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => document.getElementById('adminGMultiRet').value), '0');
  assert.equal(db.state.groupFinancialsDraft.gMultiRet, '0');
});


test('Legs in the draft show on Home even if the multi was cleared', async ({ page }) => {
  await goHome(page); await page.waitForTimeout(600);
  assert.ok(await page.locator('#groupMultiArea .hm-leg').count() >= 3, 'multi hidden by the cleared flag');
}, { db: (db) => { db.state.groupMultiCleared = true; } });

test('Clear the multi, then new legs switch it back on for everyone', async ({ page, db }) => {
  await goAdmin(page, 'entry');
  await page.evaluate(() => document.getElementById('adminClearWhoCookingBtn').click()); await page.waitForTimeout(800);
  assert.equal(db.state.groupMultiCleared, true);
  await page.evaluate(() => { const el = document.querySelector('#adminGroupEntryRows .adminWkOdds[data-name="Zak"]'); el.value = '1.96'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(2500);
  assert.equal(db.state.groupMultiCleared, false, 'flag left on, Home stays empty for everyone');
  assert.equal(db.state.groupEntryDraft.Zak.odds, 1.96);
}, { db: (db) => { db.state.weeklyIndividualBets = []; } });

test('After Save week empties the draft, typing odds and reading a slip still save', async ({ page, db, errors }) => {
  await goAdmin(page, 'entry');
  await page.evaluate(() => { delete currentState.groupEntryDraft; });
  await page.evaluate(() => { const el = document.querySelector('#adminGroupEntryRows .adminWkOdds[data-name="Zak"]'); el.value = '1.96'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(2500);
  assert.equal(db.state.groupEntryDraft.Zak.odds, 1.96, 'odds not saved');
  assert.deepEqual(errors, []);
  await goHome(page); await page.waitForTimeout(600);
  assert.ok(await page.locator('#groupMultiArea .hm-leg[data-leg="Zak"]').count() === 1, 'not on Home');
}, { db: (db) => { delete db.state.groupEntryDraft; db.state.groupMultiCleared = true; db.state.weeklyIndividualBets = []; } });

// ---------------------------------------------------------------------------
(async () => {
  const srv = await serve();
  const port = srv.address().port;
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const only = process.argv[2];
  let failed = 0;
  for(const t of tests){
    if(only && !t.name.toLowerCase().includes(only.toLowerCase())) continue;
    const db = sampleDb(); if(t.opts && t.opts.db) t.opts.db(db);
    const app = await openApp(browser, port, { db, fns: (t.opts && t.opts.fns) || {} });
    const started = Date.now();
    try{
      await t.fn(app);
      if(!(t.opts && t.opts.allowErrors) && app.errors.length) throw new Error('Page errors: ' + app.errors.join(' | '));
      console.log(`  ok    ${t.name} (${Date.now() - started}ms)`);
    }catch(e){
      failed++;
      console.log(`  FAIL  ${t.name}\n        ${String(e.message).split('\n').join('\n        ')}`);
      try{ await app.page.screenshot({ path: `test-fail-${tests.indexOf(t) + 1}.png` }); }catch(_){}
    }finally{ await app.ctx.close(); }
  }
  await browser.close(); srv.close();
  console.log(failed ? `\n${failed} test${failed === 1 ? '' : 's'} failed` : '\nAll tests passed');
  process.exit(failed ? 1 : 0);
})();
