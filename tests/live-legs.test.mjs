// tests/live-legs.test.mjs
// Checks the live-legs rules without any network: matching a leg to its
// game, judging head to head / line / total legs from the score, and the
// push alerts (once per leg, never after the admin has marked it, and no
// repeat of the admin's own result alert).
//   node tests/live-legs.test.mjs
import assert from 'assert/strict';
import { namesFor, matchLeg, judge, leagueOf, sideOf } from '../netlify/functions/lib/live-match.mjs';
import { runLiveLegs } from '../netlify/functions/live-legs-scheduled.mjs';

let failed = 0;
const test = async (name, fn) => { try{ await fn(); console.log(`  ok    ${name}`); }catch(e){ failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); } };

const NOW = Date.parse('2027-04-10T09:00:00Z');
const afl = (id, home, away, hs, as, state, start = NOW) => ({ id: `afl:${id}`, league: 'afl', home, away, homeNames: namesFor(home), awayNames: namesFor(away), hs, as, state, clock: state === 'live' ? 'Q3 12:04' : state === 'final' ? 'Full time' : '', start });
const nrl = (id, h, a, hs, as, state) => ({ id: `nrl:${id}`, league: 'nrl', home: h[1], away: a[1], homeNames: namesFor(...h), awayNames: namesFor(...a), hs, as, state, clock: '', start: NOW });

const GAMES = [
  afl(1, 'Melbourne', 'Collingwood', 62, 58, 'live'),
  afl(2, 'North Melbourne', 'Carlton', 40, 81, 'final'),
  afl(3, 'Greater Western Sydney', 'Western Bulldogs', 70, 71, 'live'),
  afl(4, 'Brisbane Lions', 'Geelong', null, null, 'pre'),
  nrl(5, ['Penrith Panthers', 'Panthers', 'Panthers', 'Penrith'], ['Brisbane Broncos', 'Broncos', 'Broncos', 'Brisbane'], 18, 12, 'final'),
];

await test('North Melbourne never matches Melbourne', async () => {
  const m = matchLeg({ sel: 'North Melbourne', team: 'North Melbourne', event: 'North Melbourne v Carlton', league: 'afl' }, GAMES, NOW);
  assert.equal(m.game.id, 'afl:2'); assert.equal(m.side, 'home');
  const m2 = matchLeg({ sel: 'Melbourne', team: 'Melbourne', event: 'Melbourne v Collingwood', league: 'afl' }, GAMES, NOW);
  assert.equal(m2.game.id, 'afl:1'); assert.equal(m2.side, 'home');
});

await test('Nicknames and bookie names match', async () => {
  assert.equal(matchLeg({ sel: 'GWS Giants -3.5', team: 'GWS', league: 'afl' }, GAMES, NOW).game.id, 'afl:3');
  assert.equal(matchLeg({ sel: 'Dogs', event: 'Giants v Bulldogs', league: 'afl' }, GAMES, NOW).side, 'away');
  assert.equal(matchLeg({ sel: 'Panthers', event: 'Panthers v Broncos', league: 'nrl' }, GAMES, NOW).game.id, 'nrl:5');
  assert.equal(matchLeg({ sel: 'Brisbane', team: 'Brisbane Lions', league: 'afl' }, GAMES, NOW).game.id, 'afl:4');
});

await test('Wrong league or unknown teams do not match', async () => {
  assert.equal(matchLeg({ sel: 'Broncos', team: 'Broncos', league: 'afl' }, GAMES, NOW), null);
  assert.equal(matchLeg({ sel: 'Fremantle', team: 'Fremantle', event: 'Fremantle v Richmond', league: 'afl' }, GAMES, NOW), null);
  assert.equal(sideOf({ sel: 'Over 165.5', event: 'Melbourne v Collingwood' }, GAMES[0]), null);
});

await test('Racing and tennis are not tracked', async () => {
  assert.equal(leagueOf({ sport: 'Horse racing', sel: 'Winx' }), null);
  assert.equal(leagueOf({ sport: 'AFL' }), 'afl');
  assert.equal(leagueOf({ sport: 'Rugby league' }), 'nrl');
  assert.equal(leagueOf({ sel: 'Nick Daicos 30+ disposals' }), 'afl');
});

await test('Head to head: winning live, settled at full time, no call on a draw', async () => {
  const live = judge({ sel: 'Melbourne', kind: 'head_to_head' }, GAMES[0], 'home');
  assert.equal(live.verdict, 'winning'); assert.equal(live.suggest, null); assert.equal(live.note, 'Up by 4');
  assert.equal(judge({ sel: 'North Melbourne', kind: 'head_to_head' }, GAMES[1], 'home').suggest, 'Loss');
  assert.equal(judge({ sel: 'Carlton', kind: 'head_to_head' }, GAMES[1], 'away').suggest, 'Win');
  assert.equal(judge({ sel: 'X', kind: 'head_to_head' }, { ...GAMES[1], hs: 50, as: 50 }, 'home').suggest, null);
  assert.equal(judge({ sel: 'Brisbane', kind: 'head_to_head' }, GAMES[3], 'home').verdict, null);
});

await test('Line: covering with the start, settled at full time', async () => {
  const j = judge({ sel: 'North Melbourne +39.5', kind: 'line' }, GAMES[1], 'home');
  assert.equal(j.suggest, 'Loss'); assert.match(j.note, /Short with the \+39\.5 by 1\.5/);
  assert.equal(judge({ sel: 'North Melbourne +44.5', kind: 'line' }, GAMES[1], 'home').suggest, 'Win');
  assert.equal(judge({ sel: 'Collingwood +6.5' }, GAMES[0], 'away').verdict, 'winning');
});

await test('Totals: an over lands the moment it passes, an under at full time', async () => {
  assert.equal(judge({ sel: 'Over 115.5', kind: 'total' }, GAMES[0], null).suggest, 'Win');
  assert.equal(judge({ sel: 'Over 165.5', kind: 'total' }, GAMES[0], null).suggest, null);
  assert.equal(judge({ sel: 'Under 115.5', kind: 'total' }, GAMES[0], null).suggest, 'Loss');
  assert.equal(judge({ sel: 'Under 125.5', kind: 'total' }, GAMES[1], null).suggest, 'Win');
  assert.equal(judge({ sel: 'Player 30+ disposals', kind: 'player' }, GAMES[0], 'home').verdict, null);
});

// ---------- the scheduled run ----------
function fakeDb(state, extra = {}){
  const data = { state, ...extra };
  const get = (p) => p.split('/').filter(Boolean).reduce((o, k) => o == null ? undefined : o[k], data);
  return {
    data,
    get: async (p) => { const v = get(p); return v === undefined ? null : JSON.parse(JSON.stringify(v)); },
    put: async (p, v) => { const ks = p.split('/').filter(Boolean); let o = data; for(const k of ks.slice(0, -1)){ o[k] = o[k] || {}; o = o[k]; } if(v === null) delete o[ks.at(-1)]; else o[ks.at(-1)] = v; },
  };
}
const feeds = (games) => ({ afl: async () => games.filter(g => g.league === 'afl'), espn: async (lg) => games.filter(g => g.league === lg) });
const draftState = () => ({
  weekLabelDraft: 'Week 5',
  groupEntryDraft: {
    Billy: { odds: 1.8, pick: { sel: 'Carlton', team: 'Carlton', event: 'North Melbourne v Carlton', sport: 'AFL', kind: 'head_to_head' } },
    Zak: { odds: 1.5, pick: { sel: 'Panthers -4.5', team: 'Panthers', event: 'Panthers v Broncos', sport: 'NRL', kind: 'line' } },
    Murph: { odds: 1.9, pick: { sel: 'Melbourne', team: 'Melbourne', event: 'Melbourne v Collingwood', sport: 'AFL', kind: 'head_to_head' } },
    Josh: { odds: 3.2, pick: { sel: 'Winx', sport: 'Horse racing', kind: 'racing' } },
  },
});

await test('A run writes every leg and alerts once per settled leg', async () => {
  const db = fakeDb(draftState()); const pushes = [];
  const r = await runLiveLegs({ db, feeds: feeds(GAMES), push: async (t, b) => { pushes.push({ t, b }); return 3; }, now: NOW });
  const L = db.data.liveLegs;
  assert.equal(L.week, 'Week 5'); assert.equal(L.live, true);
  assert.equal(L.legs.Billy.suggest, 'Win'); assert.equal(L.legs.Zak.suggest, 'Win');
  assert.equal(L.legs.Murph.verdict, 'winning'); assert.equal(L.legs.Murph.state, 'live');
  assert.equal(L.legs.Josh.tracked, false);
  assert.equal(r.alerts, 2); assert.equal(pushes.length, 2);
  assert.match(pushes[0].t, /Billy's leg got up/); assert.match(pushes[0].b, /multi alive, 2 to go/);
  assert.equal(db.data.pushMultiNotified['Week 5_Billy'], 'Win', 'admin alert key not marked');
  const again = await runLiveLegs({ db, feeds: feeds(GAMES), push: async () => { pushes.push(1); return 1; }, now: NOW });
  assert.equal(again.alerts, 0); assert.equal(pushes.length, 2, 'alerted twice');
});

await test('No alert for a leg the admin already marked; one "that\'s the multi" on a loss', async () => {
  const st = draftState(); st.groupEntryDraft.Billy.result = 'Win';
  st.groupEntryDraft.Zak.pick.sel = 'Panthers -10.5';
  const db = fakeDb(st); const pushes = [];
  await runLiveLegs({ db, feeds: feeds(GAMES), push: async (t, b) => { pushes.push({ t, b }); return 1; }, now: NOW });
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].t, /Zak's leg went down/); assert.match(pushes[0].b, /that’s the multi/);
  // Murph's game finishes and he wins: nobody is pinged about a dead multi
  const later = GAMES.map(g => g.id === 'afl:1' ? { ...g, state: 'final' } : g);
  await runLiveLegs({ db, feeds: feeds(later), push: async (t, b) => { pushes.push({ t, b }); return 1; }, now: NOW });
  assert.equal(pushes.length, 1);
  assert.equal(db.data.liveLegs.legs.Murph.suggest, 'Win', 'suggestion should still be shown');
});

await test('A cleared multi clears the live board', async () => {
  const st = draftState(); st.groupMultiCleared = true;
  const db = fakeDb(st, { liveLegs: { legs: { a: 1 } } });
  await runLiveLegs({ db, feeds: feeds(GAMES), push: async () => 0, now: NOW });
  assert.equal(db.data.liveLegs, undefined);
});

await test('A feed that is down still writes the other legs', async () => {
  const db = fakeDb(draftState());
  const r = await runLiveLegs({ db, feeds: { afl: async () => { throw new Error('Squiggle 503'); }, espn: feeds(GAMES).espn }, push: async () => 0, now: NOW });
  assert.deepEqual(r.errors, ['Squiggle 503']);
  assert.equal(db.data.liveLegs.legs.Zak.suggest, 'Win'); assert.equal(db.data.liveLegs.legs.Billy.tracked, false);
});

await test('Quiet spell: no feed calls while nothing is on, back on once a game nears', async () => {
  const st = draftState(); delete st.groupEntryDraft.Billy; delete st.groupEntryDraft.Zak; delete st.groupEntryDraft.Josh;
  const later = [afl(1, 'Melbourne', 'Collingwood', null, null, 'pre', NOW + 5 * 3600e3)];
  const db = fakeDb(st); let calls = 0;
  const f = { afl: async () => { calls++; return later; }, espn: async () => [] };
  await runLiveLegs({ db, feeds: f, push: async () => 0, now: NOW });
  await runLiveLegs({ db, feeds: f, push: async () => 0, now: NOW + 3 * 60000 });
  assert.equal(calls, 1, 'fetched during a quiet spell');
  await runLiveLegs({ db, feeds: f, push: async () => 0, now: NOW + 16 * 60000 });
  assert.equal(calls, 2, 'did not look again after 15 minutes');
  st.groupEntryDraft.Murph.pick.sel = 'Collingwood'; db.data.state = st;
  await runLiveLegs({ db, feeds: f, push: async () => 0, now: NOW + 17 * 60000 });
  assert.equal(calls, 3, 'a changed leg should be looked up straight away');
});

console.log(failed ? `\n${failed} failed` : '\nAll live-legs tests passed');
process.exit(failed ? 1 : 0);
