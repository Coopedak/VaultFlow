/**
 * flush-parquet.mjs — vaultflow SQLite → Parquet flush script
 *
 * WHY: SQLite is the hot-path write store for edit events and sessions.
 * Parquet is the cold analytical archive readable by DuckDB, pandas, etc.
 * This script is the bridge — called by Ralph maintenance loops (nightly)
 * and runnable manually for ad-hoc archival.
 *
 * Usage (manual):
 *   node flush-parquet.mjs
 *
 * Exports (for Ralph loop callers):
 *   flushParquet()          — flush SQLite → Parquet, returns counts
 *   queryHotFiles(days)     — most-edited files in last N days (default 30)
 *   querySessionSummary()   — 30-day session stats from SQLite
 */

import { createRequire }  from 'node:module';
import { fileURLToPath }  from 'node:url';
import path               from 'node:path';
import fs                 from 'node:fs';

const require     = createRequire(import.meta.url);
const db          = require('./db.cjs');
const yaml        = require('js-yaml');

// ── resolve config ────────────────────────────────────────────────────────────

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = require('../../config/resolve.cjs');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`[flush-parquet] Config not found: ${CONFIG_PATH}`);
  }
  return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// ── exported API ──────────────────────────────────────────────────────────────

/**
 * Flush edit_events and sessions from SQLite to Parquet.
 *
 * Initializes the db connection if not already open, calls flushToParquet,
 * and closes the connection in a finally block.
 *
 * @returns {Promise<{editsFlushed: number, sessionsFlushed: number, parquetDir: string}>}
 */
export async function flushParquet() {
  const cfg        = loadConfig();
  const metricsRoot = cfg?.paths?.metrics_root;
  if (!metricsRoot) throw new Error('[flush-parquet] metrics_root not configured in vaultflow.yaml');
  const dbFile      = cfg?.storage?.db_file    || 'vaultflow.db';
  const parquetDir  = cfg?.storage?.parquet_dir || 'parquet';

  db.initialize(metricsRoot, dbFile);

  try {
    const result = await db.flushToParquet(metricsRoot, parquetDir);
    return {
      editsFlushed:    result.editsFlushed,
      sessionsFlushed: result.sessionsFlushed,
      parquetDir:      path.join(metricsRoot, parquetDir),
    };
  } finally {
    db.close();
  }
}

/**
 * Return the most-edited files over the last N days.
 *
 * Unions Parquet archive + live SQLite rows via DuckDB (handled inside
 * db.queryEditFrequency). Performs a flush first so Parquet is current.
 *
 * @param {number} [days=30]
 * @returns {Promise<Array<{file_path: string, project: string|null, edit_count: number}>>}
 */
export async function queryHotFiles(days = 30) {
  const cfg        = loadConfig();
  const metricsRoot = cfg?.paths?.metrics_root;
  if (!metricsRoot) throw new Error('[flush-parquet] metrics_root not configured in vaultflow.yaml');
  const dbFile      = cfg?.storage?.db_file    || 'vaultflow.db';
  const parquetDir  = cfg?.storage?.parquet_dir || 'parquet';

  db.initialize(metricsRoot, dbFile);

  try {
    // Ensure Parquet is up-to-date before querying the union
    await db.flushToParquet(metricsRoot, parquetDir);
    return await db.queryEditFrequency(metricsRoot, parquetDir, days);
  } finally {
    db.close();
  }
}

/**
 * Flush tool_calls, prompts, and retrieval feedback tables to Parquet.
 * Complements flushParquet() which covers edit_events + sessions.
 *
 * @returns {Promise<{toolCallsFlushed: number, promptsFlushed: number, retrievalFeedbackFlushed: number, parquetDir: string}>}
 */
export async function flushTelemetry() {
  const cfg        = loadConfig();
  const metricsRoot = cfg?.paths?.metrics_root;
  if (!metricsRoot) throw new Error('[flush-parquet] metrics_root not configured in vaultflow.yaml');
  const dbFile      = cfg?.storage?.db_file    || 'vaultflow.db';
  const parquetDir  = cfg?.storage?.parquet_dir || 'parquet';

  db.initialize(metricsRoot, dbFile);

  try {
    const result = await db.flushTelemetryToParquet(metricsRoot, parquetDir);
    return {
      toolCallsFlushed:        result.toolCallsFlushed,
      promptsFlushed:          result.promptsFlushed,
      retrievalFeedbackFlushed: result.retrievalFeedbackFlushed,
      parquetDir:              path.join(metricsRoot, parquetDir),
    };
  } finally {
    db.close();
  }
}

/**
 * Return per-tool call counts over the last N days, from SQLite.
 * Useful for Ralph Loop 3 to decide which tools are actually being used.
 *
 * @param {number} [days=30]
 * @returns {{
 *   tool_name: string,
 *   call_count: number,
 *   unique_calls: number,
 *   last_called: string
 * }[]}
 */
export function queryToolCallSummary(days = 30) {
  const cfg         = loadConfig();
  const metricsRoot = cfg?.paths?.metrics_root;
  if (!metricsRoot) throw new Error('[flush-parquet] metrics_root not configured');
  const dbFile = cfg?.storage?.db_file || 'vaultflow.db';

  db.initialize(metricsRoot, dbFile);

  return db.raw().prepare(`
    SELECT   tool_name,
             COUNT(*)                   AS call_count,
             COUNT(DISTINCT input_hash) AS unique_calls,
             MAX(timestamp)             AS last_called
    FROM     tool_calls
    WHERE    timestamp >= datetime('now', ? || ' days')
    GROUP BY tool_name
    ORDER BY call_count DESC
  `).all(`-${days}`);
}

/**
 * Return a 30-day session summary queried directly from SQLite.
 *
 * @returns {{
 *   total_sessions: number,
 *   total_edits: number,
 *   total_commands: number,
 *   avg_duration_ms: number|null,
 *   last_session: string|null
 * }}
 */
export function querySessionSummary() {
  const cfg         = loadConfig();
  const metricsRoot = cfg.paths.metrics_root;
  const dbFile      = cfg.storage.db_file || 'vaultflow.db';

  db.initialize(metricsRoot, dbFile);

  const row = db.raw().prepare(`
    SELECT COUNT(*)          AS total_sessions,
           SUM(edits)        AS total_edits,
           SUM(commands)     AS total_commands,
           AVG(duration_ms)  AS avg_duration_ms,
           MAX(started_at)   AS last_session
    FROM   sessions
    WHERE  started_at >= datetime('now', '-30 days')
  `).get();

  return {
    total_sessions:  row?.total_sessions  ?? 0,
    total_edits:     row?.total_edits     ?? 0,
    total_commands:  row?.total_commands  ?? 0,
    avg_duration_ms: row?.avg_duration_ms ?? null,
    last_session:    row?.last_session    ?? null,
  };
}

// ── main (CLI entry point) ────────────────────────────────────────────────────

async function main() {
  try {
    const cfg        = loadConfig();
    const metricsRoot = cfg.paths.metrics_root;
    const dbFile      = cfg.storage.db_file    || 'vaultflow.db';
    const parquetDir  = cfg.storage.parquet_dir || 'parquet';
    const parquetFull = path.join(metricsRoot, parquetDir);

    db.initialize(metricsRoot, dbFile);

    try {
      // Flush edit_events + sessions
      const r1 = await db.flushToParquet(metricsRoot, parquetDir);
      console.log(`[flush-parquet] Edit events flushed:  ${r1.editsFlushed}`);
      console.log(`[flush-parquet] Sessions flushed:     ${r1.sessionsFlushed}`);

      // Flush tool_calls + prompts + retrieval feedback
      const r2 = await db.flushTelemetryToParquet(metricsRoot, parquetDir);
      console.log(`[flush-parquet] Tool calls flushed:   ${r2.toolCallsFlushed}`);
      console.log(`[flush-parquet] Prompts flushed:      ${r2.promptsFlushed}`);
      console.log(`[flush-parquet] Retrieval flushed:   ${r2.retrievalFeedbackFlushed}`);

      console.log(`[flush-parquet] Parquet dir: ${parquetFull}`);
    } finally {
      db.close();
    }

    process.exit(0);
  } catch (err) {
    process.stderr.write(`[flush-parquet] ERROR: ${err.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
