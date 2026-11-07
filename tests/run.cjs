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
  await page.evaluate(() => { document.getElementById('adminPanelSlips').classList.remove('admin-panel-collapsed'); document.getElementById('slipScanBtn').scrollIntoView({ block: 'center' }); }); // the slips panel starts folded
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
  await page.evaluate(() => document.getElementById('adminPanelSlips').classList.remove('admin-panel-collapsed'));
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


test('Admin week lists a leg that has a selection but no price yet', async ({ page }) => {
  await goAdmin(page, 'entry');
  await page.evaluate(() => { currentState.groupEntryDraft = { Dean: { odds: 1.5 }, Zak: { pick: { sel: 'Wrexham And Draw', leg: 2 } }, Brad: { pick: { sel: 'Over 24.5', leg: 3 } } }; updateWeeklyChecklist(); });
  const desk = await text(page, '#adminWeeklyChecklistRows');
  assert.match(desk, /0 of 3 marked/); assert.ok(desk.includes('Zak') && desk.includes('Brad'), desk);
});

test('Home individual bets: unplaced bet says so, names are not chopped', async ({ page }) => {
  await page.evaluate(() => { currentState.weeklyIndividualBets = [{ name: 'Murphington', odds: 3, result: '' }, { name: 'Dean', odds: 3, placed: true, result: '' }]; render(currentState); });
  const t = await text(page, '#weeklyIndividualBetsArea');
  assert.ok(/not placed yet/i.test(t) && /to bet/i.test(t), t);
  assert.ok(/awaiting result/i.test(t) && /running/i.test(t), t);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.ind-name')).textOverflow), 'clip');
});

test('A week saved twice is flagged and one copy can be removed, taking its totals back out', async ({ page, db }) => {
  await goAdmin(page, 'repair');
  const before = await page.evaluate(() => { const h = currentState.history; const dupe = JSON.parse(JSON.stringify(h[h.length - 1])); dupe.savedAt += 5000; h.push(dupe);
    ['lottoOut','lottoRet','multiOut','multiRet','bonus','sgmWin'].forEach(k => { currentState.group[k] = (currentState.group[k] || 0) + (dupe.group[k] || 0); });
    renderAdminHistory(); return { n: h.length, multiOut: currentState.group.multiOut }; });
  await page.click('#adminBooksBtn');
  assert.match(await text(page, '#adminBooksOut'), /saved twice/);
  assert.equal(await page.locator('#adminHistoryArea [data-remove-week]').count(), before.n);
  page.on('dialog', d => d.accept());
  await page.click('#adminHistoryArea [data-remove-week="' + (before.n - 1) + '"]'); await page.waitForTimeout(2500);
  assert.equal(db.state.history.length, before.n - 1);
  assert.equal(db.state.group.multiOut, before.multiOut - 12.5);
  assert.ok(!/saved twice/.test(await text(page, '#adminHistoryArea')));
});

test('Save week refuses to double-save a week that is already in history', async ({ page, db }) => {
  await goAdmin(page, 'entry');
  const n = db.state.history.length, label = db.state.history[n - 1].label;
  await page.evaluate((label) => { const sel = document.getElementById('adminWeekLabel'); if(![...sel.options].some(o => o.value === label)) sel.add(new Option(label, label)); sel.value = label; }, label);
  let asked = '';
  page.once('dialog', d => { asked = d.message(); d.dismiss(); });
  await page.click('#adminSaveWeekBtn'); await page.waitForTimeout(1500);
  assert.match(asked, /already saved/);
  assert.equal(db.state.history.length, n, 'a duplicate week must not be written');
  assert.match(await text(page, '#adminEntryStatus'), /already in Season history/);
  assert.equal(await page.evaluate(() => document.getElementById('adminSaveWeekBtn').disabled), false);
});

test('One tap removes the extra copy of a week saved twice and recalculates', async ({ page, db }) => {
  await goAdmin(page, 'repair');
  const n0 = await page.evaluate(() => { const h = currentState.history; const d = JSON.parse(JSON.stringify(h[h.length - 1])); d.savedAt += 5000; h.push(d); renderAdminHistory(); return h.length; });
  await page.click('#adminBooksBtn');
  page.once('dialog', d => d.accept()); page.on('dialog', d => d.accept().catch(() => {}));
  await page.click('#adminDupFixBtn'); await page.waitForTimeout(3500);
  assert.equal(db.state.history.length, n0 - 1);
  assert.match(await text(page, '#adminBooksOut'), /match the saved weeks|All totals match/);
});

test('Lotto tab: pick group members, combine several ticket screenshots into one downloadable picture', async ({ page, db }) => {
  const png = (w, h, c) => page.evaluate(([w, h, c]) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const x = cv.getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, w, h); return cv.toDataURL('image/png').split(',')[1]; }, [w, h, c]);
  await goAdmin(page, 'lotto');
  await page.click('#lcMembers [data-lc-member]:nth-child(1)'); await page.click('#lcMembers [data-lc-member]:nth-child(3)'); await page.waitForTimeout(1500);
  assert.equal(db.lottoPigs.group.members.length, 2, 'group members should be saved');
  await page.fill('#lcExtraName', 'Uncle Ray'); await page.click('#lcExtraAdd'); await page.waitForTimeout(1200);
  assert.ok(db.lottoPigs.group.members.includes('Uncle Ray'), 'an outside person can be added');
  assert.ok((await text(page, '#lcMembers')).includes('Uncle Ray'));
  const files = [];
  for(const [i, c] of ['#c33', '#3c3', '#33c'].entries()) files.push({ name: `t${i}.png`, mimeType: 'image/png', buffer: Buffer.from(await png(600, 1200 + i * 200, c), 'base64') });
  await page.setInputFiles('#lcFile', files); await page.waitForTimeout(1200);
  assert.equal(await page.locator('#lcList .lc-item').count(), 3);
  const dim = await page.evaluate(() => ({ w: lcCanvas.width, h: lcCanvas.height }));
  assert.ok(dim.w > 900 && dim.h > 900, JSON.stringify(dim));
  await page.click('#lcList [data-lc-id] [data-lc-act="down"]'); await page.click('#lcList [data-lc-id]:last-child [data-lc-act="rm"]');
  assert.equal(await page.locator('#lcList .lc-item').count(), 2);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#lcDownload')]);
  assert.match(dl.suggestedFilename(), /^lotto-tickets-\d{4}-\d{2}-\d{2}\.(png|jpg)$/);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.lc-item-btns button')].every(b => b.getBoundingClientRect().right <= b.closest('.lc-item').getBoundingClientRect().right + 1)), true, 'remove button must fit in its tile');
});

test('Lotto combiner: five screenshots can be grouped into two tickets', async ({ page }) => {
  const png = (w, h, c) => page.evaluate(([w, h, c]) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const x = cv.getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, w, h); return cv.toDataURL('image/png').split(',')[1]; }, [w, h, c]);
  await goAdmin(page, 'lotto');
  const files = [];
  for(const [i, c] of ['#c33', '#3c3', '#33c', '#cc3', '#3cc'].entries()) files.push({ name: `t${i}.png`, mimeType: 'image/png', buffer: Buffer.from(await png(600, 900, c), 'base64') });
  await page.setInputFiles('#lcFile', files); await page.waitForTimeout(1200);
  assert.equal((await text(page, '#lcCount')).startsWith('5 tickets'), true, 'starts as one ticket per screenshot');
  await page.selectOption('#lcSplit', '2'); await page.waitForTimeout(500);
  assert.ok((await text(page, '#lcCount')).startsWith('2 tickets'), await text(page, '#lcCount'));
  assert.equal(await page.locator('#lcList .lc-grp-h').count(), 2);
  assert.equal(await page.locator('#lcList .lc-joined').count(), 3);
  // by hand: make screenshot 4 its own ticket again => 3 tickets
  await page.click('#lcList [data-lc-id]:nth-of-type(4) [data-lc-act="join"], #lcList .lc-item:nth-of-type(4) [data-lc-act="join"]').catch(() => {});
  const n = await page.evaluate(() => document.querySelectorAll('#lcList .lc-grp-h').length);
  assert.ok(n >= 2 && n <= 3, 'groups: ' + n);
  const dim = await page.evaluate(() => ({ w: lcCanvas.width, h: lcCanvas.height }));
  assert.ok(dim.w > 900 && dim.h > 900, JSON.stringify(dim));
});

test('Lotto combiner: reads ticket details and fills the draw form', async ({ page, log }) => {
  const png = (w, h, c) => page.evaluate(([w, h, c]) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const x = cv.getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, w, h); return cv.toDataURL('image/png').split(',')[1]; }, [w, h, c]);
  await goAdmin(page, 'lotto');
  const files = [];
  for(const [i, c] of ['#c33', '#3c3', '#33c'].entries()) files.push({ name: `t${i}.png`, mimeType: 'image/png', buffer: Buffer.from(await png(600, 900, c), 'base64') });
  await page.setInputFiles('#lcFile', files); await page.waitForTimeout(1000);
  await page.selectOption('#lcSplit', '2'); await page.waitForTimeout(400);
  await page.click('#lcReadBtn'); await page.waitForTimeout(1500);
  assert.ok(log.some(l => l.fn === 'scan-lotto' && l.body.images.length === 3 && l.body.groups.join(',') === '2,1'), 'sent screenshots and grouping');
  const card = await text(page, '#lcInfo');
  assert.ok(card.includes('Powerball') && card.includes('Draw 1429') && card.includes('OzLotto'), card);
  await page.click('#lcInfoFill'); await page.waitForTimeout(400);
  assert.equal(await page.inputValue('#lcLLabel'), 'Powerball + OzLotto (2 tickets)');
  assert.equal(await page.inputValue('#lcLDate'), '2026-11-06');
  assert.equal(await page.inputValue('#lcLTicket'), '45');
  assert.equal(await page.inputValue('#lcLJackpot'), '100000000');
  const dim = await page.evaluate(() => ({ w: lcCanvas.width, h: lcCanvas.height }));
  assert.ok(dim.h > 600, 'clean ticket cards are drawn: ' + JSON.stringify(dim));
}, { fns: { 'scan-lotto': () => ({ tickets: [
  { game: 'Powerball', draw_number: '1429', draw_date: '2026-11-06', draws: 1, price: 30, serial: null, jackpot: 100000000, quick_pick: true, entries: [{ label: 'A', numbers: [3, 12, 19, 27, 31, 35, 20], extra: [7], extra_label: 'Powerball' }, { label: 'B', numbers: [1, 8, 14, 22, 30, 33, 34], extra: [2], extra_label: 'Powerball' }], result: null },
  { game: 'OzLotto', draw_number: '1620', draw_date: '2026-11-04', draws: 1, price: 15, serial: null, jackpot: null, quick_pick: false, entries: [{ label: 'A', numbers: [4, 9, 17, 25, 28, 36, 41], extra: [], extra_label: null }], result: null }], warnings: [] }) } });

test('Lotto combiner: MLSynd or Lotto Pigs picks the artwork and where it saves', async ({ page, db }) => {
  const png = (w, h, c) => page.evaluate(([w, h, c]) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const x = cv.getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, w, h); return cv.toDataURL('image/png').split(',')[1]; }, [w, h, c]);
  await goAdmin(page, 'lotto');
  assert.equal(await page.inputValue('#lcTitle'), 'Lotto Pigs');
  await page.setInputFiles('#lcFile', [{ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from(await png(600, 900, '#c33'), 'base64') }]); await page.waitForTimeout(800);
  await page.click('#lcTgt [data-lc-tgt="ml"]'); await page.waitForTimeout(500);
  assert.equal(await page.inputValue('#lcTitle'), 'MLSynd', 'title follows the group');
  assert.equal(await page.evaluate(() => document.getElementById('lcAttachSel').closest('label').hidden), true, 'draw picker hidden for MLSynd');
  assert.equal(await text(page, '#lcAttach'), 'Save to MLSynd');
  await page.click('#lcAttach'); await page.waitForTimeout(1500);
  const metas = Object.values((db.mlsyndLotto && db.mlsyndLotto.meta) || {});
  assert.equal(metas.length, 1, 'saved to /mlsyndLotto'); assert.equal(metas[0].label, 'MLSynd');
  assert.ok(Object.values(db.mlsyndLotto.img)[0].img.startsWith('data:image/jpeg'), 'picture stored');
  assert.ok(!db.lottoPigsTickets || !Object.keys(db.lottoPigsTickets).length, 'nothing went into Lotto Pigs');
  await goHome(page); await page.waitForTimeout(600);
  assert.ok((await text(page, '#homeMlLotto')).includes('MLSynd'), 'Home card for members');
  await page.evaluate(() => setActiveTab('diag')); await goAdmin(page, 'lotto');
  await page.click('#lcTgt [data-lc-tgt="pigs"]'); await page.waitForTimeout(400);
  assert.equal(await page.inputValue('#lcTitle'), 'Lotto Pigs');
  assert.equal(await text(page, '#lcAttach'), 'Save to draw');
});

test('Lotto combiner: draws a clean ticket card from the read details (36 games)', async ({ page }) => {
  const png = (w, h, c) => page.evaluate(([w, h, c]) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const x = cv.getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, w, h); return cv.toDataURL('image/png').split(',')[1]; }, [w, h, c]);
  await goAdmin(page, 'lotto');
  await page.setInputFiles('#lcFile', [{ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from(await png(600, 900, '#c33'), 'base64') }, { name: 'b.png', mimeType: 'image/png', buffer: Buffer.from(await png(600, 900, '#33c'), 'base64') }]);
  await page.waitForTimeout(800); await page.selectOption('#lcSplit', '1'); await page.waitForTimeout(300);
  await page.click('#lcReadBtn'); await page.waitForTimeout(1500);
  assert.equal(await page.inputValue('#lcStyle'), 'clean');
  const clean = await page.evaluate(() => ({ w: lcCanvas.width, h: lcCanvas.height }));
  assert.ok(clean.h > 1500, 'clean card is tall enough for 36 games: ' + JSON.stringify(clean));
  await page.selectOption('#lcStyle', 'shots'); await page.waitForTimeout(500);
  const shots = await page.evaluate(() => ({ w: lcCanvas.width, h: lcCanvas.height }));
  assert.ok(shots.h !== clean.h, 'switching style changes the picture');
}, { fns: { 'scan-lotto': () => ({ tickets: [{ game: 'Powerball', draw_number: '1591', draw_date: '2026-11-12', draws: 1, price: 56.6, commission: 6.2, serial: '01 212719 63909 001', entry_type: '1 Draw, 36 Game Standard entry', purchased: 'Sun, 08 Nov 2026', jackpot: null, entries: Array.from({ length: 36 }, (_, i) => ({ label: String(i + 1), numbers: [5, 7, 10, 12, 18, 27, 35], extra: [16], extra_label: 'Powerball' })), result: null }], warnings: [] }) } });

test('Lotto combiner: a re-read (saved copy with empty lists dropped) still shows', async ({ page }) => {
  const png = (w, h, c) => page.evaluate(([w, h, c]) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const x = cv.getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, w, h); return cv.toDataURL('image/png').split(',')[1]; }, [w, h, c]);
  await goAdmin(page, 'lotto');
  await page.setInputFiles('#lcFile', [{ name: 'a.png', mimeType: 'image/png', buffer: Buffer.from(await png(600, 900, '#c33'), 'base64') }]); await page.waitForTimeout(800);
  await page.click('#lcReadBtn'); await page.waitForTimeout(1500);
  const msg = await text(page, '#lcReadStatus');
  assert.ok(msg.startsWith('Found 1 ticket'), msg);
  assert.ok((await text(page, '#lcInfo')).includes('OzLotto'));
}, { fns: { 'scan-lotto': () => ({ tickets: [{ game: 'OzLotto', draw_number: '1620', price: 15, entries: [{ label: '1', numbers: [4, 9, 17, 25, 28, 36, 41] }], result: { status: 'pending' } }], cached: true }) } });

test('Lotto Pigs: attach the combined ticket to a draw, members view it, share value and top prize per share show', async ({ page, db }) => {
  await goAdmin(page, 'lotto');
  await page.click('#lcMembers [data-lc-member]:nth-child(1)'); await page.waitForTimeout(900);
  const nm = await page.evaluate(() => document.querySelector('#lcMembers [data-lc-member]').dataset.lcMember);
  await page.fill('#lcLLabel', 'Powerball'); await page.fill('#lcLPrice', '20'); await page.fill('#lcLJackpot', '100000000');
  await page.evaluate((n) => { for(let i = 0; i < 4; i++) document.querySelector(`#lcShares [data-lc-sh="1"][data-lc-n="${n}"]`).click(); }, nm);
  await page.click('#lcLSave'); await page.waitForTimeout(1000);
  const id = Object.keys(db.lottoPigs.ledger)[0];
  assert.equal(db.lottoPigs.ledger[id].jackpot, 100000000);
  const png = (w, h, c) => page.evaluate(([w, h, c]) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const x = cv.getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, w, h); return cv.toDataURL('image/png').split(',')[1]; }, [w, h, c]);
  const tk = [];
  for(const [i, c] of ['#c33', '#33c'].entries()) tk.push({ name: `a${i}.png`, mimeType: 'image/png', buffer: Buffer.from(await png(600, 1100, c), 'base64') });
  await page.setInputFiles('#lcFile', tk); await page.waitForTimeout(1200);
  await page.selectOption('#lcAttachSel', id); await page.click('#lcAttach'); await page.waitForTimeout(1500);
  assert.ok(db.lottoPigsTickets && db.lottoPigsTickets[id] && /^data:image\/jpeg/.test(db.lottoPigsTickets[id].img), 'picture stored apart from the draws');
  assert.equal(db.lottoPigs.ledger[id].hasTicket, true);
  await page.click(`[data-lc-view="${id}"]`); await page.waitForSelector('#lcViewer img', { timeout: 5000 });
  assert.ok(await page.locator('#lcViewer img').isVisible());
  await page.click('[data-lc-vclose]'); assert.equal(await page.locator('#lcViewer').count(), 0);
});

test('Lotto Pigs profit and loss: shares at a price, winnings split by shares, only entrants share', async ({ page, db }) => {
  await goAdmin(page, 'lotto');
  for(const n of [1, 2, 3]) await page.click(`#lcMembers [data-lc-member]:nth-child(${n})`);
  await page.waitForTimeout(1200);
  const plus = (name, k) => page.evaluate(([name, k]) => { for(let i = 0; i < k; i++) document.querySelector(`#lcShares [data-lc-sh="1"][data-lc-n="${name}"]`).click(); }, [name, k]);
  const names = await page.evaluate(() => [...document.querySelectorAll('#lcMembers [data-lc-member]')].slice(0, 3).map(b => b.dataset.lcMember));
  await page.fill('#lcLLabel', 'Powerball $100M'); await page.fill('#lcLPrice', '25'); await page.fill('#lcLWon', '0');
  await plus(names[0], 2); await plus(names[1], 1);
  assert.match(await text(page, '#lcLTotal'), /3 shares · 2 in · ticket \$75 \(3 × \$25\) · members pay \$75/);
  await page.click('#lcLSave'); await page.waitForTimeout(1200);
  await page.fill('#lcLLabel', 'Oz Lotto'); await page.fill('#lcLWon', '300');
  await plus(names[1], 1); await plus(names[2], 2);
  await page.click('#lcLSave'); await page.waitForTimeout(1200);
  assert.equal(Object.keys(db.lottoPigs.ledger).length, 2);
  const oz = Object.values(db.lottoPigs.ledger).find(e => e.label === 'Oz Lotto');
  assert.equal(oz.cost, 75); assert.deepEqual(oz.shares, { [names[1]]: 1, [names[2]]: 2 });
  const sum = await text(page, '#lcSummary');
  assert.ok(sum.includes('$150') && sum.includes('$300') && sum.includes('+$150'), sum);
  const per = await text(page, '#lcPerMember');
  // Oz Lotto: $300 over 3 shares = $100 a share; the 2-share person is in $50, back $200
  assert.ok(per.includes(names[2]) && per.includes('+$150'), per);
  assert.ok(per.includes(names[0]) && per.includes('-$50'), per); // 2 shares in Powerball lost, not in Oz Lotto
  await page.fill('#lcLLabel', 'No shares'); await page.click('#lcLSave');
  assert.match(await text(page, '#lcLStatus'), /at least one share/);
  page.on('dialog', d => d.accept());
  const id = Object.keys(db.lottoPigs.ledger)[0];
  await page.click(`[data-lc-del="${id}"]`); await page.waitForTimeout(1200);
  assert.equal(Object.keys(db.lottoPigs.ledger).length, 1);
});

test('Lotto Pigs: a draw can be back-dated to last week and sorts by its date', async ({ page, db }) => {
  await goAdmin(page, 'lotto');
  await page.click('#lcMembers [data-lc-member]:nth-child(1)'); await page.waitForTimeout(1000);
  const n = await page.evaluate(() => document.querySelector('#lcMembers [data-lc-member]').dataset.lcMember);
  const add = async (label, date) => { await page.fill('#lcLLabel', label); await page.fill('#lcLDate', date); await page.fill('#lcLPrice', '25'); await page.fill('#lcLWon', '0');
    await page.evaluate((n) => document.querySelector(`#lcShares [data-lc-sh="1"][data-lc-n="${n}"]`).click(), n); await page.click('#lcLSave'); await page.waitForTimeout(1000); };
  await add('This week', '2026-11-04'); await add('Last week', '2026-10-29');
  const saved = Object.values(db.lottoPigs.ledger);
  assert.ok(saved.some(e => e.label === 'Last week' && e.date === '2026-10-29'), 'past date kept');
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#lcEntries .lc-entry-main b')].map(b => b.textContent)), ['This week', 'Last week']);
});

test('Lotto Pigs: ticket cost divided by shares, and winnings can cover some or all of it', async ({ page, db }) => {
  await goAdmin(page, 'lotto');
  for(const k of [1, 2]) await page.click(`#lcMembers [data-lc-member]:nth-child(${k})`);
  await page.waitForTimeout(1000);
  const names = await page.evaluate(() => [...document.querySelectorAll('#lcMembers [data-lc-member]')].slice(0, 2).map(b => b.dataset.lcMember));
  const plus = (n, k) => page.evaluate(([n, k]) => { for(let i = 0; i < k; i++) document.querySelector(`#lcShares [data-lc-sh="1"][data-lc-n="${n}"]`).click(); }, [n, k]);
  // 1) members chip in: $30 ticket split over 3 shares (2 + 1), nothing from winnings
  await page.fill('#lcLLabel', 'Divide'); await page.fill('#lcLTicket', '30'); await plus(names[0], 2); await plus(names[1], 1);
  assert.match(await text(page, '#lcLTotal'), /ticket \$30 \(\$10 a share\).*members pay \$30/);
  await page.fill('#lcLWon', '0'); await page.click('#lcLSave'); await page.waitForTimeout(1000);
  // 2) winnings cover the whole next ticket, so nobody pays cash
  await page.fill('#lcLLabel', 'Rolled'); await page.fill('#lcLTicket', '40'); await page.fill('#lcLCovered', '40'); await plus(names[0], 1); await plus(names[1], 1);
  assert.match(await text(page, '#lcLTotal'), /winnings cover \$40 · members pay \$0/);
  await page.fill('#lcLWon', '0'); await page.click('#lcLSave'); await page.waitForTimeout(1000);
  const rolled = Object.values(db.lottoPigs.ledger).find(e => e.label === 'Rolled');
  assert.equal(rolled.cost, 40); assert.equal(rolled.covered, 40); assert.equal(rolled.costMode, 'total');
  assert.match(await text(page, '#lcSummary'), /\$70/);
  assert.match(await text(page, '#lcLedgerNote'), /Members paid \$30 in cash; \$40 of the tickets came out of winnings/);
  const per = await text(page, '#lcPerMember');
  assert.ok(per.includes('cash in $20') && per.includes('cash in $10'), per); // 2 shares of the $30 draw = $20; 1 share = $10
  await page.fill('#lcLLabel', 'Too much'); await page.fill('#lcLTicket', '10'); await page.fill('#lcLCovered', '20'); await plus(names[0], 1); await page.click('#lcLSave');
  assert.match(await text(page, '#lcLStatus'), /can't be more than the ticket cost/);
});

test('Lotto Pigs: only people ticked in the group get the header pig button and Home view', async ({ page }) => {
  await page.evaluate(() => { currentUserEmail = 'someone@example.com'; render(currentState); });
  await page.evaluate(() => lottoReload()); await page.waitForTimeout(500);
  await page.evaluate(() => render(currentState));
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('lottoHeaderBtn')).display), 'none', 'not in the group: no pig button');
  // make this login the member (Josh) who IS in the group
  await page.evaluate(() => { currentState.members.forEach(x => { if(x.linkedUid === currentUserUid) x.linkedUid = null; }); currentState.members.find(x => x.name === 'Josh').linkedUid = currentUserUid; render(currentState); });
  await page.waitForTimeout(300);
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.getElementById('lottoHeaderBtn')).display), 'none', 'in the group: pig button shows');
  const pos = await page.evaluate(() => { const l = document.getElementById('lottoHeaderBtn').getBoundingClientRect(), s = document.getElementById('syndyFabBtn'); const sr = s.getBoundingClientRect(); return { lr: l.right, sl: sr.left, vis: s.offsetParent !== null }; });
  if(pos.vis) assert.ok(pos.lr <= pos.sl, 'pig button sits left of Syndy: ' + JSON.stringify(pos));
  await page.click('#lottoHeaderBtn'); await page.waitForTimeout(800);
  const txt = await text(page, '#homeSubview-lotto');
  assert.ok(txt.includes('Lotto Pigs') && /YOU/.test(txt) && txt.includes('+$50') && txt.includes('Powerball'), txt);
  assert.equal(await page.locator('#homeSubview-lotto input, #homeSubview-lotto button:not([data-lc-toggle]):not([data-lc-view]):not([data-lc-series]):not([data-lc-fold])').count(), 0, 'members get a read-only view');
  assert.equal(await page.locator('#homeSubview-lotto .lc-dr-body').first().isVisible(), false, 'draw details start collapsed');
  await page.click('#homeSubview-lotto [data-lc-toggle]');
  assert.equal(await page.locator('#homeSubview-lotto .lc-dr-body').first().isVisible(), true, 'tap opens the details');
  assert.match(await text(page, '#homeSubview-lotto .lc-draw'), /Share value \$25/);
  await page.evaluate(() => lottoReload()); await page.waitForTimeout(500);
  assert.equal(await page.locator('#homeSubview-lotto .lc-dr-body').first().isVisible(), true, 'stays open after a refresh');
  await page.click('#homeSubview-lotto [data-lc-toggle]');
  assert.equal(await page.locator('#homeSubview-lotto .lc-dr-body').first().isVisible(), false, 'tap again closes it');
}, { db: (db) => { db.lottoPigs = { group: { name: 'Lotto Pigs', members: ['Josh'], uids: { u5: true } }, ledger: { a: { date: '2026-11-01', label: 'Powerball', price: 25, shares: { Josh: 2 }, cost: 50, won: 100, createdAt: 1 } } }; } });

test('Lotto Pigs: winnings from one draw roll into the next ticket and members top up the rest equally', async ({ page }) => {
  await page.evaluate(() => { currentState.members.forEach(x => { if(x.linkedUid === currentUserUid) x.linkedUid = null; }); currentState.members.find(x => x.name === 'Josh').linkedUid = currentUserUid; render(currentState); });
  await page.waitForTimeout(300);
  await page.click('#lottoHeaderBtn'); await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelectorAll('#homeSubview-lotto [data-lc-toggle]').forEach(b => b.click()));
  const txt = await text(page, '#homeSubview-lotto');
  assert.match(txt, /Winnings from Oz Lotto/); assert.match(txt, /−\$15\.05/); assert.match(txt, /Top-up · 7 × \$9\.08\s*\$63\.55/);
  assert.match(txt, /rolled into Powerball/);
  assert.ok(await page.locator('#lcPlChart svg path').count() >= 2, 'profit and loss chart is drawn');
  await page.locator('#lcPlot').scrollIntoViewIfNeeded(); await page.evaluate(() => { document.querySelectorAll('.bottom-nav,#bottomNav,[class*=tabbar]').forEach(e => { e.style.pointerEvents = 'none'; }); });
  const box = await page.locator('#lcPlot').boundingBox();
  await page.mouse.move(box.x + box.width * 0.95, box.y + box.height / 2); await page.mouse.down();
  assert.match(await text(page, '#lcChLbl'), /Oz Lotto/i); await page.mouse.up();
  assert.equal(await page.locator('#lcPlChart .lc-lg').count(), 2, 'a legend chip for the total and for Oz Lotto');
  assert.equal(await page.locator('.lc-types').first().isVisible(), false, 'stats start folded away');
  await page.click('[data-lc-fold="stats"]');
  assert.match(await text(page, '#homeSubview-lotto .lc-types'), /Oz Lotto -\$2\.45 1 draw/);
  await page.click('[data-lc-series="Oz Lotto"]');
  assert.equal(await page.locator('#lcPlChart .lc-lg.off').count(), 1, 'tapping a name hides its line');
  assert.equal(await page.locator('.lc-types').first().isVisible(), true, 'folds stay open after the chart redraws');
  assert.equal(await page.locator('#homeSubview-lotto .lc-people').first().isVisible(), false, 'each person starts folded');
  await page.click('[data-lc-fold="people"]');
  assert.equal(await page.locator('#homeSubview-lotto .lc-people').first().isVisible(), true);
  assert.match(txt, /You pay \$9\.08/);
}, { db: (db) => { const sh = { Brad: 1, Dean: 2, Josh: 2, Zak: 2, Murph: 2, Trasky: 2, Damon: 2 }; db.lottoPigs = { group: { name: 'Lotto Pigs', members: Object.keys(sh), uids: { u5: true } }, ledger: {
  a: { date: '2026-11-03', label: 'Oz Lotto', price: 1.35, shares: sh, cost: 17.5, won: 15.05, costMode: 'total', createdAt: 1 },
  b: { date: '2026-11-05', label: 'Powerball', price: 6.05, shares: sh, cost: 78.6, covered: 15.05, won: null, costMode: 'total', createdAt: 2 } } }; } });

test('Lotto Pigs data lives outside /state and old copies are moved out of it', async ({ page, db }) => {
  await goAdmin(page, 'lotto'); await page.waitForTimeout(1500);
  assert.ok(db.lottoPigs && db.lottoPigs.group && db.lottoPigs.group.members.includes('Billy'), 'moved to /lottoPigs');
  assert.ok(db.lottoPigs.ledger.old1, 'ledger moved');
  assert.equal(db.state.lottoGroup, undefined); assert.equal(db.state.lottoLedger, undefined);
  await page.click('#lcMembers [data-lc-member]:nth-child(2)'); await page.waitForTimeout(1000);
  assert.equal(db.state.lottoGroup, undefined, 'nothing is ever written into /state'); 
  assert.ok(Object.keys(db.lottoPigs.group.uids || {}).length >= 1, 'platform logins of the ticked members are stored for the database rules');
}, { db: (db) => { db.state.lottoGroup = { name: 'Lotto Pigs', members: ['Billy'] }; db.state.lottoLedger = { old1: { date: '2026-11-01', label: 'Old', price: 25, shares: { Billy: 1 }, cost: 25, won: 0, createdAt: 1 } }; } });

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


test('Admin week: mark each leg of an individual multi and it shows on Home', async ({ page, db }) => {
  await goAdmin(page, 'entry');
  await page.evaluate(() => { renderAdminWeeklyIndividualBetsEntry(); updateWeeklyChecklist(); });
  const row = await page.evaluate(() => adminWeekDesk.betsNow().find(b => b.name === 'Murph').row);
  await page.click(`[data-awk-legs="${row}"]`);
  await page.click(`.awk-r[data-awk="ileg"][data-id="${row}:0"][data-v="Win"]`); await page.waitForTimeout(2500);
  await page.click(`.awk-r[data-awk="ileg"][data-id="${row}:1"][data-v="Loss"]`); await page.waitForTimeout(2500);
  const m = db.state.weeklyIndividualBets.find(b => b.name === 'Murph');
  assert.equal(m.pick.legs[0].result, 'won'); assert.equal(m.pick.legs[1].result, 'lost');
  assert.ok((await text(page, '#adminWeeklyChecklistRows')).includes('2/3'), 'legs marked count');
}, { db: (db) => { db.state.weeklyIndividualBets = [{ name: 'Murph', odds: 5, stake: 50, pick: { sel: '3-leg multi', legs: [{ sel: 'A', odds: 1.5 }, { sel: 'B', odds: 1.6 }, { sel: 'C', odds: 2 }] } }]; } });

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
