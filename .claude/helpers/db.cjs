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

  -- Performance indexes — queried on every hook fire
  CREATE INDEX IF NOT EXISTS idx_edit_events_session   ON edit_events(session_id);
  CREATE INDEX IF NOT EXISTS idx_edit_events_timestamp ON edit_events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_tool_calls_session    ON tool_calls(session_id);
  CREATE INDEX IF NOT EXISTS idx_prompts_session       ON prompts(session_id);
  CREATE INDEX IF NOT EXISTS idx_memory_source         ON memory_entries(source);
  CREATE INDEX IF NOT EXISTS idx_patterns_fire         ON patterns(fire_count);
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
}

/**
 * Write a single edit event to SQLite.
 *
 * @param {string} sessionId   Active session ID.
 * @param {string} filePath    Absolute path of the edited file.
 * @param {string} [project]   Project name (derived by caller from filePath).
 * @param {string} [changeType='edit']  One of: 'edit', 'create', 'delete'.
 */
function recordEdit(sessionId, filePath, project, changeType) {
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
      (id, started_at, ended_at, duration_ms, platform, cwd,
       edits, commands, tasks, errors, project)
    VALUES
      (@id, @started_at, @ended_at, @duration_ms, @platform, @cwd,
       @edits, @commands, @tasks, @errors, @project)
    ON CONFLICT(id) DO UPDATE SET
      ended_at    = excluded.ended_at,
      duration_ms = excluded.duration_ms,
      platform    = excluded.platform,
      cwd         = excluded.cwd,
      edits       = excluded.edits,
      commands    = excluded.commands,
      tasks       = excluded.tasks,
      errors      = excluded.errors,
      project     = excluded.project
  `);

  stmt.run({
    id:          session.id,
    started_at:  session.started_at,
    ended_at:    session.ended_at    || null,
    duration_ms: session.duration_ms || null,
    platform:    session.platform    || null,
    cwd:         session.cwd         || null,
    edits:       session.edits       || 0,
    commands:    session.commands    || 0,
    tasks:       session.tasks       || 0,
    errors:      session.errors      || 0,
    project:     session.project     || null,
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
function upsertPattern(patternKey, agent) {
  if (!_db) throw new Error('db.upsertPattern: call initialize() first');

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
      const ep_ = duckEsc(editsParquet);
      if (fs.existsSync(editsParquet)) {
        await duckRun(conn,
          `COPY (
             SELECT * FROM read_parquet('${ep_}') WHERE timestamp > '1970-01-01T00:00:00.000Z'
             UNION ALL
             SELECT * FROM sqlite_scan('${db_}', 'edit_events') WHERE timestamp > '${lf_}'
           ) TO '${ep_}' (FORMAT PARQUET)`
        );
      } else {
        await duckRun(conn,
          `COPY (SELECT * FROM sqlite_scan('${db_}', 'edit_events') WHERE timestamp > '${lf_}')
           TO '${ep_}' (FORMAT PARQUET)`
        );
      }
    }

    // ── sessions flush ───────────────────────────────────────────────────
    const sessCountRows = await duckQuery(conn,
      `SELECT COUNT(*) AS cnt FROM sqlite_scan('${db_}', 'sessions') WHERE started_at > '${lf_}'`
    );
    const sessionsFlushed = sessCountRows[0]?.cnt || 0;

    if (sessionsFlushed > 0) {
      const sp_ = duckEsc(sessParquet);
      if (fs.existsSync(sessParquet)) {
        await duckRun(conn,
          `COPY (
             SELECT * FROM read_parquet('${sp_}') WHERE started_at > '1970-01-01T00:00:00.000Z'
             UNION ALL
             SELECT * FROM sqlite_scan('${db_}', 'sessions') WHERE started_at > '${lf_}'
           ) TO '${sp_}' (FORMAT PARQUET)`
        );
      } else {
        await duckRun(conn,
          `COPY (SELECT * FROM sqlite_scan('${db_}', 'sessions') WHERE started_at > '${lf_}')
           TO '${sp_}' (FORMAT PARQUET)`
        );
      }
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
  const dbPath       = path.join(root, (cfg && cfg.storage && cfg.storage.db_file) || 'vaultflow.db');
  const lookback     = days || 30;

  // Cutoff timestamp
  const cutoff = new Date(Date.now() - lookback * 24 * 60 * 60 * 1000).toISOString();

  return withDuckdb(':memory:', async (conn) => {
    await duckRun(conn, "INSTALL sqlite; LOAD sqlite;");

    const db_  = duckEsc(dbPath);
    const cut_ = duckEsc(cutoff);

    if (fs.existsSync(editsParquet)) {
      const ep_ = duckEsc(editsParquet);
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
  `).all(ftsPhrase(query), limit || 10);
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
  `).all(ftsPhrase(query), limit || 10);
}

// ── tool call telemetry ───────────────────────────────────────────────────

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

  const inputHash = sha256(inputJson || '');
  const now       = new Date().toISOString();

  const info = _db.prepare(`
    INSERT OR IGNORE INTO tool_calls (timestamp, session_id, tool_name, input_hash, input_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(now, sessionId, toolName, inputHash, inputJson || null);

  return { isDuplicate: info.changes === 0, inputHash };
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

// ── prompt history + similarity ───────────────────────────────────────────

/**
 * Record a user prompt for similarity search and routing telemetry.
 *
 * @param {string} sessionId
 * @param {string} promptText
 * @param {string} [skillRouted]   Skill the router matched (may be null)
 */
function recordPrompt(sessionId, promptText, skillRouted) {
  if (!_db) throw new Error('db.recordPrompt: call initialize() first');

  _db.prepare(`
    INSERT INTO prompts (timestamp, session_id, prompt_text, skill_routed)
    VALUES (?, ?, ?, ?)
  `).run(new Date().toISOString(), sessionId, promptText, skillRouted || null);
}

/**
 * Search past prompts for similarity using FTS5 BM25.
 * Useful for surfacing "you asked something similar 3 days ago" context.
 *
 * @param {string} query
 * @param {number} [limit=5]
 * @returns {Array<{id, timestamp, session_id, prompt_text, skill_routed, rank}>}
 */
function searchSimilarPrompts(query, limit) {
  if (!_db) throw new Error('db.searchSimilarPrompts: call initialize() first');

  return _db.prepare(`
    SELECT p.id,
           p.timestamp,
           p.session_id,
           p.prompt_text,
           p.skill_routed,
           bm25(prompts_fts) AS rank
    FROM   prompts_fts f
    JOIN   prompts p ON p.id = f.rowid
    WHERE  prompts_fts MATCH ?
    ORDER  BY rank
    LIMIT  ?
  `).all(ftsPhrase(query), limit || 5);
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
  `).all(ftsPhrase(query), limit || 10);
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
  `).all(ftsPhrase(query), limit || 10);
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
function incrementAgentUse(agentId) {
  if (!_db) throw new Error('db.incrementAgentUse: call initialize() first');

  _db.prepare(`
    UPDATE vault_agents
    SET    use_count = use_count + 1,
           last_used = ?
    WHERE  agent_id = ?
  `).run(new Date().toISOString(), agentId);
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
    'SELECT prompt_text FROM prompts WHERE session_id IN (SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1)'
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

// ── telemetry flush ───────────────────────────────────────────────────────

/**
 * Flush tool_calls and prompts tables to Parquet.
 * Mirrors flushToParquet() but for the telemetry tables.
 *
 * @param {string} [metricsRoot]
 * @param {string} [parquetDir]
 * @returns {Promise<{toolCallsFlushed: number, promptsFlushed: number}>}
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
      const tp_ = duckEsc(toolsParquet);
      if (fs.existsSync(toolsParquet)) {
        await duckRun(conn,
          `COPY (
             SELECT * FROM read_parquet('${tp_}')
             UNION ALL
             SELECT * FROM sqlite_scan('${db_}', 'tool_calls') WHERE timestamp > '${lf_}'
           ) TO '${tp_}' (FORMAT PARQUET)`
        );
      } else {
        await duckRun(conn,
          `COPY (SELECT * FROM sqlite_scan('${db_}', 'tool_calls') WHERE timestamp > '${lf_}')
           TO '${tp_}' (FORMAT PARQUET)`
        );
      }
    }

    // ── prompts ──────────────────────────────────────────────────────────
    const prCount = await duckQuery(conn,
      `SELECT COUNT(*) AS cnt FROM sqlite_scan('${db_}', 'prompts') WHERE timestamp > '${lf_}'`
    );
    const promptsFlushed = prCount[0]?.cnt || 0;

    if (promptsFlushed > 0) {
      const pp_ = duckEsc(promptsParquet);
      if (fs.existsSync(promptsParquet)) {
        await duckRun(conn,
          `COPY (
             SELECT * FROM read_parquet('${pp_}')
             UNION ALL
             SELECT * FROM sqlite_scan('${db_}', 'prompts') WHERE timestamp > '${lf_}'
           ) TO '${pp_}' (FORMAT PARQUET)`
        );
      } else {
        await duckRun(conn,
          `COPY (SELECT * FROM sqlite_scan('${db_}', 'prompts') WHERE timestamp > '${lf_}')
           TO '${pp_}' (FORMAT PARQUET)`
        );
      }
    }

    return { toolCallsFlushed, promptsFlushed };
  });

  fs.writeFileSync(sentinelPath, new Date().toISOString(), 'utf8');
  return result;
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
  // pattern FTS
  searchPatterns,
  // tool call deduplication
  recordToolCall,
  getSessionToolSummary,
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
  // session-end helpers
  getUnpromotedVaultTools,
  promoteVaultTool,
  getLastSessionPrompts,
  getDictionaryTermSet,
  // Parquet archival
  flushToParquet,
  flushTelemetryToParquet,
  queryEditFrequency,
};
