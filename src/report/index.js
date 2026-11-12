// Write every report artefact for one run: HTML (charts), Markdown, e-mail HTML, CSV exports, JSON.
import fs from 'node:fs';
import path from 'node:path';
import { renderHtml, esc } from './html.js';
import { toCSV } from '../util/csv.js';

const fmt = (n, d = 0) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
const posTxt = (p) => (p ? `#${p}` : '–');
const chgTxt = (k) => (k.isNew ? 'NEW' : k.isLost ? 'LOST' : k.change === null || k.change === undefined ? '–' : k.change > 0 ? `▲${k.change}` : k.change < 0 ? `▼${-k.change}` : '0');
const dd = (a, b, d = 0) => (b === null || b === undefined || a === null || a === undefined ? '' : ` (${a - b >= 0 ? '+' : ''}${fmt(Math.round((a - b) * 10 ** d) / 10 ** d, d)})`);

export function renderMarkdown(r, ins) {
  const k = r.kpis;
  const p = k.prev || {};
  const lines = [];
  lines.push(`# ${r.project.client} – weekly SEO rankings`, '');
  lines.push(`**${r.run.date.slice(0, 10)}**${r.compare ? ` vs ${r.compare.date.slice(0, 10)}` : ' (baseline)'} · ${k.keywords} keywords · ${r.project.brand.domains.join(', ')}`, '');
  if (ins) {
    lines.push(`## ${ins.headline}`, '', ins.summary, '');
    if (ins.wins?.length) lines.push('**Wins**', ...ins.wins.map((w) => `- ${w}`), '');
    if (ins.risks?.length) lines.push('**Risks**', ...ins.risks.map((w) => `- ${w}`), '');
    if (ins.actions?.length) lines.push('**Next week**', ...ins.actions.map((a, i) => `${i + 1}. **${a.title}** – ${a.detail}`), '');
  }
  lines.push('## KPIs', '', '| Metric | Now | Change |', '|---|---:|---:|');
  lines.push(`| Visibility score | ${fmt(k.visibility, 1)} | ${dd(k.visibility, p.visibility, 1).replace(/[()]/g, '') || '–'} |`);
  lines.push(`| Average position | ${fmt(k.avgPosition, 1)} | ${dd(k.avgPosition, p.avgPosition, 1).replace(/[()]/g, '') || '–'} |`);
  lines.push(`| Top 3 | ${k.top3} | ${dd(k.top3, p.top3).replace(/[()]/g, '') || '–'} |`);
  lines.push(`| Top 10 | ${k.top10} | ${dd(k.top10, p.top10).replace(/[()]/g, '') || '–'} |`);
  if (r.usesVolume) lines.push(`| Est. monthly clicks | ${fmt(k.estClicks)} | ${dd(k.estClicks, p.estClicks).replace(/[()]/g, '') || '–'} |`);
  lines.push(`| Featured snippets | ${k.featuredSnippets} | ${dd(k.featuredSnippets, p.featuredSnippets).replace(/[()]/g, '') || '–'} |`);
  lines.push(`| AI Overview citations | ${k.aiOverviewCitations} | ${dd(k.aiOverviewCitations, p.aiOverviewCitations).replace(/[()]/g, '') || '–'} |`);
  lines.push(`| Improved / declined | ${k.improved} / ${k.declined} | |`, '');
  if (r.alerts.length) lines.push('## Alerts', '', ...r.alerts.slice(0, 15).map((a) => `- **${a.severity === 'good' ? 'Win' : a.severity === 'high' ? 'Urgent' : 'Watch'}** ${a.text}`), '');
  const mv = (title, list) => {
    if (!list.length) return;
    lines.push(`## ${title}`, '', '| Keyword | Before | Now | Change |', '|---|---:|---:|---:|', ...list.map((x) => `| ${x.keyword} | ${posTxt(x.prevPosition)} | ${posTxt(x.position)} | ${chgTxt(x)} |`), '');
  };
  mv('Biggest gains', r.winners);
  mv('Biggest drops', r.losers);
  if (r.opportunities.length) lines.push('## Quick wins (#4–#20)', '', '| Keyword | Position | Volume | +Clicks if top 3 |', '|---|---:|---:|---:|', ...r.opportunities.map((o) => `| ${o.keyword} | #${o.position} | ${fmt(o.volume)} | ${o.gainClicks ?? '–'} |`), '');
  lines.push('## Share of voice', '', '| Site | SoV | Before | Top 10 |', '|---|---:|---:|---:|', ...r.competitors.map((c) => `| ${c.name}${c.isBrand ? ' (you)' : ''} | ${fmt(c.sov, 1)}% | ${c.prevSov === null ? '–' : fmt(c.prevSov, 1) + '%'} | ${c.top10} |`), '');
  lines.push('## All keywords', '', `| Keyword | Pos. | Change | Best | Volume | URL |`, '|---|---:|---:|---:|---:|---|', ...r.keywords.map((x) => `| ${x.keyword}${x.status !== 'ok' ? ' ⚠' : ''} | ${posTxt(x.position)} | ${chgTxt(x)} | ${posTxt(x.best)} | ${fmt(x.volume)} | ${x.url || '–'} |`), '');
  return lines.join('\n');
}

/** E-mail-safe HTML (tables + inline styles, no JS); the full report goes as an attachment. */
export function renderEmail(r, ins, { reportUrl } = {}) {
  const k = r.kpis;
  const p = k.prev || {};
  const accent = r.project.brandColor || '#2563eb';
  const cell = 'padding:8px 10px;border-bottom:1px solid #e3e2dc;font-size:14px';
  const chg = (a, b, inv = false, d = 0) => {
    if (a === null || a === undefined || b === null || b === undefined) return '<span style="color:#8a8984">–</span>';
    const x = Math.round((a - b) * 10 ** d) / 10 ** d;
    if (!x) return '<span style="color:#8a8984">0</span>';
    const good = inv ? x < 0 : x > 0;
    return `<span style="color:${good ? '#0a7d0a' : '#b42f2f'};font-weight:600">${x > 0 ? '▲' : '▼'} ${fmt(Math.abs(x), d)}</span>`;
  };
  const kpiRow = (label, v, c) => `<tr><td style="${cell}">${label}</td><td style="${cell};text-align:right;font-weight:700">${v}</td><td style="${cell};text-align:right">${c}</td></tr>`;
  const mover = (x) => `<tr><td style="${cell}">${esc(x.keyword)}</td><td style="${cell};text-align:right">${posTxt(x.prevPosition)}</td><td style="${cell};text-align:right;font-weight:700">${posTxt(x.position)}</td><td style="${cell};text-align:right;color:${x.change > 0 || x.isNew ? '#0a7d0a' : '#b42f2f'};font-weight:600">${chgTxt(x)}</td></tr>`;
  const sevColor = { high: '#d03b3b', medium: '#ec835a', good: '#0ca30c' };
  return `<!doctype html><html><body style="margin:0;background:#f4f4f2;font-family:Segoe UI,Arial,sans-serif;color:#0b0b0b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e3e2dc">
<tr><td style="background:${esc(accent)};color:#fff;padding:18px 24px"><div style="font-size:12px;opacity:.85">${esc(r.project.agency ? r.project.agency + ' · ' : '')}Weekly SEO rankings · ${r.run.date.slice(0, 10)}</div><div style="font-size:22px;font-weight:700">${esc(r.project.client)}</div></td></tr>
<tr><td style="padding:20px 24px">
${ins ? `<div style="font-size:18px;font-weight:700;margin-bottom:6px">${esc(ins.headline)}</div><div style="font-size:14px;line-height:1.5;color:#33322f">${esc(ins.summary)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;border-collapse:collapse">
${kpiRow('Visibility score', fmt(k.visibility, 1), chg(k.visibility, p.visibility, false, 1))}
${kpiRow('Average position', fmt(k.avgPosition, 1), chg(k.avgPosition, p.avgPosition, true, 1))}
${kpiRow('Keywords in top 3', k.top3, chg(k.top3, p.top3))}
${kpiRow('Keywords on page 1', k.top10, chg(k.top10, p.top10))}
${r.usesVolume ? kpiRow('Est. monthly clicks', fmt(k.estClicks), chg(k.estClicks, p.estClicks)) : ''}
${kpiRow('Featured snippets / AI Overview citations', `${k.featuredSnippets} / ${k.aiOverviewCitations}`, '')}
</table>
${ins?.actions?.length ? `<div style="font-size:13px;font-weight:700;text-transform:uppercase;color:#52514e;margin:20px 0 6px">Next week's plan</div><ol style="margin:0;padding-left:20px;font-size:14px;line-height:1.5">${ins.actions.map((a) => `<li style="margin:4px 0"><strong>${esc(a.title)}</strong> – ${esc(a.detail)}</li>`).join('')}</ol>` : ''}
${r.alerts.length ? `<div style="font-size:13px;font-weight:700;text-transform:uppercase;color:#52514e;margin:20px 0 6px">Alerts</div>${r.alerts.slice(0, 8).map((a) => `<div style="font-size:14px;padding:4px 0"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${sevColor[a.severity]};margin-right:8px"></span><strong>${a.severity === 'good' ? 'Win' : a.severity === 'high' ? 'Urgent' : 'Watch'}:</strong> ${esc(a.text)}</div>`).join('')}` : ''}
${r.winners.length ? `<div style="font-size:13px;font-weight:700;text-transform:uppercase;color:#52514e;margin:20px 0 6px">Biggest gains</div><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${r.winners.slice(0, 5).map(mover).join('')}</table>` : ''}
${r.losers.length ? `<div style="font-size:13px;font-weight:700;text-transform:uppercase;color:#52514e;margin:20px 0 6px">Biggest drops</div><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${r.losers.slice(0, 5).map(mover).join('')}</table>` : ''}
<div style="margin-top:22px;font-size:13px;color:#52514e">${reportUrl ? `<a href="${esc(reportUrl)}" style="color:${esc(accent)};font-weight:600">Open the full interactive report</a>` : 'The full interactive report (charts, every keyword, competitors) is attached as report.html.'}</div>
</td></tr></table></td></tr></table></body></html>`;
}

export function keywordRows(r) {
  return r.keywords.map((x) => {
    const row = {
      keyword: x.keyword, group: x.group, priority: x.priority ? 'yes' : '', volume: x.volume ?? '', position: x.position ?? '',
      previous: x.prevPosition ?? '', change: x.isNew ? 'new' : x.isLost ? 'lost' : x.change ?? '', best: x.best ?? '', url: x.url || '',
      url_changed: x.urlChanged ? 'yes' : '', target_url: x.targetUrl || '', wrong_page: x.targetMismatch ? 'yes' : '',
      featured_snippet: x.owns.featured ? 'owned' : x.features.includes('featured_snippet') ? 'other site' : '',
      ai_overview: x.features.includes('ai_overview') ? (x.owns.aiCited ? 'cited' : 'not cited') : '',
      serp_features: x.features.join(' '), ads: x.ads.join(' '), est_clicks: x.estClicks ?? '', volatility_pct: x.volatility ?? '',
      top_result: x.leader?.domain || '', status: x.status, checked_at: x.fetchedAt || '',
    };
    for (const [name, c] of Object.entries(x.competitors)) row[`${name}_position`] = c.position ?? '';
    return row;
  });
}

export function historyRows(r) {
  return r.keywords.map((x) => Object.fromEntries([['keyword', x.keyword], ...r.series.dates.map((d, i) => [d, x.history[i] ?? (x.history[i] === null ? 'not ranking' : '')])]));
}

/** Write all files to outDir; returns paths. */
export function writeReport(report, insights, outDir, { reportUrl } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const files = {
    html: path.join(outDir, 'report.html'),
    markdown: path.join(outDir, 'report.md'),
    email: path.join(outDir, 'email.html'),
    keywords: path.join(outDir, 'keywords.csv'),
    history: path.join(outDir, 'history.csv'),
    competitors: path.join(outDir, 'competitors.csv'),
    json: path.join(outDir, 'summary.json'),
  };
  fs.writeFileSync(files.html, renderHtml(report, insights));
  fs.writeFileSync(files.markdown, renderMarkdown(report, insights));
  fs.writeFileSync(files.email, renderEmail(report, insights, { reportUrl }));
  fs.writeFileSync(files.keywords, toCSV(keywordRows(report)));
  fs.writeFileSync(files.history, toCSV(historyRows(report), ['keyword', ...report.series.dates]));
  fs.writeFileSync(files.competitors, toCSV(report.competitors.map((c) => ({
    name: c.name, domains: c.domains.join(' '), you: c.isBrand ? 'yes' : '', share_of_voice_pct: c.sov, previous_sov_pct: c.prevSov ?? '',
    visibility: c.visibility, top3: c.top3, top10: c.top10, ranking: c.ranking, avg_position: c.avgPosition ?? '', outranks_you_on: c.outranksBrand ?? '',
  }))));
  fs.writeFileSync(files.json, JSON.stringify({ ...report, insights }, null, 2));
  return files;
}
