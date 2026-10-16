// Runs hourly and only actually distributes when it's 8am on Monday in
// Australia/Melbourne time — same self-gating pattern as check-lockouts-
// scheduled.js. Weekly per request (previously twice-monthly, 1st/16th),
// to keep payouts smaller and more frequent still. Checking the real
// AEST/AEDT wall-clock hour via Intl (rather than hand-picking a single
// UTC cron time) means this stays correct through daylight-saving changes
// automatically, and running hourly rather than once means a missed/
// failed run just gets picked up again next hour rather than waiting up
// to a week.
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
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: TIMEZONE, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
  const weekday = parts.find(p => p.type === 'weekday').value;
  const hour = parts.find(p => p.type === 'hour').value;
  // FIXED 2026-10-16: was "Monday AND hour === 8" only, so one failed or
  // skipped run meant no retry for a whole week. Now any hourly run counts
  // except Monday before 8am; distributePot() itself is a no-op unless a
  // closed period is actually sitting there, so the extra runs are cheap.
  return !(weekday === 'Mon' && Number(hour) < DISTRIBUTE_HOUR);
}
// Separate from isDistributionTime() on purpose. The Clean Record Bonus
// is monthly and was never meant to change when the pot's own cadence
// did — but it used to piggyback on periodKeyFor()'s output ending in
// "-01" to detect month-start, which only worked back when that function
// returned a twice-monthly "-01"/"-16" key. Now that periodKeyFor()
// returns a weekly Monday date instead, that check would almost never
// be true (only on the rare month where the 1st happens to fall on a
// Monday) — silently breaking a feature nobody asked to change, just as
// a side effect of the pot becoming weekly. This gives month-start its
// own independent, direct check instead of inferring it from a key
// format that no longer encodes that information.
function isMonthStartTime(){
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: TIMEZONE, day: 'numeric', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
  const day = parts.find(p => p.type === 'day').value;
  const hour = parts.find(p => p.type === 'hour').value;
  return day === '1' && Number(hour) === DISTRIBUTE_HOUR;
}
function currentMonthLabel(){
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
}

// Weekly period key — the Monday date (in TIMEZONE) that starts the
// current week, e.g. "2026-09-07" for the week beginning that Monday.
// Deliberately still stored under the same /casinoPot/months path (its
// Firebase rule is a $monthKey wildcard, so it accepts any child key
// shape) rather than migrating to a new path, to avoid touching security
// rules for a pure bucketing-scheme change. Kept the function name
// periodKeyFor (was monthKeyFor, then the twice-monthly version) but left
// every call site's local variable names as monthKey/monthKeys/nowKey —
// purely cosmetic, not worth the risk of a wider rename.
function periodKeyFor(date, timeZone){
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(date);
  const y = Number(parts.find(p => p.type === 'year').value);
  const m = Number(parts.find(p => p.type === 'month').value);
  const d = Number(parts.find(p => p.type === 'day').value);
  const weekdayStr = parts.find(p => p.type === 'weekday').value;
  const weekdayIndex = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[weekdayStr];
  // Walk back to that week's Monday using UTC date math on the
  // timezone-local y/m/d — safe here since we only need calendar-day
  // arithmetic, not a real instant, and this avoids DST edge cases that
  // constructing a local Date from these parts directly could hit.
  const asUTC = Date.UTC(y, m - 1, d);
  const mondayUTC = asUTC - weekdayIndex * 86400000;
  const mondayDate = new Date(mondayUTC);
  const yy = mondayDate.getUTCFullYear();
  const mm = String(mondayDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(mondayDate.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

async function dbGet(path, secret){
  const res = await fetch(`${FIREBASE_URL}${path}.json?access_token=${secret}`);
  if(!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}
// Atomic claim on the history path itself, using the exact same ETag
// compare-and-swap the distribution lock already uses — not a second,
// independent safety net, the ACTUAL mechanism that makes double-crediting
// impossible. The plain "check history, then later dbPut history" pattern
// this replaced had a real gap: checking and writing were two separate
// awaits with no atomicity between them, so two invocations racing here —
// whether that's two overlapping scheduled runs, OR the server-side
// scheduled function racing the client-side admin "close overdue periods"
// recovery tool, which is a genuinely separate, independent copy of this
// same logic with no shared in-memory lock at all — could both pass the
// old read-then-write check before either one had written anything yet,
// and both go on to independently draw a jackpot winner and credit XP.
// That's the exact "same period, two different jackpot winners" symptom.
// Claiming the label BEFORE any XP is credited (not after, the way the
// history dbPut used to happen right at the very end) means only one
// invocation can ever win this compare-and-swap; every other one gets
// HTTP 412 and bails out having credited nothing at all.
async function claimDistributionLabel(label, secret){
  const path = `/casinoPot/history/${label.replace(/\./g, '_')}`;
  const url = `${FIREBASE_URL}${path}.json?access_token=${secret}`;
  const getRes = await fetch(url, { headers: { 'X-Firebase-ETag': 'true' } });
  if(!getRes.ok) throw new Error(`Claim GET failed: ${getRes.status}`);
  const etag = getRes.headers.get('ETag');
  const current = await getRes.json();
  if(current != null) return false; // already has a real history entry — genuinely already distributed
  const putRes = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': etag },
    body: JSON.stringify({ claiming: true, claimedAt: Date.now() })
  });
  if(putRes.status === 412) return false; // lost the race to another concurrent invocation/tool
  if(!putRes.ok) throw new Error(`Claim PUT failed: ${putRes.status}`);
  return true;
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
// Atomic numeric add (ETag compare-and-swap, retried). FIXED 2026-10-16:
// creditPotXP used a plain read-then-PUT, so a payout landing while that
// player was mid-game could overwrite their win (or their game could
// overwrite the payout).
async function dbAddNumber(path, secret, delta){
  const url = `${FIREBASE_URL}${path}.json?access_token=${secret}`;
  for(let attempt = 0; attempt < 8; attempt++){
    const getRes = await fetch(url, { headers: { 'X-Firebase-ETag': 'true' } });
    if(!getRes.ok) throw new Error(`GET ${path} failed: ${getRes.status}`);
    const etag = getRes.headers.get('ETag');
    const cur = Number(await getRes.json()) || 0;
    const next = cur + delta;
    const putRes = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': etag }, body: JSON.stringify(next) });
    if(putRes.ok) return next;
    if(putRes.status !== 412) throw new Error(`PUT ${path} failed: ${putRes.status}`);
  }
  throw new Error(`PUT ${path} kept conflicting`);
}
async function creditPotXP(uid, amount, reason, secret){
  if(!(amount > 0)) return;
  const next = await dbAddNumber(`/xp/${uid}/balance`, secret, amount);
  await dbPost(`/xp/${uid}/log`, secret, { amount, reason, balanceAfter: next, ts: Date.now() });
}

// REWRITTEN 2026-10-16. The old version lumped EVERY closed bucket into one
// combined pot and, if that came out at zero (fines >= losses) or nobody
// qualified, just returned — leaving every bucket in place. They then piled
// up forever and dragged each later week's pot down with them, so nothing
// ever paid out again (health check: "3 closed periods never distributed").
// Old-format keys written by the tipping-fines job (e.g. "2026-10-01") were
// part of that pile too.
// Now each closed period is settled on its own, oldest first:
//   - pays out if it has a pot and someone qualifies, then is removed
//   - otherwise its losses and fines carry into the next period (the next
//     closed one, or this week's), then it is removed
//   - an old-format (non-Monday) key always carries forward
const isMondayKey = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && new Date(k + 'T00:00:00Z').getUTCDay() === 1;

async function rollPeriodForward(mk, data, intoKey, secret){
  for(const [uid, v] of Object.entries(data.losses || {})){
    const n = Number(v) || 0;
    if(n > 0) await dbAddNumber(`/casinoPot/months/${intoKey}/losses/${uid}`, secret, n);
  }
  const fines = Number(data.fines) || 0;
  if(fines > 0) await dbAddNumber(`/casinoPot/months/${intoKey}/fines`, secret, fines);
  await dbDelete(`/casinoPot/months/${mk}`, secret);
}

async function distributeOnePeriod(mk, data, rollIntoKey, secret){
  const losses = data.losses || {};
  const playCounts = data.playCounts || {};
  const fines = Number(data.fines) || 0;
  const rawPot = Object.values(losses).reduce((s, v) => s + (Number(v) || 0), 0);
  const totalPot = Math.max(0, rawPot - fines);
  const label = mk;

  // Already paid (a previous run credited everyone, then failed to delete)?
  const existing = await dbGet(`/casinoPot/history/${label.replace(/\./g, '_')}`, secret).catch(() => null);
  if(existing && existing.claiming) return { period: mk, skipped: true, stuck: true, reason: 'a previous payout run crashed part-way — needs a manual check' };
  if(existing){ await dbDelete(`/casinoPot/months/${mk}`, secret); return { period: mk, skipped: true, cleaned: true, reason: 'already paid — leftover bucket removed' }; }

  if(!isMondayKey(mk)){
    await rollPeriodForward(mk, data, rollIntoKey, secret);
    return { period: mk, skipped: true, rolled: true, rolledInto: rollIntoKey, reason: 'old-format key — carried forward' };
  }

  const allUids = new Set([...Object.keys(losses), ...Object.keys(playCounts)]);
  const eligible = [];
  for(const uid of allUids){
    if(await isEligibleForProportional(uid, label, Number(playCounts[uid]) || 0, secret)) eligible.push(uid);
  }
  if(totalPot <= 0 || eligible.length === 0){
    await rollPeriodForward(mk, data, rollIntoKey, secret);
    return { period: mk, skipped: true, rolled: true, rolledInto: rollIntoKey, totalPot, reason: totalPot <= 0 ? 'pot was zero after fines' : 'nobody qualified' };
  }

  const claimed = await claimDistributionLabel(label, secret);
  if(!claimed) return { period: mk, skipped: true, reason: 'claimed by another invocation' };

  const CASINO_POT_CAP = 120000000;
  const cappedPot = Math.min(totalPot, CASINO_POT_CAP);
  const capBurnedAmount = totalPot - cappedPot;
  const CASINO_POT_BURN_RATE = 0.30;
  const regularBurnedAmount = Math.floor(cappedPot * CASINO_POT_BURN_RATE);
  const burnedAmount = capBurnedAmount + regularBurnedAmount;
  const distributable = cappedPot - regularBurnedAmount;
  const proportionalPool = Math.floor(distributable * 0.75);
  const jackpotPool = distributable - proportionalPool;

  const proportional = {};
  const share = Math.floor(proportionalPool / eligible.length);
  eligible.forEach(uid => { proportional[uid] = share; });

  const TIPPING_JACKPOT_GAME_THRESHOLD = 50;
  const jackpotCandidates = new Set(Object.keys(playCounts).filter(uid => (Number(playCounts[uid]) || 0) > 0));
  Object.entries(data.tippingGames || {}).forEach(([uid, games]) => {
    if(Object.keys(games || {}).length >= TIPPING_JACKPOT_GAME_THRESHOLD) jackpotCandidates.add(uid);
  });
  const jackpotPoolCandidates = jackpotCandidates.size > 0 ? [...jackpotCandidates] : eligible;
  const jackpotWinner = jackpotPoolCandidates[Math.floor(Math.random() * jackpotPoolCandidates.length)];

  const payoutFailures = [];
  for(const uid of Object.keys(proportional)){
    try{ await creditPotXP(uid, proportional[uid], `Casino Pot – Even Split (${label})`, secret); }
    catch(e){ payoutFailures.push({ uid, amount: proportional[uid], kind: 'split', error: e.message }); }
  }
  try{ await creditPotXP(jackpotWinner, jackpotPool, `Casino Pot – Jackpot (${label})`, secret); }
  catch(e){ payoutFailures.push({ uid: jackpotWinner, amount: jackpotPool, kind: 'jackpot', error: e.message }); }

  const historyEntry = {
    month: label, totalPot, rawPot, finesApplied: fines, cappedPot, capBurnedAmount, proportional, jackpotWinner, jackpotAmount: jackpotPool,
    burnedAmount, participants: jackpotPoolCandidates, distributedAt: Date.now(),
    payoutFailures: payoutFailures.length ? payoutFailures : null
  };
  await dbPut(`/casinoPot/history/${label.replace(/\./g, '_')}`, secret, historyEntry);
  await dbDelete(`/casinoPot/months/${mk}`, secret);
  return historyEntry;
}

async function distributePot(secret){
  const nowKey = periodKeyFor(new Date(), TIMEZONE);
  const allMonths = (await dbGet('/casinoPot/months', secret)) || {};
  const closed = Object.keys(allMonths).filter(k => k !== nowKey).sort();
  if(closed.length === 0) return { skipped: true, reason: 'nothing open' };
  const periods = [];
  for(let i = 0; i < closed.length; i++){
    const mk = closed[i];
    const intoKey = closed[i + 1] || nowKey;
    // Re-read: an earlier period in this loop may just have rolled into it.
    const data = (await dbGet(`/casinoPot/months/${mk}`, secret)) || {};
    try{ periods.push(await distributeOnePeriod(mk, data, intoKey, secret)); }
    catch(e){ periods.push({ period: mk, skipped: true, error: e.message }); break; } // stop: never roll past a period we couldn't settle
  }
  // Push notification only for periods that actually paid out.
  const paid = periods.filter(r => !r.skipped);
  return paid.length ? Object.assign({ periods }, paid[paid.length - 1]) : { skipped: true, periods };
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
  // Independent check now — see isMonthStartTime()'s own comment for why
  // this could no longer piggyback on periodKeyFor() once that switched
  // to a weekly key.
  const monthLabel = currentMonthLabel(); // "YYYY-MM"
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
  // Two genuinely independent schedules now share this one hourly check:
  // the pot itself (Monday 8am, weekly) and the Clean Record Bonus
  // (the 1st of the month at 8am, whatever weekday that lands on — could
  // easily be a Monday, but just as easily not). Neither is nested inside
  // the other any more — each fires on its own condition below, so the
  // monthly bonus is never silently skipped just because the 1st wasn't
  // also a Monday that particular month.
  const runDistribution = isDistributionTime();
  const runCleanRecord = isMonthStartTime();
  if(!runDistribution && !runCleanRecord){
    return new Response(`Not ${DISTRIBUTE_HOUR}am on Monday or the 1st in ${TIMEZONE} — skipping.`, { status: 200 });
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
    let result = { skipped: true, reason: 'not the weekly distribution hour' };
    if(runDistribution){
      result = await distributePot(secret);
      console.log('Casino pot distribution result:', JSON.stringify(result));
      if(!result.skipped) await sendPotPushNotifications(secret, result);
    }
    // Clean Record Bonus — runs under the exact same lock (harmless to
    // share even on the rare month where the 1st IS a Monday, since the
    // lock only ever guards against a genuine concurrent double-run, not
    // against two unrelated tasks running back to back in the one
    // invocation that legitimately owns the lock).
    let cleanRecordResult = null;
    if(runCleanRecord){
      try{
        cleanRecordResult = await runCleanRecordBonus(secret);
        console.log('Clean Record Bonus result:', JSON.stringify(cleanRecordResult));
      }catch(e){
        console.error('Clean Record Bonus failed (regular pot distribution still succeeded):', e);
      }
    }
    return new Response(JSON.stringify({ ...result, cleanRecordBonus: cleanRecordResult }), { status: 200 });
  }catch(e){
    console.error('Casino pot distribution failed:', e);
    return new Response('Failed: ' + e.message, { status: 500 });
  }finally{
    await releaseDistributionLock(secret);
  }
};
