'use strict';

/**
 * db.cjs — vaultflow data layer
 *
 * WHY: Centralizes all SQLite writes (via node:sqlite DatabaseSync) and
 * DuckDB Parquet operations (analytics / archival) so every other helper
 * imports from one place rather than opening competing DB connections.
 *
 * Usage:
 *   const db = require('./db.cjs');
 *   db.initialize(metricsRoot, dbFile);
 *   db.recordEdit(sessionId, filePath, project, changeType);
 *   db.flushToParquet(metricsRoot, parquetDir);
 *   db.close();
 */

const path               = require('path');
const fs                 = require('fs');
const yaml               = require('js-yaml');
const { createHash }     = require('node:crypto');

function sha256(str) {
  return createHash('sha256').update(str || '').digest('hex');
}

// Wrap raw text in FTS5 double-quote phrase syntax, escaping embedded quotes.
// Prevents FTS5 syntax errors when the query contains operators like OR, AND, *, -.
function ftsPhrase(raw) {
  if (!raw || typeof raw !== 'string') return '""';
  const escaped = raw.replace(/"/g, '""').slice(0, 500);
  return `"${escaped}"`;
}

// Strip <private>...</private> blocks (and the tags themselves) from any
// captured user content before it lands in persistent storage. Mirrors the
// claude-mem privacy primitive — tags remain visible to the model in the live
// conversation, but secrets, scratch credentials, and PII never reach the DB
// or FTS index. Applied at the recordPrompt / recordToolCall edge.
//   "before <private>foo</private> after" → "before  after"
const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/gi;
function stripPrivateTags(input) {
  if (input == null) return input;
  if (typeof input === 'string') return input.replace(PRIVATE_TAG_RE, '');
  // Object / array: stringify, strip, parse back. If parse fails, fall back
  // to walking string fields recursively.
  try {
    const json = JSON.stringify(input);
    const stripped = json.replace(PRIVATE_TAG_RE, '');
    return JSON.parse(stripped);
  } catch (_) {
    return input;
  }
}

// ── lazy-loaded heavy deps ────────────────────────────────────────────────
let _DatabaseSync = null;  // node:sqlite DatabaseSync
let _DuckDBInst   = null;  // @duckdb/node-api DuckDBInstance

function getSqlite() {
  if (!_DatabaseSync) {
    // node:sqlite is built into Node 22+. Suppress ExperimentalWarning.
    const { emitWarning } = process;
    process.emitWarning = (msg, ...rest) => {
      if (typeof msg === 'string' && msg.includes('SQLite')) return;
      emitWarning.call(process, msg, ...rest);
    };
    ({ DatabaseSync: _DatabaseSync } = require('node:sqlite'));
    process.emitWarning = emitWarning;
  }
  return _DatabaseSync;
}

function getDuckdb() {
  if (!_DuckDBInst) {
    ({ DuckDBInstance: _DuckDBInst } = require('@duckdb/node-api'));
  }
  return _DuckDBInst;
}

// ── module state ──────────────────────────────────────────────────────────
let _db          = null;   // node:sqlite DatabaseSync connection
let _metricsRoot = null;
let _parquetDir  = null;
let _config      = null;

// ── config loader ─────────────────────────────────────────────────────────
function loadConfig() {
  if (_config) return _config;

  const configPath = require('../../config/resolve.cjs');
  if (!fs.existsSync(configPath)) {
    // Graceful degradation — callers must pass paths explicitly if config absent
    return null;
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  _config = yaml.load(raw);
  return _config;
}

// ── schema DDL ────────────────────────────────────────────────────────────
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS edit_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT    NOT NULL,
    session_id  TEXT    NOT NULL,
    file_path   TEXT    NOT NULL,
    project     TEXT,
    change_type TEXT    DEFAULT 'edit'
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT    PRIMARY KEY,
    started_at  TEXT    NOT NULL,
    ended_at    TEXT,
    duration_ms INTEGER,
    platform    TEXT,
    cli         TEXT,
    cli_version TEXT,
    model       TEXT,
    model_provider TEXT,
    cwd         TEXT,
    edits       INTEGER DEFAULT 0,
    commands    INTEGER DEFAULT 0,
    tasks       INTEGER DEFAULT 0,
    errors      INTEGER DEFAULT 0,
    project     TEXT
  );

  CREATE TABLE IF NOT EXISTS patterns (
    id          TEXT    PRIMARY KEY,
    pattern_key TEXT    NOT NULL,
    agent       TEXT,
    confidence  REAL    DEFAULT 1.0,
    fire_count  INTEGER DEFAULT 1,
    last_fired  TEXT    NOT NULL,
    promoted    INTEGER DEFAULT 0
  );

  -- Memory entries: parsed blocks from MEMORY.md and vault files.
  -- Populated by auto-memory-hook.mjs at session start.
  CREATE TABLE IF NOT EXISTS memory_entries (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    source  TEXT    NOT NULL,
    title   TEXT    NOT NULL,
    body    TEXT    DEFAULT '',
    tags    TEXT    DEFAULT ''
  );

  -- FTS5 content table backed by memory_entries — BM25 ranking built in.
  -- WHY content table: SQLite keeps FTS index in sync automatically via
  -- triggers below; no manual INSERT into memory_fts required by callers.
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    title, body, tags,
    content='memory_entries',
    content_rowid='id'
  );

  -- Sync triggers for memory_fts
  CREATE TRIGGER IF NOT EXISTS memory_entries_ai
    AFTER INSERT ON memory_entries BEGIN
      INSERT INTO memory_fts(rowid, title, body, tags)
      VALUES (new.id, new.title, new.body, new.tags);
    END;

  CREATE TRIGGER IF NOT EXISTS memory_entries_au
    AFTER UPDATE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, title, body, tags)
        VALUES ('delete', old.id, old.title, old.body, old.tags);
      INSERT INTO memory_fts(rowid, title, body, tags)
        VALUES (new.id, new.title, new.body, new.tags);
    END;

  CREATE TRIGGER IF NOT EXISTS memory_entries_ad
    AFTER DELETE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, title, body, tags)
        VALUES ('delete', old.id, old.title, old.body, old.tags);
    END;

  -- Standalone FTS5 for patterns — not content-backed because patterns uses
  -- TEXT PRIMARY KEY (not INTEGER rowid), so we sync manually in upsertPattern.
  CREATE VIRTUAL TABLE IF NOT EXISTS patterns_fts USING fts5(
    pattern_key, agent
  );

  -- Tool call telemetry. UNIQUE on (tool_name, input_hash, session_id) so
  -- repeated identical calls are detected without storing duplicates.
  CREATE TABLE IF NOT EXISTS tool_calls (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp  TEXT    NOT NULL,
    session_id TEXT    NOT NULL,
    tool_name  TEXT    NOT NULL,
    input_hash TEXT    NOT NULL,
    input_json TEXT,
    UNIQUE(tool_name, input_hash, session_id)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS tool_calls_fts USING fts5(
    tool_name, input_json,
    content='tool_calls',
    content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS tool_calls_ai
    AFTER INSERT ON tool_calls BEGIN
      INSERT INTO tool_calls_fts(rowid, tool_name, input_json)
      VALUES (new.id, new.tool_name, COALESCE(new.input_json, ''));
    END;

  CREATE TRIGGER IF NOT EXISTS tool_calls_au
    AFTER UPDATE ON tool_calls BEGIN
      INSERT INTO tool_calls_fts(tool_calls_fts, rowid, tool_name, input_json)
        VALUES ('delete', old.id, old.tool_name, COALESCE(old.input_json, ''));
      INSERT INTO tool_calls_fts(rowid, tool_name, input_json)
        VALUES (new.id, new.tool_name, COALESCE(new.input_json, ''));
    END;

  CREATE TRIGGER IF NOT EXISTS tool_calls_ad
    AFTER DELETE ON tool_calls BEGIN
      INSERT INTO tool_calls_fts(tool_calls_fts, rowid, tool_name, input_json)
        VALUES ('delete', old.id, old.tool_name, COALESCE(old.input_json, ''));
    END;

  -- Unified retrieval documents: cleaned/search-optimized representations of
  -- prompts, tool calls, and session summaries used by the live context loop.
  CREATE TABLE IF NOT EXISTS retrieval_docs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type    TEXT    NOT NULL,
    source_id      TEXT    NOT NULL,
    session_id     TEXT,
    timestamp      TEXT    NOT NULL,
    project        TEXT,
    cli            TEXT,
    model          TEXT,
    command_family TEXT,
    success_state  TEXT,
    title          TEXT    DEFAULT '',
    body           TEXT    DEFAULT '',
    search_text    TEXT    DEFAULT '',
    metadata_json  TEXT    DEFAULT '',
    UNIQUE(source_type, source_id)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_docs_fts USING fts5(
    title, body, search_text,
    content='retrieval_docs',
    content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS retrieval_docs_ai
    AFTER INSERT ON retrieval_docs BEGIN
      INSERT INTO retrieval_docs_fts(rowid, title, body, search_text)
      VALUES (new.id, COALESCE(new.title, ''), COALESCE(new.body, ''), COALESCE(new.search_text, ''));
    END;

  CREATE TRIGGER IF NOT EXISTS retrieval_docs_au
    AFTER UPDATE ON retrieval_docs BEGIN
      INSERT INTO retrieval_docs_fts(retrieval_docs_fts, rowid, title, body, search_text)
        VALUES ('delete', old.id, COALESCE(old.title, ''), COALESCE(old.body, ''), COALESCE(old.search_text, ''));
      INSERT INTO retrieval_docs_fts(rowid, title, body, search_text)
        VALUES (new.id, COALESCE(new.title, ''), COALESCE(new.body, ''), COALESCE(new.search_text, ''));
    END;

  CREATE TRIGGER IF NOT EXISTS retrieval_docs_ad
    AFTER DELETE ON retrieval_docs BEGIN
      INSERT INTO retrieval_docs_fts(retrieval_docs_fts, rowid, title, body, search_text)
        VALUES ('delete', old.id, COALESCE(old.title, ''), COALESCE(old.body, ''), COALESCE(old.search_text, ''));
    END;

  -- Prompt history for similarity search and skill routing telemetry.
  CREATE TABLE IF NOT EXISTS prompts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp        TEXT    NOT NULL,
    session_id       TEXT    NOT NULL,
    prompt_text      TEXT    NOT NULL,
    skill_routed     TEXT,
    similarity_score REAL
  );

  -- FTS5 content table backed by prompts — enables BM25 similarity search.
  CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(
    prompt_text,
    content='prompts',
    content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS prompts_ai
    AFTER INSERT ON prompts BEGIN
      INSERT INTO prompts_fts(rowid, prompt_text)
      VALUES (new.id, new.prompt_text);
    END;

  CREATE TRIGGER IF NOT EXISTS prompts_ad
    AFTER DELETE ON prompts BEGIN
      INSERT INTO prompts_fts(prompts_fts, rowid, prompt_text)
      VALUES ('delete', old.id, old.prompt_text);
    END;

  CREATE TABLE IF NOT EXISTS retrieval_feedback (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id       TEXT,
    timestamp      TEXT    NOT NULL,
    session_id     TEXT,
    query_text     TEXT,
    source_type    TEXT,
    source_id      TEXT,
    project        TEXT,
    cli            TEXT,
    model          TEXT,
    command_family TEXT,
    success_state  TEXT,
    action         TEXT    NOT NULL,
    rank           REAL,
    rerank_score   REAL,
    useful         INTEGER,
    metadata_json  TEXT    DEFAULT ''
  );

  -- Detected tech stacks per project. Populated by stack-detector.mjs on
  -- session start and injected as context.
  CREATE TABLE IF NOT EXISTS project_stacks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project     TEXT    NOT NULL,
    stack_key   TEXT    NOT NULL,
    detected_at TEXT    NOT NULL,
    confidence  REAL    DEFAULT 1.0,
    UNIQUE(project, stack_key)
  );

  -- Structured knowledge dictionary — anti-hallucination and context injection.
  -- Categories: domain, acronym, api, schema, command, config, error, stack, pattern
  CREATE TABLE IF NOT EXISTS dictionary (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    term       TEXT    NOT NULL,
    category   TEXT    NOT NULL DEFAULT 'domain',
    definition TEXT    NOT NULL,
    source     TEXT,
    tags       TEXT    DEFAULT '',
    UNIQUE(term, category)
  );

  -- FTS5 content table backed by dictionary.
  CREATE VIRTUAL TABLE IF NOT EXISTS dictionary_fts USING fts5(
    term, definition, tags,
    content='dictionary',
    content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS dictionary_ai
    AFTER INSERT ON dictionary BEGIN
      INSERT INTO dictionary_fts(rowid, term, definition, tags)
      VALUES (new.id, new.term, new.definition, new.tags);
    END;

  CREATE TRIGGER IF NOT EXISTS dictionary_au
    AFTER UPDATE ON dictionary BEGIN
      INSERT INTO dictionary_fts(dictionary_fts, rowid, term, definition, tags)
        VALUES ('delete', old.id, old.term, old.definition, old.tags);
      INSERT INTO dictionary_fts(rowid, term, definition, tags)
        VALUES (new.id, new.term, new.definition, new.tags);
    END;

  CREATE TRIGGER IF NOT EXISTS dictionary_ad
    AFTER DELETE ON dictionary BEGIN
      INSERT INTO dictionary_fts(dictionary_fts, rowid, term, definition, tags)
        VALUES ('delete', old.id, old.term, old.definition, old.tags);
    END;

  -- Vault tool registry. INTEGER PK so FTS content table works cleanly.
  CREATE TABLE IF NOT EXISTS vault_tools (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_id     TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    description TEXT    DEFAULT '',
    path        TEXT    DEFAULT '',
    use_count   INTEGER DEFAULT 0,
    last_used   TEXT,
    tags        TEXT    DEFAULT '',
    promoted    INTEGER DEFAULT 0
  );

  -- FTS5 content table backed by vault_tools.
  CREATE VIRTUAL TABLE IF NOT EXISTS vault_tools_fts USING fts5(
    name, description, tags,
    content='vault_tools',
    content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS vault_tools_ai
    AFTER INSERT ON vault_tools BEGIN
      INSERT INTO vault_tools_fts(rowid, name, description, tags)
      VALUES (new.id, new.name, new.description, new.tags);
    END;

  CREATE TRIGGER IF NOT EXISTS vault_tools_au
    AFTER UPDATE ON vault_tools BEGIN
      INSERT INTO vault_tools_fts(vault_tools_fts, rowid, name, description, tags)
        VALUES ('delete', old.id, old.name, old.description, old.tags);
      INSERT INTO vault_tools_fts(rowid, name, description, tags)
        VALUES (new.id, new.name, new.description, new.tags);
    END;

  CREATE TRIGGER IF NOT EXISTS vault_tools_ad
    AFTER DELETE ON vault_tools BEGIN
      INSERT INTO vault_tools_fts(vault_tools_fts, rowid, name, description, tags)
        VALUES ('delete', old.id, old.name, old.description, old.tags);
    END;

  -- Agent registry. Tracks both Claude skills (source='claude') and Codex
  -- agents (source='codex') with unified use_count for ranking.
  CREATE TABLE IF NOT EXISTS vault_agents (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id        TEXT    NOT NULL UNIQUE,
    name            TEXT    NOT NULL,
    source          TEXT    NOT NULL DEFAULT 'claude',
    description     TEXT    DEFAULT '',
    trigger_pattern TEXT,
    use_count       INTEGER DEFAULT 0,
    last_used       TEXT
  );

  -- Agent verdict log. Records pass/fail/warn decisions from routing and
  -- quality-gate agents so callers can query aggregate outcomes over time.
  CREATE TABLE IF NOT EXISTS agent_verdicts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT    NOT NULL,
    session_id  TEXT,
    agent_type  TEXT    NOT NULL,
    verdict     TEXT    NOT NULL,
    reason      TEXT    DEFAULT '',
    flagged_at  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_verdicts_agent ON agent_verdicts(agent_type);
  CREATE INDEX IF NOT EXISTS idx_verdicts_ts    ON agent_verdicts(timestamp);

  -- Session compaction summaries — written by session.end(), read by intelligence.getContext().
  CREATE TABLE IF NOT EXISTS session_summaries (
    session_id   TEXT PRIMARY KEY,
    project      TEXT,
    duration_ms  INTEGER,
    top_files    TEXT,
    patterns     TEXT,
    summary_at   TEXT
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
    project, top_files, patterns,
    content='session_summaries',
    content_rowid='rowid'
  );

  CREATE TRIGGER IF NOT EXISTS session_summaries_ai
    AFTER INSERT ON session_summaries BEGIN
      INSERT INTO session_summaries_fts(rowid, project, top_files, patterns)
      VALUES (new.rowid, COALESCE(new.project, ''), COALESCE(new.top_files, ''), COALESCE(new.patterns, ''));
    END;

  CREATE TRIGGER IF NOT EXISTS session_summaries_au
    AFTER UPDATE ON session_summaries BEGIN
      INSERT INTO session_summaries_fts(session_summaries_fts, rowid, project, top_files, patterns)
        VALUES ('delete', old.rowid, COALESCE(old.project, ''), COALESCE(old.top_files, ''), COALESCE(old.patterns, ''));
      INSERT INTO session_summaries_fts(rowid, project, top_files, patterns)
        VALUES (new.rowid, COALESCE(new.project, ''), COALESCE(new.top_files, ''), COALESCE(new.patterns, ''));
    END;

  CREATE TRIGGER IF NOT EXISTS session_summaries_ad
    AFTER DELETE ON session_summaries BEGIN
      INSERT INTO session_summaries_fts(session_summaries_fts, rowid, project, top_files, patterns)
        VALUES ('delete', old.rowid, COALESCE(old.project, ''), COALESCE(old.top_files, ''), COALESCE(old.patterns, ''));
    END;

  -- Model performance tracking for automatic tier demotion.
  -- One row per (agent, model, task_type) triple; current=1 marks the active model.
  CREATE TABLE IF NOT EXISTS model_performance (
    agent             TEXT NOT NULL,
    model             TEXT NOT NULL,
    task_type         TEXT NOT NULL DEFAULT 'general',
    verdicts_total    INTEGER NOT NULL DEFAULT 0,
    verdicts_approved INTEGER NOT NULL DEFAULT 0,
    sessions_on_model INTEGER NOT NULL DEFAULT 0,
    promoted_at       TEXT,
    demoted_at        TEXT,
    current           INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (agent, model, task_type)
  );

  -- Code graph: symbols exported by each file + cross-file imports.
  -- Populated by code-graph.cjs from post-edit and watcher.
  CREATE TABLE IF NOT EXISTS code_symbols (
    file       TEXT NOT NULL,
    project    TEXT,
    lang       TEXT,
    kind       TEXT NOT NULL,
    name       TEXT NOT NULL,
    line       INTEGER NOT NULL DEFAULT 0,
    indexed_at TEXT NOT NULL,
    PRIMARY KEY (file, kind, name, line)
  );

  CREATE TABLE IF NOT EXISTS code_imports (
    file       TEXT NOT NULL,
    project    TEXT,
    lang       TEXT,
    target     TEXT NOT NULL,
    raw        TEXT,
    line       INTEGER NOT NULL DEFAULT 0,
    indexed_at TEXT NOT NULL,
    PRIMARY KEY (file, target, line)
  );

  -- Memory backlinks: [[name]] references between memory files.
  -- Populated by db.upsertMemoryEntry; mirrors Obsidian graph.
  CREATE TABLE IF NOT EXISTS memory_links (
    source     TEXT NOT NULL,
    target     TEXT NOT NULL,
    title      TEXT,
    PRIMARY KEY (source, target)
  );

  -- Stale memory tracking: memory entries whose source file has disappeared
  -- or whose referenced symbols/files no longer exist. Populated nightly.
  -- Separate table (not a column on memory_entries) so the FTS5 content-table
  -- triggers stay simple.
  CREATE TABLE IF NOT EXISTS memory_stale (
    memory_id   INTEGER PRIMARY KEY,
    source      TEXT,
    title       TEXT,
    reason      TEXT,
    flagged_at  TEXT NOT NULL
  );

  -- Code call graph: who calls whom at the symbol level. Regex-based first
  -- pass (matches name( occurrences after a function definition's opening).
  CREATE TABLE IF NOT EXISTS code_calls (
    caller_file  TEXT NOT NULL,
    caller_name  TEXT NOT NULL,
    callee_name  TEXT NOT NULL,
    project      TEXT,
    lang         TEXT,
    line         INTEGER NOT NULL DEFAULT 0,
    indexed_at   TEXT NOT NULL,
    PRIMARY KEY (caller_file, caller_name, callee_name, line)
  );

  CREATE INDEX IF NOT EXISTS idx_code_calls_callee  ON code_calls(callee_name);
  CREATE INDEX IF NOT EXISTS idx_code_calls_caller  ON code_calls(caller_file, caller_name);
  CREATE INDEX IF NOT EXISTS idx_code_calls_project ON code_calls(project);
  CREATE INDEX IF NOT EXISTS idx_memory_stale_flagged ON memory_stale(flagged_at);

  -- Performance indexes — queried on every hook fire
  CREATE INDEX IF NOT EXISTS idx_code_symbols_name    ON code_symbols(name);
  CREATE INDEX IF NOT EXISTS idx_code_symbols_project ON code_symbols(project);
  CREATE INDEX IF NOT EXISTS idx_code_imports_target  ON code_imports(target);
  CREATE INDEX IF NOT EXISTS idx_code_imports_project ON code_imports(project);
  CREATE INDEX IF NOT EXISTS idx_memory_links_target  ON memory_links(target);
  CREATE INDEX IF NOT EXISTS idx_edit_events_session   ON edit_events(session_id);
  CREATE INDEX IF NOT EXISTS idx_edit_events_timestamp ON edit_events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_tool_calls_session    ON tool_calls(session_id);
  CREATE INDEX IF NOT EXISTS idx_prompts_session       ON prompts(session_id);
  CREATE INDEX IF NOT EXISTS idx_retrieval_docs_source ON retrieval_docs(source_type, source_id);
  CREATE INDEX IF NOT EXISTS idx_retrieval_docs_ts     ON retrieval_docs(timestamp);
  CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_batch ON retrieval_feedback(batch_id);
  CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_ts    ON retrieval_feedback(timestamp);
  CREATE INDEX IF NOT EXISTS idx_memory_source         ON memory_entries(source);
  CREATE INDEX IF NOT EXISTS idx_patterns_fire         ON patterns(fire_count);
  CREATE INDEX IF NOT EXISTS idx_model_perf_agent      ON model_performance(agent);
`;

// ── internal helpers ──────────────────────────────────────────────────────

/**
 * Ensure the metrics root directory exists.
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Escape a path for DuckDB SQL: forward slashes + single-quote escaping.
 * DuckDB requires forward slashes on Windows.
 */
function duckEsc(p) {
  return String(p).replace(/\\/g, '/').replace(/'/g, "''");
}

function parquetShardSuffix(date = new Date()) {
  return date.toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', 'Z');
}

function parquetShardPath(dir, baseName, stamp) {
  return path.join(dir, `${baseName}-${stamp}.parquet`);
}

function parquetGlobPath(dir, baseName) {
  return path.join(dir, `${baseName}*.parquet`);
}

function safeJsonParse(raw, fallback) {
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

const ANSI_REGEX = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const FTS_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'for', 'from', 'how', 'in', 'into',
  'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'with',
]);
const FTS_SYNONYMS = {
  shell:      ['powershell', 'bash', 'terminal', 'command', 'cmd'],
  powershell: ['shell', 'terminal', 'command'],
  bash:       ['shell', 'terminal', 'command'],
  command:    ['shell', 'terminal', 'powershell', 'bash'],
  terminal:   ['shell', 'command'],
  background: ['daemon', 'watcher', 'worker'],
  watcher:    ['background', 'daemon', 'worker'],
  daemon:     ['background', 'watcher'],
  error:      ['fail', 'failure', 'crash', 'broken'],
  fail:       ['error', 'failure', 'crash', 'broken'],
  failure:    ['error', 'fail', 'crash', 'broken'],
  crash:      ['error', 'fail', 'failure', 'broken'],
  broken:     ['error', 'fail', 'failure', 'crash'],
  summary:    ['session', 'patterns', 'files'],
  session:    ['summary', 'history'],
  prompt:     ['task', 'request', 'instruction'],
};

function stripAnsi(text) {
  return String(text || '').replace(ANSI_REGEX, ' ');
}

function flattenSearchValue(value, prefix = '', depth = 0, out = []) {
  if (value == null || depth > 3 || out.length >= 32) return out;
  if (Array.isArray(value)) {
    for (const item of value) flattenSearchValue(item, prefix, depth + 1, out);
    return out;
  }

  if (typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      if (val == null) continue;
      if (/^(id|hash|ts|timestamp|started_at|ended_at)$/i.test(key)) continue;
      const nextPrefix = prefix ? `${prefix} ${key}` : key;
      flattenSearchValue(val, nextPrefix, depth + 1, out);
      if (out.length >= 32) break;
    }
    return out;
  }

  const leaf = typeof value === 'string'
    ? value
    : (typeof value === 'number' || typeof value === 'boolean' ? String(value) : '');
  if (!leaf) return out;
  out.push(prefix ? `${prefix} ${leaf}` : leaf);
  return out;
}

function normalizeSearchText(raw, maxLen = 2000) {
  const base = typeof raw === 'string'
    ? raw
    : flattenSearchValue(raw).join(' ');
  let text = stripAnsi(base)
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}:\d{2}\b/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[{}[\]"]/g, ' ')
    .replace(/[|`]+/g, ' ')
    .replace(/[\\/]+/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\w.\-: ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (text.length > maxLen) text = text.slice(0, maxLen);
  return text;
}

function quoteFtsToken(token) {
  return `"${String(token || '').replace(/"/g, '""')}"`;
}

function tokenizeSearchQuery(raw) {
  return normalizeSearchText(raw, 400)
    .split(/\s+/)
    .filter(token => token.length > 1 && !FTS_STOPWORDS.has(token))
    .slice(0, 6);
}

function buildExpandedFtsQuery(raw) {
  const tokens = tokenizeSearchQuery(raw);
  if (tokens.length === 0) return ftsPhrase(normalizeSearchText(raw, 200) || raw);

  const groups = tokens.map((token) => {
    const expanded = new Set([token]);
    const singular = token.endsWith('s') ? token.slice(0, -1) : token;
    if (singular && singular !== token) expanded.add(singular);
    for (const synonym of FTS_SYNONYMS[token] || []) expanded.add(synonym);
    if (FTS_SYNONYMS[singular]) {
      for (const synonym of FTS_SYNONYMS[singular]) expanded.add(synonym);
    }
    return `(${[...expanded].map(quoteFtsToken).join(' OR ')})`;
  });

  return groups.join(' AND ');
}

function getQuerySignals(raw) {
  const text = normalizeSearchText(raw, 400);
  return {
    wantsFailure: /\b(error|fail|failure|crash|broken|timeout|stuck)\b/.test(text),
    wantsShell: /\b(shell|powershell|bash|command|terminal|background|watcher|daemon)\b/.test(text),
    wantsSummary: /\b(summary|session|patterns|files|recent)\b/.test(text),
  };
}

function recencyBoost(timestamp) {
  if (!timestamp) return 0;
  const ts = new Date(timestamp).getTime();
  if (!Number.isFinite(ts)) return 0;
  const ageMs = Date.now() - ts;
  if (ageMs < 24 * 60 * 60 * 1000) return -2.0;
  if (ageMs < 7 * 24 * 60 * 60 * 1000) return -1.2;
  if (ageMs < 30 * 24 * 60 * 60 * 1000) return -0.5;
  return 0;
}

function rerankRetrievalDocs(rows, query, options) {
  const opts = options || {};
  const signals = getQuerySignals(query);

  return rows.map((row) => {
    let score = typeof row.rank === 'number' ? row.rank : 0;
    if (opts.project && row.project && row.project === opts.project) score -= 3.0;
    if (opts.cli && row.cli && row.cli === opts.cli) score -= 1.5;
    if (opts.model && row.model && row.model === opts.model) score -= 1.0;
    score += recencyBoost(row.timestamp);

    if (signals.wantsShell && row.command_family === 'shell') score -= 1.5;
    if (signals.wantsSummary && row.source_type === 'session_summary') score -= 0.8;
    if (signals.wantsFailure) {
      if (row.success_state === 'failure') score -= 1.4;
      if (row.success_state === 'success') score += 0.4;
    } else if (row.success_state === 'success') {
      score -= 0.6;
    }

    return {
      ...row,
      rerank_score: Number(score.toFixed(4)),
      metadata: safeJsonParse(row.metadata_json, {}),
    };
  }).sort((a, b) => a.rerank_score - b.rerank_score || a.rank - b.rank);
}

function getSessionMetadata(sessionId) {
  if (!_db || !sessionId) return {};
  return _db.prepare(`
    SELECT project, cli, model, errors
    FROM   sessions
    WHERE  id = ?
    LIMIT  1
  `).get(sessionId) || {};
}

function deriveCommandFamily(toolName, payload) {
  const lowerName = String(toolName || '').toLowerCase();
  const command = normalizeSearchText(payload?.command || payload?.cmd || payload?.tool_name || '', 200);
  if (lowerName.includes('shell') || lowerName.includes('bash') || lowerName.includes('powershell') || command) return 'shell';
  if (lowerName.includes('watcher') || lowerName.includes('daemon') || lowerName.includes('background')) return 'background';
  if (lowerName.includes('search')) return 'search';
  if (lowerName.includes('read')) return 'read';
  if (lowerName.includes('write') || lowerName.includes('edit')) return 'write';
  if (lowerName.includes('prompt')) return 'prompt';
  return 'general';
}

// CLI/origin tags that historically leaked into prompts.skill_routed.
// Used both as a guard in recordPrompt (reject these as skill names) and
// as the predicate set for the one-shot backfill in initialize().
const KNOWN_CLI_SOURCES = new Set([
  'claude', 'copilot', 'codex', 'watcher',
  'tracked:claude', 'tracked:copilot', 'tracked:codex',
  'tui:claude', 'tui:copilot', 'tui:codex',
]);

function buildPromptTitle(source, skillRouted) {
  if (source && skillRouted) return `Prompt [${source}] → ${skillRouted}`;
  if (source)                 return `Prompt [${source}]`;
  if (skillRouted)            return `Prompt → ${skillRouted}`;
  return 'Prompt';
}

function deriveSuccessState(toolName, payload, fallbackErrors) {
  const lowerName = String(toolName || '').toLowerCase();
  if (payload && (payload.exitCode != null || payload.exit_code != null)) {
    const exitCode = payload.exitCode != null ? payload.exitCode : payload.exit_code;
    return Number(exitCode) === 0 ? 'success' : 'failure';
  }
  if (lowerName.includes('error') || lowerName.includes('fail')) return 'failure';
  if (lowerName.includes('complete') || lowerName.includes('shutdown') || lowerName.includes('success')) return 'success';
  if (typeof fallbackErrors === 'number') return fallbackErrors > 0 ? 'failure' : 'success';
  return 'unknown';
}

function summarizeToolCall(toolName, payload, rawInput) {
  const segments = [];
  if (payload?.command || payload?.cmd) segments.push(`command ${payload.command || payload.cmd}`);
  if (payload?.cwd) segments.push(`cwd ${payload.cwd}`);
  if (payload?.toolName) segments.push(`tool ${payload.toolName}`);
  if (payload?.message) segments.push(`message ${payload.message}`);
  if (payload?.contextPreview) segments.push(`context ${payload.contextPreview}`);
  if (payload?.prompt) segments.push(`prompt ${payload.prompt}`);
  if (payload?.exitCode != null || payload?.exit_code != null) {
    segments.push(`exit ${payload.exitCode != null ? payload.exitCode : payload.exit_code}`);
  }
  if (segments.length === 0) {
    segments.push(normalizeSearchText(rawInput || payload || '', 400));
  }
  return segments.join(' | ').slice(0, 800);
}

function buildSessionSummaryBody(obj) {
  const project = obj.project || 'unknown';
  const topFiles = Array.isArray(obj.top_files) ? obj.top_files : [];
  const patterns = Array.isArray(obj.patterns) ? obj.patterns : [];
  const toolCounts = _db.prepare(`
    SELECT tool_name, COUNT(*) AS call_count
    FROM   tool_calls
    WHERE  session_id = ?
    GROUP  BY tool_name
    ORDER  BY call_count DESC, tool_name ASC
    LIMIT  3
  `).all(obj.session_id);
  const recentTools = _db.prepare(`
    SELECT tool_name, input_json
    FROM   tool_calls
    WHERE  session_id = ?
    ORDER  BY timestamp DESC
    LIMIT  6
  `).all(obj.session_id);

  const commandHighlights = [];
  for (const row of recentTools) {
    const snippet = summarizeToolCall(row.tool_name, safeJsonParse(row.input_json, null), row.input_json);
    if (!snippet) continue;
    commandHighlights.push(`${row.tool_name}: ${snippet}`);
    if (commandHighlights.length >= 2) break;
  }

  const durationMin = Math.max(1, Math.round((obj.duration_ms || 0) / 60000));
  return [
    `project ${project}`,
    `duration ${durationMin}m`,
    `files ${topFiles.slice(0, 5).join(', ') || 'none'}`,
    `patterns ${patterns.slice(0, 3).join(', ') || 'none'}`,
    `tools ${toolCounts.map((row) => `${row.tool_name} x${row.call_count}`).join(', ') || 'none'}`,
    `recent ${commandHighlights.join(' ; ') || 'none'}`,
  ].join(' | ');
}

function upsertRetrievalDoc(doc) {
  if (!_db) throw new Error('db.upsertRetrievalDoc: call initialize() first');

  _db.prepare(`
    INSERT INTO retrieval_docs
      (source_type, source_id, session_id, timestamp, project, cli, model, command_family,
       success_state, title, body, search_text, metadata_json)
    VALUES
      (@source_type, @source_id, @session_id, @timestamp, @project, @cli, @model, @command_family,
       @success_state, @title, @body, @search_text, @metadata_json)
    ON CONFLICT(source_type, source_id) DO UPDATE SET
      session_id     = COALESCE(excluded.session_id, retrieval_docs.session_id),
      timestamp      = COALESCE(excluded.timestamp, retrieval_docs.timestamp),
      project        = COALESCE(excluded.project, retrieval_docs.project),
      cli            = COALESCE(excluded.cli, retrieval_docs.cli),
      model          = COALESCE(excluded.model, retrieval_docs.model),
      command_family = COALESCE(excluded.command_family, retrieval_docs.command_family),
      success_state  = COALESCE(excluded.success_state, retrieval_docs.success_state),
      title          = COALESCE(excluded.title, retrieval_docs.title),
      body           = COALESCE(excluded.body, retrieval_docs.body),
      search_text    = COALESCE(excluded.search_text, retrieval_docs.search_text),
      metadata_json  = COALESCE(excluded.metadata_json, retrieval_docs.metadata_json)
  `).run({
    source_type:    doc.source_type,
    source_id:      String(doc.source_id),
    session_id:     doc.session_id || null,
    timestamp:      doc.timestamp || new Date().toISOString(),
    project:        doc.project || null,
    cli:            doc.cli || null,
    model:          doc.model || null,
    command_family: doc.command_family || null,
    success_state:  doc.success_state || null,
    title:          doc.title || '',
    body:           doc.body || '',
    search_text:    doc.search_text || normalizeSearchText(`${doc.title || ''} ${doc.body || ''}`),
    metadata_json:  doc.metadata_json || '{}',
  });
}

function backfillRetrievalDocs() {
  if (!_db) throw new Error('db.backfillRetrievalDocs: call initialize() first');

  const counts = _db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM prompts) +
      (SELECT COUNT(*) FROM tool_calls) +
      (SELECT COUNT(*) FROM session_summaries) AS source_count,
      (SELECT COUNT(*) FROM retrieval_docs) AS doc_count
  `).get() || { source_count: 0, doc_count: 0 };

  if ((counts.doc_count || 0) >= (counts.source_count || 0)) return;

  _db.exec('BEGIN');
  try {
    const prompts = _db.prepare(`
      SELECT id, timestamp, session_id, prompt_text, skill_routed, source
      FROM   prompts
    `).all();
    for (const row of prompts) {
      const meta = getSessionMetadata(row.session_id);
      upsertRetrievalDoc({
        source_type:   'prompt',
        source_id:     row.id,
        session_id:    row.session_id,
        timestamp:     row.timestamp,
        project:       meta.project || null,
        cli:           meta.cli || row.source || null,
        model:         meta.model || null,
        command_family:'prompt',
        success_state: deriveSuccessState(row.skill_routed, null, meta.errors),
        title:         buildPromptTitle(row.source, row.skill_routed),
        body:          row.prompt_text,
        search_text:   normalizeSearchText(row.prompt_text, 1600),
        metadata_json: JSON.stringify({ skill_routed: row.skill_routed || null, source: row.source || null }),
      });
    }

    const toolCalls = _db.prepare(`
      SELECT id, timestamp, session_id, tool_name, input_json
      FROM   tool_calls
    `).all();
    for (const row of toolCalls) {
      const payload = safeJsonParse(row.input_json, null);
      const meta = getSessionMetadata(row.session_id);
      const summary = summarizeToolCall(row.tool_name, payload, row.input_json);
      upsertRetrievalDoc({
        source_type:    'tool_call',
        source_id:      row.id,
        session_id:     row.session_id,
        timestamp:      row.timestamp,
        project:        meta.project || null,
        cli:            meta.cli || null,
        model:          meta.model || null,
        command_family: deriveCommandFamily(row.tool_name, payload),
        success_state:  deriveSuccessState(row.tool_name, payload, meta.errors),
        title:          row.tool_name,
        body:           summary,
        search_text:    normalizeSearchText(`${row.tool_name} ${summary}`),
        metadata_json:  JSON.stringify({
          tool_name: row.tool_name,
          raw: typeof row.input_json === 'string' ? row.input_json.slice(0, 1200) : '',
        }),
      });
    }

    const summaries = _db.prepare(`
      SELECT session_id, project, duration_ms, top_files, patterns, summary_at
      FROM   session_summaries
    `).all();
    for (const row of summaries) {
      const topFiles = safeJsonParse(row.top_files, []);
      const patterns = safeJsonParse(row.patterns, []);
      const meta = getSessionMetadata(row.session_id);
      const body = buildSessionSummaryBody({
        session_id: row.session_id,
        project: row.project || meta.project || null,
        duration_ms: row.duration_ms || 0,
        top_files: topFiles,
        patterns,
      });
      upsertRetrievalDoc({
        source_type:   'session_summary',
        source_id:     row.session_id,
        session_id:    row.session_id,
        timestamp:     row.summary_at,
        project:       row.project || meta.project || null,
        cli:           meta.cli || null,
        model:         meta.model || null,
        command_family:'summary',
        success_state: deriveSuccessState('session_summary', null, meta.errors),
        title:         `Session summary ${row.project || meta.project || 'unknown'}`,
        body,
        search_text:   normalizeSearchText(body, 2000),
        metadata_json: JSON.stringify({
          top_files: topFiles,
          patterns,
          duration_ms: row.duration_ms || 0,
        }),
      });
    }

    _db.exec('COMMIT');
  } catch (err) {
    _db.exec('ROLLBACK');
    throw err;
  }
}

function hasParquetArchive(dir, baseName) {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some(name => name.startsWith(baseName) && name.endsWith('.parquet'));
}

/**
 * Normalize DuckDB row objects: convert BigInt values to Number.
 * @duckdb/node-api returns BigInt for INTEGER columns.
 */
function normRows(rows) {
  if (!rows || !rows.length) return rows || [];
  return rows.map(row => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = typeof v === 'bigint' ? Number(v) : v;
    }
    return out;
  });
}

/**
 * Open a DuckDB in-memory instance, run a callback, then disconnect.
 * The callback receives a connection object with .run(sql) → Promise<result>
 * where result.getRowObjects() → raw rows (call normRows() on the result).
 */
async function withDuckdb(_ignored, callback) {
  const DuckDBInstance = getDuckdb();
  const instance = await DuckDBInstance.create(':memory:');
  const conn     = await instance.connect();
  try {
    return await callback(conn);
  } finally {
    try { conn.disconnectSync(); } catch (_) {}
  }
}

/**
 * Run a DuckDB query and return normalized row objects.
 * sql must have all parameters already embedded via duckEsc().
 */
async function duckQuery(conn, sql) {
  const result = await conn.run(sql);
  return normRows(await result.getRowObjects());
}

/**
 * Run a DuckDB statement with no rows returned.
 */
async function duckRun(conn, sql) {
  await conn.run(sql);
}

// ── public API ────────────────────────────────────────────────────────────

/**
 * Initialize the data layer.
 *
 * - Creates metricsRoot directory if absent.
 * - Opens (or creates) the SQLite DB file.
 * - Applies schema DDL (idempotent — CREATE TABLE IF NOT EXISTS).
 *
 * Safe to call multiple times; subsequent calls are no-ops if the same
 * metricsRoot + dbFile combination is already open.
 *
 * @param {string} metricsRoot  Absolute path to the metrics directory.
 * @param {string} dbFile       Filename (not path) of the SQLite DB.
 */
function initialize(metricsRoot, dbFile) {
  if (_db) return; // already open — callers may pass null; once open, stay open

  // Fall back to config values if callers pass null / undefined
  const cfg = loadConfig();
  const root = metricsRoot || (cfg && cfg.paths && cfg.paths.metrics_root);
  const file = dbFile      || (cfg && cfg.storage && cfg.storage.db_file) || 'vaultflow.db';

  if (!root) {
    throw new Error('db.initialize: metricsRoot is required (or set paths.metrics_root in vaultflow.yaml)');
  }

  ensureDir(root);

  const dbPath = path.join(root, file);
  const DatabaseSync = getSqlite();

  _db          = new DatabaseSync(dbPath);
  _metricsRoot = root;

  // WAL mode for concurrent readers + write performance
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA busy_timeout = 5000');
  _db.exec('PRAGMA cache_size = -8000');     // 8 MB page cache
  _db.exec('PRAGMA temp_store = MEMORY');   // temp tables in RAM

  // Apply schema (idempotent)
  _db.exec(SCHEMA_SQL);

  // Additive migrations — safe to run every time; fail silently if already applied

  // v1: add promoted column to vault_tools
  try { _db.exec('ALTER TABLE vault_tools ADD COLUMN promoted INTEGER DEFAULT 0'); } catch (err) {
    if (!err.message.includes('duplicate column')) {
      process.stderr.write(`[db] migration warning: ${err.message}\n`);
    }
  }

  // v2: unique index on memory_entries(source, title) to prevent duplicate accumulation.
  // Deduplicate existing rows first (keep the MIN(id) per source+title pair) so the
  // index creation doesn't fail on pre-existing duplicates.
  try {
    const hasMigration = _db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_uniq'"
    ).get();
    if (!hasMigration) {
      _db.exec(`
        DELETE FROM memory_entries
        WHERE id NOT IN (
          SELECT MIN(id) FROM memory_entries GROUP BY source, title
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_uniq ON memory_entries(source, title);
      `);
    }
  } catch (err) {
    process.stderr.write(`[db] memory_entries dedup migration warning: ${err.message}\n`);
  }

  for (const migration of [
    'ALTER TABLE sessions ADD COLUMN cli TEXT',
    'ALTER TABLE sessions ADD COLUMN cli_version TEXT',
    'ALTER TABLE sessions ADD COLUMN model TEXT',
    'ALTER TABLE sessions ADD COLUMN model_provider TEXT',
    // v3: separate origin-CLI tag from skill-routing tag in prompts.
    // skill_routed had been overloaded with CLI tags ('copilot','codex',
    // 'tracked:*','tui:*'), corrupting routing analytics. source is now the
    // single source of truth for "which CLI generated this prompt".
    'ALTER TABLE prompts ADD COLUMN source TEXT',
  ]) {
    try { _db.exec(migration); } catch (err) {
      if (!err.message.includes('duplicate column')) {
        process.stderr.write(`[db] migration warning: ${err.message}\n`);
      }
    }
  }

  // One-shot backfill: split CLI tags out of prompts.skill_routed into prompts.source.
  // Idempotent — every WHERE clause stops matching once its rewrite is done.
  try {
    // Phase 1a: composite '[copilot:skillname]' originally written by an older
    // hook-handler. Split into source='copilot' + skill_routed='skillname'.
    // Handled in either column because an earlier partial backfill may have
    // moved the composite into source whole.
    _db.exec(`
      UPDATE prompts
      SET source       = COALESCE(source, 'copilot'),
          skill_routed = SUBSTR(skill_routed, 10, LENGTH(skill_routed) - 10)
      WHERE skill_routed LIKE '[copilot:%]';

      UPDATE prompts
      SET skill_routed = COALESCE(skill_routed, SUBSTR(source, 10, LENGTH(source) - 10)),
          source       = 'copilot'
      WHERE source LIKE '[copilot:%]';
    `);

    // Phase 1b: simple CLI tags ('copilot','codex','tracked:*','tui:*') that
    // ended up in skill_routed because callers passed them as the legacy 3rd arg.
    const polluted = _db.prepare(`
      SELECT COUNT(*) AS c FROM prompts
      WHERE skill_routed IS NOT NULL
        AND (
          skill_routed IN ('copilot','codex','claude','watcher')
          OR skill_routed LIKE 'tracked:%'
          OR skill_routed LIKE 'tui:%'
        )
    `).get();

    if (polluted && polluted.c > 0) {
      _db.exec(`
        UPDATE prompts
        SET source       = COALESCE(source, skill_routed),
            skill_routed = NULL
        WHERE skill_routed IN ('copilot','codex','claude','watcher')
           OR skill_routed LIKE 'tracked:%'
           OR skill_routed LIKE 'tui:%';
      `);
      process.stderr.write(`[db] backfill: split ${polluted.c} CLI tag(s) out of prompts.skill_routed into prompts.source\n`);
    }

    // Phase 2: fill any remaining null source values from the owning session's cli.
    _db.exec(`
      UPDATE prompts
      SET source = (SELECT cli FROM sessions WHERE sessions.id = prompts.session_id)
      WHERE source IS NULL;
    `);

    // Phase 3: rewrite stale retrieval_docs titles + metadata for prompts.
    // upsertRetrievalDoc COALESCEs on conflict (it's designed for partial
    // updates), so it cannot overwrite a non-null title. Use direct UPDATE.
    //
    // Idempotency anchor: the new metadata_json always includes "source",
    // the old (pre-fix) form never did. Filtering on the absence of "source"
    // in metadata_json means each row is rewritten exactly once.
    const stale = _db.prepare(`
      SELECT p.id, p.skill_routed, p.source
      FROM   prompts p
      JOIN   retrieval_docs r
        ON   r.source_type = 'prompt'
       AND   r.source_id   = CAST(p.id AS TEXT)
      WHERE  (r.title LIKE 'Prompt %' OR r.title = 'Prompt')
        AND  (r.metadata_json IS NULL OR r.metadata_json NOT LIKE '%"source"%')
    `).all();
    if (stale.length > 0) {
      const upd = _db.prepare(`
        UPDATE retrieval_docs
        SET    title         = ?,
               metadata_json = ?
        WHERE  source_type   = 'prompt'
          AND  source_id     = ?
      `);
      for (const row of stale) {
        upd.run(
          buildPromptTitle(row.source, row.skill_routed),
          JSON.stringify({ skill_routed: row.skill_routed || null, source: row.source || null }),
          String(row.id),
        );
      }
      process.stderr.write(`[db] backfill: re-derived ${stale.length} retrieval_docs prompt title(s)\n`);
    }
  } catch (err) {
    process.stderr.write(`[db] prompts source backfill warning: ${err.message}\n`);
  }

  try { _db.exec(`INSERT INTO tool_calls_fts(tool_calls_fts) VALUES ('rebuild')`); } catch (err) {
    if (!err.message.includes('no such table')) {
      process.stderr.write(`[db] tool_calls_fts rebuild warning: ${err.message}\n`);
    }
  }

  try { _db.exec(`INSERT INTO session_summaries_fts(session_summaries_fts) VALUES ('rebuild')`); } catch (err) {
    if (!err.message.includes('no such table')) {
      process.stderr.write(`[db] session_summaries_fts rebuild warning: ${err.message}\n`);
    }
  }

  try { backfillRetrievalDocs(); } catch (err) {
    process.stderr.write(`[db] retrieval docs backfill warning: ${err.message}\n`);
  }

  try { _db.exec(`INSERT INTO retrieval_docs_fts(retrieval_docs_fts) VALUES ('rebuild')`); } catch (err) {
    if (!err.message.includes('no such table')) {
      process.stderr.write(`[db] retrieval_docs_fts rebuild warning: ${err.message}\n`);
    }
  }
}

/**
 * Write a single edit event to SQLite.
 *
 * @param {string} sessionId   Active session ID.
 * @param {string} filePath    Absolute path of the edited file.
 * @param {string} [project]   Project name (derived by caller from filePath).
 * @param {string} [changeType='edit']  One of: 'edit', 'create', 'delete'.
 */
function recordEdit(sessionId, filePath, project, changeType, agent) {
  if (!_db) throw new Error('db.recordEdit: call initialize() first');

  _db.prepare(`
    INSERT INTO edit_events (timestamp, session_id, file_path, project, change_type)
    VALUES (@timestamp, @session_id, @file_path, @project, @change_type)
  `).run({
    timestamp:   new Date().toISOString(),
    session_id:  sessionId,
    file_path:   filePath,
    project:     project    || null,
    change_type: changeType || 'edit',
  });

  // Pattern fires used to be wired only into Claude's post-edit hook, which
  // meant Copilot/Codex/watcher edits never showed up on the Patterns tab.
  // Folding upsertPattern into recordEdit ensures every recorded edit — no
  // matter who made it — increments the matching pattern. The agent param is
  // optional; callers pass it when they know the active subagent.
  try {
    const path  = require('path');
    const ext   = (path.extname(filePath || '') || '').replace('.', '') || 'noext';
    const dir   = path.basename(path.dirname(filePath || '')) || 'root';
    upsertPattern(`${ext}::${dir}`, agent || null);
  } catch (_) { /* pattern bookkeeping is best-effort, never break the edit insert */ }
}

/**
 * Insert or update a session row.
 *
 * All fields are optional except `id` and `started_at`. Existing rows are
 * updated in place (upsert via INSERT OR REPLACE).
 *
 * @param {object} session
 * @param {string} session.id
 * @param {string} session.started_at   ISO timestamp
 * @param {string} [session.ended_at]
 * @param {number} [session.duration_ms]
 * @param {string} [session.platform]
 * @param {string} [session.cli]
 * @param {string} [session.cli_version]
 * @param {string} [session.model]
 * @param {string} [session.model_provider]
 * @param {string} [session.cwd]
 * @param {number} [session.edits]
 * @param {number} [session.commands]
 * @param {number} [session.tasks]
 * @param {number} [session.errors]
 * @param {string} [session.project]
 */
function upsertSession(session) {
  if (!_db) throw new Error('db.upsertSession: call initialize() first');

  const stmt = _db.prepare(`
    INSERT INTO sessions
      (id, started_at, ended_at, duration_ms, platform, cli, cli_version, model, model_provider, cwd,
       edits, commands, tasks, errors, project)
    VALUES
      (@id, @started_at, @ended_at, @duration_ms, @platform, @cli, @cli_version, @model, @model_provider, @cwd,
       @edits, @commands, @tasks, @errors, @project)
    ON CONFLICT(id) DO UPDATE SET
      started_at  = CASE
                      WHEN excluded.started_at IS NULL THEN sessions.started_at
                      WHEN sessions.started_at IS NULL THEN excluded.started_at
                      WHEN excluded.started_at < sessions.started_at THEN excluded.started_at
                      ELSE sessions.started_at
                    END,
      ended_at    = COALESCE(excluded.ended_at, sessions.ended_at),
      duration_ms = COALESCE(excluded.duration_ms, sessions.duration_ms),
      platform    = COALESCE(excluded.platform, sessions.platform),
      cli         = COALESCE(excluded.cli, sessions.cli),
      cli_version = COALESCE(excluded.cli_version, sessions.cli_version),
      model       = COALESCE(excluded.model, sessions.model),
      model_provider = COALESCE(excluded.model_provider, sessions.model_provider),
      cwd         = COALESCE(excluded.cwd, sessions.cwd),
      edits       = COALESCE(excluded.edits, sessions.edits),
      commands    = COALESCE(excluded.commands, sessions.commands),
      tasks       = COALESCE(excluded.tasks, sessions.tasks),
      errors      = COALESCE(excluded.errors, sessions.errors),
      project     = COALESCE(excluded.project, sessions.project)
  `);

  stmt.run({
    id:          session.id,
    started_at:  session.started_at,
    ended_at:    session.ended_at    ?? null,
    duration_ms: session.duration_ms ?? null,
    platform:    session.platform    ?? null,
    cli:         session.cli         ?? null,
    cli_version: session.cli_version ?? null,
    // Normalize model on write so analytics queries don't fragment on
    // dot/dash and case variants. See normalizeModelName().
    model:       normalizeModelName(session.model)       ?? null,
    model_provider: session.model_provider ?? null,
    cwd:         session.cwd         ?? null,
    edits:       session.edits       ?? null,
    commands:    session.commands    ?? null,
    tasks:       session.tasks       ?? null,
    errors:      session.errors      ?? null,
    project:     session.project     ?? null,
  });
}

/**
 * Insert or update a memory entry and keep the FTS5 index in sync.
 *
 * Source deduplication: an existing row with the same source+title is updated
 * rather than re-inserted so the FTS index doesn't accumulate duplicates.
 *
 * @param {string} source  File path this entry came from.
 * @param {string} title   Heading or key (searchable).
 * @param {string} [body]  Content block (searchable).
 * @param {string} [tags]  Space-separated tags (searchable).
 */
function upsertMemoryEntry(source, title, body, tags) {
  if (!_db) throw new Error('db.upsertMemoryEntry: call initialize() first');

  // The FTS sync triggers fire automatically on INSERT and UPDATE,
  // so no manual FTS manipulation is needed here.
  // ON CONFLICT on (source, title): update body+tags so stale content doesn't linger.
  _db.prepare(`
    INSERT INTO memory_entries (source, title, body, tags)
    VALUES (@source, @title, @body, @tags)
    ON CONFLICT(source, title) DO UPDATE SET
      body = excluded.body,
      tags = excluded.tags
  `).run({ source, title, body: body || '', tags: tags || '' });

  _refreshMemoryLinks(source, title, body || '');
}

// Extract [[wikilinks]] from memory body and refresh memory_links.
// `source` is the memory entry's source file path; entries from the same
// source share that key. We dedupe per (source,target) so multiple titles
// inside one file don't fight.
function _refreshMemoryLinks(source, title, body) {
  if (!_db) return;
  const matches = String(body).match(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g) || [];
  const targets = new Set();
  for (const m of matches) {
    const t = m.slice(2, -2).split(/[|#]/)[0].trim().toLowerCase();
    if (t) targets.add(t);
  }
  if (targets.size === 0) {
    _db.prepare('DELETE FROM memory_links WHERE source = ? AND title = ?').run(source, title || '');
    return;
  }
  _db.exec('BEGIN');
  try {
    _db.prepare('DELETE FROM memory_links WHERE source = ? AND title = ?').run(source, title || '');
    const ins = _db.prepare(
      'INSERT OR IGNORE INTO memory_links (source, target, title) VALUES (?, ?, ?)'
    );
    for (const tgt of targets) ins.run(source, tgt, title || '');
    _db.exec('COMMIT');
  } catch (err) {
    _db.exec('ROLLBACK');
    // swallow — backlinks are auxiliary
  }
}

function searchMemoryBacklinks(target, limit = 50) {
  if (!_db) throw new Error('db.searchMemoryBacklinks: call initialize() first');
  if (!target) return [];
  const key = String(target).trim().toLowerCase();
  return _db.prepare(
    `SELECT source, title, target FROM memory_links
      WHERE target = ? ORDER BY source LIMIT ?`
  ).all(key, limit);
}

function getMemoryLinkGraph(limit = 500) {
  if (!_db) throw new Error('db.getMemoryLinkGraph: call initialize() first');
  return _db.prepare(
    `SELECT source, title, target FROM memory_links ORDER BY source LIMIT ?`
  ).all(limit);
}

/**
 * Replace all memory entries from a given source file.
 *
 * Used by auto-memory-hook.mjs when re-parsing a MEMORY.md after it changes.
 * Deletes old rows first (triggers remove them from FTS), then re-inserts.
 *
 * @param {string} source   File path whose entries should be replaced.
 * @param {Array<{title, body, tags}>} entries  New entries to insert.
 */
function replaceMemorySource(source, entries) {
  if (!_db) throw new Error('db.replaceMemorySource: call initialize() first');

  _db.exec('BEGIN');
  try {
    _db.prepare('DELETE FROM memory_entries WHERE source = ?').run(source);
    _db.prepare('DELETE FROM memory_links   WHERE source = ?').run(source);
    const insert = _db.prepare(`
      INSERT INTO memory_entries (source, title, body, tags)
      VALUES (@source, @title, @body, @tags)
    `);
    for (const e of entries) {
      insert.run({ source, title: e.title, body: e.body || '', tags: e.tags || '' });
    }
    _db.exec('COMMIT');
  } catch (err) {
    _db.exec('ROLLBACK');
    throw err;
  }

  // Re-extract backlinks for each entry after the row data is committed.
  for (const e of entries) _refreshMemoryLinks(source, e.title, e.body || '');
}

/**
 * Insert or update a pattern row.
 *
 * - On first fire: INSERT with fire_count=1, confidence=1.0.
 * - On subsequent fires: increment fire_count, update last_fired.
 * - Also syncs pattern_key+agent into the standalone patterns_fts table.
 *
 * ID is derived as `${patternKey}::${agent || 'unknown'}` for deduplication.
 *
 * @param {string} patternKey  Canonical pattern identifier.
 * @param {string} [agent]     Agent that fired this pattern (e.g. 'developer-backend').
 */
// Infrastructure noise that should never be tracked as a pattern: vaultflow's
// own SQLite/DuckDB WAL files, build artifacts, caches. These were drowning
// real signal (wal::data alone had 26k fires).
const PATTERN_DENYLIST = new Set([
  'wal::data', 'shm::data', 'db::data', 'duckdb::data', 'sqlite::data',
  'noext::data', 'tmp::data', 'lock::data',
  'dll::net8.0', 'dll::net6.0', 'dll::net7.0', 'dll::net9.0',
  'dll::win-x64', 'dll::win-x86', 'pdb::win-x64', 'pdb::net8.0',
  'pyc::__pycache__', 'log::logs', 'noext::cache',
]);

// Parent-dir tokens that mark generated/cache output regardless of extension.
const NOISY_PARENTS = new Set([
  'cache', '.cache', 'node_modules', 'dist', 'build', 'bin', 'obj',
  '.next', '.parcel-cache', '.turbo', '__pycache__', '.pytest_cache',
  '.vs', '.vscode', '.idea',
]);

function upsertPattern(patternKey, agent) {
  if (!_db) throw new Error('db.upsertPattern: call initialize() first');
  if (PATTERN_DENYLIST.has(patternKey)) return;
  // Block wal/shm/lock-prefixed patterns regardless of suffix.
  if (/^(wal|shm|lock|tmp|cache|pyc)::/.test(patternKey)) return;
  // Block any pattern whose parent-dir half is a known generated/cache folder.
  const parent = patternKey.split('::')[1];
  if (parent && NOISY_PARENTS.has(parent)) return;

  const id  = `${patternKey}::${agent || 'unknown'}`;
  const now = new Date().toISOString();
  const a   = agent || null;

  // FTS5 agent stored as empty string when null so WHERE equality works cleanly.
  const agentFts = a || '';

  _db.exec('BEGIN');
  try {
    const existing = _db.prepare('SELECT 1 FROM patterns WHERE id = ?').get(id);

    _db.prepare(`
      INSERT INTO patterns (id, pattern_key, agent, confidence, fire_count, last_fired, promoted)
      VALUES (@id, @pattern_key, @agent, 1.0, 1, @now, 0)
      ON CONFLICT(id) DO UPDATE SET
        fire_count = fire_count + 1,
        last_fired = excluded.last_fired
    `).run({ id, pattern_key: patternKey, agent: a, now });

    // Sync FTS: patterns_fts is standalone (not content-backed).
    // FTS5 DELETE requires rowid — use a subquery to locate the existing row.
    if (existing) {
      _db.prepare(`
        DELETE FROM patterns_fts
        WHERE rowid IN (
          SELECT rowid FROM patterns_fts
          WHERE  pattern_key = ? AND agent = ?
        )
      `).run(patternKey, agentFts);
    }
    _db.prepare(`INSERT INTO patterns_fts(pattern_key, agent) VALUES (?, ?)`).run(patternKey, agentFts);
    _db.exec('COMMIT');
  } catch (err) {
    _db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Return all patterns whose fire_count >= threshold and haven't been promoted.
 *
 * @param {number} threshold  Minimum fire count (from config.intelligence.pattern_fire_threshold).
 * @returns {Array<{id, pattern_key, agent, confidence, fire_count, last_fired}>}
 */
function getPendingPromotions(threshold) {
  if (!_db) throw new Error('db.getPendingPromotions: call initialize() first');

  return _db.prepare(`
    SELECT id, pattern_key, agent, confidence, fire_count, last_fired
    FROM   patterns
    WHERE  fire_count >= ?
    AND    promoted   = 0
    ORDER  BY fire_count DESC
  `).all(threshold);
}

/**
 * Mark a list of patterns as promoted so they won't surface again until reset.
 *
 * @param {string[]} patternKeys  Pattern keys to mark (matches pattern_key column).
 */
function markPromoted(patternKeys) {
  if (!_db) throw new Error('db.markPromoted: call initialize() first');
  if (!patternKeys || patternKeys.length === 0) return;

  const placeholders = patternKeys.map(() => '?').join(', ');
  _db.prepare(`
    UPDATE patterns SET promoted = 1
    WHERE  pattern_key IN (${placeholders})
  `).run(...patternKeys);
}

/**
 * Flush edit_events and sessions from SQLite to Parquet via DuckDB.
 *
 * - Reads the last-flush timestamp from a sentinel file to avoid duplicates.
 * - Appends only new rows since last flush.
 * - Creates Parquet files on first flush; appends on subsequent flushes.
 * - Updates the sentinel file after a successful flush.
 *
 * DuckDB's sqlite_scan() extension reads the SQLite file directly — the
 * The node:sqlite connection does NOT need to be closed first because WAL
 * mode allows concurrent readers.
 *
 * @param {string} metricsRoot   Absolute path to metrics directory.
 * @param {string} parquetDir    Subdirectory name for Parquet files (relative to metricsRoot).
 * @returns {Promise<{editsFlushed: number, sessionsFlushed: number}>}
 */
async function flushToParquet(metricsRoot, parquetDir) {
  const cfg  = loadConfig();
  const root = metricsRoot || (_metricsRoot) || (cfg && cfg.paths && cfg.paths.metrics_root);
  const pDir = parquetDir  || (cfg && cfg.storage && cfg.storage.parquet_dir) || 'parquet';

  if (!root) throw new Error('db.flushToParquet: metricsRoot is required');

  const pDirFull      = path.join(root, pDir);
  const sentinelPath  = path.join(root, '.last-flush');
  const dbPath        = path.join(root, (cfg && cfg.storage && cfg.storage.db_file) || 'vaultflow.db');
  const editsParquet  = path.join(pDirFull, 'edit_events.parquet');
  const sessParquet   = path.join(pDirFull, 'sessions.parquet');
  const flushStamp    = parquetShardSuffix();
  const editsShard    = parquetShardPath(pDirFull, 'edit_events', flushStamp);
  const sessShard     = parquetShardPath(pDirFull, 'sessions', flushStamp);

  ensureDir(pDirFull);

  // Determine last-flush timestamp (epoch string ISO)
  let lastFlush = '1970-01-01T00:00:00.000Z';
  if (fs.existsSync(sentinelPath)) {
    lastFlush = fs.readFileSync(sentinelPath, 'utf8').trim();
  }

  // Use an in-memory DuckDB for the flush — avoids file-lock conflicts
  const result = await withDuckdb(':memory:', async (conn) => {
    await duckRun(conn, "INSTALL sqlite; LOAD sqlite;");

    const db_   = duckEsc(dbPath);
    const lf_   = duckEsc(lastFlush);

    // ── edit_events flush ────────────────────────────────────────────────
    const editCountRows = await duckQuery(conn,
      `SELECT COUNT(*) AS cnt FROM sqlite_scan('${db_}', 'edit_events') WHERE timestamp > '${lf_}'`
    );
    const editsFlushed = editCountRows[0]?.cnt || 0;

    if (editsFlushed > 0) {
      const ep_ = duckEsc(editsShard);
      await duckRun(conn,
        `COPY (SELECT * FROM sqlite_scan('${db_}', 'edit_events') WHERE timestamp > '${lf_}')
         TO '${ep_}' (FORMAT PARQUET)`
      );
    }

    // ── sessions flush ───────────────────────────────────────────────────
    const sessCountRows = await duckQuery(conn,
      `SELECT COUNT(*) AS cnt FROM sqlite_scan('${db_}', 'sessions') WHERE started_at > '${lf_}'`
    );
    const sessionsFlushed = sessCountRows[0]?.cnt || 0;

    if (sessionsFlushed > 0) {
      const sp_ = duckEsc(sessShard);
      await duckRun(conn,
        `COPY (SELECT * FROM sqlite_scan('${db_}', 'sessions') WHERE started_at > '${lf_}')
         TO '${sp_}' (FORMAT PARQUET)`
      );
    }

    return { editsFlushed, sessionsFlushed };
  });

  // Update sentinel only after successful flush
  fs.writeFileSync(sentinelPath, new Date().toISOString(), 'utf8');

  return result;
}

/**
 * Query edit frequency for files edited in the last N days.
 *
 * Unions the Parquet archive (history) with the live SQLite table (current)
 * via DuckDB so the result always reflects complete history.
 *
 * @param {string} metricsRoot   Absolute path to metrics directory.
 * @param {string} parquetDir    Subdirectory name for Parquet files.
 * @param {number} days          Lookback window in days.
 * @returns {Promise<Array<{file_path: string, edit_count: number, project: string|null}>>}
 */
async function queryEditFrequency(metricsRoot, parquetDir, days) {
  const cfg  = loadConfig();
  const root = metricsRoot || _metricsRoot || (cfg && cfg.paths && cfg.paths.metrics_root);
  const pDir = parquetDir  || (cfg && cfg.storage && cfg.storage.parquet_dir) || 'parquet';

  if (!root) throw new Error('db.queryEditFrequency: metricsRoot is required');

  const pDirFull     = path.join(root, pDir);
  const editsParquet = path.join(pDirFull, 'edit_events.parquet');
  const editsGlob    = parquetGlobPath(pDirFull, 'edit_events');
  const dbPath       = path.join(root, (cfg && cfg.storage && cfg.storage.db_file) || 'vaultflow.db');
  const lookback     = days || 30;

  // Cutoff timestamp
  const cutoff = new Date(Date.now() - lookback * 24 * 60 * 60 * 1000).toISOString();

  return withDuckdb(':memory:', async (conn) => {
    await duckRun(conn, "INSTALL sqlite; LOAD sqlite;");

    const db_  = duckEsc(dbPath);
    const cut_ = duckEsc(cutoff);

    if (fs.existsSync(editsParquet) || hasParquetArchive(pDirFull, 'edit_events')) {
      const ep_ = duckEsc(editsGlob);
      return duckQuery(conn, `
        SELECT   file_path,
                 project,
                 COUNT(*) AS edit_count
        FROM (
          SELECT file_path, project, timestamp
          FROM   read_parquet('${ep_}')
          WHERE  timestamp >= '${cut_}'

          UNION ALL

          SELECT file_path, project, timestamp
          FROM   sqlite_scan('${db_}', 'edit_events')
          WHERE  timestamp >= '${cut_}'
        ) combined
        GROUP  BY file_path, project
        ORDER  BY edit_count DESC
      `);
    } else {
      return duckQuery(conn, `
        SELECT   file_path,
                 project,
                 COUNT(*) AS edit_count
        FROM     sqlite_scan('${db_}', 'edit_events')
        WHERE    timestamp >= '${cut_}'
        GROUP  BY file_path, project
        ORDER  BY edit_count DESC
      `);
    }
  });
}

/**
 * Full-text search over memory entries using SQLite FTS5 + BM25 ranking.
 *
 * Results are ordered by BM25 score ascending — in SQLite FTS5 bm25() returns
 * negative values where more-negative = better match, so ORDER BY rank is
 * correct (most relevant rows sort first).
 *
 * @param {string} query   FTS5 query string (supports AND, OR, NOT, phrase "...").
 * @param {number} [limit=10]
 * @returns {Array<{id, source, title, body, tags, rank}>}
 */
function searchMemory(query, limit) {
  if (!_db) throw new Error('db.searchMemory: call initialize() first');

  return _db.prepare(`
    SELECT m.id,
           m.source,
           m.title,
           m.body,
           m.tags,
           bm25(memory_fts) AS rank
    FROM   memory_fts f
    JOIN   memory_entries m ON m.id = f.rowid
    WHERE  memory_fts MATCH ?
    ORDER  BY rank
    LIMIT  ?
  `).all(buildExpandedFtsQuery(query), limit || 10);
}

/**
 * Full-text search over patterns using SQLite FTS5 + BM25 ranking.
 *
 * @param {string} query   FTS5 query string.
 * @param {number} [limit=10]
 * @returns {Array<{pattern_key, agent, rank}>}
 */
function searchPatterns(query, limit) {
  if (!_db) throw new Error('db.searchPatterns: call initialize() first');

  return _db.prepare(`
    SELECT pattern_key,
           agent,
           bm25(patterns_fts) AS rank
    FROM   patterns_fts
    WHERE  patterns_fts MATCH ?
    ORDER  BY rank
    LIMIT  ?
  `).all(buildExpandedFtsQuery(query), limit || 10);
}

// ── tool call telemetry ───────────────────────────────────────────────────

function normalizeSearchArgs(limitOrOptions, maybeOptions, defaultLimit) {
  if (typeof limitOrOptions === 'object' && limitOrOptions !== null) {
    return {
      limit: Number(limitOrOptions.limit) || defaultLimit,
      options: limitOrOptions,
    };
  }
  return {
    limit: Number(limitOrOptions) || defaultLimit,
    options: maybeOptions || {},
  };
}

function searchRetrievalDocs(query, limitOrOptions, maybeOptions) {
  if (!_db) throw new Error('db.searchRetrievalDocs: call initialize() first');

  const { limit, options } = normalizeSearchArgs(limitOrOptions, maybeOptions, 10);
  const sourceTypes = Array.isArray(options.sourceTypes) && options.sourceTypes.length > 0
    ? options.sourceTypes
    : null;
  const params = [buildExpandedFtsQuery(query)];
  const filters = ['retrieval_docs_fts MATCH ?'];
  if (sourceTypes) {
    filters.push(`d.source_type IN (${sourceTypes.map(() => '?').join(', ')})`);
    params.push(...sourceTypes);
  }
  params.push(Math.max(limit * 5, 15));

  const rows = _db.prepare(`
    SELECT d.id,
           d.source_type,
           d.source_id,
           d.session_id,
           d.timestamp,
           d.project,
           d.cli,
           d.model,
           d.command_family,
           d.success_state,
           d.title,
           d.body,
           d.metadata_json,
           bm25(retrieval_docs_fts) AS rank
    FROM   retrieval_docs_fts f
    JOIN   retrieval_docs d ON d.id = f.rowid
    WHERE  ${filters.join(' AND ')}
    ORDER  BY rank
    LIMIT  ?
  `).all(...params);

  return rerankRetrievalDocs(rows, query, options).slice(0, limit);
}

/**
 * Record a tool call. Detects duplicates via SHA256(inputJson) within the
 * same session — identical calls return isDuplicate:true without re-inserting.
 *
 * @param {string} sessionId
 * @param {string} toolName    e.g. 'Read', 'Bash', 'Edit'
 * @param {string} inputJson   JSON string of the tool's input parameters
 * @returns {{ isDuplicate: boolean, inputHash: string }}
 */
function recordToolCall(sessionId, toolName, inputJson) {
  if (!_db) throw new Error('db.recordToolCall: call initialize() first');

  // Strip <private>...</private> blocks before any persistence. The hash is
  // computed on the cleaned payload so two calls that differ only in their
  // private content still dedupe correctly.
  inputJson = stripPrivateTags(inputJson);
  const inputHash = sha256(inputJson || '');
  const now       = new Date().toISOString();
  const payload   = safeJsonParse(inputJson, null);

  const info = _db.prepare(`
    INSERT OR IGNORE INTO tool_calls (timestamp, session_id, tool_name, input_hash, input_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(now, sessionId, toolName, inputHash, inputJson || null);

  const row = _db.prepare(`
    SELECT id, timestamp
    FROM   tool_calls
    WHERE  session_id = ? AND tool_name = ? AND input_hash = ?
    LIMIT  1
  `).get(sessionId, toolName, inputHash);
  const meta = getSessionMetadata(sessionId);
  const summary = summarizeToolCall(toolName, payload, inputJson);
  const successState = deriveSuccessState(toolName, payload, meta.errors);
  const rowId = row ? Number(row.id) : null;

  if (rowId != null) {
    upsertRetrievalDoc({
      source_type:    'tool_call',
      source_id:      rowId,
      session_id:     sessionId,
      timestamp:      row?.timestamp || now,
      project:        meta.project || null,
      cli:            meta.cli || null,
      model:          meta.model || null,
      command_family: deriveCommandFamily(toolName, payload),
      success_state:  successState,
      title:          toolName,
      body:           summary,
      search_text:    normalizeSearchText(`${toolName} ${summary}`),
      metadata_json:  JSON.stringify({
        tool_name: toolName,
        raw: typeof inputJson === 'string' ? inputJson.slice(0, 1200) : '',
      }),
    });
  }

  return { isDuplicate: info.changes === 0, inputHash, rowId };
}

/**
 * Return a per-tool call summary for a session. Used to inject context like
 * "Read already called on 6 files this session" before routing.
 *
 * @param {string} sessionId
 * @returns {Array<{tool_name: string, call_count: number, unique_calls: number}>}
 */
function getSessionToolSummary(sessionId) {
  if (!_db) throw new Error('db.getSessionToolSummary: call initialize() first');

  return _db.prepare(`
    SELECT   tool_name,
             COUNT(*)                 AS call_count,
             COUNT(DISTINCT input_hash) AS unique_calls
    FROM     tool_calls
    WHERE    session_id = ?
    GROUP BY tool_name
    ORDER BY call_count DESC
  `).all(sessionId);
}

/**
 * Search tool call history using SQLite FTS5 + BM25 ranking.
 *
 * @param {string} query
 * @param {number} [limit=5]
 * @returns {Array<{id, timestamp, session_id, tool_name, input_json, rank}>}
 */
function searchToolCalls(query, limitOrOptions, maybeOptions) {
  if (!_db) throw new Error('db.searchToolCalls: call initialize() first');

  const { limit, options } = normalizeSearchArgs(limitOrOptions, maybeOptions, 5);
  const docs = searchRetrievalDocs(query, {
    ...options,
    limit,
    sourceTypes: ['tool_call'],
  });

  if (docs.length === 0) return [];
  const ids = docs.map(doc => Number(doc.source_id)).filter(Number.isFinite);
  if (ids.length === 0) return [];

  const rows = _db.prepare(`
    SELECT id, timestamp, session_id, tool_name, input_json
    FROM   tool_calls
    WHERE  id IN (${ids.map(() => '?').join(', ')})
  `).all(...ids);
  const byId = new Map(rows.map(row => [Number(row.id), row]));

  return docs.map((doc) => {
    const row = byId.get(Number(doc.source_id));
    if (!row) return null;
    return {
      ...row,
      project: doc.project,
      cli: doc.cli,
      model: doc.model,
      command_family: doc.command_family,
      success_state: doc.success_state,
      rank: doc.rank,
      rerank_score: doc.rerank_score,
    };
  }).filter(Boolean);
}

// ── prompt history + similarity ───────────────────────────────────────────

/**
 * Record a user prompt for similarity search and routing telemetry.
 *
 * @param {string} sessionId
 * @param {string} promptText
 * @param {{ skillRouted?: string|null, source?: string|null } | string} [opts]
 *        Options object. Legacy form: a bare string is accepted as skillRouted
 *        for back-compat with hook-handler call sites that pass router output
 *        positionally. CLI tags ('copilot','codex',etc.) MUST be passed via
 *        `{ source }` — passing them as the legacy string raises an error so the
 *        skill_routed/source corruption can never recur silently.
 */
function recordPrompt(sessionId, promptText, opts) {
  if (!_db) throw new Error('db.recordPrompt: call initialize() first');

  // Strip <private>...</private> blocks before any persistence — see
  // stripPrivateTags(). Applied first so emptiness checks see the cleaned text.
  promptText = stripPrivateTags(promptText);

  // Empty / whitespace-only prompts come from hooks where input.prompt is
  // missing — recording them produces noise rows with no recoverable text.
  // Drop them silently rather than poisoning the prompts/retrieval tables.
  if (typeof promptText !== 'string' || !promptText.trim()) return;

  let skillRouted = null;
  let source      = null;
  if (typeof opts === 'string') {
    skillRouted = opts;
  } else if (opts && typeof opts === 'object') {
    skillRouted = opts.skillRouted ?? null;
    source      = opts.source ?? null;
  }

  if (skillRouted && KNOWN_CLI_SOURCES.has(skillRouted)) {
    throw new Error(
      `db.recordPrompt: '${skillRouted}' is a CLI source, not a skill name. ` +
      `Pass it as { source: '${skillRouted}' } instead.`
    );
  }

  const meta = getSessionMetadata(sessionId);
  if (!source) source = meta.cli || null;

  const now  = new Date().toISOString();
  const info = _db.prepare(`
    INSERT INTO prompts (timestamp, session_id, prompt_text, skill_routed, source)
    VALUES (?, ?, ?, ?, ?)
  `).run(now, sessionId, promptText, skillRouted, source);

  const promptId = Number(info.lastInsertRowid);
  upsertRetrievalDoc({
    source_type:   'prompt',
    source_id:     promptId,
    session_id:    sessionId,
    timestamp:     now,
    project:       meta.project || null,
    cli:           meta.cli || source || null,
    model:         meta.model || null,
    command_family:'prompt',
    success_state: deriveSuccessState(skillRouted, null, meta.errors),
    title:         buildPromptTitle(source, skillRouted),
    body:          promptText,
    search_text:   normalizeSearchText(promptText, 1600),
    metadata_json: JSON.stringify({ skill_routed: skillRouted || null, source: source || null }),
  });
}

/**
 * Search past prompts for similarity using FTS5 BM25.
 * Useful for surfacing "you asked something similar 3 days ago" context.
 *
 * @param {string} query
 * @param {number} [limit=5]
 * @returns {Array<{id, timestamp, session_id, prompt_text, skill_routed, rank}>}
 */
function searchSimilarPrompts(query, limitOrOptions, maybeOptions) {
  if (!_db) throw new Error('db.searchSimilarPrompts: call initialize() first');

  const { limit, options } = normalizeSearchArgs(limitOrOptions, maybeOptions, 5);
  const docs = searchRetrievalDocs(query, {
    ...options,
    limit,
    sourceTypes: ['prompt'],
  });

  if (docs.length === 0) return [];
  const ids = docs.map(doc => Number(doc.source_id)).filter(Number.isFinite);
  if (ids.length === 0) return [];

  const rows = _db.prepare(`
    SELECT id, timestamp, session_id, prompt_text, skill_routed, source
    FROM   prompts
    WHERE  id IN (${ids.map(() => '?').join(', ')})
  `).all(...ids);
  const byId = new Map(rows.map(row => [Number(row.id), row]));

  return docs.map((doc) => {
    const row = byId.get(Number(doc.source_id));
    if (!row) return null;
    return {
      ...row,
      project: doc.project,
      cli: doc.cli,
      model: doc.model,
      rank: doc.rank,
      rerank_score: doc.rerank_score,
    };
  }).filter(Boolean);
}

// ── tech stack detection ──────────────────────────────────────────────────

/**
 * Record a detected stack for a project.
 *
 * @param {string} project    Project name or path segment
 * @param {string} stackKey   e.g. 'node', 'react', 'dotnet', 'python'
 * @param {number} [confidence=1.0]
 */
function upsertProjectStack(project, stackKey, confidence) {
  if (!_db) throw new Error('db.upsertProjectStack: call initialize() first');

  _db.prepare(`
    INSERT INTO project_stacks (project, stack_key, detected_at, confidence)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project, stack_key) DO UPDATE SET
      detected_at = excluded.detected_at,
      confidence  = excluded.confidence
  `).run(project, stackKey, new Date().toISOString(), confidence != null ? confidence : 1.0);
}

/**
 * Return all detected stacks for a project, sorted by confidence.
 *
 * @param {string} project
 * @returns {Array<{stack_key: string, detected_at: string, confidence: number}>}
 */
function getProjectStacks(project) {
  if (!_db) throw new Error('db.getProjectStacks: call initialize() first');

  return _db.prepare(`
    SELECT stack_key, detected_at, confidence
    FROM   project_stacks
    WHERE  project = ?
    ORDER  BY confidence DESC, detected_at DESC
  `).all(project);
}

// ── dictionary ────────────────────────────────────────────────────────────

/**
 * Insert or update a dictionary entry.
 *
 * @param {string} term
 * @param {string} [category='domain']  One of: domain, acronym, api, schema,
 *                                      command, config, error, stack, pattern
 * @param {string} definition
 * @param {string} [source]    Where this term was learned from
 * @param {string} [tags]      Space-separated tags
 */
function upsertDictionaryEntry(term, category, definition, source, tags) {
  if (!_db) throw new Error('db.upsertDictionaryEntry: call initialize() first');

  _db.prepare(`
    INSERT INTO dictionary (term, category, definition, source, tags)
    VALUES (@term, @category, @definition, @source, @tags)
    ON CONFLICT(term, category) DO UPDATE SET
      definition = excluded.definition,
      source     = excluded.source,
      tags       = excluded.tags
  `).run({
    term,
    category:   category   || 'domain',
    definition,
    source:     source     || null,
    tags:       tags       || '',
  });
}

/**
 * Full-text search over dictionary terms using FTS5 BM25.
 *
 * @param {string} query
 * @param {number} [limit=10]
 * @returns {Array<{id, term, category, definition, source, tags, rank}>}
 */
function searchDictionary(query, limit) {
  if (!_db) throw new Error('db.searchDictionary: call initialize() first');

  return _db.prepare(`
    SELECT d.id,
           d.term,
           d.category,
           d.definition,
           d.source,
           d.tags,
           bm25(dictionary_fts) AS rank
    FROM   dictionary_fts f
    JOIN   dictionary d ON d.id = f.rowid
    WHERE  dictionary_fts MATCH ?
    ORDER  BY rank
    LIMIT  ?
  `).all(buildExpandedFtsQuery(query), limit || 10);
}

/**
 * Find dictionary terms that appear verbatim in the given text.
 * Used to inject relevant definitions before routing a prompt.
 *
 * @param {string} text
 * @returns {Array<{term, category, definition}>}
 */
function getTermMatches(text) {
  if (!_db) throw new Error('db.getTermMatches: call initialize() first');

  const lower = (text || '').toLowerCase();
  const terms = _db.prepare('SELECT term, category, definition FROM dictionary').all();
  return terms.filter(t => lower.includes(t.term.toLowerCase()));
}

// ── vault tool registry ───────────────────────────────────────────────────

/**
 * Register or update a vault tool.
 *
 * @param {string} toolId    Canonical ID (e.g. 'retry-pattern', 'excel-parser')
 * @param {string} name      Human-readable name
 * @param {string} [description]
 * @param {string} [toolPath]   Path to the tool file
 * @param {string} [tags]    Space-separated tags
 */
function upsertVaultTool(toolId, name, description, toolPath, tags) {
  if (!_db) throw new Error('db.upsertVaultTool: call initialize() first');

  _db.prepare(`
    INSERT INTO vault_tools (tool_id, name, description, path, tags)
    VALUES (@tool_id, @name, @description, @path, @tags)
    ON CONFLICT(tool_id) DO UPDATE SET
      name        = excluded.name,
      description = excluded.description,
      path        = excluded.path,
      tags        = excluded.tags
  `).run({
    tool_id:     toolId,
    name,
    description: description || '',
    path:        toolPath    || '',
    tags:        tags        || '',
  });
}

/**
 * Increment use_count and update last_used for a vault tool.
 *
 * @param {string} toolId
 */
function incrementVaultToolUse(toolId) {
  if (!_db) throw new Error('db.incrementVaultToolUse: call initialize() first');

  _db.prepare(`
    UPDATE vault_tools
    SET    use_count = use_count + 1,
           last_used = ?
    WHERE  tool_id = ?
  `).run(new Date().toISOString(), toolId);
}

/**
 * Full-text search over vault tools using FTS5 BM25.
 *
 * @param {string} query
 * @param {number} [limit=10]
 * @returns {Array<{id, tool_id, name, description, path, use_count, tags, rank}>}
 */
function searchVaultTools(query, limit) {
  if (!_db) throw new Error('db.searchVaultTools: call initialize() first');

  return _db.prepare(`
    SELECT t.id,
           t.tool_id,
           t.name,
           t.description,
           t.path,
           t.use_count,
           t.tags,
           bm25(vault_tools_fts) AS rank
    FROM   vault_tools_fts f
    JOIN   vault_tools t ON t.id = f.rowid
    WHERE  vault_tools_fts MATCH ?
    ORDER  BY rank
    LIMIT  ?
  `).all(buildExpandedFtsQuery(query), limit || 10);
}

// ── agent registry ────────────────────────────────────────────────────────

/**
 * Register or update an agent (Claude skill or Codex .agents/ skill).
 *
 * @param {string} agentId         Canonical ID (e.g. 'developer-backend')
 * @param {string} name
 * @param {string} [source='claude']  'claude' | 'codex'
 * @param {string} [description]
 * @param {string} [triggerPattern]   Keyword/glob that auto-activates this agent
 */
function upsertVaultAgent(agentId, name, source, description, triggerPattern) {
  if (!_db) throw new Error('db.upsertVaultAgent: call initialize() first');

  _db.prepare(`
    INSERT INTO vault_agents (agent_id, name, source, description, trigger_pattern)
    VALUES (@agent_id, @name, @source, @description, @trigger_pattern)
    ON CONFLICT(agent_id) DO UPDATE SET
      name            = excluded.name,
      source          = excluded.source,
      description     = excluded.description,
      trigger_pattern = excluded.trigger_pattern
  `).run({
    agent_id:        agentId,
    name,
    source:          source          || 'claude',
    description:     description     || '',
    trigger_pattern: triggerPattern  || null,
  });
}

/**
 * Increment use_count and update last_used for a registered agent.
 *
 * @param {string} agentId
 */
function incrementAgentUse(agentIdOrName) {
  if (!_db) throw new Error('db.incrementAgentUse: call initialize() first');
  if (!agentIdOrName) return;

  // Match agent_id (exact) OR name (so bare subagent_type like 'developer-backend'
  // from the Task tool credits the right row regardless of project prefix).
  const now = new Date().toISOString();
  _db.prepare(`
    UPDATE vault_agents
    SET    use_count = use_count + 1,
           last_used = ?
    WHERE  agent_id = ? OR name = ?
  `).run(now, agentIdOrName, agentIdOrName);
}

// ── agent verdicts ────────────────────────────────────────────────────────

/**
 * Record an agent verdict (pass / fail / warn / skip / etc.).
 *
 * @param {string|null} sessionId   Active session ID (may be null for background agents).
 * @param {string}      agentType   Agent identifier, e.g. 'developer-backend'.
 * @param {string}      verdict     Short outcome label, e.g. 'pass', 'fail', 'warn'.
 * @param {string}      [reason]    Human-readable explanation (max 500 chars).
 * @param {string|null} [flaggedAt] ISO timestamp if the verdict was flagged for review.
 */
function recordVerdict(sessionId, agentType, verdict, reason, flaggedAt) {
  if (!_db) throw new Error('db.recordVerdict: call initialize() first');
  _db.prepare(
    `INSERT INTO agent_verdicts (timestamp, session_id, agent_type, verdict, reason, flagged_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    new Date().toISOString(),
    sessionId  || null,
    String(agentType  || '').slice(0, 100),
    String(verdict    || '').slice(0, 50),
    String(reason     || '').slice(0, 500),
    flaggedAt  || null
  );
}

/**
 * Aggregate verdict counts grouped by agent_type and verdict over the last N days.
 *
 * @param {number} [days=30]  Lookback window in days.
 * @returns {Array<{agent_type: string, verdict: string, count: number}>}
 */
function getVerdictSummary(days) {
  if (!_db) throw new Error('db.getVerdictSummary: call initialize() first');
  const d = Number(days) || 30;
  return _db.prepare(
    `SELECT agent_type, verdict, COUNT(*) AS count
     FROM   agent_verdicts
     WHERE  timestamp > datetime('now', '-' || ? || ' days')
     GROUP  BY agent_type, verdict
     ORDER  BY agent_type, verdict`
  ).all(String(d));
}

// ── session-end helpers ───────────────────────────────────────────────────

/**
 * Return vault tools that have reached the promotion threshold.
 *
 * @param {number} [threshold=5]
 * @returns {Array<{id, name, description, use_count}>}
 */
function getUnpromotedVaultTools(threshold) {
  if (!_db) throw new Error('db.getUnpromotedVaultTools: call initialize() first');
  return _db.prepare(
    'SELECT id, name, description, use_count FROM vault_tools WHERE use_count >= ? AND (promoted IS NULL OR promoted = 0)'
  ).all(threshold != null ? threshold : 5);
}

/**
 * Mark a single vault tool as promoted.
 *
 * @param {number} id  Integer PK of the vault_tools row
 */
function promoteVaultTool(id) {
  if (!_db) throw new Error('db.promoteVaultTool: call initialize() first');
  _db.prepare('UPDATE vault_tools SET promoted = 1 WHERE id = ?').run(id);
}

/**
 * Return prompt_text for all prompts belonging to the most recent session.
 * Used by session-end term-frequency auto-add.
 *
 * @returns {Array<{prompt_text: string}>}
 */
function getLastSessionPrompts() {
  if (!_db) throw new Error('db.getLastSessionPrompts: call initialize() first');
  return _db.prepare(
    'SELECT prompt_text, source FROM prompts WHERE session_id IN (SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1)'
  ).all();
}

/**
 * Return all lowercase dictionary terms.
 * Used by session-end to avoid re-adding known terms.
 *
 * @returns {Set<string>}
 */
function getDictionaryTermSet() {
  if (!_db) throw new Error('db.getDictionaryTermSet: call initialize() first');
  const rows = _db.prepare('SELECT LOWER(term) AS t FROM dictionary').all();
  return new Set(rows.map(r => r.t));
}

/**
 * Record retrieval-loop feedback so ranking can be tuned from real outcomes.
 *
 * @param {object} event
 */
function recordRetrievalFeedback(event) {
  if (!_db) throw new Error('db.recordRetrievalFeedback: call initialize() first');

  _db.prepare(`
    INSERT INTO retrieval_feedback
      (batch_id, timestamp, session_id, query_text, source_type, source_id, project, cli, model,
       command_family, success_state, action, rank, rerank_score, useful, metadata_json)
    VALUES
      (@batch_id, @timestamp, @session_id, @query_text, @source_type, @source_id, @project, @cli, @model,
       @command_family, @success_state, @action, @rank, @rerank_score, @useful, @metadata_json)
  `).run({
    batch_id:       event.batch_id || null,
    timestamp:      event.timestamp || new Date().toISOString(),
    session_id:     event.session_id || null,
    query_text:     event.query_text || null,
    source_type:    event.source_type || null,
    source_id:      event.source_id != null ? String(event.source_id) : null,
    project:        event.project || null,
    cli:            event.cli || null,
    model:          event.model || null,
    command_family: event.command_family || null,
    success_state:  event.success_state || null,
    action:         event.action || 'candidate',
    rank:           event.rank != null ? event.rank : null,
    rerank_score:   event.rerank_score != null ? event.rerank_score : null,
    useful:         event.useful != null ? event.useful : null,
    metadata_json:  event.metadata_json || '{}',
  });
}

/**
 * Analyze retrieval feedback and promote stable retrieval patterns back into
 * the main patterns table so future runs can benefit from successful shapes.
 *
 * @returns {{
 *   batchesReviewed: number,
 *   strategiesReviewed: number,
 *   promotedPatterns: string[],
 *   topStrategies: Array<object>,
 *   topFailures: Array<object>
 * }}
 */
function runRetrievalLearningLoop() {
  if (!_db) throw new Error('db.runRetrievalLearningLoop: call initialize() first');

  const batchesReviewed = (_db.prepare(`
    SELECT COUNT(DISTINCT batch_id) AS cnt
    FROM   retrieval_feedback
    WHERE  batch_id IS NOT NULL
  `).get() || { cnt: 0 }).cnt || 0;

  const topStrategies = _db.prepare(`
    SELECT rf.project,
           COALESCE(rf.cli, 'unknown') AS cli,
           COALESCE(rf.source_type, 'unknown') AS source_type,
           COALESCE(rf.command_family, 'general') AS command_family,
           COUNT(*) AS sample_count,
           SUM(CASE WHEN outcome.action = 'run_success' THEN 1 ELSE 0 END) AS success_count
    FROM   retrieval_feedback rf
    JOIN   retrieval_feedback outcome
           ON outcome.batch_id = rf.batch_id
          AND outcome.source_type = 'batch'
          AND outcome.action IN ('run_success', 'run_failure')
    WHERE  rf.action = 'injected'
    GROUP  BY rf.project,
              COALESCE(rf.cli, 'unknown'),
              COALESCE(rf.source_type, 'unknown'),
              COALESCE(rf.command_family, 'general')
    ORDER  BY success_count DESC, sample_count DESC, rf.project ASC
    LIMIT  12
  `).all().map((row) => {
    const sampleCount = Number(row.sample_count) || 0;
    const successCount = Number(row.success_count) || 0;
    return {
      project: row.project || 'unknown',
      cli: row.cli || 'unknown',
      source_type: row.source_type || 'unknown',
      command_family: row.command_family || 'general',
      sample_count: sampleCount,
      success_count: successCount,
      success_rate: sampleCount > 0 ? Number((successCount / sampleCount).toFixed(3)) : 0,
    };
  });

  const promotedPatterns = [];
  for (const strategy of topStrategies) {
    if (strategy.sample_count < 2 || strategy.success_rate < 0.6) continue;
    const patternKey = [
      'retrieval',
      strategy.project || 'unknown',
      strategy.cli || 'unknown',
      strategy.source_type || 'unknown',
      strategy.command_family || 'general',
      'success',
    ].join(':');
    upsertPattern(patternKey, 'retrieval-learning');
    promotedPatterns.push(patternKey);
  }

  const topFailures = _db.prepare(`
    SELECT project,
           COALESCE(cli, 'unknown') AS cli,
           query_text,
           COUNT(*) AS failure_count
    FROM   retrieval_feedback
    WHERE  action = 'run_failure'
      AND  query_text IS NOT NULL
      AND  TRIM(query_text) != ''
    GROUP  BY project, cli, query_text
    ORDER  BY failure_count DESC, project ASC
    LIMIT  5
  `).all().map((row) => ({
    project: row.project || 'unknown',
    cli: row.cli || 'unknown',
    query_text: row.query_text,
    failure_count: Number(row.failure_count) || 0,
  }));

  return {
    batchesReviewed: Number(batchesReviewed) || 0,
    strategiesReviewed: topStrategies.length,
    promotedPatterns,
    topStrategies,
    topFailures,
  };
}

// ── telemetry flush ───────────────────────────────────────────────────────

/**
 * Flush tool_calls and prompts tables to Parquet.
 * Mirrors flushToParquet() but for the telemetry tables.
 *
 * @param {string} [metricsRoot]
 * @param {string} [parquetDir]
 * @returns {Promise<{toolCallsFlushed: number, promptsFlushed: number, retrievalFeedbackFlushed: number}>}
 */
async function flushTelemetryToParquet(metricsRoot, parquetDir) {
  const cfg  = loadConfig();
  const root = metricsRoot || _metricsRoot || (cfg && cfg.paths && cfg.paths.metrics_root);
  const pDir = parquetDir  || (cfg && cfg.storage && cfg.storage.parquet_dir) || 'parquet';

  if (!root) throw new Error('db.flushTelemetryToParquet: metricsRoot is required');

  const pDirFull        = path.join(root, pDir);
  const sentinelPath    = path.join(root, '.last-telemetry-flush');
  const dbPath          = path.join(root, (cfg && cfg.storage && cfg.storage.db_file) || 'vaultflow.db');
  const toolsParquet    = path.join(pDirFull, (cfg && cfg.storage && cfg.storage.tool_calls_parquet) || 'tool_calls.parquet');
  const promptsParquet  = path.join(pDirFull, (cfg && cfg.storage && cfg.storage.prompts_parquet) || 'prompts.parquet');
  const retrievalParquet = path.join(pDirFull, (cfg && cfg.storage && cfg.storage.retrieval_feedback_parquet) || 'retrieval_feedback.parquet');
  const flushStamp      = parquetShardSuffix();
  const toolsShard      = parquetShardPath(pDirFull, 'tool_calls', flushStamp);
  const promptsShard    = parquetShardPath(pDirFull, 'prompts', flushStamp);
  const retrievalShard  = parquetShardPath(pDirFull, 'retrieval_feedback', flushStamp);

  ensureDir(pDirFull);

  let lastFlush = '1970-01-01T00:00:00.000Z';
  if (fs.existsSync(sentinelPath)) {
    lastFlush = fs.readFileSync(sentinelPath, 'utf8').trim();
  }

  const result = await withDuckdb(':memory:', async (conn) => {
    await duckRun(conn, "INSTALL sqlite; LOAD sqlite;");

    const db_  = duckEsc(dbPath);
    const lf_  = duckEsc(lastFlush);

    // ── tool_calls ───────────────────────────────────────────────────────
    const tcCount = await duckQuery(conn,
      `SELECT COUNT(*) AS cnt FROM sqlite_scan('${db_}', 'tool_calls') WHERE timestamp > '${lf_}'`
    );
    const toolCallsFlushed = tcCount[0]?.cnt || 0;

    if (toolCallsFlushed > 0) {
      const tp_ = duckEsc(toolsShard);
      await duckRun(conn,
        `COPY (SELECT * FROM sqlite_scan('${db_}', 'tool_calls') WHERE timestamp > '${lf_}')
         TO '${tp_}' (FORMAT PARQUET)`
      );
    }

    // ── prompts ──────────────────────────────────────────────────────────
    const prCount = await duckQuery(conn,
      `SELECT COUNT(*) AS cnt FROM sqlite_scan('${db_}', 'prompts') WHERE timestamp > '${lf_}'`
    );
    const promptsFlushed = prCount[0]?.cnt || 0;

    if (promptsFlushed > 0) {
      const pp_ = duckEsc(promptsShard);
      await duckRun(conn,
        `COPY (SELECT * FROM sqlite_scan('${db_}', 'prompts') WHERE timestamp > '${lf_}')
         TO '${pp_}' (FORMAT PARQUET)`
      );
    }

    const rfCount = await duckQuery(conn,
      `SELECT COUNT(*) AS cnt FROM sqlite_scan('${db_}', 'retrieval_feedback') WHERE timestamp > '${lf_}'`
    );
    const retrievalFeedbackFlushed = rfCount[0]?.cnt || 0;

    if (retrievalFeedbackFlushed > 0) {
      const rp_ = duckEsc(retrievalShard);
      await duckRun(conn,
        `COPY (SELECT * FROM sqlite_scan('${db_}', 'retrieval_feedback') WHERE timestamp > '${lf_}')
         TO '${rp_}' (FORMAT PARQUET)`
      );
    }

    if (retrievalFeedbackFlushed > 0 && !fs.existsSync(retrievalParquet)) {
      fs.copyFileSync(retrievalShard, retrievalParquet);
    }

    return { toolCallsFlushed, promptsFlushed, retrievalFeedbackFlushed };
  });

  fs.writeFileSync(sentinelPath, new Date().toISOString(), 'utf8');
  return result;
}

// ── model performance + routing ──────────────────────────────────────────

/**
 * Record a model verdict (approved or rejected) for an agent/model/taskType triple.
 *
 * Uses INSERT OR IGNORE + UPDATE so the row is always present before incrementing.
 *
 * @param {string} agent
 * @param {string} model
 * @param {string} taskType
 * @param {boolean} approved
 */
function recordModelVerdict(agent, model, taskType, approved) {
  if (!_db) throw new Error('db.recordModelVerdict: call initialize() first');

  const type = taskType || 'general';

  _db.prepare(`
    INSERT OR IGNORE INTO model_performance (agent, model, task_type, verdicts_total, verdicts_approved, current)
    VALUES (?, ?, ?, 0, 0, 1)
  `).run(agent, model, type);

  _db.prepare(`
    UPDATE model_performance
    SET verdicts_total    = verdicts_total + 1,
        verdicts_approved = verdicts_approved + ?
    WHERE agent = ? AND model = ? AND task_type = ?
  `).run(approved ? 1 : 0, agent, model, type);
}

/**
 * Record one completed session/task for an agent/model/taskType triple.
 *
 * @param {string} agent
 * @param {string} model
 * @param {string} taskType
 */
function recordModelSession(agent, model, taskType) {
  if (!_db) throw new Error('db.recordModelSession: call initialize() first');

  const type = taskType || 'general';

  _db.prepare(`
    INSERT OR IGNORE INTO model_performance (agent, model, task_type, verdicts_total, verdicts_approved, sessions_on_model, current)
    VALUES (?, ?, ?, 0, 0, 0, 1)
  `).run(agent, model, type);

  _db.prepare(`
    UPDATE model_performance
    SET sessions_on_model = sessions_on_model + 1
    WHERE agent = ? AND model = ? AND task_type = ?
  `).run(agent, model, type);
}

/**
 * Return all performance rows for an agent, ordered by current DESC then sessions DESC.
 *
 * @param {string} agent
 * @returns {Array<{agent, model, task_type, verdicts_total, verdicts_approved, sessions_on_model, promoted_at, demoted_at, current}>}
 */
function getModelPerformance(agent) {
  if (!_db) throw new Error('db.getModelPerformance: call initialize() first');

  return _db.prepare(`
    SELECT agent, model, task_type, verdicts_total, verdicts_approved,
           sessions_on_model, promoted_at, demoted_at, current
    FROM   model_performance
    WHERE  agent = ?
    ORDER  BY current DESC, sessions_on_model DESC
  `).all(agent);
}

/**
 * Insert or replace a model_performance row, merging provided fields with defaults.
 *
 * @param {string} agent
 * @param {string} model
 * @param {object} fields  Optional: sessions_on_model, promoted_at, demoted_at, current
 */
function upsertModelPerformance(agent, model, fields) {
  if (!_db) throw new Error('db.upsertModelPerformance: call initialize() first');

  const f        = fields || {};
  const taskType = f.task_type || 'general';

  // Read existing row to preserve verdict counts on a replace
  const existing = _db.prepare(`
    SELECT * FROM model_performance WHERE agent = ? AND model = ? AND task_type = ?
  `).get(agent, model, taskType);

  _db.prepare(`
    INSERT OR REPLACE INTO model_performance
      (agent, model, task_type, verdicts_total, verdicts_approved,
       sessions_on_model, promoted_at, demoted_at, current)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    agent,
    model,
    taskType,
    f.verdicts_total    != null ? f.verdicts_total    : (existing ? existing.verdicts_total    : 0),
    f.verdicts_approved != null ? f.verdicts_approved : (existing ? existing.verdicts_approved : 0),
    f.sessions_on_model != null ? f.sessions_on_model : (existing ? existing.sessions_on_model : 0),
    f.promoted_at       != null ? f.promoted_at       : (existing ? existing.promoted_at       : null),
    f.demoted_at        != null ? f.demoted_at        : (existing ? existing.demoted_at        : null),
    f.current           != null ? f.current           : (existing ? existing.current           : 1)
  );
}

// ── session compaction ────────────────────────────────────────────────────

/**
 * Write (or replace) a session summary row.
 *
 * @param {object} obj
 * @param {string}   obj.session_id
 * @param {string}   obj.project
 * @param {number}   obj.duration_ms
 * @param {string[]} obj.top_files    Serialized to JSON before storing.
 * @param {string[]} obj.patterns     Serialized to JSON before storing.
 * @param {string}   obj.summary_at   ISO timestamp.
 */
function writeSessionSummary(obj) {
  if (!_db) throw new Error('db.writeSessionSummary: call initialize() first');

  const topFiles = Array.isArray(obj.top_files) ? obj.top_files : [];
  const patterns = Array.isArray(obj.patterns) ? obj.patterns : [];

  _db.prepare(`
    INSERT OR REPLACE INTO session_summaries
      (session_id, project, duration_ms, top_files, patterns, summary_at)
    VALUES
      (@session_id, @project, @duration_ms, @top_files, @patterns, @summary_at)
  `).run({
    session_id:  obj.session_id,
    project:     obj.project     || null,
    duration_ms: obj.duration_ms || 0,
    top_files:   JSON.stringify(topFiles),
    patterns:    JSON.stringify(patterns),
    summary_at:  obj.summary_at  || new Date().toISOString(),
  });

  const meta = getSessionMetadata(obj.session_id);
  const body = buildSessionSummaryBody({
    ...obj,
    project: obj.project || meta.project || null,
    top_files: topFiles,
    patterns,
  });
  upsertRetrievalDoc({
    source_type:   'session_summary',
    source_id:     obj.session_id,
    session_id:    obj.session_id,
    timestamp:     obj.summary_at || new Date().toISOString(),
    project:       obj.project || meta.project || null,
    cli:           meta.cli || null,
    model:         meta.model || null,
    command_family:'summary',
    success_state: deriveSuccessState('session_summary', null, meta.errors),
    title:         `Session summary ${obj.project || meta.project || 'unknown'}`,
    body,
    search_text:   normalizeSearchText(body, 2000),
    metadata_json: JSON.stringify({
      top_files: topFiles,
      patterns,
      duration_ms: obj.duration_ms || 0,
    }),
  });
}

/**
 * Return the most recent session summary for the given project, or null if none.
 * Arrays (top_files, patterns) are parsed from JSON before returning.
 *
 * @param {string} project
 * @returns {object|null}
 */
function getLatestSessionSummary(project) {
  if (!_db) throw new Error('db.getLatestSessionSummary: call initialize() first');

  const row = _db.prepare(`
    SELECT *
    FROM   session_summaries
    WHERE  project = ?
    ORDER  BY summary_at DESC
    LIMIT  1
  `).get(project);

  if (!row) return null;

  try { row.top_files = JSON.parse(row.top_files); } catch (_) { row.top_files = []; }
  try { row.patterns  = JSON.parse(row.patterns);  } catch (_) { row.patterns  = []; }
  return row;
}

/**
 * Get the N most recent session summaries for a project. Used by SessionStart
 * hook to inject prior-session context into the new conversation so Claude
 * starts with awareness of what was edited / which patterns fired before.
 *
 * Empty summaries (no top_files AND no patterns) are filtered out — they add
 * no signal and only burn injected-context tokens.
 */
function getRecentSessionSummaries(project, limit = 3) {
  if (!_db) throw new Error('db.getRecentSessionSummaries: call initialize() first');
  if (!project) return [];

  const rows = _db.prepare(`
    SELECT session_id, project, duration_ms, top_files, patterns, summary_at
    FROM   session_summaries
    WHERE  project = ?
    ORDER  BY summary_at DESC
    LIMIT  ?
  `).all(project, limit * 2); // pull double then filter empties

  const out = [];
  for (const row of rows) {
    let topFiles = [];
    let patterns = [];
    try { topFiles = JSON.parse(row.top_files) || []; } catch (_) {}
    try { patterns = JSON.parse(row.patterns)  || []; } catch (_) {}
    if (!topFiles.length && !patterns.length) continue; // skip empties
    out.push({ ...row, top_files: topFiles, patterns: patterns });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Search session summaries using SQLite FTS5 + BM25 ranking.
 *
 * @param {string} query
 * @param {number} [limit=5]
 * @returns {Array<{session_id, project, duration_ms, top_files, patterns, summary_at, rank}>}
 */
function searchSessionSummaries(query, limitOrOptions, maybeOptions) {
  if (!_db) throw new Error('db.searchSessionSummaries: call initialize() first');

  const { limit, options } = normalizeSearchArgs(limitOrOptions, maybeOptions, 5);
  const docs = searchRetrievalDocs(query, {
    ...options,
    limit,
    sourceTypes: ['session_summary'],
  });

  if (docs.length === 0) return [];
  const sessionIds = docs.map(doc => String(doc.source_id));
  const rows = _db.prepare(`
    SELECT session_id, project, duration_ms, top_files, patterns, summary_at
    FROM   session_summaries
    WHERE  session_id IN (${sessionIds.map(() => '?').join(', ')})
  `).all(...sessionIds);
  const byId = new Map(rows.map(row => [String(row.session_id), row]));

  return docs.map((doc) => {
    const row = byId.get(String(doc.source_id));
    if (!row) return null;
    return {
      ...row,
      top_files: safeJsonParse(row.top_files, []),
      patterns: safeJsonParse(row.patterns, []),
      cli: doc.cli,
      model: doc.model,
      rank: doc.rank,
      rerank_score: doc.rerank_score,
    };
  }).filter(Boolean);
}

/**
 * Close the SQLite connection.
 * Safe to call even if initialize() was never called.
 */
function close() {
  if (_db) {
    _db.close();
    _db          = null;
    _metricsRoot = null;
  }
}

// ── exports ───────────────────────────────────────────────────────────────
function raw() { return _db; }

module.exports = {
  // core
  initialize,
  close,
  raw,
  // edit + session telemetry
  recordEdit,
  upsertSession,
  // patterns + DISCOVERY pipeline
  upsertPattern,
  getPendingPromotions,
  markPromoted,
  // memory
  upsertMemoryEntry,
  replaceMemorySource,
  searchMemory,
  searchMemoryBacklinks,
  getMemoryLinkGraph,
  detectStaleMemory,
  getStaleMemory,
  detectStaleVaultTools,
  getStaleVaultTools,
  // pattern FTS
  searchPatterns,
  // tool call deduplication
  recordToolCall,
  getSessionToolSummary,
  searchRetrievalDocs,
  searchToolCalls,
  recordRetrievalFeedback,
  runRetrievalLearningLoop,
  // prompt history + similarity
  recordPrompt,
  searchSimilarPrompts,
  // tech stack detection
  upsertProjectStack,
  getProjectStacks,
  // dictionary
  upsertDictionaryEntry,
  searchDictionary,
  getTermMatches,
  // vault tool registry
  upsertVaultTool,
  incrementVaultToolUse,
  searchVaultTools,
  // agent registry
  upsertVaultAgent,
  incrementAgentUse,
  // agent verdicts
  recordVerdict,
  getVerdictSummary,
  // model routing
  recordModelVerdict,
  recordModelSession,
  getModelPerformance,
  upsertModelPerformance,
  // session-end helpers
  getUnpromotedVaultTools,
  promoteVaultTool,
  getLastSessionPrompts,
  getDictionaryTermSet,
  // session compaction
  writeSessionSummary,
  getLatestSessionSummary,
  getRecentSessionSummaries,
  searchSessionSummaries,
  backfillMissingSessionSummaries,
  // Parquet archival
  flushToParquet,
  flushTelemetryToParquet,
  queryEditFrequency,
  closeStaleSessions,
  recomputeSessionAggregates,
  recomputeAllSessionAggregates,
  normalizeModelName,
};

/**
 * Close stale sessions that started > `cutoffHours` ago and never received an
 * SessionEnd hook. The fix uses the timestamp of the last tool_call/edit_event
 * tied to the session as `ended_at` (best-available signal). Sessions with no
 * activity at all are closed at `started_at + 1 ms` so duration is >= 0.
 *
 * Idempotent — only touches rows where ended_at IS NULL.
 *
 * @param {number} [cutoffHours=12] Minimum age before a session is considered orphaned.
 * @returns {{ closed: number, examined: number }}
 */
function closeStaleSessions(cutoffHours = 12) {
  if (!_db) throw new Error('db.closeStaleSessions: call initialize() first');

  const cutoff = new Date(Date.now() - cutoffHours * 3600 * 1000).toISOString();

  // For each candidate, compute MAX(timestamp) across tool_calls + edit_events.
  // If neither table has any rows for the session, fall back to started_at.
  const candidates = _db.prepare(`
    SELECT id, started_at FROM sessions
    WHERE (ended_at IS NULL OR ended_at = '')
      AND started_at < ?
  `).all(cutoff);

  if (!candidates.length) return { closed: 0, examined: 0 };

  const lastActivity = _db.prepare(`
    SELECT MAX(t) AS last FROM (
      SELECT MAX(timestamp) AS t FROM tool_calls   WHERE session_id = ?
      UNION ALL
      SELECT MAX(timestamp) AS t FROM edit_events  WHERE session_id = ?
      UNION ALL
      SELECT MAX(timestamp) AS t FROM prompts      WHERE session_id = ?
    )
  `);

  const update = _db.prepare(`
    UPDATE sessions
       SET ended_at    = @ended_at,
           duration_ms = @duration_ms
     WHERE id          = @id
  `);

  let closed = 0;
  for (const c of candidates) {
    const row = lastActivity.get(c.id, c.id, c.id);
    const endedAt = row && row.last
      ? row.last
      : new Date(new Date(c.started_at).getTime() + 1).toISOString();
    const startMs = new Date(c.started_at).getTime();
    const endMs   = new Date(endedAt).getTime();
    const duration = Number.isFinite(startMs) && Number.isFinite(endMs)
      ? Math.max(0, endMs - startMs)
      : 0;
    update.run({ id: c.id, ended_at: endedAt, duration_ms: duration });
    recomputeSessionAggregates(c.id);
    closed++;
  }

  return { closed, examined: candidates.length };
}

/**
 * Derive per-session aggregate counters from the event tables and write them
 * back to the sessions row. Until this exists nothing ever incremented
 * sessions.edits / sessions.commands, so the dashboard's session list showed
 * empty cells for everything except the rare row where session.cjs.end()
 * happened to fire.
 *
 *   edits    ← COUNT(edit_events.session_id = ?)
 *   commands ← COUNT(tool_calls.tool_name = 'Bash' for this session)
 *
 * Skips errors (no source signal) and tasks (no convention yet). Also
 * backfills duration_ms when ended_at exists but duration_ms is null.
 *
 * @param {string} sessionId
 */
function recomputeSessionAggregates(sessionId) {
  if (!_db) throw new Error('db.recomputeSessionAggregates: call initialize() first');
  if (!sessionId) return;

  const editsRow = _db.prepare(
    'SELECT COUNT(*) AS n FROM edit_events WHERE session_id = ?'
  ).get(sessionId);

  // "commands" historically meant shell invocations. Bash is the only built-in
  // shell tool; Copilot's powershell:* events also count. Match both.
  const cmdRow = _db.prepare(`
    SELECT COUNT(*) AS n FROM tool_calls
    WHERE session_id = ?
      AND (tool_name = 'Bash'
           OR tool_name = 'PowerShell'
           OR tool_name LIKE 'Copilot:powershell:%'
           OR tool_name LIKE 'Copilot:bash:%')
  `).get(sessionId);

  // Backfill duration_ms when ended_at is present but duration is null/0.
  _db.prepare(`
    UPDATE sessions
       SET edits    = @edits,
           commands = @commands,
           duration_ms = CASE
             WHEN duration_ms IS NULL OR duration_ms = 0
             THEN CAST((julianday(ended_at) - julianday(started_at)) * 86400000 AS INTEGER)
             ELSE duration_ms
           END
     WHERE id = @id
  `).run({
    id: sessionId,
    edits: editsRow ? editsRow.n : 0,
    commands: cmdRow ? cmdRow.n : 0,
  });
}

/**
 * One-shot backfill across every session in the table. Safe to re-run.
 *
 * @returns {{ updated: number }}
 */
function recomputeAllSessionAggregates() {
  if (!_db) throw new Error('db.recomputeAllSessionAggregates: call initialize() first');
  const rows = _db.prepare('SELECT id FROM sessions').all();
  for (const r of rows) recomputeSessionAggregates(r.id);
  return { updated: rows.length };
}

/**
 * Detect memory entries whose source file no longer exists on disk.
 * Records into memory_stale. Idempotent — re-running just refreshes flags.
 *
 * Skips sources that aren't filesystem paths (e.g. 'session-auto:...').
 *
 * @returns {{ flagged: number, examined: number, cleared: number }}
 */
function detectStaleMemory() {
  if (!_db) throw new Error('db.detectStaleMemory: call initialize() first');
  const fsLocal = require('fs');
  const now = new Date().toISOString();

  const rows = _db.prepare(`
    SELECT id, source, title FROM memory_entries
     WHERE source LIKE 'C:%' OR source LIKE '/%' OR source LIKE './%'
  `).all();

  const insertStale = _db.prepare(`
    INSERT OR REPLACE INTO memory_stale (memory_id, source, title, reason, flagged_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const clearStale = _db.prepare(`DELETE FROM memory_stale WHERE memory_id = ?`);

  let flagged = 0, cleared = 0;
  _db.exec('BEGIN');
  try {
    for (const r of rows) {
      let exists = true;
      try { exists = fsLocal.existsSync(r.source); } catch (_) { exists = false; }
      if (!exists) {
        insertStale.run(r.id, r.source, r.title, 'source-file-missing', now);
        flagged++;
      } else {
        // If it now exists again, clear any prior stale flag (file restored).
        const res = clearStale.run(r.id);
        if (res.changes > 0) cleared++;
      }
    }
    _db.exec('COMMIT');
  } catch (err) {
    _db.exec('ROLLBACK');
    throw err;
  }
  return { flagged, examined: rows.length, cleared };
}

function getStaleMemory(limit = 200) {
  if (!_db) throw new Error('db.getStaleMemory: call initialize() first');
  return _db.prepare(`
    SELECT memory_id, source, title, reason, flagged_at
      FROM memory_stale
     ORDER BY flagged_at DESC
     LIMIT ?
  `).all(limit);
}

/**
 * Detect vault_tools whose registered path is dead. Mirrors detectStaleMemory.
 * Adds a `stale` column on first call (idempotent ALTER TABLE).
 *
 * @returns {{ flagged: number, examined: number, cleared: number }}
 */
function detectStaleVaultTools() {
  if (!_db) throw new Error('db.detectStaleVaultTools: call initialize() first');
  const fsLocal = require('fs');

  // One-shot schema upgrade: add `stale` + `stale_reason` if missing.
  try {
    const cols = _db.prepare('PRAGMA table_info(vault_tools)').all().map(c => c.name);
    if (!cols.includes('stale'))        _db.exec('ALTER TABLE vault_tools ADD COLUMN stale INTEGER DEFAULT 0');
    if (!cols.includes('stale_reason')) _db.exec('ALTER TABLE vault_tools ADD COLUMN stale_reason TEXT');
  } catch (_) { /* column already exists */ }

  const rows = _db.prepare(`
    SELECT id, tool_id, name, path FROM vault_tools
     WHERE path IS NOT NULL AND path != ''
  `).all();

  const markStale = _db.prepare(`UPDATE vault_tools SET stale = 1, stale_reason = ? WHERE id = ?`);
  const markFresh = _db.prepare(`UPDATE vault_tools SET stale = 0, stale_reason = NULL WHERE id = ?`);

  let flagged = 0, cleared = 0;
  _db.exec('BEGIN');
  try {
    for (const r of rows) {
      let exists = true;
      try { exists = fsLocal.existsSync(r.path); } catch (_) { exists = false; }
      if (!exists) { markStale.run('path-missing', r.id); flagged++; }
      else { const res = markFresh.run(r.id); if (res.changes > 0) cleared++; }
    }
    _db.exec('COMMIT');
  } catch (err) {
    _db.exec('ROLLBACK');
    throw err;
  }
  return { flagged, examined: rows.length, cleared };
}

function getStaleVaultTools(limit = 100) {
  if (!_db) throw new Error('db.getStaleVaultTools: call initialize() first');
  try {
    return _db.prepare(`
      SELECT tool_id, name, path, stale_reason FROM vault_tools
       WHERE stale = 1
       ORDER BY name
       LIMIT ?
    `).all(limit);
  } catch (_) {
    return []; // schema upgrade hasn't run yet
  }
}

/**
 * Synthesize session_summaries for closed sessions that never got one.
 *
 * Claude Code's SessionEnd hook is missed by ~95% of sessions (crash, Ctrl-C,
 * window close, etc.), so writeSessionSummary in session.cjs only fires for a
 * small fraction. This walks every closed session with no matching summary
 * row and computes the same top_files / patterns aggregate that session.end()
 * would have produced. Idempotent and safe to run on every session start.
 *
 * @returns {{ backfilled: number, examined: number }}
 */
function backfillMissingSessionSummaries(limit = 200) {
  if (!_db) throw new Error('db.backfillMissingSessionSummaries: call initialize() first');

  const candidates = _db.prepare(`
    SELECT s.id, s.project, s.started_at, s.ended_at, s.duration_ms
      FROM sessions s
      LEFT JOIN session_summaries ss ON ss.session_id = s.id
     WHERE s.ended_at IS NOT NULL AND ss.session_id IS NULL
     ORDER BY s.started_at DESC
     LIMIT ?
  `).all(limit);

  if (!candidates.length) return { backfilled: 0, examined: 0 };

  const topFilesStmt = _db.prepare(`
    SELECT file_path, COUNT(*) AS cnt FROM edit_events
     WHERE session_id = ?
     GROUP BY file_path ORDER BY cnt DESC LIMIT 5
  `);
  const patternsStmt = _db.prepare(`
    SELECT pattern_key FROM patterns
     WHERE last_fired BETWEEN ? AND ?
     ORDER BY fire_count DESC LIMIT 3
  `);

  let backfilled = 0;
  for (const s of candidates) {
    try {
      const files = topFilesStmt.all(s.id).map(r => {
        const idx = Math.max(r.file_path.lastIndexOf('/'), r.file_path.lastIndexOf('\\'));
        return idx >= 0 ? r.file_path.slice(idx + 1) : r.file_path;
      });
      // pattern window: started_at .. ended_at + 60s (cover trailing fires)
      const endMs = new Date(s.ended_at).getTime() + 60_000;
      const pats = patternsStmt.all(s.started_at, new Date(endMs).toISOString())
        .map(r => r.pattern_key);

      writeSessionSummary({
        session_id:  s.id,
        project:     s.project || '',
        duration_ms: s.duration_ms || 0,
        top_files:   files,
        patterns:    pats,
        summary_at:  s.ended_at,
      });
      backfilled++;
    } catch (_) { /* swallow per-row; keep going */ }
  }
  return { backfilled, examined: candidates.length };
}

/**
 * Canonicalize model identifiers so analytic joins don't fragment.
 *   "claude-sonnet-4.6"        → "claude-sonnet-4-6"
 *   "claude-sonnet-4-6-20250514"→ "claude-sonnet-4-6"
 *   "GPT-5"                    → "gpt-5"
 *   "gpt-5.4-mini"             → "gpt-5-4-mini"
 * Returns null for falsy input.
 */
function normalizeModelName(model) {
  if (!model) return null;
  const s = String(model).trim().toLowerCase();
  if (!s) return null;
  // Strip a trailing date suffix (8 digits) Anthropic appends to some IDs.
  let n = s.replace(/-(\d{8})$/, '');
  // Replace dots with dashes so "claude-sonnet-4.6" matches "claude-sonnet-4-6".
  n = n.replace(/\./g, '-');
  // Collapse repeated dashes.
  n = n.replace(/-+/g, '-');
  return n;
}
