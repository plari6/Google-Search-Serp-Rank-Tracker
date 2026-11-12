import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReport } from '../src/metrics.js';
import { trackProject } from '../src/tracker.js';
import { ruleInsights } from '../src/insights.js';
import { writeReport, renderEmail, renderMarkdown, keywordRows } from '../src/report/index.js';
import { renderHtml, sparkline } from '../src/report/html.js';
import { parseCSV } from '../src/util/csv.js';
import { makeProject, serp, fakeProvider, memDb, day } from './helpers.js';

async function data() {
  const db = memDb();
  const project = makeProject({ report: { agency: 'Test Agency', brandColor: '#123456' } });
  await trackProject(project, { db, provider: fakeProvider(() => serp({ 4: 'https://acme.com/', 6: 'https://rival.com/' })), now: day('2026-11-02') });
  await trackProject(project, { db, provider: fakeProvider(() => serp({ 2: 'https://acme.com/<script>', 3: 'https://rival.com/' })), now: day('2026-11-09') });
  const report = buildReport(project, db);
  return { report, insights: ruleInsights(report) };
}

test('writeReport produces every file', async () => {
  const { report, insights } = await data();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serp-report-'));
  const files = writeReport(report, insights, dir);
  for (const f of Object.values(files)) assert.ok(fs.statSync(f).size > 40, f);
  const kw = parseCSV(fs.readFileSync(files.keywords, 'utf8'));
  assert.deepEqual(kw[0].slice(0, 6), ['keyword', 'group', 'priority', 'volume', 'position', 'previous']);
  assert.ok(kw[0].includes('Rival_position'));
  assert.equal(kw.length, 5);
  const hist = parseCSV(fs.readFileSync(files.history, 'utf8'));
  assert.deepEqual(hist[0], ['keyword', '2026-11-02', '2026-11-09']);
  assert.deepEqual(hist[1].slice(1), ['4', '2']);
  const json = JSON.parse(fs.readFileSync(files.json, 'utf8'));
  assert.equal(json.insights.headline, insights.headline);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('HTML report is self-contained, charted, branded and escaped', async () => {
  const { report, insights } = await data();
  const html = renderHtml(report, insights);
  assert.match(html, /Chart\.js v4/, 'Chart.js is inlined (works offline / as attachment)');
  assert.match(html, /id="cVis"/);
  assert.match(html, /id="cSov"/);
  assert.match(html, /id="cDist"/);
  assert.match(html, /#123456/);
  assert.match(html, /Test Agency/);
  assert.ok(!html.includes('acme.com/<script>'), 'scraped URLs are escaped');
  const chart = JSON.parse(html.match(/<script type="application\/json" id="data">(.*?)<\/script>/s)[1]);
  assert.deepEqual(chart.dates, ['2026-11-02', '2026-11-09']);
  assert.equal(chart.sov.length, 3);
  assert.match(html, /prefers-color-scheme:dark/);
});

test('e-mail HTML has no scripts and carries the KPIs; Markdown has tables', async () => {
  const { report, insights } = await data();
  const email = renderEmail(report, insights, { reportUrl: 'https://reports.example/acme/report.html' });
  assert.ok(!/<script/i.test(email));
  assert.match(email, /Keywords on page 1/);
  assert.match(email, /reports\.example/);
  const md = renderMarkdown(report, insights);
  assert.match(md, /\| Keyword \| Pos\. \| Change/);
  assert.match(md, /## KPIs/);
  assert.equal(keywordRows(report)[0].change, 2);
});

test('sparkline draws gaps for missing weeks', () => {
  const svg = sparkline([5, null, 3, 2], 30);
  assert.equal((svg.match(/<polyline/g) || []).length, 2);
  assert.match(svg, /<circle/);
  assert.ok(!sparkline([null, null]).includes('<circle'));
});
