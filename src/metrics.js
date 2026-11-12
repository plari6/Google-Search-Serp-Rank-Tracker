// Turn stored SERPs into the weekly report: positions, changes, visibility, share of voice, opportunities.
import { matchesTarget, urlKey, hostOf } from './util/url.js';

// Organic click-through rate by position (blend of public 2024-2026 CTR studies, desktop).
export const CTR = [0, 0.276, 0.158, 0.11, 0.08, 0.061, 0.046, 0.036, 0.029, 0.024, 0.021,
  0.016, 0.014, 0.012, 0.011, 0.01, 0.009, 0.008, 0.007, 0.006, 0.0055];
export function ctr(pos) {
  if (!pos || pos < 1) return 0;
  if (pos <= 20) return CTR[pos];
  if (pos <= 30) return 0.003;
  if (pos <= 50) return 0.0015;
  return pos <= 100 ? 0.0005 : 0;
}

const DAY = 86400000;

/** Best position + all matching URLs of an entity in an organic list. */
export function entityRank(organic, entity) {
  const hits = (organic || []).filter((r) => entity.targets.some((t) => matchesTarget(r.url, t)));
  if (!hits.length) return { position: null, url: null, urls: [] };
  return { position: hits[0].position, url: hits[0].url, urls: hits.map((h) => ({ position: h.position, url: h.url })) };
}

const owns = (features, entity) => {
  const m = (u) => !!u && entity.targets.some((t) => matchesTarget(u, t));
  return {
    featured: m(features?.featured_snippet?.url),
    aiCited: !!features?.ai_overview?.cited?.some((c) => m(c.url)),
    local: !!features?.local_pack?.places?.some((p) => m(p.url)),
    video: !!features?.videos?.items?.some((c) => m(c.url)),
    news: !!features?.top_stories?.items?.some((c) => m(c.url)),
  };
};

const FEATURE_LABEL = {
  ai_overview: 'AI Overview', featured_snippet: 'Featured snippet', people_also_ask: 'People also ask', local_pack: 'Local pack',
  top_stories: 'Top stories', videos: 'Videos', images: 'Images', shopping: 'Shopping', knowledge_panel: 'Knowledge panel',
  discussions: 'Discussions', ads: 'Ads', related_searches: 'Related searches',
};
export const featureLabel = (k) => FEATURE_LABEL[k] || k;

function bucket(pos) {
  if (!pos) return 'not';
  if (pos <= 3) return 'top3';
  if (pos <= 10) return 'top10';
  if (pos <= 20) return 'top20';
  if (pos <= 50) return 'top50';
  return 'top100';
}

function weightOf(kw, useVolume) {
  return useVolume ? Math.max(kw.volume || 0, 10) : 1;
}

/** Visibility 0-100: CTR-weighted share of the maximum possible clicks (everything at #1). */
export function visibility(rows, useVolume) {
  let got = 0;
  let max = 0;
  for (const r of rows) {
    const w = weightOf(r.kw, useVolume);
    max += w * ctr(1);
    got += w * ctr(r.position);
  }
  return max ? (got / max) * 100 : 0;
}

/** Pick the comparison run: latest run at least ~6 days older than `current`, else the previous run. */
export function pickCompareRun(runs, current, compareDays = 7) {
  const older = runs.filter((r) => r.id !== current.id && new Date(r.started_at) < new Date(current.started_at));
  if (!older.length) return null;
  const cutoff = new Date(current.started_at).getTime() - (compareDays - 1) * DAY;
  return older.find((r) => new Date(r.started_at).getTime() <= cutoff) || older[0];
}

const round = (n, d = 1) => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

/**
 * Build all report data from the database.
 * @returns plain JSON (also written as summary.json)
 */
export function buildReport(project, db, { runId, weeks, compareDays = 7, now = new Date() } = {}) {
  const allRuns = db.getRuns(project.name, 400).filter((r) => r.status !== 'running' || r.id === runId);
  if (!allRuns.length) throw new Error(`no tracking runs for "${project.name}" yet - run: serp-tracker track ${project.name}`);
  const current = runId ? allRuns.find((r) => r.id === runId) : allRuns.find((r) => r.keywords_ok > 0) || allRuns[0];
  if (!current) throw new Error(`run #${runId} not found`);
  const compare = pickCompareRun(allRuns, current, compareDays);
  const windowWeeks = weeks || project.report.weeks || 12;
  const since = new Date(current.started_at).getTime() - windowWeeks * 7 * DAY;
  const seriesRuns = allRuns.filter((r) => new Date(r.started_at).getTime() >= since && new Date(r.started_at) <= new Date(current.started_at) && r.keywords_ok > 0).reverse();

  const serpsByRun = new Map();
  const serpsOf = (run) => {
    if (!run) return new Map();
    if (!serpsByRun.has(run.id)) serpsByRun.set(run.id, new Map(db.getSerps(run.id).map((s) => [s.keyword_key, s])));
    return serpsByRun.get(run.id);
  };
  for (const r of seriesRuns) serpsOf(r);
  const okStatus = (s) => s && (s.status === 'ok' || s.status === 'no_results');

  // Latest usable SERP per keyword at or before a run (carry forward failed fetches, flagged stale).
  const asc = [...allRuns].reverse();
  const runIndex = new Map(asc.map((r, i) => [r.id, i]));
  const serpAt = (run, key) => {
    const own = serpsOf(run).get(key);
    if (okStatus(own)) return { serp: own, stale: false };
    const idx = runIndex.get(run.id) ?? asc.length;
    for (let i = idx - 1; i >= 0 && i >= idx - 3; i--) {
      const s = serpsOf(asc[i]).get(key);
      if (okStatus(s)) return { serp: s, stale: true, error: own?.error || 'not fetched' };
    }
    return { serp: null, stale: true, error: own?.error || 'not fetched' };
  };

  const entities = [project.brand, ...project.competitors];
  const useVolume = project.keywords.some((k) => k.volume);
  const brand = project.brand;

  // ---- Per keyword ------------------------------------------------------------------------
  const keywords = project.keywords.map((kw) => {
    const cur = serpAt(current, kw.key);
    const prv = compare ? serpAt(compare, kw.key) : { serp: null, stale: true };
    const r = cur.serp ? entityRank(cur.serp.organic, brand) : { position: null, url: null, urls: [] };
    const p = prv.serp ? entityRank(prv.serp.organic, brand) : { position: null, url: null, urls: [] };
    const comparable = !!(cur.serp && prv.serp);
    const change = comparable && r.position && p.position ? p.position - r.position : null; // + = improved
    const history = seriesRuns.map((run) => {
      const s = serpsOf(run).get(kw.key);
      return okStatus(s) ? entityRank(s.organic, brand).position : undefined;
    });
    const ranked = history.filter((x) => x);
    const features = cur.serp?.features || {};
    const prevFeatures = prv.serp?.features || {};
    const own = owns(features, brand);
    const ownPrev = owns(prevFeatures, brand);
    const competitors = Object.fromEntries(project.competitors.map((c) => {
      const cr = cur.serp ? entityRank(cur.serp.organic, c).position : null;
      const cp = prv.serp ? entityRank(prv.serp.organic, c).position : null;
      return [c.name, { position: cr, prev: cp, change: cr && cp ? cp - cr : null }];
    }));
    // SERP volatility: share of the top-10 URLs that are new since the comparison run.
    let volatility = null;
    if (comparable) {
      const a = new Set(cur.serp.organic.slice(0, 10).map((o) => urlKey(o.url)));
      const b = new Set(prv.serp.organic.slice(0, 10).map((o) => urlKey(o.url)));
      if (a.size && b.size) volatility = round(([...a].filter((x) => !b.has(x)).length / a.size) * 100, 0);
    }
    const urlChanged = !!(r.url && p.url && urlKey(r.url) !== urlKey(p.url));
    const targetMismatch = !!(kw.targetUrl && r.url && urlKey(r.url) !== urlKey(kw.targetUrl.startsWith('http') ? kw.targetUrl : `https://${kw.targetUrl}`));
    const cannibal = r.urls.length > 1 && r.urls.filter((u) => u.position <= 30).length > 1 ? r.urls.filter((u) => u.position <= 30) : null;
    const top = cur.serp?.organic?.[0];
    const depth = cur.serp?.depth_reached || project.depth;
    let status = cur.serp ? (cur.stale ? 'stale' : 'ok') : 'missing';
    return {
      keyword: kw.keyword, key: kw.key, group: kw.group, volume: kw.volume, priority: kw.priority, intent: kw.intent, targetUrl: kw.targetUrl,
      position: r.position, prevPosition: p.position, change, url: r.url, prevUrl: p.url, urlChanged, targetMismatch, cannibal,
      isNew: comparable && !!r.position && !p.position,
      isLost: comparable && !r.position && !!p.position,
      best: ranked.length ? Math.min(...ranked) : r.position, history,
      bucket: bucket(r.position), prevBucket: comparable ? bucket(p.position) : null,
      features: Object.keys(features), featuresPrev: Object.keys(prevFeatures),
      owns: own, ownsPrev: comparable ? ownPrev : null,
      aiOverviewCited: features.ai_overview ? features.ai_overview.cited.map((c) => c.domain) : null,
      ads: (features.ads || []).map((a) => a.domain).filter(Boolean),
      competitors, volatility, depth,
      leader: top ? { domain: top.domain, url: top.url, title: top.title } : null,
      estClicks: kw.volume ? round(kw.volume * ctr(r.position), 0) : null,
      status, error: cur.error || null, fetchedAt: cur.serp?.fetched_at || null,
    };
  });

  const valid = keywords.filter((k) => k.status !== 'missing');
  const rowsFor = (getPos) => valid.map((k) => ({ kw: project.keywords.find((x) => x.key === k.key), position: getPos(k) }));
  const prevValid = compare ? keywords.filter((k) => k.prevBucket !== null) : [];
  const count = (list, fn) => list.filter(fn).length;
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  const kpis = {
    keywords: project.keywords.length,
    tracked: valid.length,
    stale: count(keywords, (k) => k.status === 'stale'),
    missing: count(keywords, (k) => k.status === 'missing'),
    ranking: count(valid, (k) => k.position),
    top3: count(valid, (k) => k.position && k.position <= 3),
    top10: count(valid, (k) => k.position && k.position <= 10),
    top20: count(valid, (k) => k.position && k.position <= 20),
    avgPosition: round(avg(valid.filter((k) => k.position).map((k) => k.position))),
    visibility: round(visibility(rowsFor((k) => k.position), useVolume), 2),
    estClicks: useVolume ? Math.round(valid.reduce((a, k) => a + (k.estClicks || 0), 0)) : null,
    improved: count(keywords, (k) => k.change > 0),
    declined: count(keywords, (k) => k.change < 0),
    unchanged: count(keywords, (k) => k.change === 0),
    newRankings: count(keywords, (k) => k.isNew),
    lostRankings: count(keywords, (k) => k.isLost),
    featuredSnippets: count(valid, (k) => k.owns.featured),
    aiOverviewCitations: count(valid, (k) => k.owns.aiCited),
    aiOverviewKeywords: count(valid, (k) => k.features.includes('ai_overview')),
    localPack: count(valid, (k) => k.owns.local),
    volatility: round(avg(keywords.map((k) => k.volatility).filter((v) => v !== null)), 0),
  };
  if (compare) {
    kpis.prev = {
      ranking: count(prevValid, (k) => k.prevPosition),
      top3: count(prevValid, (k) => k.prevPosition && k.prevPosition <= 3),
      top10: count(prevValid, (k) => k.prevPosition && k.prevPosition <= 10),
      top20: count(prevValid, (k) => k.prevPosition && k.prevPosition <= 20),
      avgPosition: round(avg(prevValid.filter((k) => k.prevPosition).map((k) => k.prevPosition))),
      visibility: round(visibility(prevValid.map((k) => ({ kw: project.keywords.find((x) => x.key === k.key), position: k.prevPosition })), useVolume), 2),
      estClicks: useVolume ? Math.round(prevValid.reduce((a, k) => a + (k.volume ? k.volume * ctr(k.prevPosition) : 0), 0)) : null,
      featuredSnippets: count(prevValid, (k) => k.ownsPrev?.featured),
      aiOverviewCitations: count(prevValid, (k) => k.ownsPrev?.aiCited),
    };
  }

  // ---- Movers & lists -----------------------------------------------------------------------
  const impact = (k) => (k.change || 0) * (0.5 + Math.log10(Math.max(k.volume || 10, 10)) / 4) * (k.priority ? 1.5 : 1) * (k.position && k.position <= 20 ? 1.3 : 1);
  const winners = keywords.filter((k) => k.change > 0 || k.isNew).sort((a, b) => (b.isNew ? 3 : impact(b)) - (a.isNew ? 3 : impact(a))).slice(0, 10);
  const losers = keywords.filter((k) => k.change < 0 || k.isLost).sort((a, b) => (a.isLost ? -30 : impact(a)) - (b.isLost ? -30 : impact(b))).slice(0, 10);
  const enteredTop10 = keywords.filter((k) => k.position && k.position <= 10 && (!k.prevPosition || k.prevPosition > 10) && k.prevBucket !== null);
  const leftTop10 = keywords.filter((k) => k.prevPosition && k.prevPosition <= 10 && (!k.position || k.position > 10));
  const opportunities = keywords
    .filter((k) => k.position && k.position >= 4 && k.position <= 20)
    .map((k) => {
      const w = k.volume || 100;
      const gain = w * (ctr(3) - ctr(k.position));
      return {
        keyword: k.keyword, position: k.position, volume: k.volume, url: k.url, gainClicks: k.volume ? Math.round(gain) : null, score: gain,
        leader: k.leader?.domain, why: k.position <= 10 ? 'page 1, close to the top 3' : 'striking distance: top of page 2',
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  // ---- Competitors & share of voice ---------------------------------------------------------
  const sovRaw = entities.map((e) => {
    const rows = valid.map((k) => {
      const kw = project.keywords.find((x) => x.key === k.key);
      const s = serpAt(current, k.key).serp;
      return { kw, position: s ? entityRank(s.organic, e).position : null };
    });
    const prevRows = compare ? prevValid.map((k) => {
      const kw = project.keywords.find((x) => x.key === k.key);
      const s = serpAt(compare, k.key).serp;
      return { kw, position: s ? entityRank(s.organic, e).position : null };
    }) : [];
    return {
      name: e.name, domains: e.domains, isBrand: e === brand,
      visibility: visibility(rows, useVolume), prevVisibility: compare ? visibility(prevRows, useVolume) : null,
      avgPosition: round(avg(rows.filter((r) => r.position).map((r) => r.position))),
      top10: rows.filter((r) => r.position && r.position <= 10).length,
      top3: rows.filter((r) => r.position && r.position <= 3).length,
      ranking: rows.filter((r) => r.position).length,
    };
  });
  const sovTotal = sovRaw.reduce((a, e) => a + e.visibility, 0) || 1;
  const sovPrevTotal = sovRaw.reduce((a, e) => a + (e.prevVisibility || 0), 0) || 1;
  const competitors = sovRaw.map((e) => ({
    ...e,
    visibility: round(e.visibility, 2), prevVisibility: round(e.prevVisibility, 2),
    sov: round((e.visibility / sovTotal) * 100), prevSov: compare ? round(((e.prevVisibility || 0) / sovPrevTotal) * 100) : null,
    outranksBrand: e.isBrand ? null : keywords.filter((k) => {
      const c = k.competitors[e.name]?.position;
      return c && (!k.position || c < k.position);
    }).length,
  }));
  const overtakes = [];
  for (const k of keywords) {
    for (const [name, c] of Object.entries(k.competitors)) {
      const wasBehind = k.prevPosition && (!c.prev || c.prev > k.prevPosition);
      const nowAhead = c.position && (!k.position || c.position < k.position);
      if (wasBehind && nowAhead) overtakes.push({ keyword: k.keyword, competitor: name, competitorPosition: c.position, position: k.position, priority: k.priority });
    }
  }

  // Domains that are not tracked but keep showing up in the top 10 (competitors you are missing).
  const tracked = (d) => entities.some((e) => e.targets.some((t) => matchesTarget(`https://${d}/`, { ...t, path: '' })));
  const domainCount = new Map();
  for (const k of valid) {
    const s = serpAt(current, k.key).serp;
    for (const d of new Set((s?.organic || []).slice(0, 10).map((o) => o.domain))) {
      if (!tracked(d)) domainCount.set(d, (domainCount.get(d) || 0) + 1);
    }
  }
  const discovered = [...domainCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([domain, n]) => ({ domain, keywords: n, share: round((n / Math.max(valid.length, 1)) * 100, 0) }));

  const adCount = new Map();
  for (const k of valid) for (const d of new Set(k.ads)) adCount.set(d, (adCount.get(d) || 0) + 1);
  const advertisers = [...adCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([domain, n]) => ({
    domain, keywords: n, competitor: entities.find((e) => e !== brand && e.targets.some((t) => matchesTarget(`https://${domain}/`, { ...t, path: '' })))?.name || null,
  }));

  const featureSummary = Object.keys(FEATURE_LABEL).map((f) => ({
    feature: f, label: featureLabel(f), keywords: count(valid, (k) => k.features.includes(f)),
    brandOwns: f === 'featured_snippet' ? kpis.featuredSnippets : f === 'ai_overview' ? kpis.aiOverviewCitations : f === 'local_pack' ? kpis.localPack
      : f === 'videos' ? count(valid, (k) => k.owns.video) : f === 'top_stories' ? count(valid, (k) => k.owns.news) : null,
  })).filter((f) => f.keywords > 0);

  const groups = [...new Set(project.keywords.map((k) => k.group))].map((g) => {
    const ks = keywords.filter((k) => k.group === g && k.status !== 'missing');
    return {
      group: g, keywords: ks.length,
      avgPosition: round(avg(ks.filter((k) => k.position).map((k) => k.position))),
      top10: count(ks, (k) => k.position && k.position <= 10),
      visibility: round(visibility(ks.map((k) => ({ kw: project.keywords.find((x) => x.key === k.key), position: k.position })), useVolume), 2),
      change: ks.reduce((a, k) => a + (k.change || 0), 0),
    };
  }).sort((a, b) => b.keywords - a.keywords);

  // ---- Time series for charts -----------------------------------------------------------------
  const series = { dates: [], runIds: [], visibility: [], avgPosition: [], top3: [], top10: [], top20: [], ranking: [], sov: Object.fromEntries(entities.map((e) => [e.name, []])), distribution: [] };
  for (const run of seriesRuns) {
    const rows = [];
    const perEntity = new Map(entities.map((e) => [e.name, []]));
    for (const kw of project.keywords) {
      const { serp } = serpAt(run, kw.key);
      if (!serp) continue;
      for (const e of entities) perEntity.get(e.name).push({ kw, position: entityRank(serp.organic, e).position });
    }
    const brandRows = perEntity.get(brand.name);
    rows.push(...brandRows);
    const vis = entities.map((e) => visibility(perEntity.get(e.name), useVolume));
    const tot = vis.reduce((a, b) => a + b, 0) || 1;
    series.dates.push(run.started_at.slice(0, 10));
    series.runIds.push(run.id);
    series.visibility.push(round(visibility(rows, useVolume), 2));
    series.avgPosition.push(round(avg(rows.filter((r) => r.position).map((r) => r.position))));
    series.top3.push(rows.filter((r) => r.position && r.position <= 3).length);
    series.top10.push(rows.filter((r) => r.position && r.position <= 10).length);
    series.top20.push(rows.filter((r) => r.position && r.position <= 20).length);
    series.ranking.push(rows.filter((r) => r.position).length);
    entities.forEach((e, i) => series.sov[e.name].push(round((vis[i] / tot) * 100)));
    const dist = { top3: 0, top10: 0, top20: 0, top50: 0, top100: 0, not: 0 };
    for (const r of rows) dist[bucket(r.position)]++;
    series.distribution.push(dist);
  }

  const alerts = buildAlerts(project, keywords, overtakes, advertisers);

  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    project: {
      name: project.name, client: project.client, brand: { name: brand.name, domains: brand.domains },
      competitors: project.competitors.map((c) => ({ name: c.name, domains: c.domains })), locale: project.locale, depth: project.depth,
      agency: project.report.agency, brandColor: project.report.brandColor,
    },
    usesVolume: useVolume,
    run: { id: current.id, date: current.started_at, provider: current.provider, status: current.status, requests: current.requests, error: current.error },
    compare: compare ? { id: compare.id, date: compare.started_at } : null,
    kpis, keywords, winners, losers, enteredTop10, leftTop10, opportunities, competitors, overtakes, discovered, advertisers,
    featureSummary, groups, series, alerts,
    cannibalization: keywords.filter((k) => k.cannibal).map((k) => ({ keyword: k.keyword, urls: k.cannibal })),
    urlChanges: keywords.filter((k) => k.urlChanged).map((k) => ({ keyword: k.keyword, from: k.prevUrl, to: k.url, position: k.position })),
    targetMismatches: keywords.filter((k) => k.targetMismatch).map((k) => ({ keyword: k.keyword, targetUrl: k.targetUrl, rankingUrl: k.url, position: k.position })),
  };
}

/** Alert list (severity high | medium | good). Keys are stable per run so re-sends are deduped. */
export function buildAlerts(project, keywords, overtakes = [], advertisers = []) {
  const a = project.alerts;
  const out = [];
  const add = (severity, type, k, text) => out.push({ severity, type, keyword: k?.keyword || null, text, key: `${type}:${k?.key || text}` });
  for (const k of keywords) {
    if (k.status !== 'ok' || k.prevBucket === null) continue;
    const prevOk = k.prevPosition && k.prevPosition <= a.maxPrevPosition;
    if (k.isLost && prevOk) add('high', 'lost', k, `"${k.keyword}" dropped out of the top ${k.depth} (was #${k.prevPosition})`);
    else if (k.change !== null && prevOk && -k.change >= (k.priority ? a.priorityDrop : a.dropPositions)) {
      const exit = k.prevPosition <= 10 && k.position > 10;
      add(exit || k.priority ? 'high' : 'medium', 'drop', k, `"${k.keyword}" fell ${-k.change} positions: #${k.prevPosition} → #${k.position}${exit ? ' (off page 1)' : ''}`);
    }
    if (a.featureLoss && k.ownsPrev?.featured && !k.owns.featured) add('high', 'lost_snippet', k, `Lost the featured snippet for "${k.keyword}"`);
    if (a.featureLoss && k.ownsPrev?.aiCited && !k.owns.aiCited && k.features.includes('ai_overview')) add('medium', 'lost_ai', k, `No longer cited in the AI Overview for "${k.keyword}"`);
    if (a.urlChange && k.urlChanged && k.position && k.position <= 20) add('medium', 'url_change', k, `Ranking page changed for "${k.keyword}": ${k.prevUrl} → ${k.url}`);
    if (a.gains) {
      const wonSnippet = k.owns.featured && k.ownsPrev && !k.ownsPrev.featured;
      if (wonSnippet) add('good', 'won_snippet', k, `Won the featured snippet for "${k.keyword}" (#${k.position})`);
      else if (k.position && k.position <= 3 && (!k.prevPosition || k.prevPosition > 3)) add('good', 'top3', k, `"${k.keyword}" entered the top 3 (#${k.position})`);
      else if (k.position && k.position <= 10 && (!k.prevPosition || k.prevPosition > 10)) add('good', 'top10', k, `"${k.keyword}" reached page 1 (#${k.position})`);
    }
  }
  if (a.competitorOvertake) {
    for (const o of overtakes.filter((x) => x.priority || (x.competitorPosition <= 10))) {
      const k = keywords.find((x) => x.keyword === o.keyword);
      add(o.priority ? 'high' : 'medium', `overtake_${o.competitor}`, k, `${o.competitor} overtook you on "${o.keyword}" (#${o.competitorPosition} vs ${o.position ? '#' + o.position : 'not ranking'})`);
    }
  }
  const brandTerms = [project.brand.name, ...project.brand.domains.map((d) => hostOf(d).split('.')[0])].map((s) => s.toLowerCase());
  for (const k of keywords) {
    if (!brandTerms.some((t) => t && k.key.includes(t))) continue;
    for (const d of k.ads) {
      const adv = advertisers.find((x) => x.domain === d);
      if (adv?.competitor) add('medium', `brand_bid_${d}`, k, `${adv.competitor} is bidding on your brand keyword "${k.keyword}"`);
    }
  }
  const rank = { high: 0, medium: 1, good: 2 };
  return out.sort((x, y) => rank[x.severity] - rank[y.severity]);
}
