// netlify/functions/scan-lotto.mjs
//
// Reads Australian lottery ticket screenshots (Powerball, OzLotto, Saturday
// Lotto, Set for Life, Weekday Windfall...) for the Lotto Pigs group and
// returns the details as structured data: game, draw number and date, price,
// and every game's numbers. Nothing is saved here: Admin shows the result,
// checks it, and chooses to use it.
//
// Client sends: { idToken, images: ["data:image/jpeg;base64,..."], groups: [3,2] }
// groups = how many screenshots belong to each ticket, in order.
// Auth, cost tracking and the free repeat-read cache work exactly like scan-slip.

import crypto from 'crypto';
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
const MAX_IMAGES = 8;
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

const PROMPT = `You are reading screenshots of Australian lottery tickets (The Lott / Tabcorp: Powerball, OzLotto, Saturday Lotto, Monday & Wednesday Lotto, Set for Life, Weekday Windfall, Lucky Lotteries) for a small lotto group.
The screenshots are grouped into tickets. Screenshot groups are given below as counts in order (e.g. [3,2] = the first 3 screenshots are ONE ticket, the last 2 are another). Merge the screenshots of one ticket into one ticket entry and never list a game twice.

Return ONLY a JSON object, no other text, in exactly this shape:
{
  "tickets": [
    {
      "game": string | null,            // e.g. "Powerball", "OzLotto", "Saturday Lotto", "Set for Life"
      "draw_number": string | null,     // draw number as shown
      "draw_date": string | null,       // YYYY-MM-DD of the draw (first draw if several)
      "draws": number | null,           // how many consecutive draws the ticket covers, if shown
      "price": number | null,           // total ticket price in dollars
      "serial": string | null,          // ticket or serial number if clearly shown ("Ticket no.")
      "entry_type": string | null,      // e.g. "1 Draw, 36 Game Standard entry"
      "purchased": string | null,       // purchase date as shown, e.g. "Sun, 08 Nov 2026"
      "commission": number | null,      // commission included in the total cost, in dollars
      "jackpot": number | null,         // advertised division 1 / jackpot prize in dollars if shown
      "quick_pick": boolean | null,
      "entries": [
        {
          "label": string | null,       // game letter, e.g. "A", "B"
          "numbers": [number],          // main numbers in the order shown
          "extra": [number],            // Powerball number, or supplementary numbers; [] if none
          "extra_label": string | null  // "Powerball" or "Supps" etc
        }
      ],
      "result": {                       // only if the ticket has been checked / drawn and the screenshot shows it
        "status": "won" | "lost" | "pending" | null,
        "prize": number | null,         // total prize won in dollars
        "winning_numbers": [number],
        "winning_extra": [number]
      } | null
    }
  ],
  "warnings": [string]                  // anything unclear: cut-off numbers, unreadable draw date, etc.
}

Rules:
- Money values are plain numbers without $. Numbers must be integers.
- If a value isn't visible, use null rather than guessing, and add a warning.
- Read every game on the ticket carefully (tickets can have 30+ games and the screenshots repeat the page header and status bar, ignore those); double-check each number. For Powerball the final number on each game is the Powerball: put it in extra, not in numbers.
- price is the total cost shown for the ticket (including commission).`;

// Adds this scan to the shared running-costs tally at /apiUsage/anthropic
// (read by Admin → Running costs). Written with the service account, so
// members can read it but nobody can edit it from the app.
let fbToken = null;
async function fbAuth(){ if(!fbToken) fbToken = await getFirebaseAccessToken(); return fbToken; }

// v211: a slip that's already been read comes back from here for free
// instead of being sent to Anthropic again. Keyed by a hash of the images.
async function cacheGet(key){
  try{ const t = await fbAuth(); const r = await fetch(`${FIREBASE_URL}/lottoScanCache/${key}.json?access_token=${t}`); return r.ok ? await r.json() : null; }
  catch(e){ return null; }
}
async function cachePut(key, result){
  try{ const t = await fbAuth(); await fetch(`${FIREBASE_URL}/lottoScanCache/${key}.json?access_token=${t}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result, at: Date.now() }) }); }
  catch(e){ console.error('Lotto cache write failed:', e.message); }
}

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
    const token = await fbAuth();
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
const nums = (a) => (Array.isArray(a) ? a : []).map(num).filter(n => n != null && n >= 0 && n <= 99).map(Math.round).slice(0, 20);
const dateOk = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : null);
function clean(data){
  const tickets = (Array.isArray(data && data.tickets) ? data.tickets : []).map(t => ({
    game: t.game ? String(t.game).slice(0, 40) : null,
    draw_number: t.draw_number != null ? String(t.draw_number).slice(0, 20) : null,
    draw_date: dateOk(t.draw_date),
    draws: num(t.draws),
    price: num(t.price),
    serial: t.serial ? String(t.serial).slice(0, 40) : null,
    entry_type: t.entry_type ? String(t.entry_type).slice(0, 80) : null,
    purchased: t.purchased ? String(t.purchased).slice(0, 40) : null,
    commission: num(t.commission),
    jackpot: num(t.jackpot),
    quick_pick: typeof t.quick_pick === 'boolean' ? t.quick_pick : null,
    entries: (Array.isArray(t.entries) ? t.entries : []).slice(0, 40).map(e => ({
      label: e.label ? String(e.label).slice(0, 4) : null,
      numbers: nums(e.numbers),
      extra: nums(e.extra),
      extra_label: e.extra_label ? String(e.extra_label).slice(0, 20) : null,
    })).filter(e => e.numbers.length),
    result: t.result && typeof t.result === 'object' ? {
      status: ['won', 'lost', 'pending'].includes(t.result.status) ? t.result.status : null,
      prize: num(t.result.prize),
      winning_numbers: nums(t.result.winning_numbers),
      winning_extra: nums(t.result.winning_extra),
    } : null,
  })).filter(t => t.entries.length);
  const warnings = (Array.isArray(data && data.warnings) ? data.warnings : []).map(w => String(w).slice(0, 200)).slice(0, 10);
  return { tickets, warnings };
}

export default async (req) => {
  if(req.method !== 'POST') return json(405, { error: 'POST only' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if(!apiKey) return json(500, { error: 'Ticket reading isn\'t set up yet: add ANTHROPIC_API_KEY in Netlify (Site configuration → Environment variables), then redeploy.' });
  let body;
  try{
    const raw = await req.text();
    if(raw.length > MAX_BODY_CHARS) return json(413, { error: 'Those screenshots are too large together. Try fewer at once.' });
    body = JSON.parse(raw);
  }catch(e){ return json(400, { error: 'Bad request' }); }

  try{ if(!(await verifyAdmin(body.idToken))) return json(403, { error: 'Only the admin account can read tickets.' }); }
  catch(e){ return json(500, { error: 'Could not check your sign-in: ' + e.message }); }

  const images = (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES)
    .map(d => { const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(String(d)); return m ? { media_type: m[1], data: m[2] } : null; })
    .filter(Boolean);
  if(!images.length) return json(400, { error: 'No ticket images received.' });

  const groups = (Array.isArray(body.groups) ? body.groups : []).map(n => Math.max(1, parseInt(n, 10) || 1)).slice(0, 8);
  const cacheKey = crypto.createHash('sha256').update('v2|' + images.map(i => i.data).join('|') + '#' + groups.join(',')).digest('hex').slice(0, 40);
  if(!body.force){
    const hit = await cacheGet(cacheKey);
    if(hit && hit.result && Array.isArray(hit.result.tickets)) return json(200, { ...clean(hit.result), cached: true, cachedAt: hit.at || null }); // Firebase drops empty lists, so tidy it again
  }

  const content = [
    ...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })),
    { type: 'text', text: PROMPT + (groups.length ? `\n\nScreenshot groups (screenshots per ticket, in order): [${groups.join(',')}]` : '') },
  ];
  let res;
  const model = process.env.LOTTO_SCAN_MODEL || process.env.SLIP_SCAN_MODEL || DEFAULT_MODEL;
  try{
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 6000, messages: [{ role: 'user', content }] }),
    });
  }catch(e){ return json(502, { error: 'Could not reach the ticket reader. Try again.' }); }
  const out = await res.json().catch(() => null);
  if(!res.ok){
    const msg = out && out.error && out.error.message ? out.error.message : `HTTP ${res.status}`;
    return json(502, { error: 'The ticket reader returned an error: ' + msg });
  }
  // the call was billed whether or not the reply is usable, so count it now
  await trackAnthropicUsage(model, out && out.usage);
  const text = (out && Array.isArray(out.content) ? out.content : []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  const parsed = extractJson(text);
  if(!parsed) return json(502, { error: 'Couldn\'t make sense of that ticket. Try a clearer or uncropped screenshot.' });
  const result = clean(parsed);
  if(result.tickets.length) await cachePut(cacheKey, result);
  return json(200, result);
};
