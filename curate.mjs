// News feed generator.
// Fetches RSS feeds for VR / AI / NFL, keeps the newest few per category,
// writes news.json (consumed by yellkell.com/news) and news.html.
//
// This used to ask an LLM to pick and summarise the stories, via GitHub Models.
// GitHub Models was retired, the call started returning 410, and because the
// failure was fatal the whole run died — freezing the public feed for five days
// while the workflow kept "running" every 15 minutes. There is no model call
// now: the only external dependency is the RSS feeds themselves, and a single
// feed going down costs you that feed's stories, not the whole run.

import { writeFileSync, readFileSync } from "node:fs";

const FEEDS = {
  VR: [
    "https://www.roadtovr.com/feed/",
    "https://www.uploadvr.com/rss/",
    "https://mixed-news.com/en/feed/",
  ],
  AI: [
    "https://venturebeat.com/category/ai/feed/",
    "https://feeds.arstechnica.com/arstechnica/technology-lab",
    "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
  ],
  NFL: [
    "https://www.espn.com/espn/rss/nfl/news",
    "https://profootballtalk.nbcsports.com/feed/",
  ],
};

const PER_CATEGORY = 6;  // articles published per category
const SUMMARY_CHARS = 180; // RSS blurbs run long; keep card heights even

function decode(s) {
  return (s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return m ? m[1] : "";
}

function extractImage(b) {
  let m =
    b.match(/<media:content[^>]*medium=["']image["'][^>]*url=["']([^"']+)["']/i) ||
    b.match(/<media:content[^>]*url=["']([^"']+)["'][^>]*medium=["']image["']/i) ||
    b.match(/<media:content[^>]*url=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']/i) ||
    b.match(/<media:thumbnail[^>]*url=["']([^"']+)["']/i) ||
    b.match(/<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']image/i) ||
    b.match(/<enclosure[^>]*type=["']image[^>]*url=["']([^"']+)["']/i) ||
    b.match(/<img[^>]*src=["']([^"']+)["']/i);
  let url = m ? m[1].trim() : "";
  if (url) url = url.replace(/&amp;/g, "&");
  return /^https?:\/\//i.test(url) ? url : "";
}

function parseFeed(xml) {
  const items = [];
  // RSS <item> and Atom <entry>
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/(item|entry)>/gi) || [];
  for (const b of blocks) {
    let link = decode(tag(b, "link"));
    if (!link) {
      const href = b.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (href) link = href[1];
    }
    const title = decode(tag(b, "title"));
    const desc = decode(tag(b, "description") || tag(b, "summary") || tag(b, "content"));
    const date = decode(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated"));
    if (title && link) {
      items.push({
        title, link, desc: desc.slice(0, 320), date,
        ts: Date.parse(date) || 0, image: extractImage(b),
      });
    }
  }
  return items;
}

async function fetchFeed(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (news-feed bot)" },
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parseFeed(await res.text());
    console.log(`  ${url} -> ${items.length} items`);
    return items;
  } catch (e) {
    console.warn(`  ${url} FAILED: ${e.message}`);
    return [];
  }
}

async function gatherArticles() {
  const out = {};
  for (const [cat, urls] of Object.entries(FEEDS)) {
    console.log(`Fetching ${cat}...`);
    const all = (await Promise.all(urls.map(fetchFeed))).flat();
    const seen = new Set();
    const uniq = all.filter((i) => !seen.has(i.link) && seen.add(i.link));
    uniq.sort((a, b) => b.ts - a.ts);
    out[cat] = uniq;
  }
  return out;
}

function hostOf(link) {
  try { return new URL(link).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

/* Prefer the blurb's first sentence; otherwise cut on a word boundary. */
function trimSummary(desc) {
  const s = (desc || "").trim();
  if (s.length <= SUMMARY_CHARS) return s;
  const stop = s.slice(0, SUMMARY_CHARS).search(/[.!?](?=\s|$)/);
  if (stop > 60) return s.slice(0, stop + 1);
  const cut = s.lastIndexOf(" ", SUMMARY_CHARS);
  return s.slice(0, cut > 60 ? cut : SUMMARY_CHARS).trimEnd() + "…";
}

/* Take newest-first from each source in turn rather than straight by recency.
   Sorting purely on time lets the most prolific publisher take every slot —
   The Verge alone filled all six AI cards — which is the one thing the old
   LLM pass was reliably good at preventing. */
function interleaveBySource(items, limit) {
  const bySource = new Map();
  for (const it of items) {
    const host = hostOf(it.link);
    if (!bySource.has(host)) bySource.set(host, []);
    bySource.get(host).push(it); // already newest-first
  }
  const queues = [...bySource.values()];
  const out = [];
  while (out.length < limit) {
    const round = queues.map((q) => q.shift()).filter(Boolean);
    if (!round.length) break;
    round.sort((a, b) => b.ts - a.ts); // newest still leads within a round
    out.push(...round);
  }
  return out.slice(0, limit);
}

function buildFeed(articles) {
  const feed = {};
  for (const cat of Object.keys(FEEDS)) {
    feed[cat] = interleaveBySource(articles[cat] || [], PER_CATEGORY)
      .map((src) => ({
        title: src.title, url: src.link, summary: trimSummary(src.desc),
        source: hostOf(src.link), date: src.date, image: src.image || "",
      }));
  }
  return feed;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function render(feed, updatedISO) {
  const updated = new Date(updatedISO).toUTCString();
  const meta = { VR: ["#8b7bff", "VR / XR"], AI: ["#2dd4a7", "Artificial Intelligence"], NFL: ["#ff5a5a", "NFL"] };

  const sections = Object.entries(feed)
    .map(([cat, items]) => {
      const [color, label] = meta[cat] || ["#8a8a92", cat];
      const cards = items
        .map((a) => {
          const img = a.image
            ? `<img src="${esc(a.image)}" loading="lazy" alt="" onerror="this.remove()">`
            : "";
          return `      <a class="card" href="${esc(a.url)}" target="_blank" rel="noopener">
        <div class="thumb">${img}</div>
        <div class="body">
          <h3>${esc(a.title)}</h3>
          <p>${esc(a.summary)}</p>
          <span class="src">${esc(a.source)}</span>
        </div>
      </a>`;
        })
        .join("\n");
      return `  <section style="--accent:${color}">
    <h2><span class="dot"></span>${esc(label)}</h2>
    <div class="grid">
${cards}
    </div>
  </section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VR / AI / NFL</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0b0b0d; color: #ececee;
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased; padding: 0 24px; }
  header, main, footer { max-width: 1120px; margin-left: auto; margin-right: auto; }
  header { padding: 56px 0 8px; }
  h1 { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }
  .updated { color: #6c6c74; font-size: 12.5px; margin-top: 8px; }
  section { padding: 36px 0; border-bottom: 1px solid #18181c; }
  section:last-of-type { border-bottom: none; }
  h2 { display: flex; align-items: center; gap: 9px; font-size: 12px;
    font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--accent); margin-bottom: 20px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
  .grid { display: grid; gap: 20px;
    grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); }
  .card { display: flex; flex-direction: column; background: #131318;
    border: 1px solid #1f1f26; border-radius: 14px; overflow: hidden;
    text-decoration: none; color: inherit;
    transition: border-color .15s ease, transform .15s ease; }
  .card:hover { border-color: #36363f; transform: translateY(-3px); }
  .thumb { aspect-ratio: 16 / 9; position: relative;
    background: linear-gradient(135deg, var(--accent) -40%, #131318 75%); }
  .thumb img { position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: cover; }
  .body { padding: 15px 17px 17px; display: flex; flex-direction: column; flex: 1; }
  .card h3 { font-size: 15.5px; font-weight: 600; line-height: 1.38;
    letter-spacing: -0.01em; }
  .card p { margin-top: 8px; font-size: 13.5px; color: #97979f; }
  .src { margin-top: auto; padding-top: 12px; font-size: 11px;
    letter-spacing: 0.07em; text-transform: uppercase; color: #5f5f66; }
  footer { padding: 32px 0 64px; color: #5a5a62; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>VR &middot; AI &middot; NFL</h1>
  <div class="updated">Updated ${updated}</div>
</header>
<main>
${sections}
</main>
<footer>Refreshed every 15 minutes. Headlines link to original sources.</footer>
</body>
</html>
`;
}

(async () => {
  const articles = await gatherArticles();
  const total = Object.values(articles).reduce((n, a) => n + a.length, 0);
  // A total wipeout means the network or every feed is down. Bail rather than
  // overwrite a good feed with nothing — the previous news.json stays published.
  if (total === 0) throw new Error("No articles fetched from any feed");

  const feed = buildFeed(articles);

  // Only bump the timestamp when the content actually changed, so an unchanged
  // feed produces byte-identical files and the workflow skips the commit.
  let updated = new Date().toISOString();
  try {
    const prev = JSON.parse(readFileSync("news.json", "utf8"));
    if (JSON.stringify(prev.feed) === JSON.stringify(feed)) {
      updated = prev.updated;
      console.log("Feed unchanged since last run.");
    }
  } catch {}

  writeFileSync("news.html", render(feed, updated));
  writeFileSync("news.json", JSON.stringify({ updated, feed }, null, 2));
  const published = Object.values(feed).reduce((n, a) => n + a.length, 0);
  console.log(`Wrote news.html and news.json (${published} of ${total} articles)`);
})();
