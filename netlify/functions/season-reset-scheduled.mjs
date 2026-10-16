// netlify/functions/season-reset-scheduled.mjs
//
// New Year season reset for the Casino economy. At midnight on 1 January
// (Melbourne time) every approved member's season is archived and the new
// season starts fresh:
//   - /xp/{uid}/seasons/{year}  ← final balance, XP earned that season, tier
//   - /xp/{uid}/allTime         ← running all-time totals (earned, seasons,
//                                  best balance, best season), kept forever
//   - balance → 10,000 XP, lifetimeEarned (the season counter tiers use) → 0,
//     lastKnownTier cleared so tier-ups celebrate again, win streak → 0
//   - one log line per member so the change shows in their XP history
//
// XP milestone badges stay unlocked: the app counts allTime/earned plus the
// current season when it works those out.
//
// Same auth as the other scheduled XP jobs (FIREBASE_DB_SECRET), no new
// environment variables. Netlify cron runs in UTC; the schedule below fires
// every 20 minutes from 00:00 to 02:40 on 1 January in Melbourne (AEDT,
// UTC+11), and the year marker means only the first successful run acts.

const DB_URL = process.env.SEASON_RESET_DB_URL || 'https://mlsynd-default-rtdb.firebaseio.com'; // override only for local testing
const START_BALANCE = 10000;

function melbourneParts(d){
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => +parts.find(p => p.type === t).value;
  return { year: get('year'), month: get('month'), day: get('day') };
}

async function getJson(path, SECRET){
  const r = await fetch(`${DB_URL}${path}.json?auth=${SECRET}`);
  if(!r.ok) throw new Error(`read ${path}: ${r.status}`);
  return r.json();
}
async function send(method, path, body, SECRET){
  const r = await fetch(`${DB_URL}${path}.json?auth=${SECRET}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if(!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
  return r;
}

export async function runSeasonReset({ SECRET, now = new Date(), force = false }){
  const mp = melbourneParts(now);
  if(!force && !(mp.month === 1 && mp.day === 1)){
    return { skipped: true, reason: 'not 1 January in Melbourne', melbourne: mp };
  }
  const newYear = mp.year;
  const season = newYear - 1;

  // Claim the year first with an ETag-guarded write, so two overlapping
  // runs can't both reset everyone.
  const markerRes = await fetch(`${DB_URL}/xpSeason/lastResetYear.json?auth=${SECRET}`, { headers: { 'X-Firebase-ETag': 'true' } });
  const etag = markerRes.headers.get('ETag');
  const last = await markerRes.json();
  if(last != null && Number(last) >= newYear) return { skipped: true, reason: 'already reset for this year', newYear };
  const claim = await fetch(`${DB_URL}/xpSeason/lastResetYear.json?auth=${SECRET}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'if-match': etag || '*' }, body: JSON.stringify(newYear) });
  if(claim.status === 412) return { skipped: true, reason: 'another run claimed this year first', newYear };
  if(!claim.ok) throw new Error(`could not claim year marker: ${claim.status}`);

  const users = (await getJson('/users', SECRET)) || {};
  const done = [], failed = [];
  for(const [uid, u] of Object.entries(users)){
    if(!u || u.status !== 'approved') continue;
    try{
      const [bal, earned, prevAll, lastTier] = await Promise.all([
        getJson(`/xp/${uid}/balance`, SECRET),
        getJson(`/xp/${uid}/lifetimeEarned`, SECRET),
        getJson(`/xp/${uid}/allTime`, SECRET),
        getJson(`/xp/${uid}/lastKnownTier`, SECRET),
      ]);
      const balance = Number(bal) || 0;
      const seasonEarned = Number(earned) || 0;
      const prev = prevAll || {};
      const tierKey = lastTier && typeof lastTier === 'object' ? (lastTier.tierKey || lastTier.key || null) : (lastTier || null);

      await send('PUT', `/xp/${uid}/seasons/${season}`, { season, finalBalance: balance, earned: seasonEarned, tier: tierKey, archivedAt: { '.sv': 'timestamp' } }, SECRET);
      await send('PUT', `/xp/${uid}/allTime`, {
        earned: (Number(prev.earned) || 0) + seasonEarned,
        seasons: (Number(prev.seasons) || 0) + 1,
        bestBalance: Math.max(Number(prev.bestBalance) || 0, balance),
        bestSeasonEarned: Math.max(Number(prev.bestSeasonEarned) || 0, seasonEarned),
        lastSeason: season,
      }, SECRET);
      await send('PATCH', `/xp/${uid}`, { balance: START_BALANCE, lifetimeEarned: 0, lastKnownTier: null, currentStreak: 0 }, SECRET);
      await send('POST', `/xp/${uid}/log`, { amount: START_BALANCE - balance, reason: `New season ${newYear}: balance reset to ${START_BALANCE.toLocaleString('en-AU')} XP`, balanceAfter: START_BALANCE, ts: Date.now() }, SECRET);
      done.push(uid);
    }catch(e){ failed.push({ uid, error: e.message }); }
  }
  await send('PUT', `/xpSeason/history/${newYear}`, { at: { '.sv': 'timestamp' }, season, reset: done.length, failed: failed.length }, SECRET);
  return { ok: true, newYear, season, reset: done.length, failed };
}

export default async () => {
  const SECRET = process.env.FIREBASE_DB_SECRET;
  if(!SECRET) return new Response(JSON.stringify({ error: 'FIREBASE_DB_SECRET not configured' }), { status: 500 });
  try{
    const out = await runSeasonReset({ SECRET });
    return new Response(JSON.stringify(out), { status: 200 });
  }catch(e){
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};

export const config = {
  // 13:00–15:40 UTC on 31 December = 00:00–02:40 on 1 January in Melbourne (AEDT).
  schedule: '*/20 13-15 31 12 *'
};
