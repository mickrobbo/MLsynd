// netlify/functions/scan-slip.mjs
//
// Reads Sportsbet bet slip screenshots and returns what's on them as
// structured data, so Admin can fill in the group multi or an individual
// bet without typing it all out. Nothing is saved here: Admin shows the
// result and the admin confirms it before anything is written.
//
// Client sends: { idToken, images: ["data:image/jpeg;base64,...", ...] }
// (up to 4 screenshots, e.g. a long multi split across two).
//
// Auth: the Firebase ID token is checked with Google (accounts:lookup) and
// only the admin account may scan, so nobody else can run up the bill.
//
// Needs ANTHROPIC_API_KEY (console.anthropic.com → API keys) and the
// existing FIREBASE_WEB_API_KEY. SLIP_SCAN_MODEL can override the model.

import { getFirebaseAccessToken } from './lib/firebase-token.mjs';

const ADMIN_EMAIL = 'mlsynd00@gmail.com';
const FIREBASE_URL = 'https://mlsynd-default-rtdb.firebaseio.com';
// Anthropic list prices, USD per million tokens (platform.claude.com pricing
// page, checked Oct 2026). Used to work out what each scan cost from the
// token counts the API reports. Override with ANTHROPIC_PRICE_IN /
// ANTHROPIC_PRICE_OUT if the prices change or a different model is used.
const PRICES = {
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
  'claude-haiku-5-5': [0.10, 0.50],
  'claude-fable-5-1': [10, 50],
};
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const MAX_IMAGES = 4;
const MAX_BODY_CHARS = 5_500_000; // Netlify's request limit is 6 MB

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function verifyAdmin(idToken){
  const key = process.env.FIREBASE_WEB_API_KEY;
  if(!key) throw new Error('FIREBASE_WEB_API_KEY not set');
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
  });
  if(!res.ok) return false;
  const data = await res.json();
  const user = data.users && data.users[0];
  return !!(user && String(user.email || '').toLowerCase() === ADMIN_EMAIL);
}

const PROMPT = `You are reading screenshots of Sportsbet (Australian bookmaker) bet slips from a betting syndicate's app.
Read every bet visible across all the screenshots. Screenshots may be parts of the same long bet (a multi split over several images): merge those into one bet and never list a leg twice. Different bets (separate bet receipts, separate stakes) are separate entries.

Return ONLY a JSON object, no other text, in exactly this shape:
{
  "bets": [
    {
      "type": "multi" | "same_game_multi" | "single" | "other",
      "status": "pending" | "won" | "lost" | "void" | "cashed_out" | "partial",
      "stake": number | null,            // amount staked in dollars
      "bonus_bet": boolean,              // true if placed with a bonus bet / bonus cash
      "combined_odds": number | null,    // total odds shown for the bet
      "potential_return": number | null, // "Potential return" / "To win" amount shown, in dollars
      "paid_return": number | null,      // amount actually paid out if settled (0 if lost), null if not shown
      "legs": [
        {
          "selection": string,           // e.g. "Collingwood", "Over 45.5", "Nick Daicos 30+ disposals"
          "market": string | null,       // e.g. "Head to Head", "Line", "Disposals"
          "event": string | null,        // e.g. "Collingwood v Carlton", or race name
          "odds": number | null,         // this leg's price
          "sport": string | null,        // one of: "AFL", "NRL", "Horse racing", "Greyhounds", "Harness racing", "Soccer", "Basketball", "Cricket", "Tennis", "American football", "Baseball", "Ice hockey", "Rugby union", "Golf", "Motorsport", "Combat sports", "Other"
          "team": string | null,         // the team, player or runner this leg is backing, cleanly named (e.g. "Collingwood", "Nick Daicos", "Winx"); null for totals/over-unders on a whole game
          "kind": "head_to_head" | "line" | "total" | "player" | "racing" | "other",  // head_to_head = to win; line = handicap/margin; total = over/under; player = player stat or scorer; racing = win/place on a runner
          "result": "won" | "lost" | "void" | "pending" | null  // from ticks/crosses/labels; null if unclear
        }
      ]
    }
  ],
  "warnings": [string]                   // anything unclear: cut-off legs, unreadable odds, etc.
}

Rules:
- Odds are decimal (e.g. 1.85). Money values are plain numbers without $.
- A green tick or "Won" means won; a red cross or "Lost" means lost; "Void"/"Scratched"/"Refunded" means void; no mark on an open bet means pending.
- If a value isn't visible, use null rather than guessing, and add a warning.
- For a same game multi, list each selection inside it as a leg.`;

// Adds this scan to the shared running-costs tally at /apiUsage/anthropic
// (read by Admin → Running costs). Written with the service account, so
// members can read it but nobody can edit it from the app.
async function trackAnthropicUsage(model, usage){
  try{
    const inTok = (usage && (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)) || 0;
    const outTok = (usage && usage.output_tokens) || 0;
    const [pin, pout] = PRICES[model] || PRICES[DEFAULT_MODEL];
    const priceIn = Number(process.env.ANTHROPIC_PRICE_IN) || pin;
    const priceOut = Number(process.env.ANTHROPIC_PRICE_OUT) || pout;
    const cost = (inTok * priceIn + outTok * priceOut) / 1e6;
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
    const monthKey = `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
    const token = await getFirebaseAccessToken();
    const url = (path) => `${FIREBASE_URL}/apiUsage/anthropic${path}.json?access_token=${token}`;
    const cur = await fetch(url('')).then(r => r.ok ? r.json() : null).catch(() => null) || {};
    const m = (cur.byMonth && cur.byMonth[monthKey]) || {};
    const patch = {
      totalCalls: (cur.totalCalls || 0) + 1,
      totalCostUsd: (cur.totalCostUsd || 0) + cost,
      totalInputTokens: (cur.totalInputTokens || 0) + inTok,
      totalOutputTokens: (cur.totalOutputTokens || 0) + outTok,
      lastCallAt: Date.now(),
      lastModel: model,
      [`byMonth/${monthKey}`]: { calls: (m.calls || 0) + 1, costUsd: (m.costUsd || 0) + cost, inputTokens: (m.inputTokens || 0) + inTok, outputTokens: (m.outputTokens || 0) + outTok },
    };
    await fetch(url(''), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  }catch(e){
    console.error('Anthropic usage tracking failed:', e.message);
  }
}

function extractJson(text){
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if(start < 0 || end <= start) return null;
  try{ return JSON.parse(text.slice(start, end + 1)); }catch(e){ return null; }
}
const num = (v) => { const n = typeof v === 'string' ? parseFloat(v.replace(/[^\d.-]/g, '')) : v; return typeof n === 'number' && isFinite(n) ? n : null; };
function clean(data){
  const RES = ['won', 'lost', 'void', 'pending'];
  const bets = (Array.isArray(data && data.bets) ? data.bets : []).map(b => ({
    type: String(b.type || 'other'),
    status: String(b.status || 'pending'),
    stake: num(b.stake),
    bonus_bet: !!b.bonus_bet,
    combined_odds: num(b.combined_odds),
    potential_return: num(b.potential_return),
    paid_return: num(b.paid_return),
    legs: (Array.isArray(b.legs) ? b.legs : []).map(l => ({
      selection: String(l.selection || '').slice(0, 120),
      market: l.market ? String(l.market).slice(0, 80) : null,
      event: l.event ? String(l.event).slice(0, 120) : null,
      odds: num(l.odds),
      result: RES.includes(l.result) ? l.result : null,
      sport: l.sport ? String(l.sport).slice(0, 40) : null,
      team: l.team ? String(l.team).slice(0, 80) : null,
      kind: ['head_to_head', 'line', 'total', 'player', 'racing', 'other'].includes(l.kind) ? l.kind : null,
    })).filter(l => l.selection || l.odds),
  })).filter(b => b.legs.length || b.stake != null);
  const warnings = (Array.isArray(data && data.warnings) ? data.warnings : []).map(w => String(w).slice(0, 200)).slice(0, 10);
  return { bets, warnings };
}

export default async (req) => {
  if(req.method !== 'POST') return json(405, { error: 'POST only' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if(!apiKey) return json(500, { error: 'Slip scanning isn\'t set up yet: add ANTHROPIC_API_KEY in Netlify (Site configuration → Environment variables), then redeploy.' });
  let body;
  try{
    const raw = await req.text();
    if(raw.length > MAX_BODY_CHARS) return json(413, { error: 'Those screenshots are too large together. Try fewer at once.' });
    body = JSON.parse(raw);
  }catch(e){ return json(400, { error: 'Bad request' }); }

  try{ if(!(await verifyAdmin(body.idToken))) return json(403, { error: 'Only the admin account can scan slips.' }); }
  catch(e){ return json(500, { error: 'Could not check your sign-in: ' + e.message }); }

  const images = (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES)
    .map(d => { const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(String(d)); return m ? { media_type: m[1], data: m[2] } : null; })
    .filter(Boolean);
  if(!images.length) return json(400, { error: 'No slip images received.' });

  const content = [
    ...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })),
    { type: 'text', text: PROMPT },
  ];
  let res;
  const model = process.env.SLIP_SCAN_MODEL || DEFAULT_MODEL;
  try{
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 3000, messages: [{ role: 'user', content }] }),
    });
  }catch(e){ return json(502, { error: 'Could not reach the slip reader. Try again.' }); }
  const out = await res.json().catch(() => null);
  if(!res.ok){
    const msg = out && out.error && out.error.message ? out.error.message : `HTTP ${res.status}`;
    return json(502, { error: 'The slip reader returned an error: ' + msg });
  }
  // the call was billed whether or not the reply is usable, so count it now
  await trackAnthropicUsage(model, out && out.usage);
  const text = (out && Array.isArray(out.content) ? out.content : []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  const parsed = extractJson(text);
  if(!parsed) return json(502, { error: 'Couldn\'t make sense of that slip. Try a clearer or uncropped screenshot.' });
  return json(200, clean(parsed));
};
