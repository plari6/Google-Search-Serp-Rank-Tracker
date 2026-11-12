// Deliver the weekly digest: chat webhooks (Slack, Discord, Teams, Telegram, JSON) and e-mail (Resend or outbox).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fetchWithTimeout } from '../util/async.js';

export function detectPlatform(url) {
  if (/^telegram:\/\//i.test(url)) return 'telegram';
  if (/hooks\.slack\.com/i.test(url)) return 'slack';
  if (/discord(app)?\.com\/api\/webhooks/i.test(url)) return 'discord';
  if (/\.webhook\.office\.com|logic\.azure\.com|powerautomate|environment\.api\.powerplatform/i.test(url)) return 'teams';
  return 'json';
}

const arrow = (x) => (x.isNew ? 'NEW' : x.isLost ? 'LOST' : x.change > 0 ? `▲${x.change}` : x.change < 0 ? `▼${-x.change}` : '0');
const pos = (p) => (p ? `#${p}` : '–');
const dlt = (a, b, d = 0) => (b === null || b === undefined || a === null ? '' : ` (${a - b >= 0 ? '+' : ''}${Math.round((a - b) * 10 ** d) / 10 ** d})`);

/** Plain-text digest lines shared by every chat platform. */
export function digestText(report, insights, { reportUrl, alertsOnly = false } = {}) {
  const k = report.kpis;
  const p = k.prev || {};
  const lines = [];
  lines.push(`SEO rankings – ${report.project.client} – ${report.run.date.slice(0, 10)}`);
  if (insights?.headline) lines.push(insights.headline);
  if (!alertsOnly) {
    lines.push(`Visibility ${k.visibility}${dlt(k.visibility, p.visibility, 1)} · Avg pos ${k.avgPosition ?? '–'}${dlt(k.avgPosition, p.avgPosition, 1)} · Top 3: ${k.top3}${dlt(k.top3, p.top3)} · Top 10: ${k.top10}${dlt(k.top10, p.top10)} · ▲${k.improved} ▼${k.declined}`);
  }
  const al = report.alerts.filter((a) => (alertsOnly ? a.severity !== 'good' : true)).slice(0, 8);
  if (al.length) {
    lines.push('', 'Alerts:');
    for (const a of al) lines.push(`${a.severity === 'high' ? '🔴' : a.severity === 'medium' ? '🟠' : '🟢'} ${a.text}`);
  }
  if (!alertsOnly) {
    if (report.winners.length) lines.push('', 'Top gains: ' + report.winners.slice(0, 4).map((x) => `${x.keyword} ${pos(x.position)} (${arrow(x)})`).join(' · '));
    if (report.losers.length) lines.push('Top drops: ' + report.losers.slice(0, 4).map((x) => `${x.keyword} ${pos(x.position)} (${arrow(x)})`).join(' · '));
    if (insights?.actions?.length) lines.push('', 'Next week: ' + insights.actions.slice(0, 3).map((a, i) => `${i + 1}. ${a.title}`).join('  '));
  }
  if (reportUrl) lines.push('', `Full report: ${reportUrl}`);
  return lines;
}

export function buildPayload(platform, report, insights, opts = {}) {
  const lines = digestText(report, insights, opts);
  const [title, ...rest] = lines;
  const body = rest.join('\n');
  switch (platform) {
    case 'slack':
      return { text: title, blocks: [{ type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } }, { type: 'section', text: { type: 'mrkdwn', text: body.slice(0, 2900) || ' ' } }] };
    case 'discord':
      return { username: 'SERP Rank Tracker', embeds: [{ title: title.slice(0, 256), description: body.slice(0, 4000), color: report.alerts.some((a) => a.severity === 'high') ? 0xd03b3b : 0x2a78d6 }] };
    case 'teams':
      return {
        type: 'message',
        attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body: [{ type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true }, ...rest.filter(Boolean).map((t) => ({ type: 'TextBlock', text: t, wrap: true, spacing: 'Small' }))] } }],
      };
    case 'telegram':
      return { text: `${title}\n${body}`.slice(0, 4000), disable_web_page_preview: true };
    default:
      return {
        event: 'serp.weekly_report', project: report.project.name, client: report.project.client, date: report.run.date, text: lines.join('\n'),
        kpis: report.kpis, alerts: report.alerts, winners: report.winners.slice(0, 10).map(({ keyword, position, prevPosition, change }) => ({ keyword, position, prevPosition, change })),
        losers: report.losers.slice(0, 10).map(({ keyword, position, prevPosition, change }) => ({ keyword, position, prevPosition, change })),
        insights, reportUrl: opts.reportUrl || null,
      };
  }
}

export async function sendWebhook(url, report, insights, { fetchImpl = globalThis.fetch, secret, ...opts } = {}) {
  const platform = detectPlatform(url);
  const payload = buildPayload(platform, report, insights, opts);
  let target = url;
  if (platform === 'telegram') {
    const m = url.match(/^telegram:\/\/([^@]+)@(.+)$/i);
    if (!m) throw new Error('telegram webhook format: telegram://<bot_token>@<chat_id>');
    target = `https://api.telegram.org/bot${m[1]}/sendMessage`;
    payload.chat_id = m[2];
  }
  const body = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json' };
  if (platform === 'json' && secret) headers['x-signature-256'] = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  const res = await fetchWithTimeout(target, { method: 'POST', headers, body }, 15000, fetchImpl);
  if (!res.ok) throw new Error(`${platform} webhook HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { platform, status: res.status };
}

/** E-mail via Resend (RESEND_API_KEY) with report.html attached; else written to an outbox folder. */
export async function sendEmail({ to, subject, html, attachments = [], env = process.env, fetchImpl = globalThis.fetch, outbox = 'output/outbox' }) {
  const recipients = (Array.isArray(to) ? to : String(to || '').split(',')).map((s) => s.trim()).filter(Boolean);
  if (!recipients.length) return { skipped: 'no recipients' };
  const from = env.REPORT_EMAIL_FROM || 'SEO Reports <onboarding@resend.dev>';
  if (!env.RESEND_API_KEY) {
    fs.mkdirSync(outbox, { recursive: true });
    const file = path.join(outbox, `${new Date().toISOString().replace(/[:.]/g, '-')}-${recipients[0].replace(/[^a-z0-9@.]/gi, '_')}.html`);
    fs.writeFileSync(file, `<!-- To: ${recipients.join(', ')} | From: ${from} | Subject: ${subject} | Attachments: ${attachments.map((a) => a.filename).join(', ')} -->\n${html}`);
    return { outbox: file };
  }
  const res = await fetchWithTimeout('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from, to: recipients, subject, html,
      reply_to: env.REPORT_EMAIL_REPLY_TO || undefined,
      attachments: attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })),
    }),
  }, 30000, fetchImpl);
  const text = await res.text();
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${text.slice(0, 200)}`);
  return { id: JSON.parse(text).id, to: recipients };
}

/**
 * Send the weekly digest to every configured channel. Alerts already sent for this run are skipped
 * when `alertsOnly` is used (daily checks), so nobody is spammed twice.
 */
export async function deliver(report, insights, files, { project, db, env = process.env, fetchImpl, log = () => {}, alertsOnly = false, reportUrl, dryRun = false } = {}) {
  const hooks = [...new Set([...(project.report.webhooks || []), ...String(env.WEBHOOK_URLS || '').split(',')].map((s) => s.trim()).filter(Boolean))];
  const emails = [...new Set([...(project.report.email || []), ...String(env.REPORT_EMAIL_TO || '').split(',')].map((s) => s.trim()).filter(Boolean))];
  const results = [];
  let rep = report;
  if (alertsOnly && db) {
    const fresh = report.alerts.filter((a) => a.severity !== 'good' && !db.alertSeen(project.name, `${report.run.id}:${a.key}`));
    if (!fresh.length) {
      log('No new alerts to send.');
      return results;
    }
    rep = { ...report, alerts: fresh };
  }
  if (dryRun) {
    for (const h of hooks) results.push({ channel: detectPlatform(h), dryRun: true, payload: buildPayload(detectPlatform(h), rep, insights, { reportUrl, alertsOnly }) });
    return results;
  }
  for (const h of hooks) {
    try {
      const r = await sendWebhook(h, rep, insights, { fetchImpl, secret: env.WEBHOOK_SECRET, reportUrl, alertsOnly });
      results.push({ channel: r.platform, ok: true });
      log(`  sent to ${r.platform}`);
    } catch (err) {
      results.push({ channel: detectPlatform(h), ok: false, error: err.message });
      log(`  ${detectPlatform(h)} failed: ${err.message}`);
    }
  }
  if (emails.length && !alertsOnly) {
    try {
      const k = report.kpis;
      const subject = `${report.project.client}: SEO rankings ${report.run.date.slice(0, 10)} – ${k.top10} on page 1${k.prev ? ` (${k.top10 - k.prev.top10 >= 0 ? '+' : ''}${k.top10 - k.prev.top10})` : ''}`;
      const r = await sendEmail({
        to: emails, subject, html: fs.readFileSync(files.email, 'utf8'), env, fetchImpl,
        attachments: [{ filename: 'report.html', content: fs.readFileSync(files.html) }, { filename: 'keywords.csv', content: fs.readFileSync(files.keywords) }],
        outbox: path.join(path.dirname(files.html), 'outbox'),
      });
      results.push({ channel: 'email', ok: true, ...r });
      log(r.outbox ? `  e-mail written to ${r.outbox} (set RESEND_API_KEY to send)` : `  e-mailed ${emails.join(', ')}`);
    } catch (err) {
      results.push({ channel: 'email', ok: false, error: err.message });
      log(`  e-mail failed: ${err.message}`);
    }
  }
  if (db && results.some((r) => r.ok)) for (const a of rep.alerts) db.markAlert(project.name, `${report.run.id}:${a.key}`);
  return results;
}
