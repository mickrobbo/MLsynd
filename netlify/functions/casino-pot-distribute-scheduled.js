// Runs hourly and only actually distributes when it's 8am on the 1st or
// 16th of the month in Australia/Melbourne time — same self-gating
// pattern as check-lockouts-scheduled.js. Twice-monthly instead of once,
// per request, to keep payouts smaller and more regular rather than one
// large lump sum. Checking the real AEST/AEDT wall-clock hour via Intl
// (rather than hand-picking a single UTC cron time) means this stays
// correct through daylight-saving changes automatically, and running
// hourly rather than once means a missed/failed run just gets picked up
// again next hour rather than waiting up to two weeks.
//
// Deploy alongside your other scheduled functions. Needs the same
// VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, and VAPID_SUBJECT env vars
// already set up for check-lockouts-scheduled.js — same push-notification
// setup, reused here. Also needs 'web-push' as a dependency in
// functions/package.json (already there for the existing push feature),
// and FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY — just those two
// fields from your Firebase Admin SDK service account file, not the whole
// JSON (AWS Lambda caps total env var size at 4KB across every function,
// so the unused fields in the full file are dead weight worth trimming).
// Admin-level Realtime Database access here goes through a signed JWT
// exchanged for a short-lived Google OAuth2 access token (see
// getFirebaseAccessToken) — same role a legacy database secret used to
// play, but this project's Firebase console doesn't expose that
// mechanism.

import webpush from 'web-push';
import crypto from 'crypto';

const FIREBASE_URL = 'https://mlsynd-default-rtdb.firebaseio.com';
// Was missing Craps, Plinko, Big Wheel, Mines, Crash, and Double or Nothing
// compared to the client's copy of this same pattern — found by direct
// comparison while fixing the eligibility loophole below. Meant those six
// games' wins were NOT being excluded from "earned real (non-casino) XP"
// server-side, incorrectly making a win at any of them count toward pot
// eligibility on its own. Synced to match the client exactly.
const CASINO_POT_REASON_PATTERN = /^(Blackjack|Baccarat|Roulette|Casino War|Craps|Plinko|Big Wheel|Mines|Slots|Video Poker|Spin the Wheel|Crash|Double or Nothing)/i;
// Matches the pot's OWN payout reasons (current and legacy label formats).
// Without this, receiving a pot payout counted as "real XP" for the VERY
// NEXT period's eligibility check, since a payout obviously never matched
// the game-name pattern above — silently auto-qualifying a winner for the
// next period too, even with zero plays. Known loophole, now closed.
const CASINO_POT_PAYOUT_REASON_PATTERN = /^Casino Pot – (Even Split|Jackpot|Proportional)/;
const CASINO_POT_ELIGIBLE_PLAYS = 20;
const TIMEZONE = 'Australia/Melbourne'; // change if the syndicate isn't Melbourne-based
const DISTRIBUTE_HOUR = 8; // 8am AEST/AEDT on the 1st

function normalizePemKey(raw){
  let key = (raw || '').trim();
  if((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))){
    key = key.slice(1, -1).trim();
  }
  key = key.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const match = key.match(/-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]*?)-----END (RSA )?PRIVATE KEY-----/);
  if(!match) return key;
  const label = match[1] ? 'RSA PRIVATE KEY' : 'PRIVATE KEY';
  const body = match[2].replace(/[^A-Za-z0-9+/=]/g, '');
  const lines = body.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

async function getFirebaseAccessToken(){
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawKey = process.env.FIREBASE_PRIVATE_KEY;
  if(!clientEmail) throw new Error('FIREBASE_CLIENT_EMAIL not set');
  if(!rawKey) throw new Error('FIREBASE_PRIVATE_KEY not set');
  const privateKey = normalizePemKey(rawKey);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64url(header)}.${b64url(claim)}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  let signature;
  try{
    signature = signer.sign(privateKey, 'base64url');
  }catch(e){
    const hasMarkers = privateKey.includes('-----BEGIN') && privateKey.includes('-----END');
    throw new Error(`Private key sign failed (${e.message}) — raw env var: ${rawKey.length} chars, normalized key: ${privateKey.length} chars, PEM markers found: ${hasMarkers}, line count: ${privateKey.split('\n').length}`);
  }
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  if(!res.ok){
    const errText = await res.text();
    throw new Error(`OAuth token exchange failed — HTTP ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return data.access_token;
}

function isDistributionTime(){
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: TIMEZONE, day: 'numeric', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
  const day = parts.find(p => p.type === 'day').value;
  const hour = parts.find(p => p.type === 'hour').value;
  return (day === '1' || day === '16') && Number(hour) === DISTRIBUTE_HOUR;
}

// Twice-monthly period key ("YYYY-MM-01" for the 1st-15th, "YYYY-MM-16"
// for the 16th through the end of the month) — deliberately still stored
// under the same /casinoPot/months path (its Firebase rule is a $monthKey
// wildcard, so it accepts any child key shape) rather than migrating to a
// new path, to avoid touching security rules for a pure bucketing-scheme
// change. Kept the function name periodKeyFor (was monthKeyFor) but left
// every call site's local variable names as monthKey/monthKeys/nowKey —
// purely cosmetic, not worth the risk of a wider rename.
function periodKeyFor(date, timeZone){
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const day = Number(parts.find(p => p.type === 'day').value);
  const periodStartDay = day <= 15 ? '01' : '16';
  return `${y}-${m}-${periodStartDay}`;
}

async function dbGet(path, secret){
  const res = await fetch(`${FIREBASE_URL}${path}.json?access_token=${secret}`);
  if(!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}
async function dbPut(path, secret, value){
  const res = await fetch(`${FIREBASE_URL}${path}.json?access_token=${secret}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value)
  });
  if(!res.ok) throw new Error(`PUT ${path} failed: ${res.status}`);
  return res.json();
}
async function dbPost(path, secret, value){
  const res = await fetch(`${FIREBASE_URL}${path}.json?access_token=${secret}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value)
  });
  if(!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json();
}
async function dbDelete(path, secret){
  const res = await fetch(`${FIREBASE_URL}${path}.json?access_token=${secret}`, { method: 'DELETE' });
  if(!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
}

// ---- Distribution lock -----------------------------------------------
// ROOT CAUSE OF THE TRIPLE-PAYOUT BUG: distributePot() below reads
// /casinoPot/months, computes payouts, credits XP, then deletes the month
// bucket — several separate awaits with no atomicity between them. If this
// function is invoked more than once while isDistributionTime() is true
// (a full 60-minute window on the 1st, 8am Melbourne — not an instant),
// every concurrent invocation reads the SAME still-there month data before
// the first one finishes and deletes it, so each one independently credits
// a full payout and independently draws its own jackpot winner. That's
// exactly the "paid out three times / jackpot fired three times" symptom.
//
// Fixed with a real distributed lock using Firebase RTDB REST's ETag
// conditional-write support (If-Match) — a genuine compare-and-swap, not
// just a "check then write" race of our own. Only one concurrent
// invocation can ever win the PUT below; the rest get HTTP 412 and bail
// out immediately without touching any pot data. A short staleness window
// lets a future run self-heal if a previous one crashed mid-distribution
// instead of leaving the pot locked forever.
const LOCK_PATH = '/casinoPot/distributionLock';
const LOCK_STALE_MS = 10 * 60 * 1000; // 10 min — comfortably longer than a real run takes

async function acquireDistributionLock(secret){
  const url = `${FIREBASE_URL}${LOCK_PATH}.json?access_token=${secret}`;
  const getRes = await fetch(url, { headers: { 'X-Firebase-ETag': 'true' } });
  if(!getRes.ok) throw new Error(`Lock GET failed: ${getRes.status}`);
  const etag = getRes.headers.get('ETag');
  const current = await getRes.json();
  const now = Date.now();
  if(current && current.ts && (now - current.ts) < LOCK_STALE_MS){
    return false; // another invocation holds a fresh lock — bail out, don't touch pot data
  }
  const putRes = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': etag },
    body: JSON.stringify({ ts: now })
  });
  if(putRes.status === 412) return false; // lost the race to another concurrent invocation
  if(!putRes.ok) throw new Error(`Lock PUT failed: ${putRes.status}`);
  return true;
}

async function releaseDistributionLock(secret){
  try{ await dbDelete(LOCK_PATH, secret); }catch(e){ console.warn('Lock release failed (will self-expire):', e.message); }
}

async function isEligibleForProportional(uid, monthKey, playCount, secret){
  if(playCount >= CASINO_POT_ELIGIBLE_PLAYS) return true;
  try{
    const log = (await dbGet(`/xp/${uid}/log`, secret)) || {};
    return Object.values(log).some(entry => {
      if(!entry || !(entry.amount > 0)) return false;
      if(CASINO_POT_REASON_PATTERN.test(entry.reason || '')) return false;
      if(CASINO_POT_PAYOUT_REASON_PATTERN.test(entry.reason || '')) return false;
      return periodKeyFor(new Date(entry.ts), TIMEZONE) === monthKey;
    });
  }catch(e){
    return false;
  }
}

// Deliberately does NOT bump lifetimeEarned — per request, Casino Pot
// even-split and jackpot payouts should NOT count toward Player Tier.
// Tier (computePrestigeScore in the Dashboard) is lifetimeEarned + Board
// Season Score + Tipping points, so leaving lifetimeEarned untouched here
// is the whole fix: the money is still real and spendable (balance is
// credited, and it's logged for a full audit trail), it just doesn't
// move the tier needle. Ordinary casino GAME wins (winning a hand of
// Blackjack etc.) are credited elsewhere, not through this function, and
// are unaffected — only the periodic pot distribution and jackpot draw
// are excluded from tier.
async function creditPotXP(uid, amount, reason, secret){
  if(!(amount > 0)) return;
  const bal = (await dbGet(`/xp/${uid}/balance`, secret)) || 0;
  const next = bal + amount;
  await dbPut(`/xp/${uid}/balance`, secret, next);
  await dbPost(`/xp/${uid}/log`, secret, { amount, reason, balanceAfter: next, ts: Date.now() });
}

async function distributePot(secret){
  const nowKey = periodKeyFor(new Date(), TIMEZONE);
  const allMonths = (await dbGet('/casinoPot/months', secret)) || {};
  // Everything under /casinoPot/months is by definition from before now —
  // this function only ever runs on the 1st or 16th, so any bucket present
  // here (including one matching a stale nowKey from a prior run this same
  // hour) is fair game to close out. Excluding an exact nowKey match just
  // guards against a same-day double-run within the hour this fires.
  const monthKeys = Object.keys(allMonths).filter(k => k !== nowKey).sort();
  if(monthKeys.length === 0) return { skipped: true, reason: 'nothing open' };

  const combinedLosses = {};
  const combinedPlayCounts = {};
  let combinedFines = 0;
  for(const mk of monthKeys){
    const data = allMonths[mk] || {};
    Object.entries(data.losses || {}).forEach(([uid, v]) => { combinedLosses[uid] = (combinedLosses[uid] || 0) + (Number(v) || 0); });
    Object.entries(data.playCounts || {}).forEach(([uid, v]) => { combinedPlayCounts[uid] = (combinedPlayCounts[uid] || 0) + (Number(v) || 0); });
    combinedFines += Number(data.fines) || 0;
  }
  // Fines (Group Multi leg losses from the Ledger, AFL Tipping misses from
  // casino-pot-tipping-fines-scheduled.js) reduce the pot directly — this
  // is the actual "burn" mechanism those two features rely on. Floored at
  // 0 so fines can never make the pot go negative even in an edge case
  // where fines somehow exceeded the losses collected this period.
  const rawPot = Object.values(combinedLosses).reduce((s, v) => s + v, 0);
  const totalPot = Math.max(0, rawPot - combinedFines);
  const label = monthKeys.length === 1 ? monthKeys[0] : `${monthKeys[0]}..${monthKeys[monthKeys.length - 1]}`;

  // Belt-and-braces idempotency check: if this exact month label was
  // already distributed and recorded in history, never credit it again —
  // even if a stale/expired lock somehow let two invocations both reach
  // this point. Cheap, and it's the same check the lock is trying to make
  // unnecessary, so it costs nothing to keep as a second layer.
  const existingHistory = await dbGet(`/casinoPot/history/${label.replace(/\./g, '_')}`, secret);
  if(existingHistory){
    return { skipped: true, reason: 'already distributed (idempotency check)', label };
  }

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

  // Hard cap per request — the 20% burn alone trims a PERCENTAGE, which
  // can't actually stop the absolute number spiraling once a few people
  // are staking amounts that dwarf everyone else's (the custom-bet chip
  // makes that trivially possible). A percentage burn scales WITH the
  // problem; a cap is the only thing that actually bounds it. Applied
  // BEFORE the existing 20% burn — i.e. it caps what enters that
  // pipeline, rather than being a second, separate burn concept bolted
  // on top — so everything below this line (the 75/25 split math, the
  // eligibility logic) is completely unchanged and still just operates
  // on "the pot," whatever that turned out to be this period.
  // capBurnedAmount is logged separately from the regular burn in
  // history, purely for admin visibility into how often/how hard the
  // cap is actually being hit — worth watching to see if 250M needs
  // retuning once a few real periods have gone through it.
  const CASINO_POT_CAP = 250000000;
  const cappedPot = Math.min(totalPot, CASINO_POT_CAP);
  const capBurnedAmount = totalPot - cappedPot; // always >= 0; 0 in a normal period that never reaches the cap

  // 20% burned outright per request — otherwise the pot is a pure wash:
  // 100% of what's collected gets redistributed straight back to players,
  // so nothing ever actually leaves the XP economy through it, and the
  // numbers involved only ever grow. The remaining 85% still splits at
  // the existing 75/25 ratio, unchanged — burnedAmount is logged in the
  // distribution history for a real audit trail rather than just quietly
  // vanishing with no record. Single named constant, easy to retune.
  const CASINO_POT_BURN_RATE = 0.20;
  const regularBurnedAmount = Math.floor(cappedPot * CASINO_POT_BURN_RATE);
  const burnedAmount = capBurnedAmount + regularBurnedAmount; // combined figure — what players see as "burned" is one honest number, not two to reconcile
  const distributable = cappedPot - regularBurnedAmount;
  const proportionalPool = Math.floor(distributable * 0.75);
  const jackpotPool = distributable - proportionalPool;

  // Split evenly across everyone eligible — NOT weighted by how much each
  // person lost. Changed per request (previous behaviour rewarded the
  // biggest losers with the biggest share of this pool, which is the
  // opposite of what an even split should do).
  const proportional = {};
  if(eligible.length > 0){
    const share = Math.floor(proportionalPool / eligible.length);
    eligible.forEach(uid => { proportional[uid] = share; });
  }
  // Jackpot: pure equal-chance draw among anyone who played at all this
  // month — deliberately NOT weighted by losses, play count, or anything
  // else, and deliberately a separate pool from the proportional
  // eligibility above.
  const jackpotCandidates = Object.keys(combinedPlayCounts).filter(uid => (combinedPlayCounts[uid] || 0) > 0);
  const jackpotPoolCandidates = jackpotCandidates.length > 0 ? jackpotCandidates : eligible;
  const jackpotWinner = jackpotPoolCandidates[Math.floor(Math.random() * jackpotPoolCandidates.length)];

  for(const uid of Object.keys(proportional)){
    await creditPotXP(uid, proportional[uid], `Casino Pot – Even Split (${label})`, secret);
  }
  await creditPotXP(jackpotWinner, jackpotPool, `Casino Pot – Jackpot (${label})`, secret);

  const historyEntry = {
    month: label, totalPot, rawPot, finesApplied: combinedFines, cappedPot, capBurnedAmount, proportional, jackpotWinner, jackpotAmount: jackpotPool,
    burnedAmount, participants: jackpotPoolCandidates, distributedAt: Date.now()
  };
  await dbPut(`/casinoPot/history/${label.replace(/\./g, '_')}`, secret, historyEntry);
  for(const mk of monthKeys){
    await dbDelete(`/casinoPot/months/${mk}`, secret);
  }
  return historyEntry;
}

export const config = { schedule: '0 * * * *' }; // hourly — self-gates on isDistributionTime() below

// Best-effort — a push failure should never make the function report
// failure overall, since the actual XP distribution above already
// succeeded and is the part that matters.
async function sendPotPushNotifications(secret, result){
  try{
    const vapidPublic = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
    const vapidSubject = process.env.VAPID_SUBJECT;
    if(!vapidPublic || !vapidPrivate || !vapidSubject){
      console.warn('Casino pot push skipped — VAPID env vars not set');
      return;
    }
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

    let winnerName = 'Someone';
    try{
      const userRec = await dbGet(`/users/${result.jackpotWinner}`, secret);
      winnerName = (userRec && userRec.name) || winnerName;
    }catch(e){}

    const sharedOut = result.totalPot - (result.burnedAmount || 0);
    const payload = JSON.stringify({
      title: `🎰 ${result.month} Casino Pot distributed`,
      body: `${sharedOut.toLocaleString()} XP shared out (${(result.burnedAmount || 0).toLocaleString()} burned) — ${winnerName} won the ${result.jackpotAmount.toLocaleString()} XP jackpot!`,
      url: '/'
    });

    const subs = (await dbGet('/pushSubscriptions', secret)) || {};
    for(const uid of Object.keys(subs)){
      const sub = subs[uid];
      if(!sub || !sub.endpoint) continue;
      try{
        await webpush.sendNotification(sub, payload);
      }catch(err){
        // Same dead-subscription cleanup as the existing lockout-reminder
        // push feature — a 404/410 means the browser unsubscribed.
        if(err && (err.statusCode === 404 || err.statusCode === 410)){
          try{ await dbDelete(`/pushSubscriptions/${uid}`, secret); }catch(e){}
        } else {
          console.warn('Casino pot push failed for', uid, err && err.message);
        }
      }
    }
  }catch(e){
    console.error('Casino pot push notify failed:', e);
  }
}

// ================= Clean Record Bonus =================
// A monthly (not twice-monthly, unlike the pot itself) rolling jackpot
// for genuinely spotless behaviour — zero fines of any kind across the
// whole calendar month. Per request: if nobody qualifies, the bonus
// amount rolls over and grows for next month rather than being paid to
// nobody and vanishing, same spirit as a real lottery rollover.
//
// The hard part this needed solving: existing fine history
// (/casinoPot/fineHistory/{uid}/*) is just a running CUMULATIVE count
// per category, with no date breakdown at all — there was no way to ask
// "did this person get fined THIS MONTH specifically" from what already
// existed, short of touching every single fine-application site across
// two separate apps to also write date-stamped entries. Instead this
// takes a much lighter approach: snapshot everyone's total fine count at
// the start of each month, then at the START OF THE NEXT MONTH compare
// current-vs-snapshot — unchanged means genuinely zero fines landed in
// between. No changes needed anywhere fines actually get applied.
const CLEAN_RECORD_BONUS_BASE = 15000;

async function runCleanRecordBonus(secret){
  const nowKey = periodKeyFor(new Date(), TIMEZONE);
  // Monthly, not twice-monthly — only ever evaluated on the month-start
  // ("-01") run, never on the 16th.
  if(!nowKey.endsWith('-01')) return { skipped: true, reason: 'not a month-start run' };

  const monthLabel = nowKey.slice(0, 7); // "YYYY-MM"
  // Idempotency — this whole function already only runs under the same
  // distribution lock as distributePot, but this is a second, cheap
  // guard specifically against ever double-evaluating (and so
  // double-paying, or double-rolling-over) the same calendar month.
  const lastRun = await dbGet('/casinoPot/cleanRecordBonus/lastRunMonth', secret).catch(() => null);
  if(lastRun === monthLabel) return { skipped: true, reason: 'already evaluated this month' };

  // Candidate pool is EVERYONE in /users, not just people who show up in
  // fineHistory or who played casino games — "zero fines" should be
  // checkable for anyone in the syndicate, including someone who's never
  // triggered a single fine and so never has a fineHistory entry at all.
  const users = (await dbGet('/users', secret)) || {};
  const allUids = Object.keys(users);
  if(allUids.length === 0) return { skipped: true, reason: 'no users found' };

  const snapshot = (await dbGet('/casinoPot/cleanRecordSnapshot', secret)) || {};
  const isFirstRunEver = Object.keys(snapshot).length === 0;

  const currentTotals = {};
  const newSnapshot = {};
  for(const uid of allUids){
    const fh = (await dbGet(`/casinoPot/fineHistory/${uid}`, secret).catch(() => null)) || {};
    const total = (fh.groupMultiLegs || 0) + (fh.groupMultiMIA || 0) + (fh.groupMultiLowOdds || 0) + (fh.wrongTips || 0) + (fh.missedTips || 0);
    currentTotals[uid] = total;
    newSnapshot[uid] = total;
  }

  if(isFirstRunEver){
    // Nothing to fairly evaluate on the very first run this feature ever
    // executes — there's no "start of month" baseline to compare against
    // yet, and everyone's cumulative total obviously includes a whole
    // season of history that predates this feature existing. This run
    // only establishes that baseline; the first real evaluation happens
    // at the NEXT month-start, comparing against what's recorded here.
    await dbPut('/casinoPot/cleanRecordSnapshot', secret, newSnapshot);
    await dbPut('/casinoPot/cleanRecordBonus/pool', secret, CLEAN_RECORD_BONUS_BASE);
    await dbPut('/casinoPot/cleanRecordBonus/lastRunMonth', secret, monthLabel);
    return { monthLabel, firstRun: true, note: 'baseline established this run, no evaluation until next month-start' };
  }

  const pool = (await dbGet('/casinoPot/cleanRecordBonus/pool', secret)) || CLEAN_RECORD_BONUS_BASE;
  // Anyone new to the roster since the last snapshot (no prior entry for
  // their uid at all) is treated the same as the first-run case above —
  // no baseline to compare against yet means no penalty, they qualify by
  // default rather than being unfairly excluded.
  const qualifying = allUids.filter(uid => currentTotals[uid] === (snapshot[uid] != null ? snapshot[uid] : currentTotals[uid]));

  let winner = null, amountPaid = 0, newPool;
  if(qualifying.length > 0){
    winner = qualifying[Math.floor(Math.random() * qualifying.length)];
    amountPaid = pool;
    await creditPotXP(winner, amountPaid, `Clean Record Bonus (${monthLabel})`, secret);
    newPool = CLEAN_RECORD_BONUS_BASE; // resets for the fresh cycle starting now
  } else {
    newPool = pool + CLEAN_RECORD_BONUS_BASE; // rolls over and grows — nobody collected it
  }

  await dbPut('/casinoPot/cleanRecordSnapshot', secret, newSnapshot);
  await dbPut('/casinoPot/cleanRecordBonus/pool', secret, newPool);
  await dbPut('/casinoPot/cleanRecordBonus/lastRunMonth', secret, monthLabel);

  const result = { monthLabel, qualifyingCount: qualifying.length, winner, amountPaid, poolBefore: pool, poolAfter: newPool };
  await dbPut(`/casinoPot/cleanRecordBonus/history/${monthLabel}`, secret, result);
  return result;
}

export default async () => {
  if(!isDistributionTime()){
    return new Response(`Not ${DISTRIBUTE_HOUR}am on the 1st or 16th in ${TIMEZONE} — skipping.`, { status: 200 });
  }
  let secret;
  try{
    secret = await getFirebaseAccessToken(); // named `secret` throughout below for a minimal diff — it's actually an OAuth2 access token now, not a legacy database secret
  }catch(e){
    console.error('Firebase service account auth failed:', e.message);
    return new Response('Server misconfigured: ' + e.message, { status: 500 });
  }
  let gotLock = false;
  try{
    gotLock = await acquireDistributionLock(secret);
  }catch(e){
    console.error('Distribution lock check failed:', e);
    return new Response('Lock check failed: ' + e.message, { status: 500 });
  }
  if(!gotLock){
    console.log('Casino pot distribution: another invocation holds the lock — skipping.');
    return new Response('Another distribution run is already in progress or ran within the last 10 minutes — skipping.', { status: 200 });
  }
  try{
    const result = await distributePot(secret);
    console.log('Casino pot distribution result:', JSON.stringify(result));
    if(!result.skipped) await sendPotPushNotifications(secret, result);
    // Clean Record Bonus — runs under the exact same lock, right after
    // the regular distribution. It self-gates on being a month-start
    // ("-01") run, so calling it here every 1st/16th is safe; it's a
    // genuine no-op on the 16th.
    let cleanRecordResult = null;
    try{
      cleanRecordResult = await runCleanRecordBonus(secret);
      console.log('Clean Record Bonus result:', JSON.stringify(cleanRecordResult));
    }catch(e){
      console.error('Clean Record Bonus failed (regular pot distribution still succeeded):', e);
    }
    return new Response(JSON.stringify({ ...result, cleanRecordBonus: cleanRecordResult }), { status: 200 });
  }catch(e){
    console.error('Casino pot distribution failed:', e);
    return new Response('Failed: ' + e.message, { status: 500 });
  }finally{
    await releaseDistributionLock(secret);
  }
};
