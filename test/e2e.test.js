// End to end: the CLI binary, offline (demo provider + rules), into a temporary output folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'serp-tracker.js');

function cli(args, env = {}) {
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8', cwd: ROOT, timeout: 120000,
    env: { ...process.env, SERP_SKIP_DOTENV: '1', NO_COLOR: '1', GEMINI_API_KEY: '', GROQ_API_KEY: '', NVIDIA_API_KEY: '', OPENROUTER_API_KEY: '', OLLAMA_BASE_URL: '', ...env },
  });
}

test('demo command builds the full weekly report', { timeout: 120000 }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'serp-demo-'));
  const txt = cli(['demo', '--weeks', '3', '--out', out]);
  assert.match(txt, /50 keywords × 3 weekly checks/);
  assert.match(txt, /URGENT "help desk software" fell/);
  assert.match(txt, /Won the featured snippet for "what is a help desk"/);
  for (const f of ['report.html', 'report.md', 'email.html', 'keywords.csv', 'history.csv', 'competitors.csv', 'summary.json']) assert.ok(fs.existsSync(path.join(out, f)), f);
  const s = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(s.keywords.length, 50);
  assert.equal(s.series.dates.length, 3);
  assert.equal(s.insights.source, 'rules');
  fs.rmSync(out, { recursive: true, force: true });
});

test('init + track (file provider) + report via the CLI with an isolated database', { timeout: 120000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serp-cli-'));
  const env = { SERP_PROJECTS_DIR: path.join(dir, 'projects'), SERP_DB: path.join(dir, 'db.sqlite'), SERP_HTML_DIR: path.join(dir, 'serps') };
  fs.writeFileSync(path.join(dir, 'kw.txt'), 'best crm software\nmissing keyword\n');
  cli(['init', 'acme', '--domain', 'acmecrm.com', '--competitors', 'rivalcrm.com', '--keywords', path.join(dir, 'kw.txt')], env);
  fs.mkdirSync(env.SERP_HTML_DIR);
  fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'google-modern.html'), path.join(env.SERP_HTML_DIR, 'best-crm-software.html'));
  const t = cli(['track', 'acme', '--provider', 'file'], env);
  assert.match(t, /best crm software\s+#2/);
  assert.match(t, /partial: 1 ok/);
  const r = cli(['report', 'acme', '--no-ai', '--out', path.join(dir, 'out'), '--json'], env);
  const j = JSON.parse(r);
  assert.equal(j.kpis.top3, 1);
  assert.equal(j.kpis.missing, 1);
  assert.equal(j.kpis.aiOverviewCitations, 1);
  const check = cli(['check', 'best crm software', '--project', 'acme', '--provider', 'file'], env);
  assert.match(check, /Rivalcrm\s+#5/);
  assert.match(check, /AI Overview cites: forbes\.com, acmecrm\.com/);
  fs.rmSync(dir, { recursive: true, force: true });
});
