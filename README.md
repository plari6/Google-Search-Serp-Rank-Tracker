# Google Search SERP Rank Tracker

Node.js CLI that tracks where a brand ranks on Google for its keywords (for example 50), next to its competitors, and sends a weekly SEO report that a client can read in two minutes.

```
Quillmesh (demo client) – 2026-11-12  vs 2026-11-05
Visibility 16.39 (-1.3) · Avg position 16 (-0.2) · Top 3 14 (+3) · Top 10 16 (-2) · Ranking 46/50
Share of voice: Quillmesh 31.6% · Tandorra 27.6% · Supportlyx 30.4% · Ticketgrove 10.4%
Alerts (8):
  URGENT "help desk software" fell 10 positions: #6 → #16 (off page 1)
  URGENT Tandorra overtook you on "help desk software" (#5 vs #16)
  WIN    Won the featured snippet for "what is a help desk" (#1)
```

**Stack:** JavaScript (Node 24 ESM). It is a CLI with a Cheerio scraper and Chart.js reports, all native to JS, so there is no build step. The dependencies are `cheerio`, `chart.js` and `commander`, plus an optional `puppeteer-core`.

## What it does

1. **Tracks rankings.** For every keyword it reads Google results up to a set depth (10–100). It stops early once the brand and all competitors are found, which saves API credits. For each result it records the position, ranking URL, title, snippet and sitelinks.
2. **Reads SERP features with Cheerio.** AI Overview (with the cited domains), featured snippet, People also ask, local pack (with place websites), top stories, videos, images, shopping, knowledge panel, discussions, related searches, and top and bottom ads (with advertiser domains).
3. **Keeps history in SQLite** (`node:sqlite`, no native build). One database holds every client project.
4. **Builds the weekly report.** It compares the latest check with the one about 7 days earlier:
   - visibility score (CTR-weighted, optionally weighted by search volume), average position, top 3, top 10, estimated monthly clicks
   - share of voice against each competitor, and keywords where a competitor outranks you
   - biggest gains and drops, new and lost rankings, page-1 entries and exits
   - quick wins: positions 4–20, sorted by the clicks a top-3 spot would add
   - technical signals: cannibalization (two of your URLs competing), ranking-URL swaps, the wrong landing page versus your target URL
   - untracked domains that keep appearing in your top 10s, competitors bidding on your brand keywords, SERP volatility
5. **Writes an executive summary and next week's plan with AI.** The AI only sees pre-computed facts. Any answer that quotes a number or keyword not in those facts is rejected and the next model is tried. If no model answers, a rule-based writer produces the same structure.
6. **Delivers the report.** `report.html` is a self-contained page with four Chart.js charts, a filterable and sortable keyword table with sparklines, and light and dark themes. It works offline and as an email attachment. Also produced: `email.html` (email-safe), `report.md`, `keywords.csv`, `history.csv` (keyword × week), `competitors.csv` and `summary.json`. Email goes out via Resend (or to a local outbox), and chat digests go to Slack, Discord, Teams, Telegram or a signed JSON webhook (Zapier, Make, n8n).
7. **Sends alerts** for drops (larger thresholds for priority keywords), lost rankings, a lost featured snippet or AI Overview citation, a changed ranking page, competitor overtakes and brand-keyword bidding, plus wins. Alerts are deduplicated, so daily checks never repeat one.

A keyword that could not be checked (blocked, timeout) **keeps last week's value and is flagged**. It is never reported as a lost ranking.

## Quick start

```bash
npm install
node bin/serp-tracker.js demo --open      # offline: 50 keywords × 8 weeks of fictional SERPs -> full report
npm test                                  # 56 tests, no network or keys
```

For a real client:

```bash
cp .env.example .env                      # add SERPER_API_KEY or SERPAPI_KEY (+ GEMINI_API_KEY for AI summaries)
node bin/serp-tracker.js init acme --domain acme.com --competitors rival.com,other.io --keywords acme-keywords.csv --gl us --hl en
node bin/serp-tracker.js check "plumber austin" --project acme     # one live lookup to verify setup
node bin/serp-tracker.js run acme                                  # track + report + deliver (the weekly job)
```

Keyword files can be CSV, TSV, TXT or JSON. Recognized columns: `keyword` (or query/term), `group`, `volume`, `priority`, `target_url`, `intent`. Exports from Ahrefs, Semrush and Search Console work after renaming at most one column.

## Commands

| Command | What it does |
|---|---|
| `demo [--weeks 8] [--ai] [--simulate-outage gemini] [--open]` | offline demo through the real parser and report |
| `init <name> --domain d [--competitors a,b] [--keywords file] [--gl] [--hl] [--location]` | create `projects/<name>.json` and a keyword CSV |
| `projects` · `keywords <project>` | list clients and keyword lists |
| `check "<keyword>" [--project p \| --domain d] [--provider] [--save-html dir]` | one live lookup: positions, top 20, features |
| `track <project> [--provider] [--depth] [--only kw,group] [--limit n] [--resume]` | check every keyword now |
| `report <project> [--run id] [--weeks 12] [--no-ai] [--send] [--json] [--open]` | build the report from history |
| `run <project> [--alerts-only] [--no-send]` | weekly job: track + report + deliver (`--alerts-only` for daily checks) |
| `schedule <p1> [p2...] --day mon --at 07:00 [--daily]` | built-in scheduler loop (or use cron / Task Scheduler / GitHub Actions) |
| `history <project> "<keyword>"` | position history for one keyword, with competitors |
| `parse <file.html>` | parse a saved Google page to JSON |
| `doctor [--ping]` | Node, SERP sources, every AI model, delivery, projects |
| `test-webhook <url> [--print]` | send or print a sample digest |

## Choosing a SERP source

Since early 2025, Google answers plain HTTP clients with a "turn on JavaScript" page. A live check in November 2026 confirmed this: `check --provider google` returns `blocked: js_required`. Automated querying also goes against Google's terms of service. For client work, use a SERP API: they handle locations and devices and return clean data.

| Provider | Setting | Notes |
|---|---|---|
| `serper` | `SERPER_API_KEY` | cheapest per query, JSON |
| `serpapi` | `SERPAPI_KEY` | richest data (AI Overview references, ads, local), JSON |
| `gateway` | `SCRAPER_API_URL=...{url}` | any scraping or render API that returns Google's HTML (ScraperAPI, ScrapingBee, ZenRows, Bright Data, self-hosted). Parsed locally with Cheerio. |
| `browser` | `npm i puppeteer-core` | renders the page in your installed Chrome or Edge. For occasional manual spot checks only; CAPTCHAs are reported as `blocked`. |
| `google` | none | direct HTTP; currently blocked by Google (kept for detection and testing) |
| `file` | `SERP_HTML_DIR` | saved pages (`<keyword-slug>.html`, `-p2.html`, ...) |
| `demo` | none | fictional SERPs for demos |

**Cost.** Each page is 10 results (Google removed `num=100` in 2025). 50 keywords at depth 30 is at most 150 requests per week, and early stopping usually cuts that by 30–60%. At Serper's prices that is a few cents a week per client.

The tracker retries 429 and 5xx errors with backoff. It stops after a few blocked keywords in a row (circuit breaker), stops at once on auth or credit errors, and `--resume` finishes an interrupted run.

## How the numbers work

- **Position:** organic rank across pages. Ads are excluded, and a featured snippet counts as #1 (as in Semrush and Ahrefs).
- **Visibility (0–100):** Σ weight × CTR(position) ÷ Σ weight × CTR(1). The weight is the monthly search volume when provided, else 1. The CTR curve lives in `src/metrics.js`.
- **Share of voice:** your visibility ÷ the combined visibility of you and the tracked competitors.
- **Comparison run:** the latest run at least 6 days older than the current one, else the previous run.
- **SERP volatility:** the share of top-10 URLs that are new since the comparison run.

## Project file

See [examples/project.example.json](examples/project.example.json). Fields: `brand` and `competitors` (`domains` can be `example.com`, `shop.example.com`, `example.com/blog`, or `=example.com` for that exact host only), `locale` (`gl`, `hl`, `googleDomain`, `location` such as `"Austin,Texas,United States"`, `device`), `depth`, `provider`, `keywordsFile` and/or `keywords`, `alerts` thresholds, and `report` (`email`, `webhooks`, `brandColor`, `agency`).

## Running it every week

- **Built-in:** `node bin/serp-tracker.js schedule acme beta --day mon --at 07:00 --daily`
- **Windows:** `schtasks /create /sc weekly /d MON /st 07:00 /tn "SEO acme" /tr "node C:\path\bin\serp-tracker.js run acme"`
- **Linux cron:** `0 7 * * 1 cd /app && node bin/serp-tracker.js run acme`
- **Docker:** `docker build -t serp-tracker . && docker run --env-file .env -v $PWD/data:/app/data -v $PWD/output:/app/output -v $PWD/projects:/app/projects serp-tracker run acme`
- **GitHub Actions:** [examples/github-actions-weekly.yml](examples/github-actions-weekly.yml)

## Library use

```js
import { loadProject, openDb, createProvider, trackProject, buildReport, generateInsights, writeReport } from './src/index.js';
const project = loadProject('acme');
const db = openDb('data/serp.sqlite');
await trackProject(project, { db, provider: createProvider('serper') });
const report = buildReport(project, db);
writeReport(report, await generateInsights(report, { db }), 'output/acme');
```

## Layout

```
bin/serp-tracker.js      CLI
src/parser/google.js     Cheerio SERP parser (organic, features, block pages)
src/providers/           serpapi, serper, gateway, browser, google, file, demo
src/tracker.js           pagination, early stop, retries, circuit breaker, resume
src/metrics.js           positions, visibility, share of voice, movers, opportunities, alerts
src/insights.js          AI summary (multi-model fallback, grounding check) + rule fallback
src/report/              HTML (Chart.js inlined), e-mail, Markdown, CSV, JSON
src/deliver/             Slack, Discord, Teams, Telegram, JSON (HMAC), Resend e-mail
src/ai/                  multi-model fallback router (Gemini -> Gemma -> Groq -> NVIDIA -> OpenRouter -> Ollama)
src/db.js                SQLite history
test/                    56 tests with fixtures (modern + basic Google HTML, block pages)
```

## License

MIT
