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
// ---------------------------------------------------------------------------
test('Game start times use AEDT in March and AEST in July (and prefer unixtime)', async ({ page }) => {
  const r = await page.evaluate(() => [
    gameKickoffMs({ date: '2027-03-18 19:30:00' }),
    gameKickoffMs({ date: '2027-07-10 19:30:00' }),
    gameKickoffMs({ date: '2027-03-18 19:30:00', unixtime: 1234567890 }),
  ]);
  assert.equal(r[0], Date.UTC(2027, 2, 18, 8, 30), 'March should be +11:00');
  assert.equal(r[1], Date.UTC(2027, 6, 10, 9, 30), 'July should be +10:00');
  assert.equal(r[2], 1234567890000, 'unixtime should win');
});

const nrlGames = () => {
  const t = Date.now() + 3 * 86400e3, stamp = (ms) => new Date(ms + 11 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
  return { year: Number(stamp(t).slice(0, 4)), games: [
    { id: 'n-r1-storm-v-eels', round: 1, roundname: 'Round 1', date: stamp(t), unixtime: Math.floor(t / 1000), venue: 'AAMI Park', hteam: 'Storm', ateam: 'Eels', hscore: null, ascore: null, complete: 0, winner: null, margin: null },
    { id: 'n-r1-broncos-v-roosters', round: 1, roundname: 'Round 1', date: stamp(t + 7200e3), unixtime: Math.floor((t + 7200e3) / 1000), venue: 'Suncorp Stadium', hteam: 'Broncos', ateam: 'Roosters', hscore: null, ascore: null, complete: 0, winner: null, margin: null },
  ] };
};
test('NRL tipping: switch comp, tip a round, picks land under /tippingNrl only', async ({ page, db }) => {
  await page.evaluate(() => setActiveTab('tipping'));
  await page.waitForTimeout(800);
  await page.click('#tab-tipping .tip-sport-btn[data-tipsport="nrl"]');
  await page.waitForTimeout(2500);
  assert.match(await text(page, '#tippingRoundHeading'), /NRL Tipping — Round 1/);
  assert.equal(await page.locator('#tippingGamesArea .tip-game').count(), 2);
  assert.match(await text(page, '#tipCompTitle'), /NRL/);
  // not in NRL yet: saving is refused until they join
  await page.evaluate(() => { document.querySelectorAll('.tip-game').forEach(g => g.querySelector('.tip-pick-btn[data-pick="home"]').click()); const m = document.querySelector('.tip-margin-input'); m.value = '12'; m.dispatchEvent(new Event('input')); });
  await page.click('#tipSaveAllBtn');
  assert.match(await text(page, '#tipSaveAllStatus'), /not in NRL tipping yet/);
  assert.equal(Object.keys(((db.tippingNrl || {}).picks) || {}).length, 0, 'no NRL pick may save before joining');
  await page.click('#tipEntryBar [data-tipjoin="nrl"]');
  await page.waitForTimeout(2500);
  assert.equal(db.tippingComps.adminUid.nrl, true);
  await page.evaluate(() => { document.querySelectorAll('.tip-game').forEach(g => g.querySelector('.tip-pick-btn[data-pick="home"]').click()); const m = document.querySelector('.tip-margin-input'); m.value = '12'; m.dispatchEvent(new Event('input')); });
  await page.click('#tipSaveAllBtn');
  await page.waitForTimeout(2500);
  const nrl = (db.tippingNrl || {}).picks || {};
  assert.equal(Object.keys(nrl).length, 2, 'two NRL games should have picks: ' + JSON.stringify(db.tippingNrl));
  assert.equal(Object.values(nrl)[0].adminUid.pick, 'home');
  assert.equal(Object.keys(((db.tipping || {}).picks) || {}).length, 0, 'AFL picks must stay empty');
  assert.ok(db.tippingNrl.meta && Object.keys(db.tippingNrl.meta).length === 2, 'kickoff times should be stored under NRL');
}, { fns: { 'nrl-fixtures': () => nrlGames() }, db: (db) => { db.tipping = { config: { year: 2027 } }; db.tippingNrl = { config: { year: Number(new Date(Date.now() + 3 * 86400e3 + 11 * 3600e3).toISOString().slice(0, 4)) } }; } });

test('NRL tipping: switching back to AFL shows the AFL comp again', async ({ page }) => {
  await page.evaluate(() => setActiveTab('tipping'));
  await page.waitForTimeout(600);
  await page.click('#tab-tipping .tip-sport-btn[data-tipsport="nrl"]');
  await page.waitForTimeout(1500);
  await page.click('#tab-tipping .tip-sport-btn[data-tipsport="afl"]');
  await page.waitForTimeout(1500);
  assert.match(await text(page, '#tipCompTitle'), /AFL/);
  assert.equal(await page.evaluate(() => TP.R), '/tipping');
}, { fns: { 'nrl-fixtures': () => nrlGames() } });

test('AFL tipping still saves picks under /tipping (not NRL)', async ({ page, db }) => {
  await page.evaluate(() => setActiveTab('tipping'));
  await page.waitForTimeout(2500);
  assert.match(await text(page, '#tippingRoundHeading'), /AFL Tipping — Round 1/);
  await page.evaluate(() => { document.querySelectorAll('.tip-game').forEach(g => g.querySelector('.tip-pick-btn[data-pick="away"]').click()); const m = document.querySelector('.tip-margin-input'); m.value = '5'; m.dispatchEvent(new Event('input')); });
  await page.click('#tipSaveAllBtn');
  await page.waitForTimeout(2500);
  const afl = (db.tipping || {}).picks || {};
  assert.equal(Object.keys(afl).length, 2, 'two AFL games should have picks');
  assert.equal(Object.values(afl)[0].adminUid.pick, 'away');
  assert.equal(Object.keys(((db.tippingNrl || {}).picks) || {}).length, 0, 'NRL picks must stay empty');
}, { fns: { 'afl-fixtures': () => { const g = nrlGames(); g.games.forEach((x, i) => { x.id = 9000 + i; x.hteam = ['Collingwood', 'Carlton'][i]; x.ateam = ['Essendon', 'Geelong'][i]; }); return g; } }, db: (db) => { db.tipping = { config: { year: Number(new Date(Date.now() + 3 * 86400e3 + 11 * 3600e3).toISOString().slice(0, 4)) } }; } });

test('Home multi keeps a leg whose price is missing and says the price is partial', async ({ page }) => {
  await page.evaluate(() => {
    currentState.groupEntryDraft = { Billy: { odds: 2, pick: { sel: 'Collingwood' } }, Zak: { odds: 1.5, pick: { sel: 'Penrith' } }, Josh: { pick: { sel: 'Samoa', market: 'Head to Head' } } };
    renderGroupMultiChart(currentState);
  });
  const sub = await text(page, '#homeSlipWeek'), head = await text(page, '#homeMultiOdds');
  assert.match(sub, /^3 legs/); assert.match(sub, /1 price to come/);
  assert.match(head, /Multi @ 3\.00\+/);
  assert.ok((await page.evaluate(() => window.__hmLegs.map(l => l.name))).includes('Josh'));
});

test('Rules differ for AFL and NRL', async ({ page }) => {
  await page.evaluate(() => setActiveTab('tipping')); await page.waitForTimeout(600);
  await page.click('#tippingRulesBtn');
  let t = await text(page, '#tippingRulesBody');
  assert.ok(t.includes('AFL home-and-away') && t.includes('opening bounce') && !t.includes('State of Origin'));
  await page.evaluate(() => document.getElementById('tippingRulesModal').classList.remove('open'));
  await page.click('#tab-tipping .tip-sport-btn[data-tipsport="nrl"]'); await page.waitForTimeout(800);
  await page.click('#tippingRulesBtn');
  t = await text(page, '#tippingRulesBody');
  assert.ok(t.includes('NRL regular season') && t.includes('State of Origin') && t.includes('kick-off'));
  assert.ok(!t.includes('Only people who have paid') && t.includes('no entry fee, no prize pot'));
  assert.match(await text(page, '#tippingRulesTitle'), /NRL/);
  await page.evaluate(() => document.getElementById('tippingRulesModal').classList.remove('open'));
  await page.click('#tab-tipping .tip-sport-btn[data-tipsport="efl"]'); await page.waitForTimeout(800);
  await page.click('#tippingRulesBtn');
  t = await text(page, '#tippingRulesBody');
  assert.ok(t.includes('46 matchweeks') && t.includes('Tip a Draw') && t.includes('no entry fee, no prize pot'));
  assert.match(await text(page, '#tippingRulesTitle'), /EFL/);
  await page.evaluate(() => document.getElementById('tippingRulesModal').classList.remove('open'));
  await page.click('#tab-tipping .tip-sport-btn[data-tipsport="afl"]'); await page.waitForTimeout(800);
  await page.click('#tippingRulesBtn');
  t = await text(page, '#tippingRulesBody');
  assert.ok(t.includes('Only people who have paid') && t.includes('AFL is the only comp with a prize pot'));
});


const ladderFx = () => { const t = Date.now() - 7 * 86400e3, st = (ms) => new Date(ms + 11 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
  return { t, st }; };
const ladderGames = (idf) => () => { const { t, st } = ladderFx();
  const g = (id, h, a, hs, as, off) => ({ id, round: 1, roundname: 'Round 1', date: st(t + off), unixtime: Math.floor((t + off) / 1000), venue: 'V', hteam: h, ateam: a, hscore: hs, ascore: as, complete: 100, winner: hs > as ? h : a, margin: Math.abs(hs - as) });
  return { year: Number(st(t).slice(0, 4)), games: [g(idf(1), 'Storm', 'Eels', 20, 10, 0), g(idf(2), 'Broncos', 'Roosters', 6, 18, 7200e3)] }; };
const ladderDb = (root, dues, idf) => (db) => { const yr = Number(new Date(Date.now() - 7 * 86400e3 + 11 * 3600e3).toISOString().slice(0, 4));
  db[root] = { config: { year: yr }, picks: {
    [idf(1)]: { uA: { pick: 'home', name: 'Ann' }, uB: { pick: 'home', name: 'Bob' }, uC: { pick: 'away', name: 'Cat' } },
    [idf(2)]: { uA: { pick: 'away', name: 'Ann' }, uB: { pick: 'home', name: 'Bob' }, uC: { pick: 'home', name: 'Cat' } } } };
  db[dues] = { uB: { name: 'Bob', commitment: 50, owed: 0 }, uC: { name: 'Cat', commitment: 50, owed: 0 } }; };

test('AFL ladder shows everyone but only paid entrants take the prize places', async ({ page }) => {
  await page.evaluate(() => setActiveTab('tipping')); await page.waitForTimeout(600);
  await page.click('#tab-tipping .subnav-btn[data-tipsub="ladder"]'); await page.waitForTimeout(3500);
  const t = await text(page, '#tippingLadderArea');
  assert.ok(/Ann/.test(t) && /Bob/.test(t) && /Cat/.test(t), 'everyone should be on the ladder: ' + t);
  assert.ok(t.indexOf('Ann') < t.indexOf('Bob'), 'Ann (unpaid) leads the ladder on points');
  assert.match(t, /Bob\s*💰 1st/); assert.match(t, /Cat\s*💰 2nd/); assert.ok(!/Ann\s*💰/.test(t), 'unpaid Ann must not carry a prize badge');
}, { fns: { 'afl-fixtures': ladderGames((n) => 9100 + n) }, db: ladderDb('tipping', 'tippingDues', (n) => 9100 + n) });

test('NRL is free: ladder has no prize badges, pot or fee panels', async ({ page }) => {
  await page.evaluate(() => setActiveTab('tipping')); await page.waitForTimeout(600);
  await page.click('#tab-tipping .tip-sport-btn[data-tipsport="nrl"]'); await page.waitForTimeout(1500);
  await page.click('#tab-tipping .subnav-btn[data-tipsub="ladder"]'); await page.waitForTimeout(3500);
  const t = await text(page, '#tippingLadderArea');
  assert.ok(/Ann/.test(t) && /Bob/.test(t) && /Cat/.test(t), 'everyone should be on the ladder: ' + t);
  assert.ok(!t.includes('💰'), 'free comp must show no prize badge: ' + t);
  assert.ok(await page.evaluate(() => document.body.classList.contains('tip-free')));
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('[data-tip-prize]')].filter(e => e.offsetParent !== null).length), 0, 'no prize element may be visible');
}, { fns: { 'nrl-fixtures': ladderGames((n) => 'n-g' + n) }, db: ladderDb('tippingNrl', 'tippingDuesNrl', (n) => 'n-g' + n) });

test('EFL tipping: third comp loads with Matchweek wording and saves under /tippingEfl', async ({ page, db }) => {
  await page.evaluate(() => setActiveTab('tipping')); await page.waitForTimeout(800);
  await page.click('#tab-tipping .tip-sport-btn[data-tipsport="efl"]'); await page.waitForTimeout(2500);
  assert.match(await text(page, '#tippingRoundHeading'), /EFL Tipping — Matchweek 1/);
  await page.click('#tipEntryBar [data-tipjoin="efl"]'); await page.waitForTimeout(2500);
  assert.equal(db.tippingComps.adminUid.efl, true);
  await page.evaluate(() => { document.querySelectorAll('.tip-game').forEach(g => g.querySelector('.tip-pick-btn[data-pick="home"]').click()); const m = document.querySelector('.tip-margin-input'); m.value = '1'; m.dispatchEvent(new Event('input')); });
  await page.click('#tipSaveAllBtn'); await page.waitForTimeout(2500);
  assert.equal(Object.keys(((db.tippingEfl || {}).picks) || {}).length, 2, JSON.stringify(db.tippingEfl));
  assert.equal(Object.keys(((db.tipping || {}).picks) || {}).length, 0);
}, { fns: { 'efl-fixtures': () => { const g = nrlGames(); g.games.forEach((x, i) => { x.id = 'e-' + (100 + i); x.roundname = 'Matchweek 1'; x.hteam = ['Leeds', 'Norwich'][i]; x.ateam = ['Hull', 'Derby'][i]; }); return g; } },
  db: (db) => { db.tipping = { config: { year: 2027 } }; db.tippingEfl = { config: { year: Number(new Date(Date.now() + 3 * 86400e3 + 11 * 3600e3).toISOString().slice(0, 4)) } }; } });

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
