// Environment + project (client) configuration.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvToObjects } from './util/csv.js';
import { parseTarget } from './util/url.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Load .env from the cwd, then the project folder (existing env vars win). */
export function loadEnv() {
  if (process.env.SERP_SKIP_DOTENV === '1') return;
  for (const file of [path.resolve('.env'), path.join(ROOT, '.env')]) {
    if (fs.existsSync(file)) {
      try {
        process.loadEnvFile(file);
      } catch {}
    }
  }
}

export const keywordKey = (k) => String(k).toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();

const truthy = (v) => /^(1|true|yes|y|x|high|p1)$/i.test(String(v ?? '').trim());

function normalizeKeyword(k) {
  const o = typeof k === 'string' ? { keyword: k } : { ...k };
  const keyword = String(o.keyword || o.query || o.term || o.kw || '').trim();
  if (!keyword) return null;
  const vol = String(o.volume ?? o.search_volume ?? o.sv ?? '').replace(/[,\s]/g, '');
  return {
    keyword,
    key: keywordKey(keyword),
    group: String(o.group || o.category || o.tag || o.cluster || '').trim() || 'General',
    volume: vol && Number.isFinite(Number(vol)) ? Number(vol) : null,
    targetUrl: String(o.targetUrl || o.target_url || o.landing_page || o.url || '').trim() || null,
    priority: typeof o.priority === 'boolean' ? o.priority : truthy(o.priority),
    intent: String(o.intent || '').trim() || null,
  };
}

export function parseKeywordsFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (/\.json$/i.test(file)) {
    const j = JSON.parse(text);
    return (Array.isArray(j) ? j : j.keywords || []).map(normalizeKeyword).filter(Boolean);
  }
  if (/\.(csv|tsv)$/i.test(file) || /[,;\t]/.test(text.split(/\r?\n/, 1)[0])) {
    const rows = csvToObjects(text);
    if (rows.length && Object.keys(rows[0]).some((h) => /keyword|query|term|^kw$/.test(h))) return rows.map(normalizeKeyword).filter(Boolean);
  }
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map(normalizeKeyword).filter(Boolean);
}

function normalizeEntity(e, fallbackName) {
  const o = typeof e === 'string' ? { domains: [e] } : { ...e };
  const domains = (o.domains || (o.domain ? [o.domain] : [])).map(String).filter(Boolean);
  if (!domains.length) throw new Error(`"${o.name || fallbackName}" needs at least one domain`);
  const targets = domains.map(parseTarget);
  return { name: o.name || targets[0].host, domains, targets, color: o.color || null };
}

export function projectsDir() {
  return path.resolve(process.env.SERP_PROJECTS_DIR || path.join(ROOT, 'projects'));
}

export function listProjects() {
  const dir = projectsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}

/** Load and validate a project by name or path. */
export function loadProject(nameOrPath) {
  const file = fs.existsSync(nameOrPath) && nameOrPath.endsWith('.json')
    ? path.resolve(nameOrPath)
    : path.join(projectsDir(), `${nameOrPath}.json`);
  if (!fs.existsSync(file)) {
    const have = listProjects();
    throw new Error(`project "${nameOrPath}" not found (${file}). ${have.length ? 'Available: ' + have.join(', ') : 'Create one with: serp-tracker init <name> --domain example.com'}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return normalizeProject(raw, path.dirname(file), file);
}

export function normalizeProject(raw, baseDir = process.cwd(), file = null) {
  if (!raw.brand) throw new Error('project needs a "brand": { "name", "domains": [...] }');
  const brand = normalizeEntity(raw.brand, 'brand');
  const competitors = (raw.competitors || []).map((c, i) => normalizeEntity(c, `competitor ${i + 1}`));
  let keywords = (raw.keywords || []).map(normalizeKeyword).filter(Boolean);
  if (raw.keywordsFile) {
    const kf = path.resolve(baseDir, raw.keywordsFile);
    if (!fs.existsSync(kf)) throw new Error(`keywordsFile not found: ${kf}`);
    keywords = keywords.concat(parseKeywordsFile(kf));
  }
  const seen = new Set();
  keywords = keywords.filter((k) => !seen.has(k.key) && seen.add(k.key));
  if (!keywords.length) throw new Error('project has no keywords (add "keywords" or "keywordsFile")');
  const depth = Math.min(100, Math.max(10, Number(raw.depth || 30)));
  return {
    name: raw.name || (file ? path.basename(file, '.json') : 'project'),
    file,
    client: raw.client || brand.name,
    brand,
    competitors,
    keywords,
    depth,
    provider: raw.provider || null,
    earlyStop: raw.earlyStop !== false,
    locale: {
      gl: raw.locale?.gl || 'us',
      hl: raw.locale?.hl || 'en',
      googleDomain: raw.locale?.googleDomain || 'google.com',
      location: raw.locale?.location || null,
      device: raw.locale?.device === 'mobile' ? 'mobile' : 'desktop',
    },
    alerts: {
      dropPositions: 5,
      priorityDrop: 3,
      maxPrevPosition: 30,
      urlChange: true,
      featureLoss: true,
      competitorOvertake: true,
      gains: true,
      ...(raw.alerts || {}),
    },
    report: {
      weeks: 12,
      email: [],
      webhooks: [],
      brandColor: '#2563eb',
      agency: process.env.AGENCY_NAME || null,
      ...(raw.report || {}),
    },
  };
}

export function projectTemplate({ name, domain, brandName, competitors = [], keywordsFile, gl = 'us', hl = 'en', location }) {
  return {
    name,
    client: brandName || domain,
    brand: { name: brandName || domain.split('.')[0], domains: [domain] },
    competitors: competitors.map((d) => ({ name: d.split('.')[0].replace(/^\w/, (c) => c.toUpperCase()), domains: [d] })),
    locale: { gl, hl, googleDomain: 'google.com', location: location || null, device: 'desktop' },
    depth: 30,
    provider: null,
    keywordsFile: keywordsFile || `${name}-keywords.csv`,
    alerts: { dropPositions: 5, priorityDrop: 3 },
    report: { weeks: 12, email: [], webhooks: [], brandColor: '#2563eb' },
  };
}
