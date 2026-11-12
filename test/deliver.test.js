import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPlatform, buildPayload, sendWebhook, sendEmail, deliver } from '../src/deliver/index.js';
import { buildReport } from '../src/metrics.js';
import { trackProject } from '../src/tracker.js';
import { ruleInsights } from '../src/insights.js';
import { writeReport } from '../src/report/index.js';
import { makeProject, serp, fakeProvider, memDb, day } from './helpers.js';

async function setup(over = {}) {
  const db = memDb();
  const project = makeProject(over);
  await trackProject(project, { db, provider: fakeProvider(() => serp({ 4: 'https://acme.com/' })), now: day('2026-11-02') });
  await trackProject(project, { db, provider: fakeProvider(() => serp({ 15: 'https://acme.com/', 2: 'https://rival.com/' })), now: day('2026-11-09') });
  const report = buildReport(project, db);
  return { db, project, report, insights: ruleInsights(report) };
}

test('platform detection', () => {
  assert.equal(detectPlatform('https://hooks.slack.com/services/x'), 'slack');
  assert.equal(detectPlatform('https://discord.com/api/webhooks/1/abc'), 'discord');
  assert.equal(detectPlatform('https://acme.webhook.office.com/webhookb2/x'), 'teams');
  assert.equal(detectPlatform('telegram://123:abc@-100200'), 'telegram');
  assert.equal(detectPlatform('https://hook.eu1.make.com/x'), 'json');
});

test('payloads per platform carry KPIs and urgent alerts', async () => {
  const { report, insights } = await setup();
  const slack = buildPayload('slack', report, insights);
  assert.equal(slack.blocks[0].type, 'header');
  assert.match(slack.blocks[1].text.text, /fell 11 positions/);
  assert.equal(buildPayload('discord', report, insights).embeds[0].color, 0xd03b3b);
  assert.equal(buildPayload('teams', report, insights).attachments[0].content.type, 'AdaptiveCard');
  const json = buildPayload('json', report, insights, { reportUrl: 'https://r/x' });
  assert.equal(json.event, 'serp.weekly_report');
  assert.equal(json.reportUrl, 'https://r/x');
  assert.ok(json.alerts.length > 0);
});

test('JSON webhook is HMAC-signed; Telegram URL is rewritten to the Bot API', async () => {
  const { report, insights } = await setup();
  const calls = [];
  const fetchImpl = async (u, o) => { calls.push({ u, o }); return new Response('ok', { status: 200 }); };
  await sendWebhook('https://n8n.example/webhook/x', report, insights, { fetchImpl, secret: 's3cret' });
  const expected = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(calls[0].o.body).digest('hex');
  assert.equal(calls[0].o.headers['x-signature-256'], expected);
  await sendWebhook('telegram://123:abc@-100200', report, insights, { fetchImpl });
  assert.equal(calls[1].u, 'https://api.telegram.org/bot123:abc/sendMessage');
  assert.equal(JSON.parse(calls[1].o.body).chat_id, '-100200');
  await assert.rejects(sendWebhook('https://hooks.slack.com/x', report, insights, { fetchImpl: async () => new Response('no', { status: 404 }) }), /HTTP 404/);
});

test('e-mail: outbox without a key, Resend with attachments when configured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serp-mail-'));
  const r1 = await sendEmail({ to: 'a@x.test', subject: 'S', html: '<p>hi</p>', env: {}, outbox: dir, attachments: [{ filename: 'report.html', content: 'x' }] });
  assert.ok(fs.readFileSync(r1.outbox, 'utf8').includes('Subject: S'));
  let body;
  const r2 = await sendEmail({
    to: ['a@x.test', 'b@x.test'], subject: 'S', html: '<p>hi</p>', env: { RESEND_API_KEY: 're_test', REPORT_EMAIL_FROM: 'Reports <r@agency.test>' },
    attachments: [{ filename: 'report.html', content: Buffer.from('<html>') }],
    fetchImpl: async (u, o) => { body = JSON.parse(o.body); return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }); },
  });
  assert.equal(r2.id, 'em_1');
  assert.deepEqual(body.to, ['a@x.test', 'b@x.test']);
  assert.equal(Buffer.from(body.attachments[0].content, 'base64').toString(), '<html>');
  assert.deepEqual(await sendEmail({ to: '', subject: 's', html: '' }), { skipped: 'no recipients' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('deliver(): sends to every channel; alerts-only mode never repeats an alert', async () => {
  const { db, project, report, insights } = await setup({ report: { webhooks: ['https://hooks.slack.com/services/T/B/x'], email: ['client@x.test'] } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serp-deliver-'));
  const files = writeReport(report, insights, dir);
  let posts = 0;
  const fetchImpl = async () => { posts++; return new Response('ok', { status: 200 }); };
  const res = await deliver(report, insights, files, { project, db, env: {}, fetchImpl });
  assert.deepEqual(res.map((r) => r.channel), ['slack', 'email']);
  assert.ok(res.every((r) => r.ok));
  const a1 = await deliver(report, insights, files, { project, db, env: {}, fetchImpl, alertsOnly: true });
  assert.equal(a1.length, 0, 'alerts already delivered with the weekly report');
  assert.equal(posts, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
