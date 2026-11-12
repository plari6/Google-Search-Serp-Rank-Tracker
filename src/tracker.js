// Run one tracking pass for a project: every keyword -> SERP pages -> stored organic list + features.
import fs from 'node:fs';
import path from 'node:path';
import { jitter, mapPool, sleep } from './util/async.js';
import { matchesTarget, urlKey } from './util/url.js';
import { slugify } from './providers/index.js';

const RETRYABLE = new Set(['rate_limit', 'server', 'network', 'timeout', 'bad_response']);

const BLOCK_HELP = {
  js_required: 'Google now serves a "turn on JavaScript" page to plain HTTP clients',
  captcha: 'Google answered with a CAPTCHA ("unusual traffic")',
  consent: 'Google redirected to its cookie-consent page',
};

/** Fetch one keyword across pages until depth, early stop, or the end of results. */
export async function fetchKeyword(provider, kw, project, { now, onRequest, retries = 2, backoffMs = 2000, saveHtmlDir, log = () => {}, signal } = {}) {
  const entities = [project.brand, ...project.competitors];
  const organic = [];
  const seen = new Set();
  let features = {};
  let totalResults = null;
  let pages = 0;
  const maxPages = Math.ceil(project.depth / 10);

  for (let page = 0; page < maxPages; page++) {
    let res;
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw signal.reason;
      onRequest?.();
      try {
        res = await provider.fetchPage({ keyword: kw.keyword, page, locale: project.locale, now });
      } catch (err) {
        const kind = err.kind || (err.name === 'TypeError' ? 'network' : 'error');
        if (!err.fatal && RETRYABLE.has(kind) && attempt < retries) {
          const wait = err.retryAfterMs || backoffMs * 3 ** attempt;
          log(`  retry "${kw.keyword}" p${page + 1} in ${Math.round(wait / 1000)}s (${err.message})`);
          await sleep(Math.min(wait, 120000), signal);
          continue;
        }
        throw err;
      }
      if (res.status === 'blocked' && res.blockReason === 'captcha' && attempt < retries && provider.name !== 'google') {
        await sleep(backoffMs * 2.5 * (attempt + 1), signal);
        continue;
      }
      break;
    }
    pages++;
    if (saveHtmlDir && res.html) {
      fs.mkdirSync(saveHtmlDir, { recursive: true });
      fs.writeFileSync(path.join(saveHtmlDir, `${slugify(kw.keyword)}${page ? `-p${page + 1}` : ''}.html`), res.html);
    }
    if (res.status === 'blocked') {
      if (page === 0) return { status: 'blocked', error: `${res.blockReason}: ${BLOCK_HELP[res.blockReason] || 'blocked'}`, blockReason: res.blockReason, organic, features, pages };
      break; // keep what page 1+ gave us
    }
    if (res.status === 'missing') return { status: 'error', error: res.error, organic, features, pages };
    if (page === 0) {
      features = res.features || {};
      totalResults = res.totalResults ?? null;
    }
    for (const r of res.organic || []) {
      const k = urlKey(r.url);
      if (seen.has(k)) continue;
      seen.add(k);
      organic.push({ ...r, position: organic.length + 1, page: page + 1 });
    }
    if (organic.length >= project.depth || !res.organic?.length || res.hasNextPage === false) break;
    if (project.earlyStop && entities.every((e) => organic.some((r) => e.targets.some((t) => matchesTarget(r.url, t))))) break;
    if (provider.delayMs?.[1] > 0) await sleep(jitter(...provider.delayMs), signal);
  }
  return {
    status: organic.length ? 'ok' : 'no_results',
    organic: organic.slice(0, project.depth),
    features,
    totalResults,
    pages,
    depthReached: Math.min(organic.length, project.depth),
  };
}

/**
 * @param {object} project normalized project
 * @param {{db, provider, now?: Date, log?: Function, resume?: boolean, only?: string[], limit?: number,
 *          saveHtmlDir?: string, maxConsecutiveBlocks?: number, signal?: AbortSignal}} opts
 */
export async function trackProject(project, opts) {
  const { db, provider, log = () => {}, signal } = opts;
  const now = opts.now ? new Date(opts.now) : new Date();
  const startedAt = now.toISOString();
  let keywords = project.keywords;
  if (opts.only?.length) {
    const want = new Set(opts.only.map((s) => s.toLowerCase()));
    keywords = keywords.filter((k) => want.has(k.key) || want.has(k.group.toLowerCase()));
  }
  if (opts.limit) keywords = keywords.slice(0, opts.limit);

  let runId;
  let done = new Set();
  const prev = opts.resume ? db.latestUnfinishedRun(project.name) : null;
  if (prev) {
    runId = prev.id;
    done = db.okKeywordKeys(runId);
    log(`Resuming run #${runId} (${done.size}/${prev.keywords_total} keywords already done)`);
  } else {
    runId = db.createRun({ project: project.name, provider: provider.name, depth: project.depth, keywordsTotal: keywords.length, startedAt });
  }
  const todo = keywords.filter((k) => !done.has(k.key));

  let requests = 0;
  let consecutiveBlocks = 0;
  const maxBlocks = opts.maxConsecutiveBlocks ?? (provider.name === 'google' ? 2 : 4);
  const stats = { ok: done.size, noResults: 0, blocked: 0, errors: 0 };
  let fatal = null;
  const started = Date.now();
  let finished = 0;

  try {
    await mapPool(todo, provider.concurrency || 1, async (kw, i) => {
      if (i > 0 && provider.delayMs?.[1] > 0) await sleep(jitter(...provider.delayMs), signal);
      let r;
      try {
        r = await fetchKeyword(provider, kw, project, { now, onRequest: () => requests++, saveHtmlDir: opts.saveHtmlDir, backoffMs: opts.backoffMs, log, signal });
      } catch (err) {
        r = { status: 'error', error: err.message, organic: [], features: {}, pages: 0, fatal: err.fatal };
        if (err.fatal) {
          fatal = err;
          err.stopPool = true;
        }
      }
      db.saveSerp({
        runId, project: project.name, keywordKey: kw.key, keyword: kw.keyword, fetchedAt: new Date(now.getTime() + (Date.now() - started)).toISOString(),
        status: r.status, error: r.error, pages: r.pages, depthReached: r.depthReached, totalResults: r.totalResults, organic: r.organic, features: r.features,
      });
      finished++;
      if (r.status === 'ok') stats.ok++;
      else if (r.status === 'no_results') stats.noResults++;
      else if (r.status === 'blocked') stats.blocked++;
      else stats.errors++;
      const brandHit = r.organic.find((o) => project.brand.targets.some((t) => matchesTarget(o.url, t)));
      log(`  [${String(finished).padStart(3)}/${todo.length}] ${kw.keyword.padEnd(38).slice(0, 38)} ${r.status === 'ok' ? (brandHit ? `#${brandHit.position}`.padEnd(5) : '-'.padEnd(5)) : r.status.toUpperCase()}${r.error ? '  ' + r.error : ''}`);
      if (r.status === 'blocked') {
        consecutiveBlocks++;
        if (consecutiveBlocks >= maxBlocks) {
          const e = new Error(`stopped after ${consecutiveBlocks} blocked keywords in a row (${r.error}). Use --provider serpapi | serper | gateway | browser, or slow down.`);
          e.stopPool = true;
          e.blocked = true;
          throw e;
        }
      } else if (r.status === 'ok') consecutiveBlocks = 0;
      if (r.fatal) throw fatal;
      return r;
    });
  } catch (err) {
    fatal = err;
  } finally {
    await provider.close?.();
  }

  const status = fatal ? (fatal.blocked ? 'blocked' : 'partial') : stats.errors || stats.blocked ? 'partial' : 'done';
  db.finishRun(runId, {
    status, keywordsOk: stats.ok + stats.noResults, requests, error: fatal?.message || null,
    finishedAt: new Date(now.getTime() + (Date.now() - started)).toISOString(),
  });
  return { runId, status, requests, keywords: keywords.length, ...stats, error: fatal?.message || null, durationMs: Date.now() - started };
}
