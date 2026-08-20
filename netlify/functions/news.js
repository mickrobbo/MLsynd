// netlify/functions/news.js
// Pulls sport headlines from RSS feeds. AFL and NBA use their own official
// feeds (best quality/freshness, and confirmed to carry images). NRL uses
// Sydney Morning Herald's sport feed instead of Google News specifically so
// it can carry real photos too (Google News' RSS strips all image data —
// confirmed, not a parsing gap) — SMH covers multiple sports though, so
// results get filtered down to NRL-relevant items by keyword. Horse racing
// still has no reliable image-bearing source, so that one stays on Google
// News (text-only). Zero dependencies — RSS is simple enough to parse with
// a careful regex rather than pulling in an XML library.

const CATEGORY_FEEDS = {
  afl: "https://www.afl.com.au/rss",
  nrl: "https://www.smh.com.au/rss/sport.xml",
  nba: "https://www.espn.com/espn/rss/nba/news",
  racing: "https://news.google.com/rss/search?q=horse+racing+Australia&hl=en-AU&gl=AU&ceid=AU:en",
  golf: "https://www.espn.com/espn/rss/golf/news", // single combined feed — ESPN doesn't split PGA vs LIV news the way it splits their scores/rankings
  f1: "https://www.espn.com/espn/rss/f1/news",
  efl: "https://news.google.com/rss/search?q=EFL+Championship&hl=en-AU&gl=AU&ceid=AU:en", // no dedicated ESPN feed for this league specifically, and no confirmed official EFL RSS — Google News search is already proven reliable elsewhere in this file (racing)
  motogp: "https://news.google.com/rss/search?q=MotoGP&hl=en-AU&gl=AU&ceid=AU:en", // ESPN doesn't cover MotoGP at all (confirmed earlier) and motogp.com's own RSS URL couldn't be confirmed working — same reasoning as efl above
};

// SMH's sport feed covers AFL/NRL/cricket/football/etc together — keep only
// items that actually look NRL-related. Several club nicknames are shared
// with other codes (AFL has Bulldogs/Tigers, NBA has Warriors, etc.), so
// those ambiguous ones require the fuller club name rather than matching on
// the bare nickname alone — otherwise unrelated football/AFL/NBA stories
// slip through.
const NRL_KEYWORDS = [
  "nrl", "rugby league",
  "broncos", "cowboys", "dolphins", "eels", "knights", "panthers",
  "rabbitohs", "raiders", "roosters", "sea eagles", "manly warringah",
  "canterbury bulldogs", "cronulla sharks", "melbourne storm",
  "wests tigers", "balmain tigers", "gold coast titans",
  "new zealand warriors", "nz warriors", "st george illawarra",
];
function isNrlRelevant(article) {
  const text = article.title.toLowerCase();
  return NRL_KEYWORDS.some((k) => text.includes(k));
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<\( {tag}[^>]*>([\\s\\S]*?)<\\/ \){tag}>`, "i"));
  return m ? m[1].trim() : null;
}

function cleanText(s) {
  if (!s) return "";
  let out = s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
  out = out
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  return out;
}

function extractImage(itemXml) {
  // Different feeds embed images differently — try the common patterns in order.
  let m = itemXml.match(/<enclosure[^>]*url=["']([^"']+)["'][^>]*>/i);
  if (m) return m[1];
  m = itemXml.match(/<media:(?:content|thumbnail)[^>]*url=["']([^"']+)["'][^>]*>/i);
  if (m) return m[1];
  m = itemXml.match(/!\[[^\]]*\]\((https?:\/\/[^\)]+)\)/); // AFL embeds images markdown-style inside <description>
  if (m) return m[1];
  m = itemXml.match(/<img[^>]*src=["']([^"']+)["']/i); // raw HTML <img> inside a description, common on many feeds
  if (m) return m[1];
  return null;
}

function parseRssItems(xml, limit) {
  const items = [];
  const matches = xml.match(/<item[\s\S]*?<\/item>/g) || [];
  for (const raw of matches.slice(0, limit)) {
    const title = extractTag(raw, "title");
    const link = extractTag(raw, "link");
    const pubDate = extractTag(raw, "pubDate");
    const source = extractTag(raw, "source");
    const image = extractImage(raw);
    if (title && link) {
      items.push({
        title: cleanText(title),
        link: cleanText(link),
        pubDate: pubDate || null,
        source: source ? cleanText(source) : null,
        image: image || null,
      });
    }
  }
  return items;
}

export default async function (request) {
  const url = new URL(request.url);
  const category = (url.searchParams.get("category") || "").toLowerCase();
  const feedUrl = CATEGORY_FEEDS[category];

  if (!feedUrl) {
    return new Response(JSON.stringify({ category, articles: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const resp = await fetch(feedUrl, {
      headers: { "User-Agent": "MLSynd News (contact: mlsynd00@gmail.com)" },
    });

    if (!resp.ok) {
      return new Response(JSON.stringify({ error: `Feed returned ${resp.status}` }), {
        status: resp.status,
      });
    }

    const xml = await resp.text();
    const parsed = parseRssItems(xml, category === "nrl" ? 60 : 30); // NRL needs more headroom - filtered twice (relevance + age)
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const articles = parsed
      .filter((a) => category !== "nrl" || isNrlRelevant(a))
      .filter((a) => {
        if (!a.pubDate) return false;
        const t = new Date(a.pubDate).getTime();
        return !isNaN(t) && t >= cutoff;
      })
      .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
      .slice(0, 8);

    return new Response(JSON.stringify({ category, articles }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
    });
  }
}
