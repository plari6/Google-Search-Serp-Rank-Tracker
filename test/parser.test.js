import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseGoogleSerp, detectBlock } from '../src/parser/google.js';
import { CAPTCHA, CONSENT, JS_REQUIRED, NO_RESULTS } from './fixtures/blocks.js';
import { createDemoProvider } from '../src/providers/demo.js';

const modern = fs.readFileSync(new URL('./fixtures/google-modern.html', import.meta.url), 'utf8');
const basic = fs.readFileSync(new URL('./fixtures/google-basic.html', import.meta.url), 'utf8');

test('modern SERP: organic results in order, ads / PAA / carousels / Google links excluded', () => {
  const r = parseGoogleSerp(modern);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.organic.map((o) => o.domain), ['pcmag.com', 'acmecrm.com', 'zapier.com', 'blog.acmecrm.com', 'rivalcrm.com', 'g2.com']);
  assert.deepEqual(r.organic.map((o) => o.rank), [1, 2, 3, 4, 5, 6]);
  assert.equal(r.organic[2].url, 'https://www.zapier.com/blog/best-crm-app/', 'text-fragment highlight removed');
  assert.equal(r.organic[5].url, 'https://www.g2.com/categories/crm', '/url?q= redirect resolved');
  assert.ok(!r.organic.some((o) => o.domain === 'salesforce.com'), 'PAA answer link is not organic');
  assert.ok(!r.organic.some((o) => o.domain === 'en.wikipedia.org'), 'knowledge panel link is not organic');
});

test('modern SERP: titles, snippets, dates, sitelinks, featured snippet', () => {
  const r = parseGoogleSerp(modern);
  const acme = r.organic[1];
  assert.equal(acme.title, 'Best CRM Software | AcmeCRM');
  assert.match(acme.snippet, /#1 rated CRM/);
  assert.equal(acme.date, 'Feb 3, 2026');
  assert.equal(acme.sitelinks, 2);
  assert.match(acme.displayedUrl, /acmecrm\.com/);
  assert.equal(r.organic[0].featured, true);
  assert.equal(r.organic[1].featured, false);
  assert.equal(r.features.featured_snippet.url, 'https://www.pcmag.com/picks/the-best-crm-software');
});

test('modern SERP: SERP features', () => {
  const f = parseGoogleSerp(modern).features;
  assert.deepEqual(f.ai_overview.cited.map((c) => c.domain), ['forbes.com', 'acmecrm.com']);
  assert.deepEqual(f.people_also_ask, ['What is the #1 CRM?', 'Which CRM is best for small business?']);
  assert.equal(f.local_pack.places.length, 2);
  assert.deepEqual(f.local_pack.places[0], { name: 'Acme CRM Consulting', url: 'https://www.acmecrm.com/consulting', domain: 'acmecrm.com' });
  assert.equal(f.top_stories.items[0].domain, 'techcrunch.com');
  assert.equal(f.videos.items[0].domain, 'youtube.com');
  assert.deepEqual(f.ads.map((a) => [a.position, a.domain]), [['top', 'rivalcrm.com'], ['top', 'ads.othercrm.io'], ['bottom', 'bottomcrm.net']]);
  assert.equal(f.knowledge_panel.title, 'Customer relationship management');
  assert.deepEqual(f.related_searches, ['free crm software', 'crm software for small business']);
  assert.equal(f.images, undefined, 'the "Images" navigation tab is not a SERP feature');
});

test('modern SERP: result count and pagination', () => {
  const r = parseGoogleSerp(modern);
  assert.equal(r.totalResults, 1240000000);
  assert.equal(r.hasNextPage, true);
  assert.deepEqual(parseGoogleSerp(modern, { page: 2 }).features, {}, 'features only from page 1');
});

test('basic (no-JS) HTML: /url?q= links, de-duplication, next link', () => {
  const r = parseGoogleSerp(basic);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.organic.map((o) => o.url), [
    'https://www.austinplumbing.com/',
    'https://www.yelp.com/search?find_desc=plumbers&find_loc=Austin',
    'https://plumbing.example-austin.org/services',
  ]);
  assert.equal(r.organic[0].title, 'Austin Plumbing Co. - 24/7 Plumbers');
  assert.match(r.organic[0].snippet, /Licensed plumbers/);
  assert.equal(r.hasNextPage, true);
});

test('block pages are detected, never parsed as "not ranking"', () => {
  assert.deepEqual([parseGoogleSerp(CAPTCHA).status, parseGoogleSerp(CAPTCHA).blockReason], ['blocked', 'captcha']);
  assert.equal(parseGoogleSerp(CONSENT).blockReason, 'consent');
  assert.equal(parseGoogleSerp(JS_REQUIRED).blockReason, 'js_required');
  assert.equal(detectBlock(modern), null);
  assert.equal(parseGoogleSerp(NO_RESULTS).status, 'no_results');
  assert.equal(parseGoogleSerp('').status, 'empty');
});

test('demo pages round-trip through the parser (10 results per page, absolute paging)', async () => {
  const p = createDemoProvider({ brand: 'quillmesh.com', competitors: ['tandorra.com'] });
  const r0 = await p.fetchPage({ keyword: 'what is a help desk', page: 0 });
  const r9 = await p.fetchPage({ keyword: 'what is a help desk', page: 9 });
  assert.equal(r0.organic.length, 10);
  assert.equal(r0.organic[0].domain, 'quillmesh.com');
  assert.equal(r0.organic[0].featured, true);
  assert.ok(r0.features.ai_overview);
  assert.equal(r9.hasNextPage, false);
});
