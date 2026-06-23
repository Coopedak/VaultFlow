/**
 * lint.mjs — vaultflow data-hygiene linter
 *
 * Checks for data-quality issues that audit.mjs doesn't cover:
 * dead patterns, stale memory, unused vault tools, orphaned sessions,
 * stuck pipeline gate, and DB size threshold.
 *
 * Usage:
 *   node .claude/helpers/lint.mjs          # report only
 *   node .claude/helpers/lint.mjs --fix    # auto-fix what can be fixed
 *   npm run lint
 *   npm run lint:fix
 *
 * Exit codes:
 *   0 — all checks ok or info-only
 *   1 — one or more FAIL results
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path              from 'node:path';
import fs                from 'node:fs';
import os                from 'node:os';

const require   = createRequire(import.meta.url);
const yaml      = require('js-yaml');

// ── config ────────────────────────────────────────────────────────────────

const CONFIG_PATH = require('../../config/resolve.cjs');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try { return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; }
  catch (_) { return {}; }
}

const cfg     = loadConfig();
const METRICS = cfg.paths?.metrics_root || path.join(os.homedir(), 'vault', 'methodology', '.metrics');
const DB_FILE = cfg.storage?.db_file    || 'vaultflow.db';
const DB_PATH = path.join(METRICS, DB_FILE);

const DO_FIX  = process.argv.includes('--fix');

// ── SQLite helpers ────────────────────────────────────────────────────────

function openDb(readOnly = true) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(DB_PATH, { readOnly });
}

// ── check runner ──────────────────────────────────────────────────────────

const PASS = '\x1b[32m✓\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';
const INFO = '\x1b[36mℹ\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

let hasFail = false;

function report(icon, label, detail) {
  const pad = label.padEnd(28);
  console.log(`  ${icon}  ${pad}${detail || ''}`);
}

const ICON = { PASS, WARN, INFO, FAIL };

// ── pure classifiers (exported, unit-tested) ────────────────────────────────
// Each maps an already-computed number to a { level, detail } verdict. No DB,
// no IO — the WARN/PASS boundaries that can silently regress live here, locked
// by tests/lintClassifiers.test.mjs.

function classifyUnusedTools(n) {
  return { level: n < 10 ? 'PASS' : 'INFO', detail: `${n} tool(s) with use_count = 0` };
}

function classifyStaleMemory(n) {
  return { level: n < 50 ? 'PASS' : 'WARN', detail: `${n} memory entries flagged stale (source vanished)` };
}

function classifyStuckPipeline(ageMs) {
  const ageH = (ageMs / 3_600_000).toFixed(1);
  return ageMs > 2 * 3_600_000
    ? { level: 'WARN', detail: `pending-review.json is ${ageH}h old — pipeline may be stuck` }
    : { level: 'PASS', detail: `flag exists but only ${ageH}h old` };
}

function classifyDbSize(bytes) {
  const mb  = (bytes / 1_048_576).toFixed(2);
  const big = bytes > 500 * 1_048_576;
  // `npm run flush` archives to Parquet but does NOT shrink the SQLite file —
  // only VACUUM reclaims freed pages (auto_vacuum is OFF). nightly.mjs runs a
  // gated VACUUM when there is meaningful reclaimable space, so a large file is
  // usually live data, not bloat. Point at the real lever, not flush.
  const detail = `${mb} MB${big ? ' — nightly VACUUMs reclaimable space; flush only archives' : ''}`;
  return { level: big ? 'WARN' : 'PASS', detail };
}

// ── checks ────────────────────────────────────────────────────────────────

function checkOrphanedSessions(conn) {
  const { n } = conn.prepare(`
    SELECT COUNT(*) AS n FROM sessions
    WHERE  ended_at IS NULL
      AND  started_at < datetime('now', '-24 hours')
  `).get();

  if (n === 0) {
    report(PASS, 'orphaned-sessions', 'none');
  } else if (DO_FIX) {
    const rw = openDb(false);
    rw.exec(`
      UPDATE sessions
      SET    ended_at    = datetime('now'),
             duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)
      WHERE  ended_at IS NULL
        AND  started_at < datetime('now', '-24 hours')
    `);
    rw.close();
    report(WARN, 'orphaned-sessions', `${n} closed automatically (--fix)`);
  } else {
    report(WARN, 'orphaned-sessions', `${n} sessions > 24h old without ended_at — run with --fix`);
  }
}

function checkDeadPatterns(conn) {
  const { n } = conn.prepare(`
    SELECT COUNT(*) AS n FROM patterns
    WHERE  promoted  = 0
      AND  fire_count < 2
      AND  (last_fired IS NULL OR last_fired < datetime('now', '-60 days'))
  `).get();

  if (n === 0) {
    report(PASS, 'dead-patterns', 'none');
  } else if (DO_FIX) {
    const rw = openDb(false);
    rw.exec(`
      DELETE FROM patterns
      WHERE  promoted  = 0
        AND  fire_count < 2
        AND  (last_fired IS NULL OR last_fired < datetime('now', '-60 days'))
    `);
    rw.close();
    report(INFO, 'dead-patterns', `${n} deleted (fire_count < 2, no fire in 60d)`);
  } else {
    report(INFO, 'dead-patterns', `${n} patterns never gained traction — run with --fix to prune`);
  }
}

function checkUnusedVaultTools(conn) {
  let n = 0;
  try {
    n = conn.prepare(`SELECT COUNT(*) AS n FROM vault_tools WHERE use_count = 0`).get().n;
  } catch (_) {
    report(INFO, 'unused-vault-tools', 'vault_tools table not present yet');
    return;
  }
  const r = classifyUnusedTools(n);
  report(ICON[r.level], 'unused-vault-tools', r.detail);
}

function checkStaleMemory(conn) {
  // memory_entries has no timestamp column, so "not updated in N days" can't be
  // computed there — the old query errored and the catch silently misreported it
  // as "table not present". The real stale signal is memory_stale, populated
  // nightly by detectStaleMemory (entries whose source file vanished).
  let n = 0;
  try {
    n = conn.prepare(`SELECT COUNT(*) AS n FROM memory_stale`).get().n;
  } catch (_) {
    report(INFO, 'stale-memory', 'memory_stale table not present yet');
    return;
  }
  const r = classifyStaleMemory(n);
  report(ICON[r.level], 'stale-memory', r.detail);
}

function checkStuckPipeline() {
  const flagPath = path.join(METRICS, 'pending-review.json');
  if (!fs.existsSync(flagPath)) {
    report(PASS, 'stuck-pipeline', 'no pending-review flag');
    return;
  }
  try {
    const stat  = fs.statSync(flagPath);
    const ageMs = Date.now() - stat.mtimeMs;
    const r = classifyStuckPipeline(ageMs);
    report(ICON[r.level], 'stuck-pipeline', r.detail);
  } catch (e) {
    report(FAIL, 'stuck-pipeline', e.message);
    hasFail = true;
  }
}

function checkDbSize() {
  try {
    const { size } = fs.statSync(DB_PATH);
    const r = classifyDbSize(size);
    report(ICON[r.level], 'db-size', r.detail);
  } catch (e) {
    report(FAIL, 'db-size', e.message);
    hasFail = true;
  }
}

// ── main ──────────────────────────────────────────────────────────────────
// Only run the linter (and exit) when executed directly. Importing this module
// — e.g. a unit test pulling in the classifiers — must not open the DB or exit.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

if (isMain) {
  console.log(`\nvaultflow lint${DO_FIX ? ' --fix' : ''}`);
  console.log('─'.repeat(44));

  if (!fs.existsSync(DB_PATH)) {
    console.log(`  ${WARN}  DB not found at ${DB_PATH} — nothing to lint`);
    process.exit(0);
  }

  const conn = openDb();

  try {
    checkOrphanedSessions(conn);
    checkDeadPatterns(conn);
    checkUnusedVaultTools(conn);
    checkStaleMemory(conn);
    checkStuckPipeline();      // file-based, no conn needed
    checkDbSize();             // file-based, no conn needed
  } finally {
    try { conn.close(); } catch (_) {}
  }

  console.log('─'.repeat(44));
  if (hasFail) {
    console.log('Result: FAIL\n');
    process.exit(1);
  } else {
    console.log('Result: OK\n');
  }
}

export {
  classifyUnusedTools,
  classifyStaleMemory,
  classifyStuckPipeline,
  classifyDbSize,
};
