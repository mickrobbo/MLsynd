// Fines the Casino Pot two ways, per request: 100,000 XP for every wrong
// AFL tip a person actually submitted, and 50,000 XP for every game a
// known tipper had NO pick at all (a genuine miss, not the Dashboard's
// own "auto-defaults to Away" ladder-scoring convenience — that's a
// display fallback for the ladder, not something this treats as a real
// pick). "Known tipper" = anyone with an entry in /tippingStats, i.e.
// has had at least one tip scored this season.
//
// Runs every 30 minutes, self-gates on nothing time-of-day-specific (AFL
// games finish at all sorts of hours) — instead gates on genuinely new
// data: only ever processes a (game, uid) pair it hasn't already marked
// done, via a persistent marker at /casinoPot/tippingFinesChecked, so it's
// safe to run as often as it likes and can never double-fine the same
// wrong tip twice no matter how many times it fires.
//
// Uses the SAME distribution-lock pattern as
// casino-pot-distribute-scheduled.js (a different lock path — the two
// functions never contend with each other) rather than a per-item lock:
// this function's own runs are the only thing that could race each other,
// and a single per-run lock is proven, simple, and sufficient for that.
//
// Deploy alongside your other scheduled functions. Needs the same
// FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY env vars already set up for
// casino-pot-distribute-scheduled.js — reused here, nothing new to add.

const FIREBASE_URL = 'https://mlsynd-default-rtdb.firebaseio.com';
const SITE_URL = 'https://mlsynddash.netlify.app';
const TIPPING_LOSS_FINE = 30000;
const MISSED_TIP_FINE = 15000;
const FINE_PERSONAL_SHARE = 0.10; // 10% comes off the fined person's own balance now, per request — the other 90% still goes to the shared pot exactly as before
const TIMEZONE = 'Australia/Melbourne';
const LOCK_PATH = '/casinoPot/tippingFineLock';
const LOCK_STALE_MS = 10 * 60 * 1000;

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
  const crypto = await import('crypto');
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
  const signature = signer.sign(privateKey, 'base64url');
  const jwt = `${unsigned}.${signature}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  if(!res.ok) throw new Error(`OAuth token exchange failed — HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
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
async function dbDelete(path, secret){
  const res = await fetch(`${FIREBASE_URL}${path}.json?access_token=${secret}`, { method: 'DELETE' });
  if(!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
}

async function acquireLock(secret){
  const url = `${FIREBASE_URL}${LOCK_PATH}.json?access_token=${secret}`;
  const getRes = await fetch(url, { headers: { 'X-Firebase-ETag': 'true' } });
  if(!getRes.ok) throw new Error(`Lock GET failed: ${getRes.status}`);
  const etag = getRes.headers.get('ETag');
  const current = await getRes.json();
  const now = Date.now();
  if(current && current.ts && (now - current.ts) < LOCK_STALE_MS) return false;
  const putRes = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': etag },
    body: JSON.stringify({ ts: now })
  });
  if(putRes.status === 412) return false;
  if(!putRes.ok) throw new Error(`Lock PUT failed: ${putRes.status}`);
  return true;
}
async function releaseLock(secret){
  try{ await dbDelete(LOCK_PATH, secret); }catch(e){}
}

function periodKeyFor(date, timeZone){
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const day = Number(parts.find(p => p.type === 'day').value);
  const periodStartDay = day <= 15 ? '01' : '16';
  return `${y}-${m}-${periodStartDay}`;
}
function normTeamName(s){ return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

async function applyFine(uid, amount, historyField, reasonLabel, secret){
  // 90/10 split per request — previously 100% went to the shared pot with
  // zero personal impact. Restores some real individual stake without
  // making a bad month feel unrecoverable: the pot still absorbs the
  // large majority, this just isn't purely a group consequence anymore.
  const potShare = Math.round(amount * (1 - FINE_PERSONAL_SHARE));
  const personalShareTarget = amount - potShare;
  const path = `/casinoPot/months/${periodKeyFor(new Date(), TIMEZONE)}/fines`;
  const current = (await dbGet(path, secret).catch(() => 0)) || 0;
  await dbPut(path, secret, current + potShare);

  // Personal deduction floored at zero, never pushed negative — a low
  // balance just means this specific fine collects less than its full
  // 10%, not that the account goes into debt. The shortfall (if any)
  // simply isn't collected anywhere; the pot's own 90% share is
  // unaffected either way, it was already credited above.
  const balPath = `/xp/${uid}/balance`;
  const currentBal = (await dbGet(balPath, secret).catch(() => 0)) || 0;
  const personalShare = Math.min(personalShareTarget, Math.max(0, currentBal));
  if(personalShare > 0){
    const newBal = currentBal - personalShare;
    await dbPut(balPath, secret, newBal);
    await fetch(`${FIREBASE_URL}/xp/${uid}/log.json?access_token=${secret}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: -personalShare, reason: `${reasonLabel} (personal share)`, balanceAfter: newBal, ts: Date.now() })
    });
  }

  // Per-person breakdown for profile display — separate write from the
  // pot-level total above, same reasoning as the Ledger's own copy of
  // this pattern: a brand new path that starts empty for everyone, so a
  // profile only ever shows fines caused since this feature launched,
  // never anything from before it existed (there's nothing to derive
  // "before" from — this counter simply didn't exist yet). historyField
  // is 'wrongTips' or 'missedTips' depending on which fine this is —
  // same pot-level effect, different per-person breakdown.
  const historyPath = `/casinoPot/fineHistory/${uid}/${historyField}`;
  const currentHistory = (await dbGet(historyPath, secret).catch(() => 0)) || 0;
  await dbPut(historyPath, secret, currentHistory + 1);
}

async function runFines(secret){
  const fixturesRes = await fetch(`${SITE_URL}/.netlify/functions/afl-fixtures`);
  if(!fixturesRes.ok) throw new Error(`afl-fixtures fetch failed: ${fixturesRes.status}`);
  const fixturesData = await fixturesRes.json();
  const games = fixturesData.games || [];

  const seasonStartRoundRaw = await dbGet('/tipping/config/firstRound', secret).catch(() => null);
  const seasonStartRound = seasonStartRoundRaw != null ? Number(seasonStartRoundRaw) : 1;

  const finishedGames = games.filter(g =>
    g.complete >= 100 && (g.winner || (g.hscore != null && g.ascore != null)) && g.round >= seasonStartRound
  );

  // Fetched once, not once per game/pick — was previously a separate GET
  // for every single item checked, which is fine in steady state (most
  // games already fully marked "checked" and skipped in one read each)
  // but genuinely wasteful on a first run or after any real backlog,
  // where it'd be one round trip per pick instead of one for the whole
  // season so far. The crash-safety this was providing (catching a game
  // that was only partially processed before a previous run died) is
  // fully preserved — it's the SAME lookup, just done once in memory
  // instead of on every iteration.
  const alreadyChecked = (await dbGet('/casinoPot/tippingFinesChecked', secret).catch(() => ({}))) || {};

  // Known tippers — needed to detect a MISSING pick, not just a wrong
  // one (nobody's "missing" from the picks object itself; you can only
  // know someone was supposed to be in it by checking against a roster
  // of who actually tips). /tippingStats holds one entry per person
  // who's ever had a tip scored, so its key set is used as that roster —
  // a single fetch here rather than reconstructing "who tips" from every
  // game's picks all season, which would be a much bigger read for the
  // same answer.
  const tippingStats = (await dbGet('/tippingStats', secret).catch(() => ({}))) || {};
  const knownTipperUids = Object.keys(tippingStats);

  let checkedCount = 0;
  let finedCount = 0;
  let missedCount = 0;
  let totalFined = 0;

  for(const g of finishedGames){
    if(alreadyChecked[g.id] === true) continue;

    const picks = await dbGet(`/tipping/picks/${g.id}`, secret).catch(() => ({})) || {};
    const isDrawResult = g.hscore != null && g.ascore != null && Number(g.hscore) === Number(g.ascore);

    for(const [uid, p] of Object.entries(picks)){
      if(!p || !p.pick) continue; // no real pick — handled in the missed-tip pass below, not here
      if(alreadyChecked[`${g.id}_${uid}`] === true) continue;

      const isCorrect = isDrawResult
        ? p.pick === 'draw'
        : normTeamName(p.pick === 'home' ? g.hteam : (p.pick === 'away' ? g.ateam : '')) === normTeamName(g.winner);

      if(!isCorrect){
        await applyFine(uid, TIPPING_LOSS_FINE, 'wrongTips', 'Wrong Tip Fine', secret);
        finedCount++;
        totalFined += TIPPING_LOSS_FINE;
      }
      await dbPut(`/casinoPot/tippingFinesChecked/${g.id}_${uid}`, secret, true);
      checkedCount++;
    }

    // Missed tips — a known tipper with no real pick at all for this
    // game, per request. Same idempotency key (${g.id}_${uid}) as the
    // pass above is safe to reuse here: for any given (game, uid) pair
    // exactly one of "they picked" or "they didn't" is ever true, so a
    // uid is only ever processed by ONE of the two passes, never both,
    // and marking it checked either way correctly stops a future run
    // from re-processing it regardless of which branch handled it.
    for(const uid of knownTipperUids){
      if(picks[uid] && picks[uid].pick) continue; // they did pick — already handled above
      if(alreadyChecked[`${g.id}_${uid}`] === true) continue;
      await applyFine(uid, MISSED_TIP_FINE, 'missedTips', 'Missed Tip Fine', secret);
      missedCount++;
      totalFined += MISSED_TIP_FINE;
      await dbPut(`/casinoPot/tippingFinesChecked/${g.id}_${uid}`, secret, true);
    }

    await dbPut(`/casinoPot/tippingFinesChecked/${g.id}`, secret, true);
  }

  return { finishedGamesSeen: finishedGames.length, picksChecked: checkedCount, tipsFined: finedCount, tipsMissed: missedCount, totalFined };
}

export default async (req) => {
  let secret;
  try{ secret = await getFirebaseAccessToken(); }
  catch(e){ return new Response('Auth failed: ' + e.message, { status: 500 }); }

  let gotLock = false;
  try{ gotLock = await acquireLock(secret); }
  catch(e){ return new Response('Lock check failed: ' + e.message, { status: 500 }); }
  if(!gotLock){
    return new Response('Another run is already in progress or ran within the last 10 minutes — skipping.', { status: 200 });
  }

  try{
    const result = await runFines(secret);
    return new Response(JSON.stringify(result), { status: 200 });
  }catch(e){
    return new Response('Failed: ' + e.message, { status: 500 });
  }finally{
    await releaseLock(secret);
  }
};

export const config = { schedule: '*/30 * * * *' }; // every 30 minutes
