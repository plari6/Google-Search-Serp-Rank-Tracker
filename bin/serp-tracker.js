#!/usr/bin/env node
// Google Search SERP Rank Tracker - CLI
import '../src/util/quiet.js';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { ROOT, loadEnv, loadProject, listProjects, projectsDir, projectTemplate, parseKeywordsFile, keywordKey } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createProvider, resolveProviderName, PROVIDERS, buildGoogleUrl } from '../src/providers/index.js';
import { parseGoogleSerp } from '../src/parser/google.js';
import { trackProject, fetchKeyword } from '../src/tracker.js';
import { buildReport, entityRank, featureLabel } from '../src/metrics.js';
import { generateInsights } from '../src/insights.js';
import { writeReport } from '../src/report/index.js';
import { deliver, buildPayload, detectPlatform, sendWebhook } from '../src/deliver/index.js';
import { runSchedule } from '../src/scheduler.js';
import { createRouterFromEnv } from '../src/ai/index.js';
import { toCSV } from '../src/util/csv.js';
import { parseTarget } from '../src/util/url.js';

loadEnv();

const c = process.stdout.isTTY && !process.env.NO_COLOR
  ? { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` }
  : { b: (s) => s, g: (s) => s, r: (s) => s, y: (s) => s, d: (s) => s };
const log = (...a) => console.log(...a);
const quietLog = { json: false };
const say = (...a) => { if (!quietLog.json) console.log(...a); };

const dbPath = () => path.resolve(process.env.SERP_DB || path.join(ROOT, 'data', 'serp.sqlite'));

function makeAI({ ai = true, simulate } = {}) {
  if (!ai) return null;
  const sim = simulate ? String(simulate).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const router = createRouterFromEnv(process.env, {
    simulate: sim,
    onEvent: (e) => {
      if (e.type === 'failure') say(c.d(`  [ai] ${e.target} ${e.kind}${e.status ? ' ' + e.status : ''} -> next model`));
      if (e.type === 'success') say(c.d(`  [ai] answered by ${e.target} in ${e.ms} ms`));
    },
  });
  return router.enabledCount ? router : null;
}

function printSummary(report, insights, files) {
  const k = report.kpis;
  const p = k.prev || {};
  const d = (a, b, inv = false, dg = 0) => {
    if (b === undefined || b === null || a === null) return '';
    const x = Math.round((a - b) * 10 ** dg) / 10 ** dg;
    if (!x) return c.d(' (=)');
    return ((inv ? x < 0 : x > 0) ? c.g : c.r)(` (${x > 0 ? '+' : ''}${x})`);
  };
  say('');
  say(c.b(`${report.project.client} – ${report.run.date.slice(0, 10)}`) + c.d(report.compare ? `  vs ${report.compare.date.slice(0, 10)}` : '  (baseline)'));
  if (insights) say(c.b(insights.headline) + c.d(`  [${insights.source}${insights.model ? ': ' + insights.model : ''}]`));
  say(`Visibility ${k.visibility}${d(k.visibility, p.visibility, false, 1)} · Avg position ${k.avgPosition ?? '–'}${d(k.avgPosition, p.avgPosition, true, 1)} · Top 3 ${k.top3}${d(k.top3, p.top3)} · Top 10 ${k.top10}${d(k.top10, p.top10)} · Ranking ${k.ranking}/${k.keywords}`);
  say(`Improved ${c.g(k.improved)} · Declined ${c.r(k.declined)} · New ${k.newRankings} · Lost ${k.lostRankings} · Snippets ${k.featuredSnippets} · AI Overview citations ${k.aiOverviewCitations}${k.stale ? c.y(` · ${k.stale} keywords carried from last week`) : ''}`);
  const sov = report.competitors.map((x) => `${x.isBrand ? c.b(x.name) : x.name} ${x.sov}%`).join(' · ');
  say(`Share of voice: ${sov}`);
  if (report.alerts.length) {
    say(c.b(`Alerts (${report.alerts.length}):`));
    for (const a of report.alerts.slice(0, 8)) say(`  ${a.severity === 'high' ? c.r('URGENT') : a.severity === 'medium' ? c.y('WATCH ') : c.g('WIN   ')} ${a.text}`);
  }
  if (insights?.actions?.length) {
    say(c.b('Next week:'));
    insights.actions.forEach((a, i) => say(`  ${i + 1}. ${a.title}`));
  }
  if (files) say(c.d(`\nReport: ${files.html}\nAlso:   ${[files.markdown, files.email, files.keywords, files.history, files.competitors, files.json].map((f) => path.basename(f)).join(', ')}`));
}

async function makeReport(project, db, opts) {
  const report = buildReport(project, db, { runId: opts.run ? Number(opts.run) : undefined, weeks: opts.weeks ? Number(opts.weeks) : undefined, now: opts.now });
  const ai = opts.ai === false ? null : makeAI({ simulate: opts.simulateOutage });
  const insights = await generateInsights(report, { ai, db, log: (m) => say(c.y(m)), noCache: !!opts.noCache });
  const out = path.resolve(opts.out || path.join(ROOT, 'output', project.name));
  const files = writeReport(report, insights, out, { reportUrl: opts.reportUrl || process.env.REPORT_BASE_URL ? `${(opts.reportUrl || process.env.REPORT_BASE_URL).replace(/\/$/, '')}/${project.name}/report.html` : undefined });
  return { report, insights, files };
}

function openFile(file) {
  const cmd = process.platform === 'win32' ? `start "" "${file}"` : process.platform === 'darwin' ? `open "${file}"` : `xdg-open "${file}"`;
  import('node:child_process').then(({ exec }) => exec(cmd));
}

function trackerProvider(project, opts) {
  const name = resolveProviderName(opts.provider || project.provider || undefined, process.env);
  return createProvider(name, {
    demo: { brand: project.brand.domains[0], competitors: project.competitors.map((x) => x.domains[0]), endDate: opts.demoEnd },
  });
}

async function doTrack(project, db, opts) {
  if (opts.depth) project.depth = Math.min(100, Math.max(10, Number(opts.depth)));
  const provider = trackerProvider(project, opts);
  if (provider.name === 'google') say(c.y('Note: no SERP API configured, using direct Google HTTP. Google usually answers plain HTTP clients with a JavaScript wall; set SERPAPI_KEY or SERPER_API_KEY (see README).'));
  say(c.b(`Tracking ${project.keywords.length} keywords for ${project.client} via ${provider.name} (depth ${project.depth}, google.${project.locale.googleDomain.replace(/^google\./, '')} ${project.locale.gl}/${project.locale.hl}${project.locale.location ? ', ' + project.locale.location : ''})`));
  const res = await trackProject(project, {
    db, provider, now: opts.now, resume: !!opts.resume, limit: opts.limit ? Number(opts.limit) : undefined,
    only: opts.only ? String(opts.only).split(',').map((s) => keywordKey(s)) : undefined, saveHtmlDir: opts.saveHtml,
    log: opts.quiet ? () => {} : say,
  });
  const color = res.status === 'done' ? c.g : res.status === 'partial' ? c.y : c.r;
  say(color(`Run #${res.runId} ${res.status}: ${res.ok} ok, ${res.noResults} no results, ${res.blocked} blocked, ${res.errors} errors · ${res.requests} requests · ${(res.durationMs / 1000).toFixed(1)}s`));
  if (res.error) say(c.r(res.error));
  return res;
}

const program = new Command();
program.name('serp-tracker').description('Google Search SERP Rank Tracker – weekly SEO rankings for a brand vs competitors').version('1.0.0');

program.command('demo')
  .description('offline demo: 8 weeks of fictional SERPs for 50 keywords -> full weekly report (no keys needed)')
  .option('--weeks <n>', 'weeks of history to simulate', '8')
  .option('--out <dir>', 'output folder', path.join(ROOT, 'output', 'demo'))
  .option('--ai', 'write the summary with AI (needs a key in .env)')
  .option('--simulate-outage <providers>', 'pretend these AI providers are down, e.g. gemini')
  .option('--open', 'open the HTML report when done')
  .action(async (o) => {
    const file = path.join(ROOT, 'data', 'demo.sqlite');
    for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true });
    const db = openDb(file);
    const project = loadProject(path.join(ROOT, 'projects', 'demo.json'));
    const weeks = Math.max(2, Number(o.weeks));
    const end = new Date();
    end.setHours(7, 0, 0, 0);
    say(c.b(`Demo: ${project.keywords.length} keywords × ${weeks} weekly checks for ${project.client} (fictional SERPs through the real parser)`));
    for (let w = weeks - 1; w >= 0; w--) {
      const now = new Date(end.getTime() - w * 7 * 86400000);
      const res = await trackProject(project, { db, provider: trackerProvider(project, { demoEnd: end }), now, log: () => {} });
      say(c.d(`  week of ${now.toISOString().slice(0, 10)}: run #${res.runId} ${res.status}, ${res.ok} keywords, ${res.requests} SERP pages parsed`));
    }
    const { report, insights, files } = await makeReport(project, db, { ai: !!o.ai, out: o.out, simulateOutage: o.simulateOutage, noCache: true });
    const sent = await deliver(report, insights, files, { project, db, log: say, dryRun: false });
    printSummary(report, insights, files);
    if (sent.some((s) => s.outbox)) say(c.d(`E-mail preview: ${sent.find((s) => s.outbox).outbox}`));
    db.close();
    if (o.open) openFile(files.html);
  });

program.command('init <name>')
  .description('create a client project (projects/<name>.json + keyword CSV)')
  .requiredOption('--domain <domain>', 'client domain, e.g. example.com (or example.com/blog)')
  .option('--brand-name <name>', 'display name of the brand')
  .option('--competitors <domains>', 'comma-separated competitor domains')
  .option('--keywords <file>', 'CSV/TXT/JSON keyword list to copy into the project')
  .option('--gl <country>', 'Google country code', 'us')
  .option('--hl <lang>', 'Google interface language', 'en')
  .option('--location <name>', 'canonical location, e.g. "Austin,Texas,United States"')
  .option('--force', 'overwrite an existing project')
  .action((name, o) => {
    const dir = projectsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.json`);
    if (fs.existsSync(file) && !o.force) throw new Error(`${file} exists (use --force)`);
    const kwFile = path.join(dir, `${name}-keywords.csv`);
    if (o.keywords) {
      const kws = parseKeywordsFile(o.keywords);
      fs.writeFileSync(kwFile, toCSV(kws.map((k) => ({ keyword: k.keyword, group: k.group, volume: k.volume ?? '', priority: k.priority ? 'yes' : '', target_url: k.targetUrl || '' }))));
      say(`Imported ${kws.length} keywords -> ${kwFile}`);
    } else if (!fs.existsSync(kwFile)) {
      fs.writeFileSync(kwFile, 'keyword,group,volume,priority,target_url\n' + `${parseTarget(o.domain).host.split('.')[0]},Brand,,yes,\n`);
      say(`Created ${kwFile} – add up to 50+ keywords (keyword, group, volume, priority, target_url)`);
    }
    const tpl = projectTemplate({ name, domain: o.domain, brandName: o.brandName, competitors: o.competitors ? o.competitors.split(',').map((s) => s.trim()).filter(Boolean) : [], keywordsFile: `${name}-keywords.csv`, gl: o.gl, hl: o.hl, location: o.location });
    fs.writeFileSync(file, JSON.stringify(tpl, null, 2) + '\n');
    say(c.g(`Project created: ${file}`));
    say(`Next: serp-tracker check "<keyword>" --project ${name}   then   serp-tracker run ${name}`);
  });

program.command('projects').description('list projects and their latest run').action(() => {
  const db = openDb(dbPath());
  const names = listProjects().filter((n) => n !== 'demo');
  if (!names.length) say('No projects yet. Create one: serp-tracker init acme --domain acme.com --competitors rival.com');
  for (const n of names) {
    try {
      const p = loadProject(n);
      const last = db.getRuns(n, 1)[0];
      say(`${c.b(n.padEnd(20))} ${p.client.padEnd(28).slice(0, 28)} ${String(p.keywords.length).padStart(3)} kw · ${p.competitors.length} competitors · ${last ? `last run ${last.started_at.slice(0, 16).replace('T', ' ')} (${last.status}, ${last.keywords_ok}/${last.keywords_total})` : 'never tracked'}`);
    } catch (err) {
      say(`${c.r(n.padEnd(20))} ${err.message}`);
    }
  }
  db.close();
});

program.command('keywords <project>').description('show the keyword list of a project').action((name) => {
  const p = loadProject(name);
  const groups = {};
  for (const k of p.keywords) (groups[k.group] ||= []).push(k);
  for (const [g, ks] of Object.entries(groups)) {
    say(c.b(`${g} (${ks.length})`));
    for (const k of ks) say(`  ${k.priority ? c.y('★') : ' '} ${k.keyword.padEnd(44)} ${k.volume ? String(k.volume).padStart(7) : '      –'}  ${k.targetUrl || ''}`);
  }
  say(c.d(`${p.keywords.length} keywords`));
});

const trackOpts = (cmd) => cmd
  .option('--provider <name>', `SERP source: ${PROVIDERS.join(' | ')}`)
  .option('--depth <n>', 'positions to check (10-100)')
  .option('--limit <n>', 'only the first n keywords (testing)')
  .option('--only <keywords>', 'comma-separated keywords or group names')
  .option('--resume', 'continue the last unfinished run')
  .option('--save-html <dir>', 'save raw result pages (debugging)')
  .option('--quiet', 'no per-keyword lines');

trackOpts(program.command('track <project>').description('check every keyword now and store the results'))
  .action(async (name, o) => {
    const db = openDb(dbPath());
    const res = await doTrack(loadProject(name), db, o);
    db.close();
    if (res.status === 'blocked') process.exitCode = 2;
  });

program.command('report <project>')
  .description('build the weekly report from stored runs (HTML with charts, MD, e-mail, CSV, JSON)')
  .option('--run <id>', 'report a specific run')
  .option('--weeks <n>', 'weeks of history in charts')
  .option('--out <dir>', 'output folder (default output/<project>)')
  .option('--no-ai', 'rule-based summary only')
  .option('--simulate-outage <providers>', 'pretend these AI providers are down')
  .option('--send', 'deliver to e-mail / webhooks')
  .option('--report-url <base>', 'public base URL where output/ is hosted (for links)')
  .option('--json', 'print summary JSON')
  .option('--open', 'open the HTML report')
  .action(async (name, o) => {
    quietLog.json = !!o.json;
    const db = openDb(dbPath());
    const project = loadProject(name);
    const { report, insights, files } = await makeReport(project, db, o);
    if (o.send) await deliver(report, insights, files, { project, db, log: say, reportUrl: o.reportUrl });
    if (o.json) console.log(JSON.stringify({ kpis: report.kpis, alerts: report.alerts, insights, files }, null, 2));
    else printSummary(report, insights, files);
    db.close();
    if (o.open) openFile(files.html);
  });

trackOpts(program.command('run <project>').description('the weekly job: track + report + deliver'))
  .option('--no-ai', 'rule-based summary only')
  .option('--no-send', 'do not deliver')
  .option('--alerts-only', 'daily check: only send new urgent alerts')
  .option('--report-url <base>', 'public base URL where output/ is hosted')
  .action(async (name, o) => {
    const db = openDb(dbPath());
    const project = loadProject(name);
    const res = await doTrack(project, db, o);
    if (!res.ok && res.status !== 'done') {
      say(c.r('Nothing tracked – report skipped.'));
      process.exitCode = 2;
      return db.close();
    }
    const { report, insights, files } = await makeReport(project, db, { ...o, run: res.runId });
    if (o.send !== false) await deliver(report, insights, files, { project, db, log: say, alertsOnly: !!o.alertsOnly, reportUrl: o.reportUrl });
    printSummary(report, insights, files);
    db.close();
  });

program.command('check <keyword>')
  .description('one live SERP lookup: positions of the brand/competitors, top results and SERP features')
  .option('--project <name>', 'use this project\'s domains and locale')
  .option('--domain <domain>', 'domain to look for (without a project)')
  .option('--provider <name>', `SERP source: ${PROVIDERS.join(' | ')}`)
  .option('--depth <n>', 'positions to check', '20')
  .option('--gl <country>', 'country', 'us')
  .option('--hl <lang>', 'language', 'en')
  .option('--location <name>', 'canonical location name')
  .option('--save-html <dir>', 'save the raw page(s)')
  .option('--json', 'print JSON')
  .action(async (keyword, o) => {
    const project = o.project ? loadProject(o.project) : {
      name: 'adhoc', brand: { name: o.domain || 'site', domains: [o.domain || 'example.invalid'], targets: [parseTarget(o.domain || 'example.invalid')] },
      competitors: [], provider: null, locale: { gl: o.gl, hl: o.hl, googleDomain: 'google.com', location: o.location || null, device: 'desktop' },
      earlyStop: false,
    };
    project.depth = Math.min(100, Math.max(10, Number(o.depth)));
    project.earlyStop = false;
    const provider = trackerProvider(project, o);
    say(c.d(`${provider.name}: ${buildGoogleUrl(keyword, 0, project.locale)}`));
    const r = await fetchKeyword(provider, { keyword }, project, { saveHtmlDir: o.saveHtml, log: say });
    await provider.close?.();
    if (o.json) return console.log(JSON.stringify(r, null, 2));
    if (r.status !== 'ok') {
      say(c.r(`${r.status}${r.error ? ': ' + r.error : ''}`));
      if (r.status === 'blocked') say(c.y('Tip: use --provider serpapi | serper | gateway | browser (see README "Choosing a SERP source").'));
      process.exitCode = 2;
      return;
    }
    for (const e of [project.brand, ...project.competitors]) {
      const er = entityRank(r.organic, e);
      say(`${c.b(e.name.padEnd(16))} ${er.position ? c.g('#' + er.position) : c.r('not in top ' + project.depth)} ${er.url || ''}${er.urls.length > 1 ? c.y(`  (+${er.urls.length - 1} more URLs)`) : ''}`);
    }
    say('');
    for (const x of r.organic.slice(0, Math.min(project.depth, 20))) say(`${String(x.position).padStart(3)}. ${x.featured ? c.y('[snippet] ') : ''}${x.domain.padEnd(28).slice(0, 28)} ${c.d(x.title.slice(0, 70))}`);
    const f = Object.keys(r.features);
    say('');
    say(`SERP features: ${f.length ? f.map(featureLabel).join(', ') : 'none'}`);
    if (r.features.ai_overview?.cited?.length) say(`AI Overview cites: ${r.features.ai_overview.cited.map((x) => x.domain).join(', ')}`);
    if (r.features.ads?.length) say(`Ads: ${r.features.ads.map((a) => a.domain || '?').join(', ')}`);
    say(c.d(`${r.pages} page(s) · ${r.organic.length} organic results${r.totalResults ? ' · about ' + r.totalResults.toLocaleString('en-US') + ' results' : ''}`));
  });

program.command('parse <file>')
  .description('parse a saved Google results page (HTML) and print the JSON')
  .action((file) => console.log(JSON.stringify(parseGoogleSerp(fs.readFileSync(file, 'utf8')), null, 2)));

program.command('history <project> <keyword>').description('position history of one keyword').action((name, keyword) => {
  const db = openDb(dbPath());
  const project = loadProject(name);
  const rows = db.keywordHistory(project.name, keywordKey(keyword), 60).reverse();
  if (!rows.length) say(`No history for "${keyword}".`);
  for (const s of rows) {
    const b = entityRank(s.organic, project.brand);
    const comps = project.competitors.map((x) => `${x.name} ${entityRank(s.organic, x).position ?? '–'}`).join(' · ');
    say(`${s.run_started.slice(0, 10)}  ${s.status !== 'ok' ? c.y(s.status.padEnd(6)) : (b.position ? '#' + b.position : '–').padEnd(6)} ${c.d(comps)}  ${b.url || ''}`);
  }
  db.close();
});

program.command('doctor')
  .description('check Node, SERP providers, AI models, delivery settings')
  .option('--ping', 'call every AI model once')
  .action(async (o) => {
    const ok = (b) => (b ? c.g('ok ') : c.y('-- '));
    say(c.b('Runtime'));
    say(`  ${ok(Number(process.versions.node.split('.')[0]) >= 22)} Node ${process.versions.node}`);
    say(`  ${ok(true)} database ${dbPath()}`);
    say(c.b('SERP sources') + c.d(`  (default: ${resolveProviderName(undefined, process.env)})`));
    say(`  ${ok(!!process.env.SERPAPI_KEY)} serpapi   SERPAPI_KEY`);
    say(`  ${ok(!!process.env.SERPER_API_KEY)} serper    SERPER_API_KEY`);
    say(`  ${ok((process.env.SCRAPER_API_URL || '').includes('{url}'))} gateway   SCRAPER_API_URL (template with {url})`);
    let browser = '';
    try { await import('puppeteer'); browser = 'puppeteer'; } catch {
      try { await import('puppeteer-core'); const { findChrome } = await import('../src/providers/index.js'); browser = `puppeteer-core + ${process.env.BROWSER_EXECUTABLE || findChrome() || 'no Chrome found (set BROWSER_EXECUTABLE)'}`; } catch {}
    }
    say(`  ${ok(!!browser)} browser   ${browser || 'npm i puppeteer-core (optional)'}`);
    say(`  ${ok(true)} google    direct HTTP (Google now answers plain HTTP with a JavaScript wall - use an API)`);
    say(`  ${ok(true)} demo/file always available`);
    say(c.b('AI summary') + c.d('  (multi-model fallback; rules if none)'));
    const ai = createRouterFromEnv(process.env);
    for (const t of ai.status()) {
      let extra = t.enabled ? '' : c.d(` (${t.disabledReason})`);
      if (o.ping && t.enabled) {
        try {
          const r = await ai.generate({ only: t.id, messages: [{ role: 'user', content: 'Reply with OK' }], maxTokens: 1024, timeoutMs: 20000 });
          extra = c.g(` ${r.ms} ms`);
        } catch (err) {
          extra = c.r(` ${err.attempts?.[0]?.kind || err.kind || 'error'}: ${(err.attempts?.[0]?.error || err.message).slice(0, 80)}`);
        }
      }
      say(`  ${ok(t.enabled)} ${t.id}${extra}`);
    }
    say(c.b('Delivery'));
    say(`  ${ok(!!process.env.RESEND_API_KEY)} e-mail    RESEND_API_KEY ${process.env.RESEND_API_KEY ? '' : c.d('(else written to output/<project>/outbox)')}`);
    const hooks = String(process.env.WEBHOOK_URLS || '').split(',').filter(Boolean);
    say(`  ${ok(hooks.length)} webhooks  ${hooks.map(detectPlatform).join(', ') || 'WEBHOOK_URLS (Slack, Discord, Teams, telegram://token@chat, JSON)'}`);
    say(c.b('Projects'));
    for (const n of listProjects()) {
      try {
        const p = loadProject(n);
        say(`  ${ok(true)} ${n}: ${p.keywords.length} keywords, ${p.competitors.length} competitors, provider ${p.provider || resolveProviderName(undefined, process.env)}`);
      } catch (err) {
        say(`  ${c.r('ERR')} ${n}: ${err.message}`);
      }
    }
  });

program.command('schedule <projects...>')
  .description('keep running: weekly report (track + report + deliver), optional daily alert checks')
  .option('--day <day>', 'weekday of the weekly report', 'mon')
  .option('--at <HH:MM>', 'local time', '07:00')
  .option('--daily', 'also track every day and send only new urgent alerts')
  .option('--no-ai', 'rule-based summaries')
  .action(async (names, o) => {
    const job = async (alertsOnly) => {
      for (const name of names) {
        const db = openDb(dbPath());
        try {
          const project = loadProject(name);
          const res = await doTrack(project, db, { quiet: true });
          if (res.ok) {
            const { report, insights, files } = await makeReport(project, db, { ai: o.ai, run: res.runId });
            await deliver(report, insights, files, { project, db, log: say, alertsOnly });
            if (!alertsOnly) printSummary(report, insights, files);
          }
        } catch (err) {
          say(c.r(`${name}: ${err.message}`));
        } finally {
          db.close();
        }
      }
    };
    say(c.b(`Scheduler: ${names.join(', ')} every ${o.day} at ${o.at}${o.daily ? ' + daily alert checks' : ''}. Ctrl+C to stop.`));
    await runSchedule({ day: o.day, at: o.at, daily: !!o.daily, weekly: () => job(false), dailyJob: () => job(true), log: say });
  });

program.command('test-webhook <url>')
  .description('send a sample digest to a webhook (Slack/Discord/Teams/telegram://token@chat/JSON)')
  .option('--print', 'only print the payload')
  .action(async (url, o) => {
    const db = openDb(path.join(ROOT, 'data', 'demo.sqlite'));
    let report;
    try {
      report = buildReport(loadProject(path.join(ROOT, 'projects', 'demo.json')), db);
    } catch {
      throw new Error('run "serp-tracker demo" first (the sample uses the demo data)');
    }
    const { ruleInsights } = await import('../src/insights.js');
    const ins = ruleInsights(report);
    if (o.print) console.log(JSON.stringify(buildPayload(detectPlatform(url), report, ins), null, 2));
    else say(JSON.stringify(await sendWebhook(url, report, ins, { secret: process.env.WEBHOOK_SECRET })));
    db.close();
  });

program.parseAsync().catch((err) => {
  console.error(c.r(`Error: ${err.message}`));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
