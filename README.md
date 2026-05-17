# AI-Curated News Feed — VR / AI / NFL

A GitHub Action runs every 12 hours, fetches RSS feeds, asks an LLM (via
**GitHub Models**) to pick and summarize the top stories, and writes a
self-contained `news.html`.

No personal API key is involved — curation authenticates with the workflow's
built-in `GITHUB_TOKEN`. GitHub Models is free (rate-limited).

## One-time setup

1. **Create a GitHub repo** and push this folder:
   ```sh
   cd news-feed
   git init
   git add .
   git commit -m "Initial news feed"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

2. **Run it once** — Actions tab → *Curate news feed* → *Run workflow*.
   This generates and commits `news.html`. (No secrets to configure.)

## Serving the page

- **GitHub Pages:** Settings → Pages → deploy from `main` branch.
  The feed is then live at `https://<you>.github.io/<repo>/news.html`.
- **Your own site:** copy/sync `news.html` into `public_html`, or `<iframe>` /
  fetch the Pages URL from an existing page.

## Run locally (optional)

GitHub Models needs a token even locally. Create a GitHub
[fine-grained PAT](https://github.com/settings/tokens) with the **Models**
permission, then:

```sh
MODELS_TOKEN=ghp_... node curate.mjs
```

## Tuning

Edit `curate.mjs`:
- `FEEDS` — RSS sources per category
- `PER_CATEGORY` — stories kept per category (default 6)
- `MODEL` — GitHub Models catalog id (e.g. `openai/gpt-4o`, `openai/gpt-4o-mini`)

Edit `.github/workflows/curate.yml` `cron` to change the schedule.
