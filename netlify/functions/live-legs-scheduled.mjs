// netlify/functions/live-legs-scheduled.mjs (v225)
//
// Match-day tracking for the group multi. Every 3 minutes:
//   1. reads this week's legs (/state/groupEntryDraft)
//   2. finds each leg's game on the public score feeds
//      (Squiggle for AFL, ESPN for NRL, NFL, NBA, MLB, NHL and EPL)
//   3. writes how each leg is going to /liveLegs, which Home shows live
//   4. pushes an alert when a leg is settled on the scoreboard
//
// It never marks results. A finished leg gets a *suggested* result that the
// admin accepts in Admin → Week, so the ledger stays admin-confirmed.
//
// Alerts are sent once per leg (/liveLegsNotified) and also recorded under
// /pushMultiNotified with the same key the admin's own result alert uses,
// so when the admin confirms the same result nobody is pinged twice.
// Racing, tennis, cricket and player bets aren't tracked; those legs just
// show their game's score when one can be found.
//
// Uses the Firebase service account (FIREBASE_CLIENT_EMAIL /
// FIREBASE_PRIVATE_KEY) and the push keys the other alerts already use.

import { getFirebaseAccessToken } from './lib/firebase-token.mjs';
import { namesFor, matchLeg, leagueOf, judge } from './lib/live-match.mjs';

const FIREBASE_URL = 'https://mlsynd-default-rtdb.firebaseio.com';
const UA = 'MLSynd Dashboard live legs (private syndicate app; contact mlsynd00@gmail.com)';
const DAY = 86400000;
const ESPN = {
  nrl: 'rugby-league/3', nfl: 'football/nfl', nba: 'basketball/nba',
  mlb: 'baseball/mlb', nhl: 'hockey/nhl', epl: 'soccer/eng.1',
};
const safeKey = (s) => String(s || '').replace(/[.#$\[\]\/]/g, '_').slice(0, 120);

// ---------- score feeds ----------
const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
async function espnGames(league, now){
  const url = `https://site.api.espn.com/apis/site/v2/sports/${ESPN[league]}/scoreboard?dates=${ymd(now - 2 * DAY)}-${ymd(now + 5 * DAY)}&limit=200`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if(!res.ok) throw new Error(`ESPN ${league} ${res.status}`);
  const data = await res.json();
  return (data.events || []).map(ev => {
    const comp = (ev.competitions && ev.competitions[0]) || {};
    const cs = comp.competitors || [];
    const h = cs.find(c => c.homeAway === 'home') || {}, a = cs.find(c => c.homeAway === 'away') || {};
    const st = (ev.status && ev.status.type) || {};
    const tn = (c) => { const t = c.team || {}; return [t.displayName, t.shortDisplayName, t.name, t.location, t.nickname]; };
    return {
      id: `${league}:${ev.id}`, league,
      home: (h.team && h.team.shortDisplayName) || 'Home', away: (a.team && a.team.shortDisplayName) || 'Away',
      homeNames: namesFor(...tn(h)), awayNames: namesFor(...tn(a)),
      hs: h.score != null && st.state !== 'pre' ? Number(h.score) : null,
      as: a.score != null && st.state !== 'pre' ? Number(a.score) : null,
      state: st.completed ? 'final' : st.state === 'in' ? 'live' : 'pre',
      clock: st.shortDetail || st.detail || '',
      start: Date.parse(ev.date) || null,
    };
  });
}
async function aflGames(now, knownIds){
  const year = new Date(now).getFullYear();
  const get = async (q) => {
    const res = await fetch(`https://api.squiggle.com.au/?q=games;${q}`, { headers: { 'User-Agent': UA } });
    if(!res.ok) throw new Error(`Squiggle ${res.status}`);
    return (await res.json()).games || [];
  };
  // upcoming and live games, plus any already matched (so a finished one
  // keeps updating); the full year only if nothing is coming up
  let raw = await get(`year=${year};complete=!100`);
  for(const id of knownIds) if(!raw.some(g => g.id === id)) raw = raw.concat(await get(`game=${id}`));
  if(!raw.length) raw = (await get(`year=${year}`)).filter(g => Math.abs((g.unixtime * 1000) - now) < 3 * DAY);
  return raw.map(g => ({
    id: `afl:${g.id}`, league: 'afl', home: g.hteam, away: g.ateam,
    homeNames: namesFor(g.hteam), awayNames: namesFor(g.ateam),
    hs: g.complete > 0 ? g.hscore : null, as: g.complete > 0 ? g.ascore : null,
    state: g.complete >= 100 ? 'final' : g.complete > 0 ? 'live' : 'pre',
    clock: g.complete >= 100 ? 'Full time' : g.complete > 0 ? (g.timestr || 'Live') : '',
    start: g.unixtime ? g.unixtime * 1000 : Date.parse(g.date) || null,
  }));
}

// ---------- push ----------
async function pushAll(db, title, body){
  if(!process.env.VAPID_PRIVATE_KEY) return 0;
  const webpush = (await import('web-push')).default;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:mlsynd00@gmail.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const subs = (await db.get('/pushSubscriptions')) || {};
  const payload = JSON.stringify({ title: title.slice(0, 80), body: body.slice(0, 160), url: '/' });
  let sent = 0;
  for(const [uid, sub] of Object.entries(subs)){
    if(!sub || !sub.endpoint) continue;
    try{ await webpush.sendNotification(sub, payload); sent++; }
    catch(e){ if(e.statusCode === 410 || e.statusCode === 404) await db.put(`/pushSubscriptions/${uid}`, null); }
  }
  return sent;
}

// ---------- one run ----------
// `deps` lets tests pass a fake database, fake feeds and a fake push.
export async function runLiveLegs(deps){
  const { db, feeds, push, now = Date.now() } = deps;
  // just the three small pieces needed, never the whole of /state (it's
  // large, and this runs every few minutes)
  const [draftRaw, weekRaw, cleared] = await Promise.all(['/state/groupEntryDraft', '/state/weekLabelDraft', '/state/groupMultiCleared'].map(p => db.get(p)));
  const state = { groupMultiCleared: cleared };
  const draft = draftRaw || {};
  const week = weekRaw || 'week';
  const prev = (await db.get('/liveLegs')) || {};
  const legs = Object.entries(draft).filter(([, e]) => e && e.pick && Number(e.odds) > 0);
  if(state.groupMultiCleared || !legs.length){
    if(prev.legs) await db.put('/liveLegs', null);
    return { tracked: 0 };
  }

  // Quiet spell: nothing on for a while (every game finished or more than
  // 45 minutes off) and the legs haven't changed, so skip the score feeds
  // and only look again every 15 minutes.
  const sig = JSON.stringify(legs.map(([n, e]) => [n, e.pick.sel, e.pick.event, e.result || '']));
  const prevLegs = Object.values(prev.legs || {});
  if(prev.week === week && prev.sig === sig && prev.updatedAt && now - prev.updatedAt < 15 * 60000
    && prevLegs.every(l => !l.tracked || l.state === 'final' || (l.state === 'pre' && l.start && l.start - now > 45 * 60000))){
    return { tracked: prevLegs.filter(l => l.tracked).length, quiet: true };
  }

  // only fetch the leagues this week's legs need
  const want = new Map();
  for(const [name, e] of legs){ const lg = leagueOf(e.pick); if(lg) want.set(name, lg); }
  const leagues = [...new Set(want.values())];
  const known = Object.values((prev.week === week && prev.legs) || {}).map(l => l && l.gameId).filter(id => id && id.startsWith('afl:')).map(id => Number(id.slice(4)));
  const games = [];
  const errors = [];
  await Promise.all(leagues.map(async lg => {
    try{ games.push(...(lg === 'afl' ? await feeds.afl(now, known) : await feeds.espn(lg, now))); }
    catch(e){ errors.push(e.message); }
  }));

  const out = {};
  for(const [name, e] of legs){
    const lg = want.get(name);
    if(!lg){ out[name] = { tracked: false }; continue; }
    const m = matchLeg({ ...e.pick, league: lg }, games, now);
    if(!m){ out[name] = { tracked: false, league: lg }; continue; }
    const g = m.game; const j = judge(e.pick, g, m.side);
    out[name] = {
      tracked: true, league: lg, gameId: g.id, home: g.home, away: g.away, side: m.side || null,
      hs: g.hs, as: g.as, state: g.state, clock: g.clock || '', start: g.start || null,
      verdict: j.verdict, suggest: j.suggest, note: j.note,
    };
  }

  // ---------- alerts on a leg settling ----------
  const sent = (await db.get(`/liveLegsNotified/${safeKey(week)}`)) || {};
  // a leg's settled result: the admin's if marked, else the scoreboard's
  const settled = (n) => (draft[n] && draft[n].result) || (out[n] && out[n].suggest) || null;
  const alerts = [];
  const dead = legs.some(([n]) => settled(n) === 'Loss');
  for(const [name, e] of legs){
    const L = out[name];
    if(!L || !L.suggest || e.result || sent[safeKey(name)] === L.suggest) continue;
    const toGo = legs.filter(([n]) => !settled(n)).length;
    const score = `${L.home} ${L.hs}–${L.as} ${L.away}`;
    const sel = e.pick.sel || 'their leg';
    if(L.suggest === 'Win'){
      if(sent._dead) continue; // we've already told everyone the multi's gone
      const tail = dead ? 'multi already gone' : toGo === 0 ? 'every leg is home!' : `multi alive, ${toGo} to go`;
      alerts.push({ name, result: 'Win', title: `✅ ${name}'s leg got up`, body: `${sel} · ${score} · ${tail}` });
    }else{
      alerts.push({ name, result: 'Loss', title: `❌ ${name}'s leg went down`, body: `${sel} · ${score}${sent._dead ? '' : ' · that’s the multi'}` });
    }
  }
  let pushed = 0;
  for(const a of alerts){
    sent[safeKey(a.name)] = a.result;
    if(a.result === 'Loss') sent._dead = true;
    // the admin's confirm alert uses `${week}_${name}`: mark it done so it doesn't repeat
    await db.put(`/pushMultiNotified/${safeKey(`${week}_${a.name}`)}`, a.result);
    pushed += await push(a.title, a.body);
  }
  if(alerts.length) await db.put(`/liveLegsNotified/${safeKey(week)}`, sent);

  const anyLive = Object.values(out).some(l => l.state === 'live');
  await db.put('/liveLegs', { week, sig, updatedAt: now, live: anyLive, legs: out, ...(errors.length ? { errors } : {}) });
  return { tracked: Object.values(out).filter(l => l.tracked).length, alerts: alerts.length, pushed, errors };
}

export default async () => {
  try{
    const token = await getFirebaseAccessToken();
    const url = (p) => `${FIREBASE_URL}${p}.json?access_token=${token}`;
    const db = {
      get: async (p) => { const r = await fetch(url(p)); if(!r.ok) throw new Error(`GET ${p} ${r.status}`); return r.json(); },
      put: async (p, v) => { const r = await fetch(url(p), { method: v === null ? 'DELETE' : 'PUT', headers: { 'Content-Type': 'application/json' }, body: v === null ? undefined : JSON.stringify(v) }); if(!r.ok) throw new Error(`PUT ${p} ${r.status}`); },
    };
    const out = await runLiveLegs({ db, feeds: { afl: aflGames, espn: espnGames }, push: (t, b) => pushAll(db, t, b) });
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }catch(e){
    console.error('live legs failed:', e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config = { schedule: '*/3 * * * *' };
