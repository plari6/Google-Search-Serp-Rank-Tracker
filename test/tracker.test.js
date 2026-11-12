import test from 'node:test';
import assert from 'node:assert/strict';
import { trackProject, fetchKeyword } from '../src/tracker.js';
import { ProviderError } from '../src/providers/index.js';
import { makeProject, serp, fakeProvider, memDb, day } from './helpers.js';

test('fetchKeyword paginates with absolute positions and stops early when every site is found', async () => {
  const project = makeProject();
  const s = serp({ 2: 'https://acme.com/', 5: 'https://rival.com/', 14: 'https://other.io/x' });
  const p = fakeProvider({ 'crm software': s });
  const r = await fetchKeyword(p, project.keywords[0], project);
  assert.equal(r.status, 'ok');
  assert.equal(p.requests, 2, 'page 3 skipped: brand + both competitors already found');
  assert.equal(r.organic[13].position, 14);
  assert.equal(r.organic[13].page, 2);
});

test('fetchKeyword goes to full depth when a competitor is missing, and de-duplicates across pages', async () => {
  const project = makeProject();
  const s = serp({ 2: 'https://acme.com/', 11: 'https://acme.com/' });
  const p = fakeProvider({ 'crm software': s });
  const r = await fetchKeyword(p, project.keywords[0], project);
  assert.equal(p.requests, 3);
  assert.equal(r.organic.length, 29, 'duplicate URL on page 2 dropped');
  assert.equal(r.organic.filter((o) => o.url === 'https://acme.com/').length, 1);
});

test('retryable errors are retried, fatal errors are not', async () => {
  const project = makeProject();
  let n = 0;
  const flaky = fakeProvider(async () => {
    if (n++ === 0) throw new ProviderError('busy', { kind: 'rate_limit', retryAfterMs: 5 });
    return serp({ 1: 'https://acme.com/', 2: 'https://rival.com/', 3: 'https://other.io/' });
  });
  const r = await fetchKeyword(flaky, project.keywords[0], project);
  assert.equal(r.status, 'ok');
  const fatal = fakeProvider(async () => { throw new ProviderError('bad key', { kind: 'auth', fatal: true }); });
  await assert.rejects(fetchKeyword(fatal, project.keywords[0], project), /bad key/);
});

test('trackProject stores every keyword and finishes the run', async () => {
  const db = memDb();
  const project = makeProject();
  const s = serp({ 3: 'https://acme.com/', 1: 'https://rival.com/', 4: 'https://other.io/' });
  const res = await trackProject(project, { db, provider: fakeProvider(() => s), now: day('2026-11-02') });
  assert.equal(res.status, 'done');
  assert.equal(res.ok, 4);
  const run = db.getRun(res.runId);
  assert.equal(run.status, 'done');
  assert.equal(run.keywords_ok, 4);
  assert.equal(run.started_at, '2026-11-02T07:00:00.000Z');
  assert.equal(db.getSerps(res.runId).length, 4);
});

test('consecutive blocks trip the circuit breaker; resume finishes the run', async () => {
  const db = memDb();
  const project = makeProject();
  const blocked = { status: 'blocked', blockReason: 'captcha', organic: [], features: {} };
  const p1 = fakeProvider(() => blocked, { concurrency: 1 });
  const r1 = await trackProject(project, { db, provider: p1, maxConsecutiveBlocks: 2, backoffMs: 1, now: day('2026-11-02') });
  assert.equal(r1.status, 'blocked');
  assert.equal(r1.blocked, 2);
  assert.match(r1.error, /blocked keywords in a row/);
  assert.ok(db.getSerps(r1.runId).every((s) => s.status === 'blocked'));

  const good = serp({ 1: 'https://acme.com/', 2: 'https://rival.com/', 3: 'https://other.io/' });
  const r2 = await trackProject(project, { db, provider: fakeProvider(() => good), resume: true });
  assert.equal(r2.runId, r1.runId);
  assert.equal(r2.status, 'done');
  assert.equal(db.getSerps(r1.runId).filter((s) => s.status === 'ok').length, 4);
});

test('a fatal provider error stops the run as partial with the message', async () => {
  const db = memDb();
  const project = makeProject();
  const p = fakeProvider(async () => { throw new ProviderError('serpapi: out of credits', { kind: 'quota', fatal: true }); }, { concurrency: 1 });
  const r = await trackProject(project, { db, provider: p });
  assert.equal(r.status, 'partial');
  assert.match(r.error, /out of credits/);
  assert.equal(p.requests, 1, 'no more requests after a fatal error');
});

test('--only and --limit narrow the keyword list', async () => {
  const db = memDb();
  const project = makeProject();
  const s = serp({ 1: 'https://acme.com/' });
  const r = await trackProject(project, { db, provider: fakeProvider(() => s), only: ['pricing'] });
  assert.equal(r.keywords, 1);
  const r2 = await trackProject(project, { db, provider: fakeProvider(() => s), limit: 2 });
  assert.equal(r2.keywords, 2);
});
