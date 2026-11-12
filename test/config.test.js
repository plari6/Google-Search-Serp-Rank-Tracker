import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeProject, parseKeywordsFile, keywordKey, loadProject } from '../src/config.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'serp-cfg-'));

test('keyword files: CSV with alternative headers, plain text, JSON', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.csv'), 'Query;Search Volume;Category;Landing Page;Priority\n"crm, small business";"1,300";Core;https://a.com/x;yes\nseo tool;;;;\n');
  const a = parseKeywordsFile(path.join(d, 'a.csv'));
  assert.deepEqual(a[0], { keyword: 'crm, small business', key: 'crm, small business', group: 'Core', volume: 1300, targetUrl: 'https://a.com/x', priority: true, intent: null });
  assert.equal(a[1].group, 'General');
  assert.equal(a[1].volume, null);
  fs.writeFileSync(path.join(d, 'b.txt'), '# comment\nkw one\n\nKW  Two\n');
  assert.deepEqual(parseKeywordsFile(path.join(d, 'b.txt')).map((k) => k.key), ['kw one', 'kw two']);
  fs.writeFileSync(path.join(d, 'c.json'), JSON.stringify({ keywords: ['x', { keyword: 'y', volume: 5 }] }));
  assert.equal(parseKeywordsFile(path.join(d, 'c.json'))[1].volume, 5);
  fs.rmSync(d, { recursive: true, force: true });
});

test('normalizeProject: defaults, de-duplication, validation', () => {
  const p = normalizeProject({ brand: { domains: ['www.acme.com'] }, competitors: ['rival.com'], keywords: ['A b', 'a  B', 'c'], depth: 500 });
  assert.equal(p.brand.name, 'acme.com');
  assert.equal(p.competitors[0].name, 'rival.com');
  assert.equal(p.keywords.length, 2);
  assert.equal(p.depth, 100);
  assert.equal(p.locale.gl, 'us');
  assert.equal(p.alerts.dropPositions, 5);
  assert.throws(() => normalizeProject({ keywords: ['x'] }), /brand/);
  assert.throws(() => normalizeProject({ brand: { domains: ['a.com'] } }), /no keywords/);
  assert.throws(() => normalizeProject({ brand: { name: 'x' }, keywords: ['k'] }), /at least one domain/);
  assert.equal(keywordKey('  Best   CRM '), 'best crm');
});

test('the bundled demo project loads 50 keywords', () => {
  const p = loadProject(new URL('../projects/demo.json', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
  assert.equal(p.keywords.length, 50);
  assert.equal(p.competitors.length, 3);
  assert.ok(p.keywords.filter((k) => k.priority).length >= 5);
  assert.throws(() => loadProject('does-not-exist'), /not found/);
});
