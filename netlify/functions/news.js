// netlify/functions/news.js
// Pulls sport headlines from RSS feeds. AFL and NBA use their own official
// feeds (best quality/freshness); NRL and horse racing don't have a single
// reliable official feed, so those use Google News' AU-localized search
// feed instead. Zero dependencies — RSS is simple enough to parse with a
// careful regex rather than pulling in an XML library.

const CATEGORY_FEEDS = {
  afl: "https://www.afl.com.au/rss",
  nrl: "https://news.google.com/rss/search?q=NRL+rugby+league&hl=en-AU&gl=AU&ceid=AU:en",
  nba: "https://www.espn.com/espn/rss/nba/news",
  racing: "https://news.google.com/rss/search?q=horse+racing+Australia&hl=en-AU&gl=AU&ceid=AU:en",
};

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
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

exports.handler = async function (event) {
  const category = ((event.queryStringParameters || {}).category || "").toLowerCase();
  const feedUrl = CATEGORY_FEEDS[category];

  if (!feedUrl) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, articles: [] }),
    };
  }

  try {
    const resp = await fetch(feedUrl, {
      headers: { "User-Agent": "MLSynd News (contact: mlsynd00@gmail.com)" },
    });

    if (!resp.ok) {
      return {
        statusCode: resp.status,
        body: JSON.stringify({ error: `Feed returned ${resp.status}` }),
      };
    }

    const xml = await resp.text();
    const parsed = parseRssItems(xml, 30); // pull a few extra since some will get filtered out by age
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const articles = parsed
      .filter((a) => {
        if (!a.pubDate) return false;
        const t = new Date(a.pubDate).getTime();
        return !isNaN(t) && t >= cutoff;
      })
      .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
      .slice(0, 8);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, articles }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
