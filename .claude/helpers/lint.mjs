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
  const icon = n < 10 ? PASS : INFO;
  report(icon, 'unused-vault-tools', `${n} tool(s) with use_count = 0`);
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
  const icon = n < 50 ? PASS : WARN;
  report(icon, 'stale-memory', `${n} memory entries flagged stale (source vanished)`);
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
    const ageH  = (ageMs / 3_600_000).toFixed(1);
    if (ageMs > 2 * 3_600_000) {
      report(WARN, 'stuck-pipeline', `pending-review.json is ${ageH}h old — pipeline may be stuck`);
    } else {
      report(PASS, 'stuck-pipeline', `flag exists but only ${ageH}h old`);
    }
  } catch (e) {
    report(FAIL, 'stuck-pipeline', e.message);
    hasFail = true;
  }
}

function checkDbSize() {
  try {
    const { size } = fs.statSync(DB_PATH);
    const mb       = (size / 1_048_576).toFixed(2);
    const icon     = size > 500 * 1_048_576 ? WARN : PASS;
    const suffix   = size > 500 * 1_048_576 ? ' — consider: npm run flush' : '';
    report(icon, 'db-size', `${mb} MB${suffix}`);
  } catch (e) {
    report(FAIL, 'db-size', e.message);
    hasFail = true;
  }
}

// ── main ──────────────────────────────────────────────────────────────────

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
