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
const GROQ_MODEL = 'groq/compound'; // has REAL, native web search built in (powered by Tavily, decided automatically per-query) — this is what lets Syndy check current facts instead of relying only on training data or the structured feeds below. Groq reports ~4.9s average latency for this vs much faster for a plain model — if that feels too slow in practice, groq/compound-mini trades some depth for real speed while keeping the same built-in search.
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

const SYNDY_SYSTEM_PROMPT = `You are Syndy — a sharp, quick-witted, no-bullshit AI companion based in Melbourne, Australia (AEST). You speak like a proper footy-loving, racing-mad, pub-frequenting mate: warm when it's warranted, full of banter, and completely unafraid to swear and carry on when someone is being rude or talking shit. You give as good as you get — and then some. Never break character. Never apologise for swearing or banter unless the user specifically asks you to tone it down.

### Expertise
Australian sport first — AFL, NRL, cricket, horse racing (especially Melbourne tracks), A-League, local Melbourne culture. Also strong on American sports, world soccer, motorsport (F1, MotoGP, Supercars), and Melbourne food/pubs/bars.

### Style
Heavy banter and Aussie slang (mate, legend, deadset, get it up ya, what a fucking joke, etc.). Swear freely (fuck, shit, cunt, bastard, prick, bullshit) and match energy if someone's rude or talking shit — but banter and swearing stop dead at genuine hate or discrimination. Keep replies punchy, 2-5 sentences, unless asked for more depth — except for a genuinely historical question (a past event, a famous game, a grand final years back): give that real multi-paragraph depth instead, that's the one case short replies are wrong. Only answer what was asked, don't over-explain, end most replies with a short question to keep it going.

### Accuracy — the one rule that matters most
Never state a specific number, date, name, or record as fact unless it actually came from somewhere real: your web search, or real data provided to you in this conversation (odds, AFL ladder, or MLSynd syndicate standings). You have real live web search — use it for anything current (player news, injuries, results, form, history) instead of guessing from stale training knowledge. If search comes up empty, say so plainly and keep the banter going rather than inventing an answer. A confident wrong stat is worse than an honest "don't know."

Odds you're given are head-to-head (match-winner) only — no live prices for player props, lines, or totals (not offered by the provider for any sport). But you have real web search, so when someone asks about goal scorers, disposals, lines, or totals, actually search for what backs up the answer — recent disposal/goal-kicking averages, injury and team news, weather forecast for the venue, other bookmakers' current lines for context, recent head-to-head — then give a genuinely reasoned pick built on what you found. Just don't invent a specific live price for those markets since your own odds feed doesn't cover them; everything else about them is fair game to actually go find out.

### Multis & betting
You can suggest multis and legs — base them primarily on form, stats, head-to-head, recent performance, injuries, conditions, venue trends; search for these when you don't already have them rather than guessing. Odds are secondary context, not the main reason for a pick. Talk like a mate throwing ideas around, never like a tipster guaranteeing winners, never present anything as guaranteed or as financial advice. Mention responsible gambling once per conversation, briefly and naturally.

If someone asks for a specific number of legs, deliver exactly that many, fully reasoned, every time — never stop partway through and never pad a shorter list to look complete. If you're genuinely running low on room, wrap up cleanly with a shorter note per leg rather than cutting the list off unfinished. Use a plain numbered list for multi legs (1. Team — pick — brief why), never a markdown table — the chat display can't render tables at all, they'll show up as broken raw text.

### MLSynd syndicate data
Real standings given to you (season P/L, win/loss/void record, dues status) are genuine ledger data, same numbers every member already sees in the app — completely fair game for banter: roast whoever's down big, call out dues dodgers, answer honestly about anyone's season. Keep it cutting but grounded in the real numbers, never made-up detail about someone.

### Boundaries
Never guarantee wins or profits. Stay focused on sport, racing, Melbourne food & drink, and related banter.

You are Syndy. Ready to bag the umpires, roast a rival, break down live stats and form, throw a multi together based on the numbers, argue the best parma in Melbourne, or tell someone to fuck off if they're being a cunt. What's on, mate?`;

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

// ---- Real AFL ladder data ----
// Syndy was confidently inventing specific ladder positions, win-loss
// records, player names, and injury news when asked "how's team X going"
// — all fabricated, presented with total confidence. This pulls the exact
// same afl-ladder.js data the Dashboard's own Sport tab already uses, so
// ladder position/record/percentage claims are grounded in something
// real. Player-level detail (rosters, individual stats, injuries) still
// isn't available from anywhere in this app — the system prompt tells her
// to say so rather than invent it.
const LADDER_INTENT_WORDS = ['ladder', 'standing', 'how are', "how's", 'how is', 'going this year', 'this season', 'form', 'record', 'top of the table', 'bottom of the table', 'finals chase'];
function detectLadderIntent(text){
  const t = text.toLowerCase();
  return LADDER_INTENT_WORDS.some(w => t.includes(w));
}
async function fetchAflLadder(origin){
  try{
    const res = await fetch(`${origin}/.netlify/functions/afl-ladder`, { headers: { 'Accept': 'application/json' } });
    if(!res.ok) return null;
    const data = await res.json();
    if(!data || !Array.isArray(data.ladder) || data.ladder.length === 0) return null;
    return data.ladder;
  }catch(e){
    return null;
  }
}
function formatLadderForPrompt(ladder){
  const lines = ladder.map((t, i) => {
    const rank = t.rank ?? (i + 1);
    const pct = t.percentage != null ? Number(t.percentage).toFixed(1) : '—';
    return `${rank}. ${t.name || 'Unknown'} — ${t.wins ?? '—'}W-${t.losses ?? '—'}L (${t.played ?? '—'} played), ${pct}%`;
  });
  return `Real current AFL ladder (this is the actual live standings, not a guess):\n${lines.join('\n')}\n\nUse this exact data for any ladder position, win-loss record, or percentage claim — never state a specific position/record that isn't shown here. For anything else about these teams (players, injuries, recent match detail), use your web search rather than guessing.`;
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

// ---- Real MLSynd platform data (standings, dues, records) ----
// Fetched on every message, not intent-gated — the group is only ~11
// people, so the token cost is trivial, and gating on keywords would miss
// plenty of genuine questions ("how's Billy going this year?") that don't
// contain an obvious trigger word. Field names match exactly what
// DASHBOARD-index.html and LEDGER-index.html already read/write on
// state.members — this isn't new data, it's the same numbers already
// visible to every member in the app, just handed to Syndy too.
async function fetchPlatformSummary(accessToken){
  try{
    const res = await fetch(`${FIREBASE_URL}/state/members.json?access_token=${accessToken}`);
    if(!res.ok) return null;
    const members = await res.json();
    if(!Array.isArray(members) || members.length === 0) return null;
    const lines = members.filter(m => m && m.name).map(m => {
      const wins = m.wins || 0, losses = m.losses || 0, voids = m.voids || 0;
      const winPct = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;
      const pl = typeof m.pl === 'number' ? m.pl : 0;
      const owed = Math.round(m.duesOwed || 0);
      return `${m.name}: season P/L ${pl >= 0 ? '+' : ''}$${pl.toFixed(0)}, record ${wins}-${losses}-${voids} (${winPct}% win rate)${owed > 0 ? `, owes $${owed} in dues` : ', dues paid up'}`;
    });
    if(lines.length === 0) return null;
    return lines.join('\n');
  }catch(e){
    return null;
  }
}
function formatOddsForPrompt(sport, data){
  const lines = data.events.slice(0, 10).map(e => {
    const when = new Date(e.commence_time).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short', hour: '2-digit', minute: '2-digit' });
    return `${e.home_team} vs ${e.away_team} (${when} AEST) — ${e.home_team} $${e.home_best_price} (${e.home_best_bookmaker}), ${e.away_team} $${e.away_best_price} (${e.away_best_bookmaker})`;
  });
  return `Live ${sport.toUpperCase()} head-to-head odds ONLY, decimal, best price currently available across tracked bookmakers:\n${lines.join('\n')}\n\nUse this real data when discussing straight win/loss odds, favourites, or a match-winner-only multi for these games — don't claim you lack live odds while this is in front of you. This is head-to-head data ONLY — if the request involves goal scorers, disposals, lines, or totals, that's not covered here; say so rather than quietly answering with just the win/loss picks above. Still weight form/stats over price per your usual approach.`;
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

  // Kicked off immediately, in parallel with the whole auth chain below —
  // this fetch doesn't depend on anything the auth chain produces, so
  // there's no reason to make the user wait for it sequentially after.
  // Every "multi" message was hitting this (it's one of the odds-intent
  // keywords), so this alone was adding a full extra network round-trip
  // to every multi request before Groq was even called.
  const trimmedHistoryForIntent = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY_MESSAGES);
  const latestUserTextForIntent = [...trimmedHistoryForIntent].reverse().find(m => m.role === 'user');
  const oddsSport = latestUserTextForIntent ? detectOddsSport(latestUserTextForIntent.content) : null;
  const oddsPromise = oddsSport ? fetchPuntersEdgeOdds(oddsSport, new URL(req.url).origin) : Promise.resolve(null);
  const wantsLadder = latestUserTextForIntent ? detectLadderIntent(latestUserTextForIntent.content) : false;
  const ladderPromise = wantsLadder ? fetchAflLadder(new URL(req.url).origin) : Promise.resolve(null);

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

  // Kicked off now (not awaited yet) — runs while the bonus check and
  // everything else below happens, using the same accessToken already in
  // hand rather than adding a further sequential wait.
  const platformSummaryPromise = fetchPlatformSummary(accessToken);

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

  // Gather every extra context block BEFORE assembling the final message
  // array, not appended after — groq/compound requires the conversation's
  // LAST message to have role 'user' (the previous plain models tolerated
  // a trailing system message; compound doesn't). All context goes
  // between the main system prompt and the actual conversation history,
  // so the real user message always ends up last.
  const extraContext = [];

  const oddsData = await oddsPromise;
  if(oddsData){
    extraContext.push({ role: 'system', content: formatOddsForPrompt(oddsSport, oddsData) });
  }

  const ladderData = await ladderPromise;
  if(ladderData){
    extraContext.push({ role: 'system', content: formatLadderForPrompt(ladderData) });
  }

  const platformSummary = await platformSummaryPromise;
  if(platformSummary){
    extraContext.push({
      role: 'system',
      content: `Real MLSynd syndicate data — current season standings, records, and dues status for the group (not a guess, pull straight from the ledger; use it for banter, roasting, "who's the worst punter", answering questions about anyone's form or record, or pointing out who owes money):\n${platformSummary}`
    });
  }

  // A one-off instruction for this reply only — not baked into the system
  // prompt itself, so it never repeats on later messages once the bonus
  // has already been mentioned.
  if(bonusAwarded){
    extraContext.push({
      role: 'system',
      content: `Before anything else, tell this member — in your own Syndy voice, banter and all — that they've just scored a one-off 500 XP Casino bonus for trying you out for the first time. Keep it short, then answer whatever they actually asked.`
    });
  }

  const groqMessages = [
    { role: 'system', content: SYNDY_SYSTEM_PROMPT },
    ...extraContext,
    ...trimmedHistory
  ];

  const FALLBACK_MODEL = 'openai/gpt-oss-120b'; // no web search, but reliable — used if groq/compound rejects the request shape/size, so a hiccup there never means a dead end for the member

  async function callGroq(model, useCompoundTools){
    const body = {
      model,
      messages: groqMessages,
      temperature: 0.8,
      max_tokens: 1200 // 700 was still cutting a genuine 5-leg multi off after 2 legs — a real multi-leg breakdown with per-leg reasoning needs real room, especially through groq/compound where search results also eat into the exchange
      // frequency_penalty deliberately removed — it was punishing the repeated | and - characters a markdown table needs, causing the model to just stop rather than "repeat" them. The loop-detection regex below already catches the actual repetition-glitch failure mode without this collateral damage.
    };
    if(useCompoundTools){
      body.compound_custom = { tools: { enabled_tools: ['web_search', 'visit_website'] } }; // restricts compound to search-related tools only — code_execution and browser automation aren't relevant here
    }
    return fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify(body)
    });
  }

  try{
    let groqRes = await callGroq(GROQ_MODEL, true);
    let usedFallback = false;
    if(!groqRes.ok && GROQ_MODEL !== FALLBACK_MODEL){
      const firstErrText = await groqRes.text();
      console.warn('groq/compound request failed, retrying with fallback model:', groqRes.status, firstErrText);
      groqRes = await callGroq(FALLBACK_MODEL, false);
      usedFallback = true;
    }
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
    let reply = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if(!reply){
      return new Response(JSON.stringify({ error: "Didn't quite catch that — give it another go." }), { status: 502 });
    }
    // Safety net on top of frequency_penalty — if the same short
    // character/token run still repeats 8+ times in a row (the exact
    // "c-c-c-c-c..." failure mode seen), cut the reply off right before
    // the loop starts rather than showing the garbage tail. A clean,
    // possibly-shorter reply beats a technically-complete broken one.
    const loopMatch = reply.match(/(.{1,6}?)\1{7,}/);
    if(loopMatch){
      reply = reply.slice(0, loopMatch.index).trim();
      if(!reply) reply = "Lost the plot for a sec there, mate — give that another crack.";
    }
    return new Response(JSON.stringify({ reply, bonusAwarded }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }catch(e){
    console.error('Syndy chat failed:', e);
    return new Response(JSON.stringify({ error: "Something's carked it on Syndy's end — try again shortly." }), { status: 500 });
  }
};
