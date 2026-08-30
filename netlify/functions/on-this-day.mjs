// netlify/functions/on-this-day.js
// Rebuilt from scratch — the previous version's source isn't available
// to inspect or patch here, and the reported symptom ("used to show
// real sports facts, now it's all over the shop") matches exactly what
// a non-search-grounded LLM call does: it fabricates specifics with
// total confidence. syndy-chat.mjs's own comments describe hitting
// this exact failure mode in an earlier build, before switching to
// Perplexity's Agent API specifically for guaranteed real web search on
// every call. Built on that same pattern here — "today's date" and
// "what actually happened" are both real search results, not generated
// text — rather than risk repeating the same failure with a plain
// completion call.
//
// No auth required — this is a generic "what happened in sports on
// today's date" lookup, not personalized or sensitive, matching how the
// client already calls it (plain fetch, no idToken).
//
// Cached server-side per calendar date in Firebase, shared across every
// member rather than per-device — the fact for a given date doesn't
// depend on who's asking, so there's no reason for up to 11 separate
// Perplexity calls a day for the same answer. The client also keeps its
// own 20-hour local cache on top of this, so in practice this function
// runs once a day for the whole group, not once per device.
//
// Needs the same PERPLEXITY_API_KEY already set for syndy-chat.mjs, and
// the same FIREBASE_DB_SECRET every other function here uses. No new
// env vars — caching degrades gracefully to "no cache, call Perplexity
// every time" if DB_SECRET isn't set, rather than failing outright.

const FIREBASE_URL = "https://mlsynd-default-rtdb.firebaseio.com";
const DB_SECRET = process.env.FIREBASE_DB_SECRET;

async function dbGet(path) {
  if (!DB_SECRET) return null;
  try {
    const res = await fetch(`${FIREBASE_URL}${path}.json?auth=${DB_SECRET}`);
    if (!res.ok) return null;
    return res.json();
  } catch (e) {
    return null;
  }
}
async function dbPut(path, value) {
  if (!DB_SECRET) return;
  try {
    await fetch(`${FIREBASE_URL}${path}.json?auth=${DB_SECRET}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  } catch (e) { /* cache write failing shouldn't break the actual response */ }
}

// AEST/AEDT-pinned, matching how every other date-keyed thing in this
// app is scoped (the Casino pot's month key, the Board's week key) —
// the real authority is Melbourne's calendar day, not whichever
// timezone a given request happens to arrive from.
function todayDateKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function todayDateLabel() {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne", month: "long", day: "numeric",
  }).format(new Date());
}

const SYSTEM_PROMPT = `You find one genuinely notable sports event, record, or scandal that happened on a specific calendar date in a past year. Search the real web for this — never invent or guess a date or detail.

What counts: results, records, injuries, retirements, deaths, doping busts, match-fixing, brawls, controversial officiating, suspensions, contract sagas, or any other moment that was actually a big deal in sports at the time. Don't sanitize or soften it for politeness — a genuine scandal or controversy described plainly and factually is exactly what's wanted here, not a sanded-down version of it. What doesn't count: anything you're not confident actually happened on this exact date, or anything you'd have to guess the details of.

Reply with ONLY a JSON object, no other text, in exactly this shape:
{"found": true, "year": 1999, "text": "One or two sentences describing what happened, written plainly."}

If you genuinely can't find anything real and specific for this date, reply exactly:
{"found": false}`;

export default async (req) => {
  try {
    const dateKey = todayDateKey();
    const cached = await dbGet(`/onThisDayCache/${dateKey}`);
    if (cached) {
      return new Response(JSON.stringify(cached), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const perplexityKey = process.env.PERPLEXITY_API_KEY;
    if (!perplexityKey) {
      return new Response(JSON.stringify({ found: false }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const dateLabel = todayDateLabel();
    const perplexityRes = await fetch("https://api.perplexity.ai/v1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${perplexityKey}` },
      body: JSON.stringify({
        preset: "fast",
        instructions: SYSTEM_PROMPT,
        input: [{ role: "user", content: `Today's date is ${dateLabel}. Find one genuinely notable sports event, record, or scandal that happened on this exact date (month and day) in a past year.` }],
        max_output_tokens: 300,
      }),
    });

    let data = null;
    try { data = await perplexityRes.json(); } catch (e) { /* error responses aren't always JSON */ }
    if (!perplexityRes.ok || !data) {
      console.error("on-this-day: Perplexity call failed", perplexityRes.status);
      return new Response(JSON.stringify({ found: false }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const messageItem = Array.isArray(data.output) ? data.output.find(o => o && o.type === "message") : null;
    const raw = messageItem && Array.isArray(messageItem.content) && messageItem.content[0] && messageItem.content[0].text;
    if (!raw) {
      return new Response(JSON.stringify({ found: false }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    let parsed;
    try {
      // Strips markdown code fences if the model wrapped the JSON in
      // them despite the "ONLY a JSON object" instruction — cheap
      // insurance, costs nothing if it wasn't actually needed.
      const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("on-this-day: could not parse Perplexity output as JSON:", raw.slice(0, 200));
      return new Response(JSON.stringify({ found: false }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    const result = (parsed && parsed.found && parsed.year && parsed.text)
      ? { found: true, year: Number(parsed.year), text: String(parsed.text).slice(0, 400) }
      : { found: false };

    await dbPut(`/onThisDayCache/${dateKey}`, result);
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("on-this-day error:", err.message);
    return new Response(JSON.stringify({ found: false }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
};
