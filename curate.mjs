// AI-curated news feed generator.
// Fetches RSS feeds for VR / AI / NFL, asks an LLM to curate, writes news.html.
// Runs in GitHub Actions via GitHub Models — auth uses the built-in
// GITHUB_TOKEN, so no personal API key is ever uploaded.

import { writeFileSync } from "node:fs";

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

const MODEL = "openai/gpt-4o-mini"; // GitHub Models catalog id
const MODELS_ENDPOINT = "https://models.github.ai/inference/chat/completions";
const PER_CATEGORY = 6; // articles Claude keeps per category
const MAX_CANDIDATES = 22; // most-recent items per category sent to Claude

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
      items.push({ title, link, desc: desc.slice(0, 320), date, ts: Date.parse(date) || 0 });
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

async function gatherCandidates() {
  const out = {};
  for (const [cat, urls] of Object.entries(FEEDS)) {
    console.log(`Fetching ${cat}...`);
    const all = (await Promise.all(urls.map(fetchFeed))).flat();
    const seen = new Set();
    const uniq = all.filter((i) => !seen.has(i.link) && seen.add(i.link));
    uniq.sort((a, b) => b.ts - a.ts);
    out[cat] = uniq.slice(0, MAX_CANDIDATES);
  }
  return out;
}

async function curate(candidates) {
  const key = process.env.GITHUB_TOKEN || process.env.MODELS_TOKEN;
  if (!key) throw new Error("GITHUB_TOKEN (or MODELS_TOKEN) is not set");

  const list = Object.entries(candidates)
    .map(([cat, items]) => {
      const lines = items
        .map((it, i) => `  [${cat}-${i}] ${it.title}\n      ${it.desc}`)
        .join("\n");
      return `### ${cat}\n${lines}`;
    })
    .join("\n\n");

  const prompt = `You are the editor of a tech & sports news feed covering three beats: VR (virtual/augmented reality), AI (artificial intelligence), and NFL (American football).

Below are candidate articles fetched from RSS feeds. For EACH category, pick the ${PER_CATEGORY} most newsworthy and interesting articles. Prefer concrete news (launches, signings, results, research, deals) over opinion or roundups. Skip duplicates and low-value SEO filler.

For each chosen article write a single punchy summary sentence (max 28 words) in a neutral editorial voice.

Return ONLY valid JSON, no markdown fences, in this exact shape:
{"VR":[{"id":"VR-0","summary":"..."}],"AI":[...],"NFL":[...]}
Use the id tags exactly as given. Order each list most-important first.

CANDIDATES:
${list}`;

  const res = await fetch(MODELS_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`GitHub Models ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let text = data.choices?.[0]?.message?.content || "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("No JSON in Claude response");
  const picks = JSON.parse(text.slice(start, end + 1));

  // resolve ids back to full articles
  const result = {};
  for (const cat of Object.keys(FEEDS)) {
    result[cat] = (picks[cat] || [])
      .map((p) => {
        const idx = parseInt(String(p.id).split("-")[1], 10);
        const src = candidates[cat]?.[idx];
        if (!src) return null;
        const host = (() => {
          try { return new URL(src.link).hostname.replace(/^www\./, ""); }
          catch { return ""; }
        })();
        return { title: src.title, url: src.link, summary: p.summary || src.desc, source: host, date: src.date };
      })
      .filter(Boolean);
  }
  return result;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function render(feed) {
  const now = new Date();
  const updated = now.toUTCString();
  const meta = { VR: ["#7c5cff", "VR / XR"], AI: ["#00d4aa", "Artificial Intelligence"], NFL: ["#ff4d4d", "NFL"] };

  const sections = Object.entries(feed)
    .map(([cat, items]) => {
      const [color, label] = meta[cat];
      const cards = items
        .map(
          (a) => `        <a class="card" href="${esc(a.url)}" target="_blank" rel="noopener">
          <h3>${esc(a.title)}</h3>
          <p>${esc(a.summary)}</p>
          <span class="src">${esc(a.source)}</span>
        </a>`
        )
        .join("\n");
      return `    <section>
      <h2 style="--accent:${color}">${esc(label)}</h2>
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
<title>Curated Feed — VR / AI / NFL</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0b0c10; color: #e8e8ec;
    font: 16px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif;
    padding: 32px 20px 64px; }
  header { max-width: 1100px; margin: 0 auto 32px; }
  h1 { font-size: 28px; letter-spacing: -0.02em; }
  .updated { color: #7a7a85; font-size: 13px; margin-top: 6px; }
  main { max-width: 1100px; margin: 0 auto; }
  section { margin-top: 40px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.12em;
    color: var(--accent); padding-bottom: 8px; margin-bottom: 16px;
    border-bottom: 1px solid #1e1f26; }
  .grid { display: grid; gap: 14px;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
  .card { display: block; background: #14151c; border: 1px solid #1e1f26;
    border-radius: 12px; padding: 18px; text-decoration: none; color: inherit;
    transition: border-color .15s, transform .15s; }
  .card:hover { border-color: #3a3b46; transform: translateY(-2px); }
  .card h3 { font-size: 16px; line-height: 1.35; margin-bottom: 8px; }
  .card p { font-size: 14px; color: #b6b6c0; }
  .src { display: inline-block; margin-top: 12px; font-size: 12px; color: #6f6f7a; }
  footer { max-width: 1100px; margin: 56px auto 0; color: #5a5a64; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>Curated Feed</h1>
  <div class="updated">VR &middot; AI &middot; NFL &mdash; auto-curated by Claude &middot; updated ${updated}</div>
</header>
<main>
${sections}
</main>
<footer>Generated every 12 hours via GitHub Actions. Headlines link to original sources.</footer>
</body>
</html>
`;
}

(async () => {
  const candidates = await gatherCandidates();
  const total = Object.values(candidates).reduce((n, a) => n + a.length, 0);
  if (total === 0) throw new Error("No articles fetched from any feed");
  console.log(`Curating ${total} candidates with ${MODEL}...`);
  const feed = await curate(candidates);
  writeFileSync("news.html", render(feed));
  writeFileSync("news.json", JSON.stringify({ updated: new Date().toISOString(), feed }, null, 2));
  console.log("Wrote news.html and news.json");
})();
