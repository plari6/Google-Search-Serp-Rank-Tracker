import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createProvider, mapSerpApi, mapSerper, buildGoogleUrl, resolveProviderName, ProviderError } from '../src/providers/index.js';

const modern = fs.readFileSync(new URL('./fixtures/google-modern.html', import.meta.url), 'utf8');
const res = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const locale = { gl: 'gb', hl: 'en', googleDomain: 'google.co.uk', location: 'London,England,United Kingdom', device: 'desktop' };

test('buildGoogleUrl: domain, paging, locale, uule', () => {
  const u = new URL(buildGoogleUrl('crm software', 2, locale));
  assert.equal(u.hostname, 'www.google.co.uk');
  assert.equal(u.searchParams.get('q'), 'crm software');
  assert.equal(u.searchParams.get('start'), '20');
  assert.equal(u.searchParams.get('gl'), 'gb');
  assert.ok(u.searchParams.get('uule').startsWith('w+CAIQICI'));
  assert.equal(new URL(buildGoogleUrl('x', 0, {})).searchParams.get('start'), null);
});

test('provider auto-selection prefers configured APIs', () => {
  assert.equal(resolveProviderName(undefined, {}), 'google');
  assert.equal(resolveProviderName(undefined, { SERPER_API_KEY: 'k' }), 'serper');
  assert.equal(resolveProviderName(undefined, { SERPER_API_KEY: 'k', SERPAPI_KEY: 'k' }), 'serpapi');
  assert.equal(resolveProviderName(undefined, { SCRAPER_API_URL: 'https://g/?u={url}' }), 'gateway');
  assert.equal(resolveProviderName('demo', { SERPAPI_KEY: 'k' }), 'demo');
  assert.throws(() => createProvider('nope', { env: {} }), /unknown provider/);
});

const SERPAPI_SAMPLE = {
  search_information: { total_results: 98000 },
  answer_box: { type: 'organic_result', link: 'https://snippet.com/a', title: 'Snippet' },
  organic_results: [
    { position: 1, link: 'https://www.acme.com/', title: 'Acme', snippet: 's', sitelinks: { inline: [{}, {}] } },
    { position: 2, link: 'https://snippet.com/a', title: 'dup of answer box' },
    { position: 3, link: 'https://rival.com/x', title: 'Rival' },
  ],
  ai_overview: { references: [{ link: 'https://acme.com/guide', source: 'Acme' }] },
  related_questions: [{ question: 'Is Acme good?' }],
  local_results: { places: [{ title: 'Acme Store', links: { website: 'https://acme.com/store' } }] },
  ads: [{ block_position: 'top', link: 'https://rival.com/ad', title: 'Rival ad' }],
  related_searches: [{ query: 'acme pricing' }],
  serpapi_pagination: { next: 'https://serpapi.com/...' },
};

test('SerpApi JSON maps to the common shape (answer box = #1, no duplicate)', () => {
  const r = mapSerpApi(SERPAPI_SAMPLE, 0);
  assert.deepEqual(r.organic.map((o) => o.domain), ['snippet.com', 'acme.com', 'rival.com']);
  assert.equal(r.organic[0].featured, true);
  assert.equal(r.organic[1].sitelinks, 2);
  assert.equal(r.features.ai_overview.cited[0].domain, 'acme.com');
  assert.equal(r.features.local_pack.places[0].domain, 'acme.com');
  assert.equal(r.features.ads[0].domain, 'rival.com');
  assert.equal(r.totalResults, 98000);
  assert.equal(r.hasNextPage, true);
  assert.equal(mapSerpApi({ error: "Google hasn't returned any results for this query." }, 0).status, 'no_results');
  assert.throws(() => mapSerpApi({ error: 'Invalid API key.' }, 0), (e) => e instanceof ProviderError && e.fatal);
});

test('Serper JSON maps to the common shape', () => {
  const r = mapSerper({
    answerBox: { link: 'https://a.com/x' },
    organic: Array.from({ length: 10 }, (_, i) => ({ link: `https://site${i}.com/`, title: `t${i}`, position: i + 1 })),
    peopleAlsoAsk: [{ question: 'Why?' }], places: [{ title: 'Shop', website: 'https://site1.com' }], relatedSearches: [{ query: 'q2' }],
  }, 0);
  assert.equal(r.organic.length, 11);
  assert.equal(r.organic[0].featured, true);
  assert.equal(r.features.local_pack.places[0].domain, 'site1.com');
  assert.equal(r.hasNextPage, true);
});

test('serpapi provider: request params, 429 retryable, 401 fatal', async () => {
  let seen;
  const ok = createProvider('serpapi', { env: { SERPAPI_KEY: 'k' }, fetchImpl: async (u) => { seen = new URL(u); return res(200, SERPAPI_SAMPLE); } });
  const r = await ok.fetchPage({ keyword: 'acme', page: 1, locale });
  assert.equal(seen.searchParams.get('start'), '10');
  assert.equal(seen.searchParams.get('google_domain'), 'google.co.uk');
  assert.equal(seen.searchParams.get('location'), locale.location);
  assert.equal(r.status, 'ok');
  assert.deepEqual(Object.keys(r.features), [], 'features only on page 0');

  const limited = createProvider('serpapi', { env: { SERPAPI_KEY: 'k' }, fetchImpl: async () => res(429, { error: 'too many' }, { 'retry-after': '3' }) });
  await assert.rejects(limited.fetchPage({ keyword: 'a', page: 0, locale }), (e) => e.kind === 'rate_limit' && e.retryAfterMs === 3000 && !e.fatal);
  const bad = createProvider('serpapi', { env: { SERPAPI_KEY: 'k' }, fetchImpl: async () => res(401, { error: 'Invalid API key.' }) });
  await assert.rejects(bad.fetchPage({ keyword: 'a', page: 0, locale }), (e) => e.fatal);
  await assert.rejects(createProvider('serpapi', { env: {} }).fetchPage({ keyword: 'a', page: 0, locale }), /SERPAPI_KEY/);
});

test('serper provider posts JSON with the key header', async () => {
  let req;
  const p = createProvider('serper', { env: { SERPER_API_KEY: 'sk' }, fetchImpl: async (u, o) => { req = { u, o }; return res(200, { organic: [{ link: 'https://x.com/' }] }); } });
  const r = await p.fetchPage({ keyword: 'x', page: 2, locale });
  assert.equal(req.o.headers['x-api-key'], 'sk');
  assert.deepEqual(JSON.parse(req.o.body).page, 3);
  assert.equal(r.organic[0].domain, 'x.com');
});

test('gateway provider: {url} template, raw HTML or JSON-wrapped HTML', async () => {
  let called;
  const env = { SCRAPER_API_URL: 'https://api.scraper.test/?key=K&render=true&url={url}' };
  const raw = createProvider('gateway', { env, fetchImpl: async (u) => { called = u; return res(200, modern); } });
  const r1 = await raw.fetchPage({ keyword: 'best crm software', page: 0, locale });
  assert.ok(called.includes(encodeURIComponent('https://www.google.co.uk/search?')));
  assert.equal(r1.organic.length, 6);
  const wrapped = createProvider('gateway', { env, fetchImpl: async () => res(200, { html: modern, status: 200 }) });
  assert.equal((await wrapped.fetchPage({ keyword: 'x', page: 0, locale })).organic[0].domain, 'pcmag.com');
  const down = createProvider('gateway', { env, fetchImpl: async () => res(503, 'busy') });
  await assert.rejects(down.fetchPage({ keyword: 'x', page: 0, locale }), (e) => e.kind === 'server');
});

test('direct google provider reports block pages', async () => {
  const p = createProvider('google', { env: {}, fetchImpl: async () => res(200, '<html><body><noscript><a href="/httpservice/retry/enablejs?sei=1">here</a></noscript></body></html>') });
  const r = await p.fetchPage({ keyword: 'x', page: 0, locale: {} });
  assert.equal(r.status, 'blocked');
  assert.equal(r.blockReason, 'js_required');
});
