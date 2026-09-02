// Fines the Casino Pot 150,000 XP for every INDIVIDUAL wrong AFL tip, per
// person, per request. Deliberately scoped to real, actively-submitted
// picks only — a missed tip (auto-defaults to Away, same rule the
// Dashboard's own tipping ladder uses) is NOT fined here, since forgetting
// to tip feels like a different thing than actively guessing wrong. Easy
// to widen later if that's not what was actually wanted.
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
const TIPPING_LOSS_FINE = 150000;
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

async function applyFine(uid, amount, secret){
  const nowKey = periodKeyFor(new Date(), TIMEZONE);
  const path = `/casinoPot/months/${nowKey}/fines`;
  const current = (await dbGet(path, secret).catch(() => 0)) || 0;
  await dbPut(path, secret, current + amount);
  // Per-person breakdown for profile display — separate write from the
  // pot-level total above, same reasoning as the Ledger's own copy of
  // this pattern: a brand new path that starts empty for everyone, so a
  // profile only ever shows fines caused since this feature launched,
  // never anything from before it existed (there's nothing to derive
  // "before" from — this counter simply didn't exist yet).
  const historyPath = `/casinoPot/fineHistory/${uid}/wrongTips`;
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

  let checkedCount = 0;
  let finedCount = 0;
  let totalFined = 0;

  for(const g of finishedGames){
    const alreadyChecked = await dbGet(`/casinoPot/tippingFinesChecked/${g.id}`, secret).catch(() => null);
    // Per-game short-circuit: once every real pick on a finished game has
    // been checked, that game's result and picks can never change again —
    // marking the whole game "checked": true once done means future runs
    // skip it in one read instead of re-reading every pick every time.
    if(alreadyChecked === true) continue;

    const picks = await dbGet(`/tipping/picks/${g.id}`, secret).catch(() => ({})) || {};
    const isDrawResult = g.hscore != null && g.ascore != null && Number(g.hscore) === Number(g.ascore);

    for(const [uid, p] of Object.entries(picks)){
      if(!p || !p.pick) continue; // no real pick — auto-tips are deliberately not fined, see file header
      const alreadyDone = await dbGet(`/casinoPot/tippingFinesChecked/${g.id}_${uid}`, secret).catch(() => null);
      if(alreadyDone === true) continue;

      const isCorrect = isDrawResult
        ? p.pick === 'draw'
        : normTeamName(p.pick === 'home' ? g.hteam : (p.pick === 'away' ? g.ateam : '')) === normTeamName(g.winner);

      if(!isCorrect){
        await applyFine(uid, TIPPING_LOSS_FINE, secret);
        finedCount++;
        totalFined += TIPPING_LOSS_FINE;
      }
      await dbPut(`/casinoPot/tippingFinesChecked/${g.id}_${uid}`, secret, true);
      checkedCount++;
    }
    await dbPut(`/casinoPot/tippingFinesChecked/${g.id}`, secret, true);
  }

  return { finishedGamesSeen: finishedGames.length, picksChecked: checkedCount, tipsFined: finedCount, totalFined };
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
