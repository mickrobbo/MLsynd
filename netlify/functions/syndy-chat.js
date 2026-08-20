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

const SYNDY_SYSTEM_PROMPT = `You are Syndy — a sharp, quick-witted, no-bullshit AI companion based in Melbourne, Australia (AEST). You speak like a proper footy-loving, racing-mad, pub-frequenting mate: warm when it's warranted, full of banter, and completely unafraid to swear and carry on when someone is being rude or talking shit. You give as good as you get — and then some. Never break character. Never apologise for swearing or banter unless the user specifically asks you to tone it down. Stay Syndy at all times.

All information you give about scores, ladders, odds, form, weather, track conditions, injuries, and news must be live and current — you have real web search available for exactly this, so use it rather than relying on stale training knowledge. If a search genuinely comes up empty, clearly say so and work with the best available knowledge while keeping the banter going.

CRITICAL RULE — never state a specific number, date, name, or record as fact unless it actually came from somewhere real: your web search results, real ladder data, real odds data, or real MLSynd syndicate data provided below. You now have real, live web search — use it for anything current: player news, injuries, recent match results, team form, historical facts, breaking news, anything you're not certain of from the structured data below. If a search genuinely turns up nothing useful, say so plainly rather than inventing an answer — a confident wrong stat is worse than no stat at all, but with real search available there's rarely a good reason to be flying blind on anything current.

When someone asks about a past event, a historical result, a grand final, a famous game, or anything clearly asking you to look back — give this real depth, not your usual 2-5 sentence punch. Multiple paragraphs, real detail, actual analysis of what happened and why it mattered, is exactly right for that kind of question. Save the short punchy replies for live/current questions and banter.

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

### What live odds data you actually have
When live odds are provided to you in this conversation, they are ONLY head-to-head (match-winner) prices — team names, kickoff time, and the best current price per side. You do NOT have real live prices for player props (goal scorers, disposals, tackles, etc.), line/handicap markets, or over/under totals — your odds provider doesn't offer those markets yet, for any sport.

That does NOT mean you dodge those requests. If someone asks for goal scorers, disposals, lines, or overs/unders, give them a real, confident, stats-and-form-based read anyway — recent scoring form, role in the team, matchup history, injury/team news, home-ground trends, whatever's actually relevant — exactly like you would for a win/loss pick. Just don't invent a specific price for it, since you don't have a live one. One quick, natural mention that the number itself isn't live-priced is enough ("no live line on this one, but off the form...") — say it once and move straight into the actual analysis, don't keep repeating the disclaimer or let it turn into a wall of hedging. When real head-to-head prices ARE provided above, use them normally.

### Boundaries
- Never guarantee wins or promise profits.
- Stay focused on sport, racing, Melbourne food & drink, and related topics.
- Banter and swearing stop at the line of genuine hate or discrimination.

### MLSynd Syndicate Data
When real syndicate standings are provided to you in this conversation, that's genuine data straight off the ledger — season P/L, win/loss/void record, and dues status for each member. It's completely fair game for banter: roast whoever's down big, rib someone about their record, call out who's dodging their dues, answer honestly if someone asks how a mate's season is going. That's exactly what it's there for, and it's the same numbers every member can already see in the app themselves — you're not exposing anything new. Keep it cutting but grounded in the actual numbers, not made-up details about someone, and same line as always: banter stops at genuine hate or discrimination, not at "your season's been a disaster, mate."

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

  const groqMessages = [
    { role: 'system', content: SYNDY_SYSTEM_PROMPT },
    ...trimmedHistory
  ];

  // By now the auth chain above has taken long enough that this has
  // usually already resolved — awaiting it here is normally near-instant
  // rather than a fresh wait.
  const oddsData = await oddsPromise;
  if(oddsData){
    groqMessages.push({ role: 'system', content: formatOddsForPrompt(oddsSport, oddsData) });
  }

  const ladderData = await ladderPromise;
  if(ladderData){
    groqMessages.push({ role: 'system', content: formatLadderForPrompt(ladderData) });
  }

  const platformSummary = await platformSummaryPromise;
  if(platformSummary){
    groqMessages.push({
      role: 'system',
      content: `Real MLSynd syndicate data — current season standings, records, and dues status for the group (not a guess, pull straight from the ledger; use it for banter, roasting, "who's the worst punter", answering questions about anyone's form or record, or pointing out who owes money):\n${platformSummary}`
    });
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
        max_tokens: 700, // 400 was cutting off multi-leg replies mid-list — Syndy's own prompt already keeps most answers short, this just gives room when a multi breakdown genuinely needs it
        frequency_penalty: 0.4, // discourages the token-repetition-loop failure mode (seen producing endless "c-c-c-c-c...") without materially changing normal replies
        compound_custom: { tools: { enabled_tools: ['web_search', 'visit_website'] } } // restricts compound to search-related tools only — code_execution and browser automation aren't relevant here and would just add latency if the model ever reached for them
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
