import test from 'node:test';
import assert from 'node:assert/strict';
import { ctr, visibility, pickCompareRun, buildReport, entityRank } from '../src/metrics.js';
import { trackProject } from '../src/tracker.js';
import { ProviderError } from '../src/providers/index.js';
import { makeProject, serp, fakeProvider, memDb, day } from './helpers.js';

test('CTR curve is monotonic and zero when not ranking', () => {
  for (let p = 1; p < 100; p++) assert.ok(ctr(p) >= ctr(p + 1), `ctr(${p}) >= ctr(${p + 1})`);
  assert.equal(ctr(null), 0);
  assert.equal(ctr(101), 0);
  assert.equal(visibility([{ kw: { volume: 100 }, position: 1 }], true), 100);
  assert.equal(visibility([{ kw: {}, position: null }], false), 0);
});

test('pickCompareRun prefers the run about a week earlier', () => {
  const runs = [
    { id: 4, started_at: '2026-11-10T07:00:00Z' }, { id: 3, started_at: '2026-11-08T07:00:00Z' },
    { id: 2, started_at: '2026-11-03T07:00:00Z' }, { id: 1, started_at: '2026-10-27T07:00:00Z' },
  ];
  assert.equal(pickCompareRun(runs, runs[0]).id, 2);
  assert.equal(pickCompareRun(runs.slice(0, 2), runs[0]).id, 3, 'falls back to the previous run');
  assert.equal(pickCompareRun([runs[3]], runs[3]), null);
});

test('entityRank finds best position and all URLs', () => {
  const s = serp({ 4: 'https://acme.com/a', 9: 'https://blog.acme.com/b' });
  const r = entityRank(s.organic.map((o, i) => ({ ...o, position: i + 1 })), makeProject().brand);
  assert.equal(r.position, 4);
  assert.equal(r.urls.length, 2);
});

async function twoWeeks({ week2Fails = false } = {}) {
  const db = memDb();
  const project = makeProject();
  const w1 = {
    'crm software': serp({ 4: 'https://acme.com/crm', 6: 'https://rival.com/' }),
    'best crm': serp({ 12: 'https://acme.com/best', 2: 'https://rival.com/' }, { featured_snippet: { url: 'https://filler1.net/page' } }),
    'crm pricing': serp({ 8: 'https://acme.com/pricing' }),
    'what is crm': serp({ 1: 'https://acme.com/what-is-crm' }, { featured_snippet: { url: 'https://acme.com/what-is-crm' }, ai_overview: { cited: [{ url: 'https://acme.com/what-is-crm', domain: 'acme.com' }] } }),
  };
  const w2 = {
    'crm software': serp({ 14: 'https://acme.com/crm', 3: 'https://rival.com/' }), // drop off page 1 + overtake
    'best crm': serp({ 5: 'https://acme.com/best', 2: 'https://rival.com/' }), // +7
    'crm pricing': serp({ 7: 'https://acme.com/blog/pricing-guide', 20: 'https://acme.com/pricing' }), // url change + cannibal + wrong page
    'what is crm': serp({ 2: 'https://acme.com/what-is-crm' }, { featured_snippet: { url: 'https://rival.com/x' }, ai_overview: { cited: [{ url: 'https://rival.com/x', domain: 'rival.com' }] } }),
  };
  await trackProject(project, { db, provider: fakeProvider(w1), now: day('2026-11-02') });
  const p2 = week2Fails
    ? fakeProvider(async (kw, page) => { if (kw === 'what is crm') throw new ProviderError('timeout', { kind: 'timeout' }); return fakeProvider(w2).fetchPage({ keyword: kw, page }); })
    : fakeProvider(w2);
  await trackProject(project, { db, provider: p2, backoffMs: 1, now: day('2026-11-09') });
  return { db, project };
}

test('weekly report: KPIs, changes, movers, opportunities', async () => {
  const { db, project } = await twoWeeks();
  const r = buildReport(project, db);
  assert.equal(r.compare.date.slice(0, 10), '2026-11-02');
  const kw = Object.fromEntries(r.keywords.map((k) => [k.keyword, k]));
  assert.equal(kw['crm software'].change, -10);
  assert.equal(kw['best crm'].change, 7);
  assert.equal(kw['crm pricing'].urlChanged, true);
  assert.equal(kw['crm pricing'].targetMismatch, true);
  assert.equal(kw['crm pricing'].cannibal.length, 2);
  assert.deepEqual(kw['crm software'].history, [4, 14]);
  assert.equal(r.kpis.top10, 3);
  assert.equal(r.kpis.prev.top10, 3);
  assert.equal(r.kpis.featuredSnippets, 0);
  assert.equal(r.kpis.prev.featuredSnippets, 1);
  assert.equal(r.winners[0].keyword, 'best crm');
  assert.equal(r.losers[0].keyword, 'crm software');
  assert.deepEqual(r.leftTop10.map((k) => k.keyword), ['crm software']);
  assert.ok(r.opportunities.some((o) => o.keyword === 'crm software' && o.gainClicks > 0));
  const sov = r.competitors.reduce((a, c) => a + c.sov, 0);
  assert.ok(Math.abs(sov - 100) < 0.5, `share of voice sums to 100 (${sov})`);
  assert.equal(r.series.dates.length, 2);
  assert.equal(r.overtakes[0].competitor, 'Rival');
});

test('alerts: drop off page 1, lost snippet + AI citation, URL change, overtake, gains', async () => {
  const { db, project } = await twoWeeks();
  const types = buildReport(project, db).alerts.map((a) => `${a.severity}:${a.type}:${a.keyword}`);
  assert.ok(types.includes('high:drop:crm software'));
  assert.ok(types.includes('high:lost_snippet:what is crm'));
  assert.ok(types.includes('medium:lost_ai:what is crm'));
  assert.ok(types.includes('medium:url_change:crm pricing'));
  assert.ok(types.includes('high:overtake_Rival:crm software'));
  assert.ok(types.includes('good:top10:best crm'));
  assert.equal(types.findIndex((t) => t.startsWith('good')) > types.findIndex((t) => t.startsWith('high')), true, 'urgent first');
});

test('a failed fetch carries last week forward as stale - never reported as a lost ranking', async () => {
  const { db, project } = await twoWeeks({ week2Fails: true });
  const r = buildReport(project, db);
  const k = r.keywords.find((x) => x.keyword === 'what is crm');
  assert.equal(k.status, 'stale');
  assert.equal(k.position, 1);
  assert.equal(k.isLost, false);
  assert.equal(k.change, 0);
  assert.equal(r.kpis.stale, 1);
  assert.ok(!r.alerts.some((a) => a.keyword === 'what is crm'));
});

test('first run is a baseline with no comparison', async () => {
  const db = memDb();
  const project = makeProject();
  await trackProject(project, { db, provider: fakeProvider(() => serp({ 3: 'https://acme.com/' })) });
  const r = buildReport(project, db);
  assert.equal(r.compare, null);
  assert.equal(r.kpis.prev, undefined);
  assert.ok(r.keywords.every((k) => k.change === null));
  assert.equal(r.alerts.length, 0);
  assert.throws(() => buildReport(makeProject({ name: 'empty' }), db), /no tracking runs/);
});

test('discovered domains and competitor ads on brand keywords', async () => {
  const db = memDb();
  const project = makeProject({ keywords: ['acme pricing', 'crm tool'] });
  const s = serp({ 1: 'https://acme.com/', 2: 'https://bigsite.com/a' }, { ads: [{ position: 'top', domain: 'rival.com' }] });
  await trackProject(project, { db, provider: fakeProvider(() => s), now: day('2026-11-01') });
  await trackProject(project, { db, provider: fakeProvider(() => s), now: day('2026-11-08') });
  const r = buildReport(project, db);
  assert.equal(r.discovered.find((d) => d.domain === 'bigsite.com').keywords, 2);
  assert.equal(r.advertisers[0].competitor, 'Rival');
  assert.ok(r.alerts.some((a) => a.type === 'brand_bid_rival.com' && a.keyword === 'acme pricing'));
  assert.ok(!r.alerts.some((a) => a.type.startsWith('brand_bid') && a.keyword === 'crm tool'));
});
