// netlify/functions/on-this-day.js
// Pulls today's historical events from Wikipedia's free "on this day" feed,
// filters down to sport-related ones, and scores them for drama (scandals,
// records, disqualifications, etc.) so the most outrageous one wins rather
// than just whichever happened to be listed first.

const SPORT_KEYWORDS = [
  "olympic", "world cup", "championship", "football", "soccer", "afl",
  "nrl", "rugby", "cricket", "tennis", "golf", "boxing", "wrestl",
  "athlete", "stadium", "medal", "marathon", "hockey", "baseball",
  "basketball", "nba", "nfl", "swimming", "grand prix", "formula",
  "cyclist", "cycling", "sport", "tournament", "league", "coach",
  "referee", "umpire", "gymnast", "sprinter", "goalkeeper", "jockey",
];

const DRAMA_KEYWORDS = [
  "banned", "scandal", "disqualif", "riot", "brawl", "fight", "protest",
  "boycott", "died", "killed", "collapse", "streak", "first ever",
  "youngest", "oldest", "record", "fined", "arrested", "stripped",
  "controvers", "walkout", "forfeit", "doping", "drugs", "suspended",
  "sent off", "invaded the pitch", "brutal", "chaos", "outrage",
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function hasWordStart(text, phrase) {
  // left word-boundary only (not a full \b...\b match) so "sport" still
  // correctly matches "sports"/"sporting", but stops matching mid-word
  // occurrences like "tranSPORT" or "paSSPORT" — the actual bug found live.
  return new RegExp(`\\b${escapeRegex(phrase)}`, "i").test(text);
}

function scoreEvent(text) {
  const isSport = SPORT_KEYWORDS.some((k) => hasWordStart(text, k));
  if (!isSport) return -1;
  let score = 1;
  DRAMA_KEYWORDS.forEach((k) => {
    if (hasWordStart(text, k)) score += 2;
  });
  return score;
}

function getAESTDateParts() {
  // The server's default "today" is UTC, not AEST — up to 11 hours off from
  // what the person actually means by "midnight". Using the IANA timezone
  // (not a hardcoded UTC+10) so this stays correct through AEST/AEDT
  // daylight saving transitions automatically.
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const month = parts.find((p) => p.type === "month").value;
  const day = parts.find((p) => p.type === "day").value;
  return { month, day };
}

const NO_CACHE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

exports.handler = async function () {
  const { month, day } = getAESTDateParts();

  try {
    const resp = await fetch(
      `https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${month}/${day}`,
      { headers: { "User-Agent": "MLSynd On This Day (contact: mlsynd00@gmail.com)" } }
    );

    if (!resp.ok) {
      return { statusCode: resp.status, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: `Wikipedia returned ${resp.status}` }) };
    }

    const data = await resp.json();
    const events = data.events || [];

    let best = null;
    let bestScore = 0;
    events.forEach((ev) => {
      const score = scoreEvent(ev.text || "");
      if (score > bestScore) {
        bestScore = score;
        best = ev;
      }
    });

    if (!best) {
      return {
        statusCode: 200,
        headers: NO_CACHE_HEADERS,
        body: JSON.stringify({ found: false, date: `${month}/${day}` }),
      };
    }

    return {
      statusCode: 200,
      headers: NO_CACHE_HEADERS,
      body: JSON.stringify({
        found: true,
        date: `${month}/${day}`,
        year: best.year,
        text: best.text,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: NO_CACHE_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
