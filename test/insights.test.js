import test from 'node:test';
import assert from 'node:assert/strict';
import { createLLMRouter } from '../src/ai/index.js';
import { buildReport } from '../src/metrics.js';
import { trackProject } from '../src/tracker.js';
import { generateInsights, validateInsights, ruleInsights, factsFor } from '../src/insights.js';
import { makeProject, serp, fakeProvider, memDb, day } from './helpers.js';

async function report() {
  const db = memDb();
  const project = makeProject();
  await trackProject(project, { db, provider: fakeProvider(() => serp({ 4: 'https://acme.com/', 6: 'https://rival.com/' })), now: day('2026-11-02') });
  await trackProject(project, { db, provider: fakeProvider(() => serp({ 12: 'https://acme.com/', 3: 'https://rival.com/' })), now: day('2026-11-09') });
  return { db, report: buildReport(project, db) };
}

const goodAnswer = (r) => JSON.stringify({
  headline: 'Rankings fell this week as Rival moved ahead',
  summary: `Page-1 keywords dropped from ${r.kpis.prev.top10} to ${r.kpis.top10}.`,
  wins: [], risks: ['Rival now outranks you'],
  actions: [{ title: 'Recover crm software', detail: 'Refresh the page.', keyword: 'crm software' }, { title: 'Review internal links', detail: 'Check links.', keyword: null }],
});

const router = (...answers) => createLLMRouter({
  chain: answers.map((_, i) => ({ provider: `p${i}`, model: `m${i}` })),
  providers: Object.fromEntries(answers.map((a, i) => [`p${i}`, { configured: true, complete: async () => (a instanceof Error ? Promise.reject(a) : { text: a }) }])),
  hedgeAfterMs: 0,
});

test('validateInsights accepts grounded output and rejects invented numbers', async () => {
  const { report: r } = await report();
  const facts = factsFor(r);
  const ok = validateInsights(JSON.parse(goodAnswer(r)), facts);
  assert.equal(ok.actions.length, 2);
  assert.equal(ok.actions[0].keyword, 'crm software');
  const invented = JSON.parse(goodAnswer(r));
  invented.summary = 'Traffic grew 613% and revenue rose by 4,250 dollars.';
  assert.throws(() => validateInsights(invented, facts), /ungrounded numbers: 613, 4250/);
  assert.throws(() => validateInsights({ headline: 'x' }, facts), /missing/);
  const wrongKw = JSON.parse(goodAnswer(r));
  wrongKw.actions[0].keyword = 'made up keyword';
  assert.equal(validateInsights(wrongKw, facts).actions[0].keyword, null);
});

test('AI insights: bad JSON / ungrounded answer moves on to the next model; result is cached', async () => {
  const { db, report: r } = await report();
  const ai = router('not json at all', JSON.stringify({ headline: 'h', summary: 'up 999 places', actions: [{ title: 'a' }, { title: 'b' }] }), goodAnswer(r));
  const out = await generateInsights(r, { ai, db });
  assert.equal(out.source, 'ai');
  assert.equal(out.model, 'p2:m2');
  assert.match(out.headline, /Rival/);
  const again = await generateInsights(r, { ai: router(new Error('should not be called')), db });
  assert.equal(again.source, 'cache');
});

test('every model failing falls back to rule-based insights', async () => {
  const { report: r } = await report();
  const logs = [];
  const out = await generateInsights(r, { ai: router(new Error('503 overloaded')), log: (m) => logs.push(m) });
  assert.equal(out.source, 'rules');
  assert.ok(out.headline && out.summary && out.actions.length >= 2);
  assert.match(logs[0], /rule-based/);
  assert.equal((await generateInsights(r, { ai: null })).source, 'rules');
});

test('rule-based insights mention the real movers', async () => {
  const { report: r } = await report();
  const ins = ruleInsights(r);
  assert.match(ins.headline, /Visibility slipped/);
  assert.match(ins.summary, /previously 4/);
  assert.ok(ins.risks.some((x) => /Rival overtook/.test(x)));
  assert.ok(ins.actions.some((a) => a.keyword === 'crm software'));
  assert.equal(new Set(ins.actions.map((a) => a.keyword)).size, ins.actions.length, 'one action per keyword');
});
