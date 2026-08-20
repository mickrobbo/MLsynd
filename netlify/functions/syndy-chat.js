// Syndy chat proxy. Client sends { idToken, messages: [{role, content}, ...] }
// (messages = conversation so far, most recent last, NOT including a
// system prompt — that's added here, server-side, so it's never exposed
// to the client and can't be tampered with).
//
// Auth: verifies the Firebase ID token via Identity Toolkit's
// accounts:lookup (this actually validates the token's signature/expiry
// server-side — Google does the verification, not this function), then
// confirms that uid has status: 'approved' in /users, same access rule
// as everywhere else in the app. Rejects anything else with 401/403
// before ever calling Groq — Syndy is for logged-in members only.
//
// Needs GROQ_API_KEY set in Netlify env vars (get one at console.groq.com).
// FIREBASE_WEB_API_KEY is the public Firebase web key already embedded in
// DASHBOARD-index.html client-side — safe to expose either way, but it
// has to live in an env var here rather than hardcoded in the file,
// because Netlify's build-time secrets scanner flags any string shaped
// like a Google API key regardless of whether it's actually sensitive,
// and fails the whole build.
//
// FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY are the only two fields
// actually needed from your Firebase Admin SDK service account file
// (Project Settings → Service Accounts → Generate new private key) —
// stored as two separate env vars rather than the whole JSON, since AWS
// Lambda (which every Netlify Function runs on) caps total environment
// variable size at 4KB combined across ALL variables for a function, and
// the unused fields in the full JSON (project_id, client_id, three URI
// fields, universe_domain) were dead weight pushing things over that
// limit. This project's Firebase console doesn't expose the older
// "database secret" mechanism, so admin-level access here goes through a
// signed JWT exchanged for a short-lived Google OAuth2 access token
// instead — see getFirebaseAccessToken below. That token is what actually
// reads/writes past the RTDB rules, same role the old database secret
// used to play.
//
// PuntersEdge odds are pulled from the site's own existing
// puntersedge-sports-odds function (no separate key needed here) when a
// message looks odds/betting-flavoured — see detectOddsSport below.

const FIREBASE_URL = 'https://mlsynd-default-rtdb.firebaseio.com';
const GROQ_MODEL = 'openai/gpt-oss-120b'; // Groq deprecated llama-3.3-70b-versatile (and llama-3.1-8b-instant) on 2026-06-17 — this is their own recommended replacement for it. Swap to openai/gpt-oss-20b for lower latency/cost if 120b feels slow.
const MAX_HISTORY_MESSAGES = 12; // trims the conversation sent to Groq — cost/latency control, not a hard memory limit client-side
const SYNDY_BONUS_XP = 500;

import crypto from 'crypto';

// A simple "\n" replace, or even a chain of them, still isn't reliable —
// copy-pasting a multi-line PEM through Netlify's env var UI can collapse
// real newlines, add stray spaces, or otherwise scramble the strict line
// structure OpenSSL expects, even when the underlying key data is
// completely intact. This rebuilds the PEM from scratch instead of
// patching whitespace: pull out just the base64 payload between the
// BEGIN/END markers, strip every character that isn't valid base64
// (regardless of how it got mangled), then re-wrap it at the standard
// 64-char line length. That survives essentially any copy-paste damage,
// since it never trusts the existing whitespace/newlines at all.
function normalizePemKey(raw){
  let key = (raw || '').trim();
  if((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))){
    key = key.slice(1, -1).trim();
  }
  key = key.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const match = key.match(/-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]*?)-----END (RSA )?PRIVATE KEY-----/);
  if(!match) return key; // couldn't find PEM markers at all — let it fail downstream with the real error rather than guessing further
  const label = match[1] ? 'RSA PRIVATE KEY' : 'PRIVATE KEY';
  const body = match[2].replace(/[^A-Za-z0-9+/=]/g, ''); // strip every non-base64 character, including any surviving whitespace
  const lines = body.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

// Fetched fresh once per request rather than cached across invocations —
// simpler and safer than trying to persist a token across Netlify's
// stateless function instances, at the cost of one extra HTTP round-trip
// per chat message. Tokens are valid for an hour; this just doesn't try
// to reuse one.
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
    // Never include the key itself in an error — only enough shape
    // information to tell whether normalizePemKey actually found valid
    // markers and produced a plausible-length key, without exposing any
    // of the actual key material.
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

const SYNDY_SYSTEM_PROMPT = `You are Syndy — a sharp, quick-witted, no-bullshit AI companion based in Melbourne, Australia (AEST). You speak like a proper footy-loving, racing-mad, pub-frequenting mate: warm when it's warranted, full of banter, and completely unafraid to swear and carry on when someone is being rude or talking shit. You give as good as you get — and then some. Never break character. Never apologise for swearing or banter unless the user specifically asks you to tone it down. Stay Syndy at all times.

All information you give about scores, ladders, odds, form, weather, track conditions, injuries, and news must be live and current. If you do not have live data, clearly say so and work with the best available knowledge while keeping the banter going.

### Primary Expertise
- Australian sport first and foremost: AFL, NRL, cricket, horse racing (especially Melbourne tracks), A-League, and local Melbourne sporting culture.
- Strong knowledge of American sports, world soccer, and motorsport (F1, MotoGP, Supercars).
- Elite form analysis and multi construction using live and historical stats, head-to-head records, recent performance, injuries, track rating, track bias, weather, sectionals, pace maps, barrier bias, jockey/trainer stats, and conditions.
- Melbourne food, pubs, bars, and alcohol recommendations.

### Style
- Heavy banter and natural Aussie slang (mate, legend, deadset, get it up ya, soft as butter, what a fucking joke, etc.).
- You can swear freely (fuck, shit, cunt, bastard, prick, bullshit) and match energy if the user is rude or talking shit.
- Keep most replies punchy and concise (2-5 sentences maximum unless the user specifically asks for deeper analysis).
- Only give the information that was asked for — do not over-explain or dump large amounts of data.
- End most messages with a short question to keep the banter going.

### Multis & Betting
You are allowed to suggest multis and possible legs.

Important: Base your multi suggestions primarily on form, historical stats, head-to-head records, recent performance, injuries, track conditions, weather, venue trends, and other relevant data. Odds are secondary — use them for value and market context, not as the main reason for selecting a leg.

Speak like a mate throwing ideas around, not like a tipster guaranteeing winners.

You can name specific teams/players as part of the suggestion. Just don't present it as guaranteed or as financial advice.

Only mention responsible gambling once per conversation (keep it short and natural). Example: "Gamble responsibly mate — only bet what you can afford to lose."

### Boundaries
- Never guarantee wins or promise profits.
- Stay focused on sport, racing, Melbourne food & drink, and related topics.
- Banter and swearing stop at the line of genuine hate or discrimination.

You are Syndy. Ready to bag the umpires, roast a rival, break down live stats and form, factor in track rating and bias, throw a multi together based on the numbers, argue about the best parma in Melbourne, or tell someone to fuck off if they're being a cunt. What's on, mate?`;

async function verifyFirebaseIdToken(idToken){
  const fbApiKey = process.env.FIREBASE_WEB_API_KEY;
  if(!fbApiKey) throw new Error('FIREBASE_WEB_API_KEY not set');
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${fbApiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
  });
  if(!res.ok) return null;
  const data = await res.json();
  const user = data.users && data.users[0];
  return user ? { uid: user.localId, email: user.email } : null;
}

// Returns { ok, user, reason } rather than just null — a bare "for
// approved members only" message with no detail is exactly the kind of
// thing that's cost real debugging time elsewhere in this project before;
// surfacing the actual cause here (bad secret, missing record, wrong
// status, etc.) means the next failure is diagnosable from the error text
// alone instead of guessing blind again.
async function getApprovedMemberInfo(uid, accessToken){
  try{
    const res = await fetch(`${FIREBASE_URL}/users/${uid}.json?access_token=${accessToken}`);
    if(!res.ok){
      return { ok: false, reason: `Firebase read failed — HTTP ${res.status} (check the service account has Realtime Database access)` };
    }
    const user = await res.json();
    if(!user){
      return { ok: false, reason: `No /users/${uid} record found` };
    }
    if(user.status !== 'approved'){
      return { ok: false, reason: `status is "${user.status}", not "approved"` };
    }
    // Syndy is Full/Dashboard members only — role is undefined/null for
    // legacy accounts (that means "full", same convention used throughout
    // the app), so only explicitly reject tipping/readonly rather than
    // requiring role to be positively set.
    if(user.role === 'readonly' || user.role === 'tipping'){
      return { ok: false, reason: `role is "${user.role}" — Syndy is Full/Dashboard members only` };
    }
    return { ok: true, user };
  }catch(e){
    return { ok: false, reason: 'Exception: ' + e.message };
  }
}

// One-time 500 XP "try Syndy" bonus. The flag is set BEFORE the XP is
// actually credited (not after) — narrows the double-award window if two
// requests from the same brand-new user somehow overlapped, at the cost
// of a vanishingly rare edge case where the flag sets but the credit
// fails; that's a much smaller problem than double-crediting.
async function claimSyndyBonusIfEligible(uid, accessToken){
  try{
    const flagRes = await fetch(`${FIREBASE_URL}/users/${uid}/syndyBonusClaimed.json?access_token=${accessToken}`);
    const alreadyClaimed = flagRes.ok ? await flagRes.json() : true; // fail closed — if we can't tell, don't award
    if(alreadyClaimed) return false;

    await fetch(`${FIREBASE_URL}/users/${uid}/syndyBonusClaimed.json?access_token=${accessToken}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(true)
    });

    const balRes = await fetch(`${FIREBASE_URL}/xp/${uid}/balance.json?access_token=${accessToken}`);
    const bal = balRes.ok ? ((await balRes.json()) || 0) : 0;
    const next = bal + SYNDY_BONUS_XP;
    await fetch(`${FIREBASE_URL}/xp/${uid}/balance.json?access_token=${accessToken}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next)
    });
    await fetch(`${FIREBASE_URL}/xp/${uid}/log.json?access_token=${accessToken}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: SYNDY_BONUS_XP, reason: 'Syndy chat bonus', balanceAfter: next, ts: Date.now() })
    });
    const ltRes = await fetch(`${FIREBASE_URL}/xp/${uid}/lifetimeEarned.json?access_token=${accessToken}`);
    const lt = ltRes.ok ? ((await ltRes.json()) || 0) : 0;
    await fetch(`${FIREBASE_URL}/xp/${uid}/lifetimeEarned.json?access_token=${accessToken}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lt + SYNDY_BONUS_XP)
    });
    return true;
  }catch(e){
    console.error('Syndy bonus award failed:', e);
    return false;
  }
}

// ---- PuntersEdge odds context ----
// Only fetched when the latest message actually looks odds/betting-
// flavoured — not on every single message, to keep the extra fetch (and
// the tokens it adds to the Groq call) proportional to when it's useful.
// Response shape confirmed from a real call to puntersedge-sports-odds:
// { supported, sport, events: [{ home_team, away_team, commence_time,
//   home_best_price, home_best_bookmaker, away_best_price, away_best_bookmaker }] }
// — decimal H2H best-price odds, no line/totals markets. If a sport
// comes back supported:false, that's the API's own signal to skip it,
// not something to guess around.
const ODDS_INTENT_WORDS = ['odds', 'multi', 'bet', 'price', 'favourite', 'favorite', 'chances', 'value', 'tip', 'line', 'markets', 'h2h', 'head to head', 'who wins', "who's going to win", 'best price'];
function detectOddsSport(text){
  const t = text.toLowerCase();
  if(!ODDS_INTENT_WORDS.some(w => t.includes(w))) return null;
  if(t.includes('nrl') || t.includes('rugby league')) return 'nrl';
  return 'afl'; // Syndy's primary expertise, and the confirmed-working sport for this endpoint
}
async function fetchPuntersEdgeOdds(sport, origin){
  try{
    const res = await fetch(`${origin}/.netlify/functions/puntersedge-sports-odds?sport=${encodeURIComponent(sport)}`, { headers: { 'Accept': 'application/json' } });
    if(!res.ok) return null;
    const data = await res.json();
    if(!data || !data.supported || !Array.isArray(data.events) || data.events.length === 0) return null;
    return data;
  }catch(e){
    return null;
  }
}
function formatOddsForPrompt(sport, data){
  const lines = data.events.slice(0, 10).map(e => {
    const when = new Date(e.commence_time).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short', hour: '2-digit', minute: '2-digit' });
    return `${e.home_team} vs ${e.away_team} (${when} AEST) — ${e.home_team} $${e.home_best_price} (${e.home_best_bookmaker}), ${e.away_team} $${e.away_best_price} (${e.away_best_bookmaker})`;
  });
  return `Live ${sport.toUpperCase()} head-to-head odds, decimal, best price currently available across tracked bookmakers:\n${lines.join('\n')}\n\nUse this real data when discussing odds, favourites, or multis for these games — don't claim you lack live odds while this is in front of you. Still weight form/stats over price per your usual approach.`;
}

export default async (req) => {
  if(req.method !== 'POST'){
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try{ body = await req.json(); }
  catch(e){ return new Response('Invalid JSON', { status: 400 }); }

  const { idToken, messages } = body || {};
  if(!idToken || !Array.isArray(messages)){
    return new Response('Missing idToken or messages', { status: 400 });
  }

  let auth;
  try{
    auth = await verifyFirebaseIdToken(idToken);
  }catch(e){
    console.error('Firebase token verification failed:', e.message);
    return new Response(JSON.stringify({ error: 'Server misconfigured.' }), { status: 500 });
  }
  if(!auth){
    return new Response(JSON.stringify({ error: 'Invalid or expired session — please sign in again.' }), { status: 401 });
  }

  let accessToken;
  try{
    accessToken = await getFirebaseAccessToken();
  }catch(e){
    console.error('Firebase service account auth failed:', e.message);
    return new Response(JSON.stringify({ error: `Server misconfigured. (${e.message})` }), { status: 500 });
  }
  const memberCheck = await getApprovedMemberInfo(auth.uid, accessToken);
  if(!memberCheck.ok){
    console.error('Syndy access denied for uid', auth.uid, '—', memberCheck.reason);
    return new Response(JSON.stringify({ error: `Syndy is for approved members only. (${memberCheck.reason})` }), { status: 403 });
  }

  const groqKey = process.env.GROQ_API_KEY;
  if(!groqKey){
    console.error('GROQ_API_KEY not set');
    return new Response(JSON.stringify({ error: 'Syndy is not configured yet — ask the admin to set GROQ_API_KEY.' }), { status: 500 });
  }

  const bonusAwarded = await claimSyndyBonusIfEligible(auth.uid, accessToken);

  // Trim to the last N messages and make sure every entry has a sane shape
  // before it goes anywhere near Groq — a malformed client message
  // shouldn't be able to break the request.
  const trimmedHistory = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY_MESSAGES);

  const groqMessages = [
    { role: 'system', content: SYNDY_SYSTEM_PROMPT },
    ...trimmedHistory
  ];

  const latestUserText = [...trimmedHistory].reverse().find(m => m.role === 'user');
  const oddsSport = latestUserText ? detectOddsSport(latestUserText.content) : null;
  if(oddsSport){
    const origin = new URL(req.url).origin;
    const oddsData = await fetchPuntersEdgeOdds(oddsSport, origin);
    if(oddsData){
      groqMessages.push({ role: 'system', content: formatOddsForPrompt(oddsSport, oddsData) });
    }
  }

  // A one-off instruction for this reply only — not baked into the system
  // prompt itself, so it never repeats on later messages once the bonus
  // has already been mentioned.
  if(bonusAwarded){
    groqMessages.push({
      role: 'system',
      content: `Before anything else, tell this member — in your own Syndy voice, banter and all — that they've just scored a one-off 500 XP Casino bonus for trying you out for the first time. Keep it short, then answer whatever they actually asked.`
    });
  }

  try{
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: groqMessages,
        temperature: 0.8,
        max_tokens: 400
      })
    });
    if(!groqRes.ok){
      const errText = await groqRes.text();
      console.error('Groq API error:', groqRes.status, errText);
      // Surfaced to the chat itself (not just server logs) so the actual
      // cause is visible without needing to dig through Netlify function
      // logs — same reasoning as every other diagnostic error in this
      // project: a generic message just means guessing blind next time.
      return new Response(JSON.stringify({ error: `Syndy's gone quiet for a sec. (Groq HTTP ${groqRes.status}: ${errText.slice(0, 200)})` }), { status: 502 });
    }
    const data = await groqRes.json();
    const reply = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if(!reply){
      return new Response(JSON.stringify({ error: "Didn't quite catch that — give it another go." }), { status: 502 });
    }
    return new Response(JSON.stringify({ reply, bonusAwarded }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }catch(e){
    console.error('Syndy chat failed:', e);
    return new Response(JSON.stringify({ error: "Something's carked it on Syndy's end — try again shortly." }), { status: 500 });
  }
};
