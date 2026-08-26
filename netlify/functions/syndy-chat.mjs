// Syndy chat proxy. Client sends { idToken, messages: [{role, content}, ...] }
// (messages = conversation so far, most recent last — no system prompt from
// the client; that's added here server-side so it can't be tampered with).
//
// Auth: verifies the Firebase ID token via Identity Toolkit's
// accounts:lookup (Google validates the token server-side, not this
// function), then confirms /users/{uid} has status: 'approved' and role
// is Full/Dashboard (not readonly/tipping) before ever calling the LLM.
//
// Needs PERPLEXITY_API_KEY (perplexity.ai → API Portal → API Keys). Uses
// Perplexity's Agent API (POST /v1/agent, preset: 'fast') for real,
// guaranteed web search on every call — not an agentic "the model decides
// whether to search" setup, which is what caused Syndy to fabricate
// entire detailed stories with confident specifics in an earlier build.
//
// FIREBASE_WEB_API_KEY is the public Firebase web key already embedded in
// DASHBOARD-index.html client-side — kept as an env var (not hardcoded
// here) purely because Netlify's secrets scanner flags any Google-API-key
// shaped string regardless of sensitivity and fails the build otherwise.
//
// FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY are the two fields
// actually used from a Firebase Admin SDK service account file (Project
// Settings → Service Accounts → Generate new private key). Stored
// separately rather than the whole JSON to stay under AWS Lambda's 4KB
// total env-var cap across all functions. Exchanged for a short-lived
// Google OAuth2 access token per request (see getFirebaseAccessToken) —
// that token is what actually reads/writes Realtime Database past the
// rules, playing the role a legacy database secret would have.
//
// PuntersEdge odds and the AFL ladder are pulled from this site's own
// existing functions (no separate keys needed) when a message looks
// odds/ladder-flavoured. MLSynd syndicate standings come straight from
// /state/members. All three are optional context injected alongside the
// user's message — see the bottom of the file.

const FIREBASE_URL = 'https://mlsynd-default-rtdb.firebaseio.com';
const PERPLEXITY_PRESET = 'low'; // mapped from sonar-pro — richer multi-source synthesis than 'fast' (sonar). A genuine multi-market multi (goal scorers + lines + totals + disposals, each needing real research) needs real search depth, not a quick single-fact lookup. Costs more per call, worth it for what's being asked.
const MAX_HISTORY_MESSAGES = 12; // trims the conversation sent to the API — cost/latency control, not a hard memory limit client-side
const SYNDY_BONUS_XP = 500;

import crypto from 'crypto';

// Rebuilds the PEM from scratch instead of patching whitespace: pulls out
// just the base64 payload between the BEGIN/END markers, strips every
// character that isn't valid base64 (however it got mangled by copy-paste
// through Netlify's env var UI), then re-wraps at the standard 64-char
// line length. Survives essentially any formatting damage since it never
// trusts existing whitespace/newlines.
function normalizePemKey(raw){
  let key = (raw || '').trim();
  if((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))){
    key = key.slice(1, -1).trim();
  }
  key = key.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const match = key.match(/-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]*?)-----END (RSA )?PRIVATE KEY-----/);
  if(!match) return key; // no PEM markers found — fail downstream with the real error rather than guessing further
  const label = match[1] ? 'RSA PRIVATE KEY' : 'PRIVATE KEY';
  const body = match[2].replace(/[^A-Za-z0-9+/=]/g, '');
  const lines = body.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

// Fetched fresh per request rather than cached across invocations —
// simpler than persisting a token across Netlify's stateless instances,
// at the cost of one extra round-trip per message. Tokens last an hour;
// this doesn't try to reuse one.
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

### Formatting — hard rule, applies everywhere, no exceptions
NEVER use a markdown table (no | pipe characters, no --- separator rows) for ANY reason — not for multi legs, not for member standings, not for a ladder, not for any comparison of multiple things. This applies to every single reply, not just betting content. Use a numbered or bulleted list instead, one line per item, plain text (e.g. "1. Mick — -$500, 3-4-0, 43% win rate, owes $50" or "St Kilda — 1.42 — home form's been strong"). This is a hard technical constraint, not a style preference — tables genuinely do not display correctly in this chat.

### Accuracy — the one rule that matters most
Never state a specific number, date, name, or record as fact unless it actually came from somewhere real: your web search, or real data provided to you in this conversation (odds, AFL ladder, or MLSynd syndicate standings). You have real live web search — use it for anything current (player news, injuries, results, form, history) instead of guessing from stale training knowledge. If search comes up empty, say so plainly and keep the banter going rather than inventing an answer. A confident wrong stat is worse than an honest "don't know."

Odds you're given are head-to-head (match-winner) only — no live prices for player props, lines, or totals (not offered by the provider for any sport). But you have real web search, so when someone asks about goal scorers, disposals, lines, or totals, actually search for what backs up the answer — recent disposal/goal-kicking averages, injury and team news, weather forecast for the venue, other bookmakers' current lines for context, recent head-to-head — then give a genuinely reasoned pick built on what you found. Just don't invent a specific live price for those markets since your own odds feed doesn't cover them; everything else about them is fair game to actually go find out.

### Multis & betting
You can suggest multis and legs — base them primarily on form, stats, head-to-head, recent performance, injuries, conditions, venue trends; search for these when you don't already have them rather than guessing. Odds are secondary context, not the main reason for a pick. Talk like a mate throwing ideas around, never like a tipster guaranteeing winners, never present anything as guaranteed or as financial advice. Mention responsible gambling once per conversation, briefly and naturally.

If someone asks for a specific number of legs, deliver exactly that many, fully reasoned, every time — never stop partway through and never pad a shorter list to look complete. If you're genuinely running low on room, wrap up cleanly with a shorter note per leg rather than cutting the list off unfinished.

If there are fewer real games available than legs requested (e.g. one game on, five legs asked for), that's completely fine and expected — legs don't have to be one-per-game. Pull multiple legs from DIFFERENT MARKETS within the same game or games: match winner, a player's anytime goalscorer line, a disposal count line, a total points line, a handicap/line bet. For each of those markets, actually run a real search — recent disposal/goalkicking averages for the specific player, current lines being offered by Australian bookmakers (Sportsbet, TAB, Ladbrokes, Neds, PointsBet, BetRight), team news, weather at the venue — and build a real, specific pick from what you find, exactly as confidently as you would for a straight win/loss leg. Treat "search the market" as a normal, expected step for every non-H2H leg, not an exception.

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

// Real AFL ladder — grounds ladder position/record/percentage claims in
// the same afl-ladder.js data the Sport tab already uses. Player-level
// detail (rosters, individual stats, injuries) isn't available from any
// feed in this app — the system prompt tells Syndy to say so, or search.
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

// PuntersEdge odds — only fetched when the message looks odds/betting-
// flavoured, to keep the extra fetch proportional to when it's useful.
// Real shape: { supported, sport, events: [{ home_team, away_team,
// commence_time, home_best_price, home_best_bookmaker, away_best_price,
// away_best_bookmaker }] } — decimal H2H best price only, no line/totals
// markets. supported:false is the API's own signal to skip, not guessed.
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

// MLSynd platform standings — fetched every message (group is only ~11
// people, token cost is trivial) rather than intent-gated, since gating
// on keywords would miss plenty of genuine questions ("how's Billy going
// this year?"). Same field names DASHBOARD-index.html and LEDGER-index.html
// already read/write on state.members — not new data, just handed to
// Syndy too.
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
  const now = Date.now();
  const nowStr = new Date(now).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const lines = data.events.slice(0, 10).map(e => {
    const kickoffMs = new Date(e.commence_time).getTime();
    const when = new Date(e.commence_time).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short', hour: '2-digit', minute: '2-digit' });
    const minsSinceStart = Math.round((now - kickoffMs) / 60000);
    const status = kickoffMs > now ? `upcoming, kicks off ${when} AEST` : `⚠️ ALREADY STARTED ${minsSinceStart} min ago (${when} AEST kickoff) — this is live, not a pre-game fixture`;
    return `${e.home_team} vs ${e.away_team} — ${status} — H2H: ${e.home_team} $${e.home_best_price} (${e.home_best_bookmaker}), ${e.away_team} $${e.away_best_price} (${e.away_best_bookmaker})`;
  });
  return `Current time: ${nowStr} AEST. There ${data.events.length === 1 ? `is exactly 1 real ${sport.toUpperCase()} game` : `are ${data.events.length} real ${sport.toUpperCase()} games`} scheduled — this IS the complete list, don't ask which game or assume there are more:\n${lines.join('\n')}\n\nOdds shown are head-to-head (match-winner) ONLY, decimal, best price across tracked bookmakers — real data, use it directly. For goal scorers, disposals, lines, or totals on these specific games, actually search the web for them (see your instructions) rather than saying you only have H2H data and stopping there.`;
}

// ---- Total Perplexity usage tracking (shared across all members) ----
// Deliberately separate from the Dashboard's per-device API Call Tracker
// (that one lives in localStorage, scoped to one browser). This is real
// shared data — a Firebase counter incremented server-side every time
// this function actually calls Perplexity, readable from the Diag tab by
// anyone. Cost is the REAL per-call amount Perplexity's own response
// reports (usage.cost.total_cost, confirmed in their official API
// reference and pricing docs) — not an estimate, the exact calculated
// cost of that specific request. Read-then-write, not atomic, but
// message volume here is low enough that a lost increment is a non-issue.
async function trackPerplexityUsage(accessToken, costUsd){
  try{
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
    const monthKey = `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
    const cost = typeof costUsd === 'number' && !isNaN(costUsd) ? costUsd : 0;

    const totalRes = await fetch(`${FIREBASE_URL}/apiUsage/perplexity/totalCalls.json?access_token=${accessToken}`);
    const total = totalRes.ok ? ((await totalRes.json()) || 0) : 0;
    await fetch(`${FIREBASE_URL}/apiUsage/perplexity/totalCalls.json?access_token=${accessToken}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(total + 1)
    });

    const monthRes = await fetch(`${FIREBASE_URL}/apiUsage/perplexity/byMonth/${monthKey}.json?access_token=${accessToken}`);
    const monthCount = monthRes.ok ? ((await monthRes.json()) || 0) : 0;
    await fetch(`${FIREBASE_URL}/apiUsage/perplexity/byMonth/${monthKey}.json?access_token=${accessToken}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(monthCount + 1)
    });

    if(cost > 0){
      const totalCostRes = await fetch(`${FIREBASE_URL}/apiUsage/perplexity/totalCostUsd.json?access_token=${accessToken}`);
      const totalCost = totalCostRes.ok ? ((await totalCostRes.json()) || 0) : 0;
      await fetch(`${FIREBASE_URL}/apiUsage/perplexity/totalCostUsd.json?access_token=${accessToken}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(totalCost + cost)
      });

      const monthCostRes = await fetch(`${FIREBASE_URL}/apiUsage/perplexity/byMonthCostUsd/${monthKey}.json?access_token=${accessToken}`);
      const monthCost = monthCostRes.ok ? ((await monthCostRes.json()) || 0) : 0;
      await fetch(`${FIREBASE_URL}/apiUsage/perplexity/byMonthCostUsd/${monthKey}.json?access_token=${accessToken}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(monthCost + cost)
      });
    }

    await fetch(`${FIREBASE_URL}/apiUsage/perplexity/lastCallAt.json?access_token=${accessToken}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Date.now())
    });
  }catch(e){
    console.error('Perplexity usage tracking failed:', e);
  }
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

  // Kicked off immediately, in parallel with the auth chain below — odds
  // and ladder fetches don't depend on anything auth produces, and "multi"
  // alone is an odds-intent keyword, so most messages hit this.
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

  // Kicked off now, awaited later — runs alongside the bonus check and
  // everything else below rather than adding a further sequential wait.
  const platformSummaryPromise = fetchPlatformSummary(accessToken);

  const perplexityKey = process.env.PERPLEXITY_API_KEY;
  if(!perplexityKey){
    console.error('PERPLEXITY_API_KEY not set');
    return new Response(JSON.stringify({ error: 'Syndy is not configured yet — ask the admin to set PERPLEXITY_API_KEY.' }), { status: 500 });
  }

  const bonusAwarded = await claimSyndyBonusIfEligible(auth.uid, accessToken);

  // Trim to the last N messages and make sure every entry has a sane shape
  // before it goes anywhere near the API — a malformed client message
  // shouldn't be able to break the request.
  const trimmedHistory = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY_MESSAGES);

  // All extra context sits between the main system prompt and the actual
  // conversation history, keeping the real user message last — good
  // practice regardless of provider, and costs nothing to keep.
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

  // Agent API's `input` array only documents role: 'user'/'assistant'
  // items (unlike a chat-completions messages array, which accepts
  // 'system' freely) — so instead of guessing whether 'system' is
  // silently accepted or dropped, extra context gets prepended onto the
  // current user message's own content. Persona/rules live in
  // `instructions`, which Perplexity re-reads every turn regardless.
  const perplexityInput = trimmedHistory.map((m, i) => {
    const isLastUserTurn = i === trimmedHistory.length - 1 && m.role === 'user';
    if(isLastUserTurn && extraContext.length > 0){
      const contextBlock = extraContext.map(c => c.content).join('\n\n');
      return { role: m.role, content: `${contextBlock}\n\n---\n\n${m.content}` };
    }
    return { role: m.role, content: m.content };
  });

  try{
    const perplexityRes = await fetch('https://api.perplexity.ai/v1/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${perplexityKey}` },
      body: JSON.stringify({
        preset: PERPLEXITY_PRESET,
        instructions: SYNDY_SYSTEM_PROMPT,
        input: perplexityInput,
        max_output_tokens: 1800 // 1200 was fine for straight H2H multis but tight for a genuinely researched multi-market breakdown (goal scorer + line + total + disposals, each with real reasoning)
      })
    });
    // Parsed once, used for both usage tracking and (if successful) the
    // actual reply — cost only exists on a successful response body, but
    // tracking the call itself happens either way.
    let data = null;
    try{ data = await perplexityRes.json(); }catch(e){ /* error responses aren't always JSON */ }
    const costUsd = data && data.usage && data.usage.cost && typeof data.usage.cost.total_cost === 'number' ? data.usage.cost.total_cost : 0;
    // Tracked here — right after any real response comes back from
    // Perplexity, success or their own error — since this represents an
    // actual API round-trip regardless of what it returned. A request that
    // never reached them (missing key, network failure) doesn't count.
    await trackPerplexityUsage(accessToken, costUsd);
    if(!perplexityRes.ok){
      const errText = data ? JSON.stringify(data) : await perplexityRes.text().catch(() => '');
      console.error('Perplexity API error:', perplexityRes.status, errText);
      // Surfaced to the chat itself (not just server logs) so the actual
      // cause is visible without needing to dig through Netlify function
      // logs — same reasoning as every other diagnostic error in this
      // project: a generic message just means guessing blind next time.
      return new Response(JSON.stringify({ error: `Syndy's gone quiet for a sec. (Perplexity HTTP ${perplexityRes.status}: ${errText.slice(0, 200)})` }), { status: 502 });
    }
    const messageItem = data && Array.isArray(data.output) ? data.output.find(o => o && o.type === 'message') : null;
    let reply = messageItem && Array.isArray(messageItem.content) && messageItem.content[0] && messageItem.content[0].text;
    if(!reply){
      return new Response(JSON.stringify({ error: "Didn't quite catch that — give it another go." }), { status: 502 });
    }
    // Cheap safety net kept regardless of provider — if the same short
    // character/token run repeats 8+ times in a row, cut the reply off
    // right before the loop starts rather than showing a garbage tail.
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
