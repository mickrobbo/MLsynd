// Runs hourly and only actually distributes when it's 8am on the 1st of
// the month in Australia/Melbourne time — same self-gating pattern as
// check-lockouts-scheduled.js. Checking the real AEST/AEDT wall-clock hour
// via Intl (rather than hand-picking a single UTC cron time) means this
// stays correct through daylight-saving changes automatically, and running
// hourly rather than once means a missed/failed run just gets picked up
// again next hour rather than waiting a full month.
//
// Deploy alongside your other scheduled functions. Needs the same
// FIREBASE_DB_SECRET env var already set for check-lockouts-scheduled.js —
// it's what lets this function write past Firebase's normal auth rules
// with no real user session (this is a full-access legacy secret, so
// treat it with the same care as any other production credential).

const FIREBASE_URL = 'https://mlsynd-default-rtdb.firebaseio.com';
const CASINO_POT_REASON_PATTERN = /^(Blackjack|Baccarat|Roulette|Casino War|Slots|Video Poker|Spin the Wheel)/i;
const CASINO_POT_ELIGIBLE_PLAYS = 20;
const TIMEZONE = 'Australia/Melbourne'; // change if the syndicate isn't Melbourne-based
const DISTRIBUTE_HOUR = 8; // 8am AEST/AEDT on the 1st

function isDistributionTime(){
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: TIMEZONE, day: 'numeric', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
  const day = parts.find(p => p.type === 'day').value;
  const hour = parts.find(p => p.type === 'hour').value;
  return day === '1' && Number(hour) === DISTRIBUTE_HOUR;
}

function monthKeyFor(date, timeZone){
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(date);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  return `${y}-${m}`;
}

async function dbGet(path, secret){
  const res = await fetch(`${FIREBASE_URL}${path}.json?auth=${secret}`);
  if(!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}
async function dbPut(path, secret, value){
  const res = await fetch(`${FIREBASE_URL}${path}.json?auth=${secret}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value)
  });
  if(!res.ok) throw new Error(`PUT ${path} failed: ${res.status}`);
  return res.json();
}
async function dbPost(path, secret, value){
  const res = await fetch(`${FIREBASE_URL}${path}.json?auth=${secret}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value)
  });
  if(!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json();
}
async function dbDelete(path, secret){
  const res = await fetch(`${FIREBASE_URL}${path}.json?auth=${secret}`, { method: 'DELETE' });
  if(!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
}

async function isEligibleForProportional(uid, monthKey, playCount, secret){
  if(playCount >= CASINO_POT_ELIGIBLE_PLAYS) return true;
  try{
    const log = (await dbGet(`/xp/${uid}/log`, secret)) || {};
    return Object.values(log).some(entry => {
      if(!entry || !(entry.amount > 0)) return false;
      if(CASINO_POT_REASON_PATTERN.test(entry.reason || '')) return false;
      return monthKeyFor(new Date(entry.ts), TIMEZONE) === monthKey;
    });
  }catch(e){
    return false;
  }
}

async function creditPotXP(uid, amount, reason, secret){
  if(!(amount > 0)) return;
  const bal = (await dbGet(`/xp/${uid}/balance`, secret)) || 0;
  const next = bal + amount;
  await dbPut(`/xp/${uid}/balance`, secret, next);
  await dbPost(`/xp/${uid}/log`, secret, { amount, reason, balanceAfter: next, ts: Date.now() });
  const lt = (await dbGet(`/xp/${uid}/lifetimeEarned`, secret)) || 0;
  await dbPut(`/xp/${uid}/lifetimeEarned`, secret, lt + amount);
}

async function distributePot(secret){
  const nowKey = monthKeyFor(new Date(), TIMEZONE);
  const allMonths = (await dbGet('/casinoPot/months', secret)) || {};
  // Everything under /casinoPot/months is by definition from before now —
  // this function only ever runs on the 1st, so any bucket present here
  // (including one matching a stale nowKey from a prior run this same
  // hour) is fair game to close out. Excluding an exact nowKey match just
  // guards against a same-day double-run within the hour this fires.
  const monthKeys = Object.keys(allMonths).filter(k => k !== nowKey).sort();
  if(monthKeys.length === 0) return { skipped: true, reason: 'nothing open' };

  const combinedLosses = {};
  const combinedPlayCounts = {};
  for(const mk of monthKeys){
    const data = allMonths[mk] || {};
    Object.entries(data.losses || {}).forEach(([uid, v]) => { combinedLosses[uid] = (combinedLosses[uid] || 0) + (Number(v) || 0); });
    Object.entries(data.playCounts || {}).forEach(([uid, v]) => { combinedPlayCounts[uid] = (combinedPlayCounts[uid] || 0) + (Number(v) || 0); });
  }
  const totalPot = Object.values(combinedLosses).reduce((s, v) => s + v, 0);
  const label = monthKeys.length === 1 ? monthKeys[0] : `${monthKeys[0]}..${monthKeys[monthKeys.length - 1]}`;

  const allUids = new Set([...Object.keys(combinedLosses), ...Object.keys(combinedPlayCounts)]);
  const eligible = [];
  for(const uid of allUids){
    const ok = await isEligibleForProportional(uid, label, combinedPlayCounts[uid] || 0, secret);
    if(ok) eligible.push(uid);
  }

  if(totalPot <= 0 || eligible.length === 0){
    // Nothing to distribute (or no one qualifies yet) — leave the month
    // bucket(s) untouched so they roll into whichever future run finally
    // has an eligible winner.
    return { skipped: true, reason: 'no eligible / empty pot', totalPot };
  }

  const proportionalPool = Math.floor(totalPot * 0.6);
  const jackpotPool = totalPot - proportionalPool;

  const eligibleWithLosses = eligible.filter(uid => (combinedLosses[uid] || 0) > 0);
  const totalEligibleLosses = eligibleWithLosses.reduce((s, uid) => s + (combinedLosses[uid] || 0), 0);
  const proportional = {};
  if(totalEligibleLosses > 0){
    eligibleWithLosses.forEach(uid => {
      proportional[uid] = Math.floor(proportionalPool * (combinedLosses[uid] / totalEligibleLosses));
    });
  }
  // Jackpot: pure equal-chance draw among anyone who played at all this
  // month — deliberately NOT weighted by losses, play count, or anything
  // else, and deliberately a separate pool from the proportional
  // eligibility above.
  const jackpotCandidates = Object.keys(combinedPlayCounts).filter(uid => (combinedPlayCounts[uid] || 0) > 0);
  const jackpotPoolCandidates = jackpotCandidates.length > 0 ? jackpotCandidates : eligible;
  const jackpotWinner = jackpotPoolCandidates[Math.floor(Math.random() * jackpotPoolCandidates.length)];

  for(const uid of Object.keys(proportional)){
    await creditPotXP(uid, proportional[uid], `Monthly Casino Pot – Proportional (${label})`, secret);
  }
  await creditPotXP(jackpotWinner, jackpotPool, `Monthly Casino Pot – Jackpot (${label})`, secret);

  const historyEntry = {
    month: label, totalPot, proportional, jackpotWinner, jackpotAmount: jackpotPool,
    participants: jackpotPoolCandidates, distributedAt: Date.now()
  };
  await dbPut(`/casinoPot/history/${label.replace(/\./g, '_')}`, secret, historyEntry);
  for(const mk of monthKeys){
    await dbDelete(`/casinoPot/months/${mk}`, secret);
  }
  return historyEntry;
}

export const config = { schedule: '0 * * * *' }; // hourly — self-gates on isDistributionTime() below

export default async () => {
  if(!isDistributionTime()){
    return new Response(`Not ${DISTRIBUTE_HOUR}am on the 1st in ${TIMEZONE} — skipping.`, { status: 200 });
  }
  const secret = process.env.FIREBASE_DB_SECRET;
  if(!secret){
    console.error('FIREBASE_DB_SECRET not set');
    return new Response('Missing FIREBASE_DB_SECRET', { status: 500 });
  }
  try{
    const result = await distributePot(secret);
    console.log('Casino pot distribution result:', JSON.stringify(result));
    return new Response(JSON.stringify(result), { status: 200 });
  }catch(e){
    console.error('Casino pot distribution failed:', e);
    return new Response('Failed: ' + e.message, { status: 500 });
  }
};
