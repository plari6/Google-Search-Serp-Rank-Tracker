// SERP providers. Every provider returns the same shape as parseGoogleSerp():
//   { status: 'ok'|'blocked'|'no_results'|'empty', blockReason, organic: [...], features: {...}, totalResults, hasNextPage }
import fs from 'node:fs';
import path from 'node:path';
import { parseGoogleSerp } from '../parser/google.js';
import { fetchWithTimeout } from '../util/async.js';
import { hostOf, uule } from '../util/url.js';
import { createDemoProvider } from './demo.js';

export class ProviderError extends Error {
  constructor(message, { kind = 'network', status, fatal = false, retryAfterMs } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.fatal = fatal;
    this.retryAfterMs = retryAfterMs;
  }
}

const UA = {
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  mobile: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
};

export function buildGoogleUrl(keyword, page, locale = {}) {
  const domain = (locale.googleDomain || 'google.com').replace(/^https?:\/\//, '').replace(/^www\./, '');
  const p = new URLSearchParams({ q: keyword, hl: locale.hl || 'en', gl: locale.gl || 'us', pws: '0', nfpr: '1' });
  if (page > 0) p.set('start', String(page * 10));
  if (locale.location) p.set('uule', uule(locale.location));
  return `https://www.${domain}/search?${p}`;
}

function httpError(res, body, name) {
  const s = res.status;
  const retry = Number(res.headers.get('retry-after'));
  const retryAfterMs = Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined;
  const snippet = String(body || '').slice(0, 200).replace(/\s+/g, ' ');
  if (s === 401 || s === 403) return new ProviderError(`${name}: HTTP ${s} (check the API key / plan) ${snippet}`, { kind: 'auth', status: s, fatal: name !== 'google' });
  if (s === 402) return new ProviderError(`${name}: out of credits (HTTP 402)`, { kind: 'quota', status: s, fatal: true });
  if (s === 429) return new ProviderError(`${name}: rate limited (HTTP 429)`, { kind: 'rate_limit', status: s, retryAfterMs });
  if (s >= 500) return new ProviderError(`${name}: server error HTTP ${s}`, { kind: 'server', status: s, retryAfterMs });
  return new ProviderError(`${name}: HTTP ${s} ${snippet}`, { kind: 'bad_response', status: s });
}

// ---- Direct Google over HTTP (low volume only) ---------------------------------------------------
function createGoogleProvider({ env, fetchImpl, timeoutMs }) {
  return {
    name: 'google',
    concurrency: 1,
    delayMs: [Number(env.GOOGLE_MIN_DELAY_MS || 9000), Number(env.GOOGLE_MAX_DELAY_MS || 22000)],
    async fetchPage({ keyword, page, locale }) {
      const url = buildGoogleUrl(keyword, page, locale);
      const res = await fetchWithTimeout(url, {
        redirect: 'follow',
        headers: {
          'user-agent': UA[locale.device] || UA.desktop,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': `${locale.hl || 'en'}-${(locale.gl || 'us').toUpperCase()},${locale.hl || 'en'};q=0.9`,
        },
      }, timeoutMs, fetchImpl);
      const html = await res.text();
      if (res.url.includes('/sorry/') || res.status === 429) return { ...parseGoogleSerp(html, { page: page + 1 }), status: 'blocked', blockReason: 'captcha', html };
      if (!res.ok) throw httpError(res, html, 'google');
      return { ...parseGoogleSerp(html, { page: page + 1, baseUrl: url }), html };
    },
  };
}

// ---- Any scraping / rendering API that returns Google's HTML ------------------------------------
// SCRAPER_API_URL is a template with {url}: ScraperAPI, ScrapingBee, ZenRows, Bright Data Web Unlocker,
// Scrape.do, or a self-hosted gateway such as the Anti-Bot Proxy Rotator (/fetch?url={url}).
function createGatewayProvider({ env, fetchImpl, timeoutMs }) {
  const template = env.SCRAPER_API_URL || '';
  return {
    name: 'gateway',
    concurrency: Number(env.SCRAPER_API_CONCURRENCY || 3),
    delayMs: [0, 400],
    configured: template.includes('{url}'),
    async fetchPage({ keyword, page, locale }) {
      if (!template.includes('{url}')) throw new ProviderError('gateway: set SCRAPER_API_URL with a {url} placeholder', { kind: 'config', fatal: true });
      const target = buildGoogleUrl(keyword, page, locale);
      const url = template.replace('{url}', encodeURIComponent(target)).replace('{url_raw}', target);
      const res = await fetchWithTimeout(url, { headers: { accept: 'text/html,application/json' } }, Math.max(timeoutMs, 60000), fetchImpl);
      let body = await res.text();
      if (!res.ok) throw httpError(res, body, 'gateway');
      if (/^\s*[{[]/.test(body)) {
        try {
          const j = JSON.parse(body);
          body = j.html || j.body || j.content || j.data?.html || j.result?.html || body;
        } catch {}
      }
      return { ...parseGoogleSerp(body, { page: page + 1 }), html: body };
    },
  };
}

// ---- SerpApi (JSON) -----------------------------------------------------------------------------
export function mapSerpApi(j, page) {
  if (j.error) {
    if (/hasn't returned any results|no results/i.test(j.error)) return { status: 'no_results', organic: [], features: {}, totalResults: 0, hasNextPage: false };
    throw new ProviderError(`serpapi: ${j.error}`, { kind: /api key|account|plan|searches/i.test(j.error) ? 'auth' : 'bad_response', fatal: /api key|run out|plan/i.test(j.error) });
  }
  const organic = [];
  const push = (r, featured = false) => {
    const url = r.link || r.url;
    if (!url || organic.some((o) => o.url === url)) return;
    organic.push({
      rank: organic.length + 1,
      title: r.title || '',
      url,
      domain: hostOf(url),
      displayedUrl: r.displayed_link || '',
      snippet: (r.snippet || '').slice(0, 320),
      date: r.date || null,
      sitelinks: (r.sitelinks?.inline?.length || 0) + (r.sitelinks?.expanded?.length || 0),
      featured,
    });
  };
  const ab = j.answer_box;
  if (page === 0 && ab?.link && /organic|featured|snippet/i.test(ab.type || 'organic_result')) push(ab, true);
  for (const r of j.organic_results || []) push(r);

  const f = {};
  if (page === 0) {
    if (ab?.link) f.featured_snippet = { url: ab.link };
    if (j.ai_overview) f.ai_overview = { cited: (j.ai_overview.references || []).filter((r) => r.link).map((r) => ({ url: r.link, domain: hostOf(r.link) })) };
    if (j.related_questions?.length) f.people_also_ask = j.related_questions.map((q) => q.question).filter(Boolean).slice(0, 10);
    const places = Array.isArray(j.local_results) ? j.local_results : j.local_results?.places;
    if (places?.length) f.local_pack = { places: places.slice(0, 10).map((p) => ({ name: p.title, url: p.links?.website || p.website || '', domain: hostOf(p.links?.website || p.website || '') })) };
    if (j.top_stories?.length) f.top_stories = { items: j.top_stories.slice(0, 10).map((s) => ({ url: s.link, domain: hostOf(s.link) })) };
    if (j.inline_videos?.length) f.videos = { items: j.inline_videos.slice(0, 10).map((s) => ({ url: s.link, domain: hostOf(s.link) })) };
    if (j.inline_images?.length) f.images = true;
    if (j.shopping_results?.length || j.immersive_products?.length || j.inline_shopping?.length) f.shopping = true;
    if (j.knowledge_graph) f.knowledge_panel = { title: j.knowledge_graph.title || null };
    if (j.discussions_and_forums?.length) f.discussions = { items: j.discussions_and_forums.slice(0, 10).map((s) => ({ url: s.link, domain: hostOf(s.link) })) };
    if (j.ads?.length) f.ads = j.ads.map((a) => ({ position: a.block_position === 'bottom' ? 'bottom' : 'top', domain: hostOf(a.link || a.displayed_link), title: a.title || '' }));
    if (j.related_searches?.length) f.related_searches = j.related_searches.map((r) => r.query).filter(Boolean).slice(0, 10);
  }
  return {
    status: organic.length ? 'ok' : 'no_results',
    organic,
    features: f,
    totalResults: j.search_information?.total_results ?? null,
    hasNextPage: !!j.serpapi_pagination?.next,
  };
}

function createSerpApiProvider({ env, fetchImpl, timeoutMs }) {
  const key = env.SERPAPI_KEY || env.SERPAPI_API_KEY;
  return {
    name: 'serpapi',
    concurrency: Number(env.SERPAPI_CONCURRENCY || 4),
    delayMs: [0, 200],
    configured: !!key,
    async fetchPage({ keyword, page, locale }) {
      if (!key) throw new ProviderError('serpapi: set SERPAPI_KEY', { kind: 'config', fatal: true });
      const p = new URLSearchParams({
        engine: 'google', q: keyword, hl: locale.hl || 'en', gl: locale.gl || 'us',
        google_domain: locale.googleDomain || 'google.com', device: locale.device || 'desktop', api_key: key,
      });
      if (page > 0) p.set('start', String(page * 10));
      if (locale.location) p.set('location', locale.location);
      if (env.SERPAPI_NO_CACHE === '1') p.set('no_cache', 'true');
      const res = await fetchWithTimeout(`https://serpapi.com/search.json?${p}`, {}, Math.max(timeoutMs, 45000), fetchImpl);
      const body = await res.text();
      if (res.status === 429 || res.status >= 500) throw httpError(res, body, 'serpapi');
      let j;
      try {
        j = JSON.parse(body);
      } catch {
        if (!res.ok) throw httpError(res, body, 'serpapi');
        throw new ProviderError('serpapi: invalid JSON', { kind: 'bad_response' });
      }
      if (!res.ok && !j.error) throw httpError(res, body, 'serpapi');
      return mapSerpApi(j, page);
    },
  };
}

// ---- Serper.dev (JSON) --------------------------------------------------------------------------
export function mapSerper(j, page) {
  const organic = [];
  const push = (r, featured = false) => {
    const url = r.link;
    if (!url || organic.some((o) => o.url === url)) return;
    organic.push({
      rank: organic.length + 1, title: r.title || '', url, domain: hostOf(url), displayedUrl: '',
      snippet: (r.snippet || '').slice(0, 320), date: r.date || null, sitelinks: r.sitelinks?.length || 0, featured,
    });
  };
  if (page === 0 && j.answerBox?.link) push(j.answerBox, true);
  for (const r of j.organic || []) push(r);
  const f = {};
  if (page === 0) {
    if (j.answerBox?.link) f.featured_snippet = { url: j.answerBox.link };
    if (j.aiOverview) f.ai_overview = { cited: (j.aiOverview.references || j.aiOverview.sources || []).filter((r) => r.link).map((r) => ({ url: r.link, domain: hostOf(r.link) })) };
    if (j.peopleAlsoAsk?.length) f.people_also_ask = j.peopleAlsoAsk.map((q) => q.question).filter(Boolean).slice(0, 10);
    if (j.places?.length) f.local_pack = { places: j.places.slice(0, 10).map((p) => ({ name: p.title, url: p.website || '', domain: hostOf(p.website || '') })) };
    if (j.topStories?.length) f.top_stories = { items: j.topStories.slice(0, 10).map((s) => ({ url: s.link, domain: hostOf(s.link) })) };
    if (j.videos?.length) f.videos = { items: j.videos.slice(0, 10).map((s) => ({ url: s.link, domain: hostOf(s.link) })) };
    if (j.images?.length) f.images = true;
    if (j.shopping?.length) f.shopping = true;
    if (j.knowledgeGraph) f.knowledge_panel = { title: j.knowledgeGraph.title || null };
    if (j.relatedSearches?.length) f.related_searches = j.relatedSearches.map((r) => r.query).filter(Boolean).slice(0, 10);
  }
  return { status: organic.length ? 'ok' : 'no_results', organic, features: f, totalResults: null, hasNextPage: (j.organic || []).length >= 9 };
}

function createSerperProvider({ env, fetchImpl, timeoutMs }) {
  const key = env.SERPER_API_KEY;
  return {
    name: 'serper',
    concurrency: Number(env.SERPER_CONCURRENCY || 5),
    delayMs: [0, 150],
    configured: !!key,
    async fetchPage({ keyword, page, locale }) {
      if (!key) throw new ProviderError('serper: set SERPER_API_KEY', { kind: 'config', fatal: true });
      const body = { q: keyword, gl: locale.gl || 'us', hl: locale.hl || 'en', page: page + 1, num: 10, autocorrect: false };
      if (locale.location) body.location = locale.location;
      const res = await fetchWithTimeout('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'x-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, Math.max(timeoutMs, 30000), fetchImpl);
      const text = await res.text();
      if (!res.ok) throw httpError(res, text, 'serper');
      return mapSerper(JSON.parse(text), page);
    },
  };
}

// ---- Headless Chrome (optional dependency: puppeteer-core + installed Chrome/Edge, or puppeteer) ---
export function findChrome() {
  const local = process.env.LOCALAPPDATA || '';
  const candidates = {
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
  }[process.platform] || [];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function createBrowserProvider({ env, timeoutMs }) {
  let browserPromise = null;
  const getBrowser = async () => {
    if (!browserPromise) {
      browserPromise = (async () => {
        let puppeteer;
        let needsExecutable = false;
        try {
          puppeteer = (await import('puppeteer')).default;
        } catch {
          try {
            puppeteer = (await import('puppeteer-core')).default;
            needsExecutable = true;
          } catch {
            throw new ProviderError('browser: run  npm i puppeteer-core  (uses your installed Chrome/Edge) or  npm i puppeteer', { kind: 'config', fatal: true });
          }
        }
        const executablePath = env.BROWSER_EXECUTABLE || (needsExecutable ? findChrome() : undefined);
        if (needsExecutable && !executablePath) throw new ProviderError('browser: Chrome/Edge not found - set BROWSER_EXECUTABLE to chrome.exe / msedge.exe', { kind: 'config', fatal: true });
        const args = [`--lang=${env.BROWSER_LANG || 'en-US'}`, '--window-size=1366,900'];
        if (env.BROWSER_PROXY) args.push(`--proxy-server=${env.BROWSER_PROXY}`);
        return puppeteer.launch({
          headless: env.BROWSER_HEADLESS === '0' ? false : true,
          executablePath,
          args,
          defaultViewport: { width: 1366, height: 900 },
          userDataDir: env.BROWSER_PROFILE_DIR || undefined,
        });
      })();
    }
    return browserPromise;
  };
  return {
    name: 'browser',
    concurrency: 1,
    delayMs: [Number(env.GOOGLE_MIN_DELAY_MS || 6000), Number(env.GOOGLE_MAX_DELAY_MS || 15000)],
    async fetchPage({ keyword, page, locale }) {
      const browser = await getBrowser();
      const tab = await browser.newPage();
      try {
        await tab.setUserAgent(UA[locale.device] || UA.desktop);
        if (locale.device === 'mobile') await tab.setViewport({ width: 412, height: 915, isMobile: true });
        const url = buildGoogleUrl(keyword, page, locale);
        await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(timeoutMs, 45000) });
        await tab.waitForSelector('#search, #rso, #captcha-form, form[action*="consent"]', { timeout: 15000 }).catch(() => {});
        const html = await tab.content();
        return { ...parseGoogleSerp(html, { page: page + 1, baseUrl: url }), html };
      } finally {
        await tab.close().catch(() => {});
      }
    },
    async close() {
      if (browserPromise) (await browserPromise.catch(() => null))?.close();
    },
  };
}

// ---- Saved HTML files (manual exports, tests, debugging) ---------------------------------------
export function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'keyword';
}

function createFileProvider({ env }) {
  const dir = env.SERP_HTML_DIR || 'serps';
  return {
    name: 'file',
    concurrency: 4,
    delayMs: [0, 0],
    async fetchPage({ keyword, page }) {
      const base = path.join(dir, slugify(keyword));
      const file = [page === 0 ? `${base}.html` : null, `${base}-p${page + 1}.html`].filter(Boolean).find((f) => fs.existsSync(f));
      if (!file) return { status: page === 0 ? 'missing' : 'no_results', organic: [], features: {}, totalResults: null, hasNextPage: false, error: page === 0 ? `no file ${base}.html` : undefined };
      return parseGoogleSerp(fs.readFileSync(file, 'utf8'), { page: page + 1 });
    },
  };
}

export const PROVIDERS = ['demo', 'serpapi', 'serper', 'gateway', 'browser', 'google', 'file'];

/** Pick a provider: explicit name, else SERP_PROVIDER, else the first one that has credentials. */
export function resolveProviderName(name, env = process.env) {
  const n = (name || env.SERP_PROVIDER || '').toLowerCase();
  if (n) return n;
  if (env.SERPAPI_KEY || env.SERPAPI_API_KEY) return 'serpapi';
  if (env.SERPER_API_KEY) return 'serper';
  if ((env.SCRAPER_API_URL || '').includes('{url}')) return 'gateway';
  return 'google';
}

export function createProvider(name, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 20000, demo = {} } = {}) {
  const n = resolveProviderName(name, env);
  const ctx = { env, fetchImpl, timeoutMs: Number(env.SERP_TIMEOUT_MS || timeoutMs) };
  switch (n) {
    case 'google': return createGoogleProvider(ctx);
    case 'gateway': case 'scraperapi': return createGatewayProvider(ctx);
    case 'serpapi': return createSerpApiProvider(ctx);
    case 'serper': return createSerperProvider(ctx);
    case 'browser': case 'puppeteer': return createBrowserProvider(ctx);
    case 'file': return createFileProvider(ctx);
    case 'demo': return createDemoProvider(demo);
    default: throw new ProviderError(`unknown provider "${n}" (use ${PROVIDERS.join(', ')})`, { kind: 'config', fatal: true });
  }
}
