// Library entry point: use the tracker from your own code (n8n code node, Express API, other CLIs).
export { loadProject, normalizeProject, parseKeywordsFile, listProjects } from './config.js';
export { openDb } from './db.js';
export { createProvider, resolveProviderName, buildGoogleUrl, mapSerpApi, mapSerper, PROVIDERS } from './providers/index.js';
export { parseGoogleSerp, detectBlock } from './parser/google.js';
export { trackProject, fetchKeyword } from './tracker.js';
export { buildReport, buildAlerts, entityRank, ctr, visibility } from './metrics.js';
export { generateInsights, ruleInsights } from './insights.js';
export { writeReport, renderMarkdown, renderEmail } from './report/index.js';
export { renderHtml } from './report/html.js';
export { deliver, sendWebhook, sendEmail, buildPayload, detectPlatform } from './deliver/index.js';
export { nextOccurrence, runSchedule } from './scheduler.js';
