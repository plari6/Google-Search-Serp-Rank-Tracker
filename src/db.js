// SQLite history (node:sqlite, no native build). One database can hold many client projects.
import './util/quiet.js';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  provider TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  depth INTEGER,
  keywords_total INTEGER DEFAULT 0,
  keywords_ok INTEGER DEFAULT 0,
  requests INTEGER DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS runs_project ON runs(project, started_at);
CREATE TABLE IF NOT EXISTS serps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  keyword_key TEXT NOT NULL,
  keyword TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  pages INTEGER DEFAULT 0,
  depth_reached INTEGER DEFAULT 0,
  total_results INTEGER,
  organic TEXT NOT NULL DEFAULT '[]',
  features TEXT NOT NULL DEFAULT '{}',
  UNIQUE(run_id, keyword_key)
);
CREATE INDEX IF NOT EXISTS serps_kw ON serps(project, keyword_key, fetched_at);
CREATE TABLE IF NOT EXISTS ai_cache (key TEXT PRIMARY KEY, created_at TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alerts_sent (project TEXT NOT NULL, key TEXT NOT NULL, sent_at TEXT NOT NULL, PRIMARY KEY(project, key));
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return wrap(db);
}

const parseSerp = (r) => r && { ...r, organic: JSON.parse(r.organic || '[]'), features: JSON.parse(r.features || '{}') };

function wrap(db) {
  const q = (sql) => db.prepare(sql);
  return {
    raw: db,
    close: () => db.close(),
    createRun({ project, provider, depth, keywordsTotal, startedAt }) {
      const r = q('INSERT INTO runs (project, started_at, provider, depth, keywords_total) VALUES (?, ?, ?, ?, ?)')
        .run(project, startedAt, provider, depth, keywordsTotal);
      return Number(r.lastInsertRowid);
    },
    finishRun(id, { status, keywordsOk, requests, error = null, finishedAt }) {
      q('UPDATE runs SET status = ?, keywords_ok = ?, requests = ?, error = ?, finished_at = ? WHERE id = ?')
        .run(status, keywordsOk, requests, error, finishedAt, id);
    },
    saveSerp(s) {
      q(`INSERT INTO serps (run_id, project, keyword_key, keyword, fetched_at, status, error, pages, depth_reached, total_results, organic, features)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, keyword_key) DO UPDATE SET fetched_at = excluded.fetched_at, status = excluded.status, error = excluded.error,
           pages = excluded.pages, depth_reached = excluded.depth_reached, total_results = excluded.total_results,
           organic = excluded.organic, features = excluded.features`)
        .run(s.runId, s.project, s.keywordKey, s.keyword, s.fetchedAt, s.status, s.error ?? null, s.pages ?? 0, s.depthReached ?? 0,
          s.totalResults ?? null, JSON.stringify(s.organic || []), JSON.stringify(s.features || {}));
    },
    getRun: (id) => q('SELECT * FROM runs WHERE id = ?').get(id),
    /** Most recent runs first. */
    getRuns: (project, limit = 100) => q('SELECT * FROM runs WHERE project = ? ORDER BY started_at DESC, id DESC LIMIT ?').all(project, limit),
    latestUnfinishedRun: (project) => q("SELECT * FROM runs WHERE project = ? AND status IN ('running','partial','blocked') ORDER BY id DESC LIMIT 1").get(project),
    getSerps: (runId) => q('SELECT * FROM serps WHERE run_id = ?').all(runId).map(parseSerp),
    okKeywordKeys: (runId) => new Set(q("SELECT keyword_key FROM serps WHERE run_id = ? AND status IN ('ok','no_results')").all(runId).map((r) => r.keyword_key)),
    keywordHistory: (project, key, limit = 52) =>
      q('SELECT s.*, r.started_at AS run_started FROM serps s JOIN runs r ON r.id = s.run_id WHERE s.project = ? AND s.keyword_key = ? ORDER BY r.started_at DESC LIMIT ?')
        .all(project, key, limit).map(parseSerp),
    cacheGet(key) {
      const r = q('SELECT value FROM ai_cache WHERE key = ?').get(key);
      return r ? JSON.parse(r.value) : null;
    },
    cacheSet: (key, value) => q('INSERT OR REPLACE INTO ai_cache (key, created_at, value) VALUES (?, ?, ?)').run(key, new Date().toISOString(), JSON.stringify(value)),
    alertSeen: (project, key) => !!q('SELECT 1 FROM alerts_sent WHERE project = ? AND key = ?').get(project, key),
    markAlert: (project, key) => q('INSERT OR IGNORE INTO alerts_sent (project, key, sent_at) VALUES (?, ?, ?)').run(project, key, new Date().toISOString()),
    deleteProject(project) {
      q('DELETE FROM serps WHERE project = ?').run(project);
      q('DELETE FROM runs WHERE project = ?').run(project);
      q('DELETE FROM alerts_sent WHERE project = ?').run(project);
    },
  };
}
