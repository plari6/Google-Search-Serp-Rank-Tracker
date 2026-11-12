// Self-contained weekly HTML report (Chart.js inlined, works offline and as an e-mail attachment).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { featureLabel } from '../metrics.js';

const require = createRequire(import.meta.url);
let chartJsSource = null;
function chartJs() {
  if (chartJsSource === null) {
    try {
      const dir = path.dirname(require.resolve('chart.js'));
      const file = ['chart.umd.min.js', 'chart.umd.js'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
      chartJsSource = file ? fs.readFileSync(file, 'utf8') : '';
    } catch {
      chartJsSource = '';
    }
  }
  return chartJsSource;
}

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (n, d = 0) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const dateStr = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '–');

/** Up/down chip; for positions lower is better so `invert` flips the colour. */
function delta(cur, prev, { invert = false, digits = 0, suffix = '' } = {}) {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return '<span class="d flat">no comparison</span>';
  const diff = Math.round((cur - prev) * 10 ** digits) / 10 ** digits;
  if (diff === 0) return '<span class="d flat">● no change</span>';
  const good = invert ? diff < 0 : diff > 0;
  return `<span class="d ${good ? 'up' : 'down'}">${diff > 0 ? '▲' : '▼'} ${fmt(Math.abs(diff), digits)}${suffix} vs last week</span>`;
}

function change(k) {
  if (k.isNew) return '<span class="chg up">NEW</span>';
  if (k.isLost) return '<span class="chg down">LOST</span>';
  if (k.change === null || k.change === undefined) return '<span class="chg flat">–</span>';
  if (k.change === 0) return '<span class="chg flat">0</span>';
  return `<span class="chg ${k.change > 0 ? 'up' : 'down'}">${k.change > 0 ? '▲' : '▼'}${Math.abs(k.change)}</span>`;
}

const pos = (p) => (p ? `#${p}` : '<span class="muted">–</span>');
const link = (u, max = 48) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\/(www\.)?/, '').slice(0, max))}</a>` : '<span class="muted">–</span>');

/** Inline SVG sparkline of positions (top = #1). */
export function sparkline(history, depth = 100) {
  const pts = history.map((p, i) => ({ i, p }));
  const n = Math.max(history.length - 1, 1);
  const W = 96, H = 26, pad = 3;
  // Scale to this keyword's own range (min span 6 positions) so real moves stay visible; #1 stays on top.
  const vals = history.filter((p) => p).map((p) => Math.min(p, depth));
  let lo = vals.length ? Math.min(...vals) : 1;
  let hi = vals.length ? Math.max(...vals) : depth;
  if (hi - lo < 6) {
    const mid = (hi + lo) / 2;
    lo = Math.max(1, mid - 3);
    hi = lo + 6;
  }
  const y = (p) => pad + ((Math.min(p, depth) - lo) / (hi - lo)) * (H - 2 * pad);
  const x = (i) => pad + (i / n) * (W - 2 * pad);
  const segs = [];
  let cur = [];
  for (const { i, p } of pts) {
    if (p) cur.push(`${x(i).toFixed(1)},${y(p).toFixed(1)}`);
    else if (cur.length) { segs.push(cur); cur = []; }
  }
  if (cur.length) segs.push(cur);
  const last = [...pts].reverse().find((q) => q.p);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">${segs.map((s) => `<polyline points="${s.join(' ')}"/>`).join('')}${last ? `<circle cx="${x(last.i).toFixed(1)}" cy="${y(last.p).toFixed(1)}" r="2.5"/>` : ''}</svg>`;
}

const SEV = { high: ['critical', '⚠', 'Urgent'], medium: ['serious', '!', 'Watch'], good: ['good', '✓', 'Win'] };

export function renderHtml(report, insights) {
  const r = report;
  const k = r.kpis;
  const p = k.prev || {};
  const brand = r.project.brand.name;
  const chartData = {
    dates: r.series.dates,
    visibility: r.series.visibility,
    avgPosition: r.series.avgPosition,
    distribution: r.series.distribution,
    sov: r.competitors.map((c) => ({ name: c.name, isBrand: c.isBrand, data: r.series.sov[c.name] || [] })),
  };

  const kpi = (label, value, d, hint) => `<div class="kpi"><div class="kpi-l">${label}</div><div class="kpi-v">${value}</div>${d}${hint ? `<div class="kpi-h">${hint}</div>` : ''}</div>`;
  const kpis = [
    kpi('Visibility score', fmt(k.visibility, 1), delta(k.visibility, p.visibility, { digits: 1 }), 'share of possible clicks, 0–100'),
    kpi('Average position', fmt(k.avgPosition, 1), delta(k.avgPosition, p.avgPosition, { invert: true, digits: 1 }), `of ${k.ranking} ranking keywords`),
    kpi('Top 3', `${k.top3}<small>/${k.keywords}</small>`, delta(k.top3, p.top3), 'keywords'),
    kpi('Page 1 (top 10)', `${k.top10}<small>/${k.keywords}</small>`, delta(k.top10, p.top10), 'keywords'),
    r.usesVolume ? kpi('Est. monthly clicks', fmt(k.estClicks), delta(k.estClicks, p.estClicks), 'search volume × CTR') : kpi('Ranking', `${k.ranking}<small>/${k.keywords}</small>`, delta(k.ranking, p.ranking), `in top ${r.project.depth}`),
    kpi('Featured snippets', fmt(k.featuredSnippets), delta(k.featuredSnippets, p.featuredSnippets), 'owned'),
    kpi('AI Overview citations', fmt(k.aiOverviewCitations), delta(k.aiOverviewCitations, p.aiOverviewCitations), `${k.aiOverviewKeywords} keywords show an AI Overview`),
    kpi('Movement', `<span class="up">▲${k.improved}</span> <span class="down">▼${k.declined}</span>`, `<span class="d flat">${k.newRankings} new · ${k.lostRankings} lost</span>`, `SERP volatility ${fmt(k.volatility)}%`),
  ].join('');

  const ins = insights || {};
  const insightHtml = `
    <section class="card insight">
      <div class="eyebrow">This week in one line ${ins.source === 'ai' || ins.source === 'cache' ? '<span class="tag">AI-written from tracked data</span>' : ''}</div>
      <h2 class="headline">${esc(ins.headline || '')}</h2>
      <p class="lead">${esc(ins.summary || '')}</p>
      <div class="cols">
        <div><h3>Wins</h3><ul class="ticks good">${(ins.wins || []).map((w) => `<li>${esc(w)}</li>`).join('') || '<li class="muted">No notable wins this week</li>'}</ul></div>
        <div><h3>Risks</h3><ul class="ticks bad">${(ins.risks || []).map((w) => `<li>${esc(w)}</li>`).join('') || '<li class="muted">No notable risks this week</li>'}</ul></div>
      </div>
      <h3>Next week's plan</h3>
      <ol class="actions">${(ins.actions || []).map((a) => `<li><strong>${esc(a.title)}</strong><span>${esc(a.detail)}</span></li>`).join('')}</ol>
    </section>`;

  const alerts = r.alerts.length
    ? `<ul class="alerts">${r.alerts.slice(0, 25).map((a) => { const [cls, icon, label] = SEV[a.severity]; return `<li class="al ${cls}"><span class="al-i" aria-hidden="true">${icon}</span><span class="al-l">${label}</span>${esc(a.text)}</li>`; }).join('')}</ul>`
    : '<p class="muted">No alerts this week.</p>';

  const moverRows = (list) => list.length ? list.map((x) => `<tr><td>${esc(x.keyword)}${x.priority ? ' <span class="tag">priority</span>' : ''}</td><td class="n">${pos(x.prevPosition)}</td><td class="n">${pos(x.position)}</td><td class="n">${change(x)}</td><td class="n">${fmt(x.volume)}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">None</td></tr>';
  const moverTable = (list) => `<table><thead><tr><th>Keyword</th><th class="n">Last week</th><th class="n">Now</th><th class="n">Change</th><th class="n">Volume</th></tr></thead><tbody>${moverRows(list)}</tbody></table>`;

  const opp = r.opportunities.length ? `<table><thead><tr><th>Keyword</th><th class="n">Position</th><th class="n">Volume</th><th class="n">+Clicks if top 3</th><th>Top result now</th><th>Your page</th></tr></thead><tbody>${r.opportunities.map((o) => `<tr><td>${esc(o.keyword)}</td><td class="n">#${o.position}</td><td class="n">${fmt(o.volume)}</td><td class="n">${o.gainClicks !== null ? '+' + fmt(o.gainClicks) : '–'}</td><td>${esc(o.leader || '–')}</td><td>${link(o.url, 40)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No keywords in positions 4–20 right now.</p>';

  const comp = `<table><thead><tr><th>Site</th><th class="n">Share of voice</th><th class="n">Change</th><th class="n">Visibility</th><th class="n">Top 3</th><th class="n">Top 10</th><th class="n">Avg pos.</th><th class="n">Outranks you on</th></tr></thead><tbody>${r.competitors.map((c) => {
    const d = c.prevSov === null ? '–' : (() => { const x = Math.round((c.sov - c.prevSov) * 10) / 10; return x === 0 ? '0' : `<span class="chg ${x > 0 ? (c.isBrand ? 'up' : 'down') : (c.isBrand ? 'down' : 'up')}">${x > 0 ? '+' : ''}${x} pt</span>`; })();
    return `<tr${c.isBrand ? ' class="me"' : ''}><td><strong>${esc(c.name)}</strong> <span class="muted">${esc(c.domains.join(', '))}</span>${c.isBrand ? ' <span class="tag">you</span>' : ''}</td><td class="n">${fmt(c.sov, 1)}%</td><td class="n">${d}</td><td class="n">${fmt(c.visibility, 1)}</td><td class="n">${c.top3}</td><td class="n">${c.top10}</td><td class="n">${fmt(c.avgPosition, 1)}</td><td class="n">${c.isBrand ? '–' : c.outranksBrand + ' kw'}</td></tr>`;
  }).join('')}</tbody></table>`;

  const feats = r.featureSummary.length ? `<table><thead><tr><th>SERP feature</th><th class="n">Keywords showing it</th><th class="n">You appear in it</th></tr></thead><tbody>${r.featureSummary.map((f) => `<tr><td>${esc(f.label)}</td><td class="n">${f.keywords}</td><td class="n">${f.brandOwns === null ? '<span class="muted">n/a</span>' : f.brandOwns}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No SERP features detected.</p>';

  const discovered = r.discovered.length ? `<table><thead><tr><th>Domain</th><th class="n">Top-10 appearances</th><th class="n">Share of keywords</th></tr></thead><tbody>${r.discovered.map((d) => `<tr><td>${esc(d.domain)}</td><td class="n">${d.keywords}</td><td class="n">${d.share}%</td></tr>`).join('')}</tbody></table>` : '<p class="muted">–</p>';
  const ads = r.advertisers.length ? `<table><thead><tr><th>Advertiser</th><th class="n">Keywords with ads</th><th>Tracked competitor</th></tr></thead><tbody>${r.advertisers.map((a) => `<tr><td>${esc(a.domain)}</td><td class="n">${a.keywords}</td><td>${a.competitor ? esc(a.competitor) : '<span class="muted">–</span>'}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No ads seen on tracked keywords.</p>';

  const issues = [
    ...r.cannibalization.map((c) => `<li><strong>Cannibalisation</strong> on "${esc(c.keyword)}": ${c.urls.map((u) => `#${u.position} ${link(u.url, 50)}`).join(', ')}</li>`),
    ...r.urlChanges.map((c) => `<li><strong>Ranking page changed</strong> for "${esc(c.keyword)}": ${link(c.from, 45)} → ${link(c.to, 45)}</li>`),
    ...r.targetMismatches.map((c) => `<li><strong>Wrong page ranks</strong> for "${esc(c.keyword)}": target ${link(c.targetUrl, 45)}, Google shows ${link(c.rankingUrl, 45)} (#${c.position})</li>`),
  ];

  const groupRows = r.groups.length > 1 ? `<section class="card"><h2>By keyword group</h2><table><thead><tr><th>Group</th><th class="n">Keywords</th><th class="n">Top 10</th><th class="n">Avg pos.</th><th class="n">Visibility</th><th class="n">Net change</th></tr></thead><tbody>${r.groups.map((g) => `<tr><td>${esc(g.group)}</td><td class="n">${g.keywords}</td><td class="n">${g.top10}</td><td class="n">${fmt(g.avgPosition, 1)}</td><td class="n">${fmt(g.visibility, 1)}</td><td class="n">${change({ change: g.change })}</td></tr>`).join('')}</tbody></table></section>` : '';

  const compNames = r.project.competitors.map((c) => c.name);
  const kwRows = r.keywords.map((x) => {
    const f = [];
    if (x.owns.featured) f.push('<span class="pill on" title="You own the featured snippet">Snippet</span>');
    else if (x.features.includes('featured_snippet')) f.push('<span class="pill" title="Featured snippet held by another site">Snippet</span>');
    if (x.features.includes('ai_overview')) f.push(`<span class="pill${x.owns.aiCited ? ' on' : ''}" title="${x.owns.aiCited ? 'You are cited in the AI Overview' : 'AI Overview without your site'}">AI</span>`);
    if (x.features.includes('local_pack')) f.push(`<span class="pill${x.owns.local ? ' on' : ''}">Local</span>`);
    if (x.features.includes('people_also_ask')) f.push('<span class="pill">PAA</span>');
    if (x.features.includes('videos')) f.push('<span class="pill">Video</span>');
    if (x.ads.length) f.push(`<span class="pill" title="${esc(x.ads.join(', '))}">Ads ${x.ads.length}</span>`);
    const status = x.status === 'stale' ? ` <span class="tag warn" title="${esc(x.error || '')}">last week's data</span>` : x.status === 'missing' ? ` <span class="tag warn" title="${esc(x.error || '')}">no data</span>` : '';
    return `<tr data-group="${esc(x.group)}" data-pos="${x.position || 999}" data-chg="${x.change ?? (x.isNew ? 100 : x.isLost ? -100 : 0)}" data-vol="${x.volume || 0}">
      <td>${esc(x.keyword)}${x.priority ? ' <span class="tag">priority</span>' : ''}${status}<div class="muted small">${esc(x.group)}</div></td>
      <td class="n big">${pos(x.position)}</td><td class="n">${change(x)}</td><td class="n">${pos(x.best)}</td>
      <td>${sparkline(x.history, r.project.depth)}</td><td class="n">${fmt(x.volume)}</td>
      ${compNames.map((n) => `<td class="n">${pos(x.competitors[n]?.position)}</td>`).join('')}
      <td>${f.join(' ')}</td><td class="url">${link(x.url, 42)}${x.urlChanged ? ' <span class="tag warn">new URL</span>' : ''}</td></tr>`;
  }).join('');
  const groups = [...new Set(r.keywords.map((x) => x.group))];

  const compareLine = r.compare ? `compared with ${dateStr(r.compare.date)}` : 'first tracked week (baseline)';
  const locale = [r.project.locale.location, `google.${r.project.locale.googleDomain.replace(/^google\./, '')}`, r.project.locale.hl, r.project.locale.device].filter(Boolean).join(' · ');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.project.client)} – SEO rankings ${dateStr(r.run.date)}</title>
<style>
:root{color-scheme:light;--bg:#f4f4f2;--surface:#fcfcfb;--line:#e3e2dc;--text:#0b0b0b;--text2:#52514e;--muted:#8a8984;--accent:${esc(r.project.brandColor || '#2563eb')};
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#6250d6;--s8:#e34948;
--b1:#184f95;--b2:#3987e5;--b3:#86b6ef;--b4:#b7d3f6;--b5:#dbe9fb;--none:#d6d5cf;
--good:#0ca30c;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b;--goodText:#0a7d0a;--badText:#b42f2f;--grid:#ebeae5}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;--bg:#111110;--surface:#1a1a19;--line:#2e2e2b;--text:#f0efec;--text2:#c3c2b7;--muted:#8f8e86;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--s8:#e66767;
--b1:#86b6ef;--b2:#5598e7;--b3:#2a78d6;--b4:#1c5cab;--b5:#104281;--none:#3a3a37;--goodText:#3fc43f;--badText:#f07a7a;--grid:#262624}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#111110;--surface:#1a1a19;--line:#2e2e2b;--text:#f0efec;--text2:#c3c2b7;--muted:#8f8e86;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--s8:#e66767;
--b1:#86b6ef;--b2:#5598e7;--b3:#2a78d6;--b4:#1c5cab;--b5:#104281;--none:#3a3a37;--goodText:#3fc43f;--badText:#f07a7a;--grid:#262624}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1240px;margin:0 auto;padding:24px 16px 64px}
header{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:flex-end;margin-bottom:20px;border-bottom:3px solid var(--accent);padding-bottom:16px}
h1{margin:0;font-size:26px;letter-spacing:-.01em}h2{font-size:17px;margin:0 0 12px}h3{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--text2);margin:18px 0 8px}
.sub{color:var(--text2)}.muted{color:var(--muted)}.small{font-size:12px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:16px;min-width:0}
.grid{display:grid;gap:16px;grid-template-columns:repeat(2,minmax(0,1fr))}@media(max-width:860px){.grid{grid-template-columns:1fr}}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}@media(max-width:860px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.kpi-l{color:var(--text2);font-size:12px;font-weight:600}
.kpi-v{font-size:28px;font-weight:700;font-variant-numeric:tabular-nums;margin:2px 0}.kpi-v small{font-size:14px;color:var(--muted);font-weight:500}.kpi-h{color:var(--muted);font-size:11px;margin-top:2px}
.d{font-size:12px;font-weight:600}.up{color:var(--goodText)}.down{color:var(--badText)}.flat{color:var(--muted)}
.insight{border-left:4px solid var(--accent)}.eyebrow{font-size:12px;color:var(--text2);font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.headline{font-size:21px;margin:6px 0 8px}.lead{font-size:15px;color:var(--text);max-width:80ch;margin:0}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:700px){.cols{grid-template-columns:1fr}}
ul.ticks{margin:0;padding-left:0;list-style:none}ul.ticks li{padding:3px 0 3px 22px;position:relative}
ul.ticks.good li::before{content:"✓";position:absolute;left:2px;color:var(--goodText);font-weight:700}ul.ticks.bad li::before{content:"!";position:absolute;left:6px;color:var(--badText);font-weight:700}
ol.actions{margin:0;padding-left:20px}ol.actions li{margin:6px 0}ol.actions strong{display:block}ol.actions span{color:var(--text2)}
.tag{display:inline-block;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:1px 6px;border-radius:999px;background:var(--bg);color:var(--text2);border:1px solid var(--line);vertical-align:middle}
.tag.warn{border-color:var(--warning);color:var(--text)}
.chart-box{position:relative;height:260px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text2);font-weight:600;white-space:nowrap}td.n,th.n{text-align:right}td.big{font-weight:700;font-size:15px}
tr.me td{background:color-mix(in srgb,var(--accent) 8%,transparent)}
.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
.chg{font-weight:700;font-size:12px}.chg.up{color:var(--goodText)}.chg.down{color:var(--badText)}.chg.flat{color:var(--muted)}
.pill{display:inline-block;font-size:10px;padding:1px 6px;border-radius:4px;border:1px solid var(--line);color:var(--text2);margin:1px 0}.pill.on{background:var(--s1);border-color:var(--s1);color:#fff}
.spark{display:block}.spark polyline{fill:none;stroke:var(--s1);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}.spark circle{fill:var(--s1);stroke:var(--surface);stroke-width:1.5}
a{color:var(--s1);text-decoration:none}a:hover{text-decoration:underline}td.url{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
ul.alerts{list-style:none;margin:0;padding:0}.al{display:flex;gap:10px;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--line)}
.al-i{width:20px;height:20px;border-radius:50%;display:inline-grid;place-items:center;font-size:11px;font-weight:700;color:#fff;flex:none}
.al-l{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;width:56px;flex:none}
.al.critical .al-i{background:var(--critical)}.al.serious .al-i{background:var(--serious)}.al.good .al-i{background:var(--good)}
.al.critical .al-l{color:var(--badText)}.al.serious .al-l{color:var(--text2)}.al.good .al-l{color:var(--goodText)}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}.filters input,.filters select{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
.filters input{flex:1;min-width:180px}th[data-sort]{cursor:pointer}th[data-sort]:hover{color:var(--text)}
ul.issues{margin:0;padding-left:18px}ul.issues li{margin:5px 0}
footer{color:var(--muted);font-size:12px;margin-top:24px;line-height:1.6}
.theme{font:inherit;font-size:12px;border:1px solid var(--line);background:var(--surface);color:var(--text2);border-radius:8px;padding:4px 10px;cursor:pointer}
@media print{.filters,.theme{display:none}.card,.kpi{break-inside:avoid}body{background:#fff}}
</style></head>
<body><div class="wrap">
<header>
  <div><div class="sub">${esc(r.project.agency ? r.project.agency + ' · ' : '')}Weekly SEO ranking report</div><h1>${esc(r.project.client)}</h1>
  <div class="sub">${esc(r.project.brand.domains.join(', '))} · ${k.keywords} keywords · ${esc(locale)}</div></div>
  <div style="text-align:right"><div><strong>${dateStr(r.run.date)}</strong></div><div class="sub">${compareLine}</div>
  <button class="theme" type="button" onclick="toggleTheme()">Light / dark</button></div>
</header>

${insightHtml}
<div class="kpis">${kpis}</div>

<div class="grid">
  <section class="card"><h2>Visibility score</h2><div class="chart-box"><canvas id="cVis" aria-label="Visibility score per week"></canvas></div></section>
  <section class="card"><h2>Share of voice vs competitors</h2><div class="chart-box"><canvas id="cSov" aria-label="Share of voice per week"></canvas></div></section>
  <section class="card"><h2>Ranking distribution</h2><div class="chart-box"><canvas id="cDist" aria-label="Keywords per ranking bucket per week"></canvas></div></section>
  <section class="card"><h2>Average position <span class="muted small">(lower is better)</span></h2><div class="chart-box"><canvas id="cPos" aria-label="Average position per week"></canvas></div></section>
</div>

<section class="card"><h2>Alerts</h2>${alerts}</section>

<div class="grid">
  <section class="card"><h2>Biggest gains</h2><div class="tablewrap">${moverTable(r.winners)}</div></section>
  <section class="card"><h2>Biggest drops</h2><div class="tablewrap">${moverTable(r.losers)}</div></section>
</div>

<section class="card"><h2>Quick-win opportunities</h2><p class="muted small">Keywords ranking #4–#20, sorted by the clicks a top-3 position would add.</p><div class="tablewrap">${opp}</div></section>
<section class="card"><h2>Competitors</h2><div class="tablewrap">${comp}</div></section>

<div class="grid">
  <section class="card"><h2>SERP features</h2><div class="tablewrap">${feats}</div></section>
  <section class="card"><h2>Who else ranks on page 1</h2><p class="muted small">Untracked domains that appear most in your top 10s – possible competitors to add.</p><div class="tablewrap">${discovered}</div></section>
</div>
<div class="grid">
  <section class="card"><h2>Paid search on your keywords</h2><div class="tablewrap">${ads}</div></section>
  <section class="card"><h2>Technical signals</h2>${issues.length ? `<ul class="issues">${issues.join('')}</ul>` : '<p class="muted">No cannibalisation, page swaps or wrong landing pages detected.</p>'}</section>
</div>
${groupRows}

<section class="card"><h2>All keywords</h2>
  <div class="filters"><input id="q" type="search" placeholder="Filter keywords…" aria-label="Filter keywords">
  <select id="grp" aria-label="Group"><option value="">All groups</option>${groups.map((g) => `<option>${esc(g)}</option>`).join('')}</select>
  <select id="bkt" aria-label="Position"><option value="">All positions</option><option value="3">Top 3</option><option value="10">Top 10</option><option value="20">Top 20</option><option value="999">Not ranking</option></select></div>
  <div class="tablewrap"><table id="kw"><thead><tr><th data-sort="text">Keyword</th><th class="n" data-sort="pos">Pos.</th><th class="n" data-sort="chg">Change</th><th class="n">Best</th><th>Trend</th><th class="n" data-sort="vol">Volume</th>${compNames.map((n) => `<th class="n">${esc(n)}</th>`).join('')}<th>Features</th><th>Ranking URL</th></tr></thead>
  <tbody>${kwRows}</tbody></table></div>
</section>

<footer>
  <strong>How to read this report.</strong> Positions are organic Google positions (ads excluded; a featured snippet counts as #1), checked to a depth of ${r.project.depth}.
  "Change" compares with the previous weekly check (▲ = moved up). Visibility = share of the clicks you would get if every keyword ranked #1, using a position click-through curve${r.usesVolume ? ' weighted by monthly search volume' : ''}.
  Share of voice = your visibility divided by the combined visibility of you and the tracked competitors. SERP volatility = share of top-10 URLs that are new since last week.
  Keywords marked "last week's data" could not be checked this run and carry their previous result.<br>
  Generated ${dateStr(r.generatedAt)} · run #${r.run.id} via ${esc(r.run.provider)} · ${r.run.requests} SERP requests${ins.model ? ' · summary by ' + esc(ins.model) : ins.source === 'rules' ? ' · rule-based summary' : ''}.
</footer>
</div>
<script>${chartJs().replace(/<\/script/gi, '<\\/script')}</script>
<script type="application/json" id="data">${JSON.stringify(chartData).replace(/</g, '\\u003c')}</script>
<script>
(function(){
  var D = JSON.parse(document.getElementById('data').textContent);
  var charts = [];
  function css(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  window.toggleTheme = function(){
    var el = document.documentElement, dark = el.getAttribute('data-theme') ? el.getAttribute('data-theme') === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    el.setAttribute('data-theme', dark ? 'light' : 'dark'); draw();
  };
  function draw(){
    if (typeof Chart === 'undefined') { document.querySelectorAll('.chart-box').forEach(function(b){ b.innerHTML = '<p class="muted">Charts need JavaScript (Chart.js).</p>'; }); return; }
    charts.forEach(function(c){ c.destroy(); }); charts = [];
    var text2 = css('--text2'), grid = css('--grid'), surface = css('--surface');
    Chart.defaults.color = text2; Chart.defaults.font.family = getComputedStyle(document.body).fontFamily; Chart.defaults.font.size = 12;
    Chart.defaults.borderColor = grid;
    var tip = { backgroundColor: css('--text'), titleColor: surface, bodyColor: surface, padding: 10, cornerRadius: 6, boxPadding: 4, usePointStyle: true };
    var scaleX = { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } };
    var labels = D.dates.map(function(d){ var x = new Date(d + 'T00:00:00'); return x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); });
    var base = { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false }, plugins: { tooltip: tip, legend: { display: false } } };
    function line(color, data, label, extra){ return Object.assign({ label: label, data: data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: data.length > 20 ? 0 : 4, pointHoverRadius: 6, pointBorderColor: surface, pointBorderWidth: 2, tension: 0.25, spanGaps: true }, extra || {}); }

    charts.push(new Chart(document.getElementById('cVis'), { type: 'line', data: { labels: labels, datasets: [line(css('--s1'), D.visibility, 'Visibility', { fill: { target: 'origin', above: css('--s1') + '1f' } })] },
      options: Object.assign({}, base, { scales: { x: scaleX, y: { beginAtZero: true, grid: { color: grid }, ticks: { maxTicksLimit: 5 } } } }) }));

    var slots = ['--s1','--s2','--s3','--s4','--s5','--s6','--s7','--s8'];
    charts.push(new Chart(document.getElementById('cSov'), { type: 'line', data: { labels: labels, datasets: D.sov.map(function(s, i){ return line(css(slots[i % 8]), s.data, s.name + (s.isBrand ? ' (you)' : ''), { borderWidth: s.isBrand ? 3 : 2 }); }) },
      options: Object.assign({}, base, { plugins: { tooltip: Object.assign({}, tip, { callbacks: { label: function(c){ return ' ' + c.dataset.label + ': ' + c.parsed.y + '%'; } } }), legend: { display: true, position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, padding: 14 } } },
        scales: { x: scaleX, y: { beginAtZero: true, grid: { color: grid }, ticks: { callback: function(v){ return v + '%'; }, maxTicksLimit: 5 } } } }) }));

    var buckets = [['top3','Top 3','--b1'],['top10','4–10','--b2'],['top20','11–20','--b3'],['top50','21–50','--b4'],['top100','51–100','--b5'],['not','Not ranking','--none']];
    charts.push(new Chart(document.getElementById('cDist'), { type: 'bar', data: { labels: labels, datasets: buckets.map(function(b){ return { label: b[1], data: D.distribution.map(function(d){ return d[b[0]]; }), backgroundColor: css(b[2]), borderColor: surface, borderWidth: { top: 2 }, borderSkipped: false, borderRadius: 2, maxBarThickness: 44 }; }) },
      options: Object.assign({}, base, { plugins: { tooltip: tip, legend: { display: true, position: 'bottom', labels: { usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 10, padding: 12 } } },
        scales: { x: Object.assign({ stacked: true }, scaleX), y: { stacked: true, beginAtZero: true, grid: { color: grid }, ticks: { precision: 0, maxTicksLimit: 6 } } } }) }));

    charts.push(new Chart(document.getElementById('cPos'), { type: 'line', data: { labels: labels, datasets: [line(css('--s1'), D.avgPosition, 'Average position')] },
      options: Object.assign({}, base, { scales: { x: scaleX, y: { reverse: true, grid: { color: grid }, ticks: { maxTicksLimit: 5, callback: function(v){ return '#' + v; } } } } }) }));
  }
  draw();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);

  // keyword table: filter + sort
  var tbody = document.querySelector('#kw tbody'), rows = Array.prototype.slice.call(tbody.rows);
  var q = document.getElementById('q'), grp = document.getElementById('grp'), bkt = document.getElementById('bkt');
  function filter(){
    var s = q.value.toLowerCase(), g = grp.value, b = Number(bkt.value || 0);
    rows.forEach(function(r){
      var p = Number(r.dataset.pos), ok = (!s || r.cells[0].textContent.toLowerCase().indexOf(s) >= 0) && (!g || r.dataset.group === g) &&
        (!b || (b === 999 ? p === 999 : p <= b));
      r.style.display = ok ? '' : 'none';
    });
  }
  [q, grp, bkt].forEach(function(el){ el.addEventListener('input', filter); });
  var dir = {};
  document.querySelectorAll('#kw th[data-sort]').forEach(function(th){
    th.addEventListener('click', function(){
      var key = th.dataset.sort; dir[key] = -(dir[key] || (key === 'pos' ? -1 : 1));
      rows.sort(function(a, b){
        if (key === 'text') return dir[key] * a.cells[0].textContent.localeCompare(b.cells[0].textContent);
        return dir[key] * (Number(a.dataset[key]) - Number(b.dataset[key]));
      });
      rows.forEach(function(r){ tbody.appendChild(r); });
    });
  });
})();
</script>
</body></html>`;
}

export { featureLabel };
