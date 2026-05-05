/**
 * audit.mjs — vaultflow health audit
 *
 * Checks DB integrity, session health, Parquet flush state, hook wiring, and
 * configuration validity. Prints a pass/fail report with fix commands.
 *
 * Usage:
 *   node .claude/helpers/audit.mjs          # full audit
 *   node .claude/helpers/audit.mjs --fix    # auto-fix what can be fixed
 *   npm run audit
 *   npm run audit:fix
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed (see report)
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path              from 'node:path';
import fs                from 'node:fs';

const require   = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const yaml   = require('js-yaml');

// ── config ─────────────────────────────────────────────────────────────────

const CONFIG_PATH = require('../../config/resolve.cjs');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try { return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || null; }
  catch (_) { return null; }
}

const cfg         = loadConfig();
const METRICS     = cfg?.paths?.metrics_root     || '';
const DB_FILE     = cfg?.storage?.db_file        || 'vaultflow.db';
const PARQUET_DIR = cfg?.storage?.parquet_dir    || 'parquet';
const DB_PATH     = METRICS ? path.join(METRICS, DB_FILE) : '';

// ── CLI flags ───────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const DO_FIX = args.includes('--fix');

// ── result tracking ─────────────────────────────────────────────────────────

const PASS = '✓';
const FAIL = '✗';
const WARN = '⚠';

const results = [];

function check(label, status, detail, fix) {
  results.push({ label, status, detail, fix });
  const icon = status === 'pass' ? PASS : status === 'warn' ? WARN : FAIL;
  const color = status === 'pass' ? '\x1b[32m' : status === 'warn' ? '\x1b[33m' : '\x1b[31m';
  console.log(`  ${color}${icon}\x1b[0m ${label}`);
  if (detail && status !== 'pass') console.log(`     ${detail}`);
}

// ── SQLite helpers ──────────────────────────────────────────────────────────

function openDb(readOnly = true) {
  const { emitWarning } = process;
  process.emitWarning = (msg, ...rest) => {
    if (typeof msg === 'string' && msg.includes('SQLite')) return;
    emitWarning.call(process, msg, ...rest);
  };
  const { DatabaseSync } = require('node:sqlite');
  process.emitWarning = emitWarning;
  return new DatabaseSync(DB_PATH, { readOnly });
}

// ── checks ──────────────────────────────────────────────────────────────────

function checkConfig() {
  console.log('\n[1] Configuration');

  if (!fs.existsSync(CONFIG_PATH)) {
    check('vaultflow config exists', 'fail',
      `Not found at ${CONFIG_PATH}`,
      `Copy config/vaultflow.example.yaml to config/vaultflow.yaml and fill in your paths`);
    return false;
  }
  check('vaultflow config exists', 'pass');

  if (!cfg) {
    check('Config parses as valid YAML', 'fail', 'YAML parse error');
    return false;
  }
  check('Config parses as valid YAML', 'pass');

  if (!cfg?.paths?.metrics_root) {
    check('paths.metrics_root is set', 'fail',
      'metrics_root is missing or empty in the active config',
      'Set paths.metrics_root in config/vaultflow.local.yaml');
    return false;
  }
  check('paths.metrics_root is set', 'pass', `→ ${METRICS}`);

  if (!fs.existsSync(METRICS)) {
    check('metrics_root directory exists', 'warn',
      `${METRICS} not found — will be created on first hook fire`);
  } else {
    check('metrics_root directory exists', 'pass');
  }

  const hooksSettingsPath = path.resolve(__dirname, '../../.claude/settings.json');
  if (!fs.existsSync(hooksSettingsPath)) {
    check('.claude/settings.json exists', 'warn', 'Hook wiring file missing — run: npm run install-hooks');
  } else {
    check('.claude/settings.json exists', 'pass');
  }

  return true;
}

function checkDb() {
  console.log('\n[2] SQLite Database');

  if (!DB_PATH) {
    check('DB path resolvable', 'fail', 'metrics_root not set — cannot check DB');
    return false;
  }

  if (!fs.existsSync(DB_PATH)) {
    check('DB file exists', 'warn',
      `${DB_PATH} not found — will be created on first session`,
      'Run a Claude Code session or: node .claude/helpers/hook-handler.cjs session-start');
    return false;
  }
  check('DB file exists', 'pass', `${DB_PATH} (${(fs.statSync(DB_PATH).size / 1024).toFixed(1)} KB)`);

  let conn;
  try {
    conn = openDb();
  } catch (err) {
    check('DB opens without error', 'fail', err.message,
      'DB may be corrupt. Run: node -e "require(\'node:sqlite\').DatabaseSync(path).exec(\'PRAGMA integrity_check\')"');
    return false;
  }

  try {
    const result = conn.prepare('PRAGMA integrity_check').get();
    if (result.integrity_check === 'ok') {
      check('PRAGMA integrity_check', 'pass');
    } else {
      check('PRAGMA integrity_check', 'fail', result.integrity_check,
        'DB is corrupt. Restore from backup or delete and let vaultflow recreate it.');
    }
  } catch (err) {
    check('PRAGMA integrity_check', 'fail', err.message);
  }

  // Table existence
  const tables = conn.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  ).all().map(r => r.name);

  const requiredTables = ['sessions', 'edit_events', 'patterns', 'memory_entries', 'tool_calls', 'prompts'];
  const missingTables  = requiredTables.filter(t => !tables.includes(t));

  if (missingTables.length === 0) {
    check('All required tables exist', 'pass', `(${tables.length} tables total)`);
  } else {
    check('All required tables exist', 'fail',
      `Missing: ${missingTables.join(', ')}`,
      'Run: node .claude/helpers/hook-handler.cjs session-start (initializes schema)');
  }

  // Stale sessions (started but never ended)
  try {
    const stale = conn.prepare(`
      SELECT COUNT(*) AS n FROM sessions
      WHERE ended_at IS NULL
        AND started_at < datetime('now', '-2 hours')
    `).get().n;

    if (stale === 0) {
      check('No stale open sessions', 'pass');
    } else {
      check('No stale open sessions', 'warn',
        `${stale} session(s) started > 2h ago with no ended_at`,
        DO_FIX
          ? null
          : 'Run: npm run audit:fix — will close stale sessions');
      if (DO_FIX) {
        const wrConn = openDb(false);
        wrConn.exec(`
          UPDATE sessions
          SET ended_at = datetime('now'),
              duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)
          WHERE ended_at IS NULL
            AND started_at < datetime('now', '-2 hours')
        `);
        wrConn.close();
        console.log(`     → Fixed: closed ${stale} stale session(s)`);
      }
    }
  } catch (_) {
    check('No stale open sessions', 'warn', 'Could not query — sessions table may not exist yet');
  }

  // Recent session activity
  try {
    const last = conn.prepare(
      "SELECT MAX(started_at) AS ts FROM sessions"
    ).get();
    if (last?.ts) {
      const hoursAgo = (Date.now() - new Date(last.ts).getTime()) / 3600000;
      if (hoursAgo < 168) { // 7 days
        check('Recent session activity', 'pass', `Last session: ${last.ts}`);
      } else {
        check('Recent session activity', 'warn',
          `Last session was ${Math.round(hoursAgo / 24)} days ago — are hooks wired?`);
      }
    } else {
      check('Recent session activity', 'warn', 'No sessions recorded yet');
    }
  } catch (_) {}

  // Row counts
  try {
    const counts = {};
    for (const t of ['sessions', 'edit_events', 'tool_calls', 'prompts', 'memory_entries']) {
      try { counts[t] = conn.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; }
      catch (_) { counts[t] = null; }
    }
    const summary = Object.entries(counts)
      .map(([t, n]) => `${t}:${n ?? '?'}`)
      .join('  ');
    check('Row counts', 'pass', summary);
  } catch (_) {}

  conn.close();
  return true;
}

function checkParquet() {
  console.log('\n[3] Parquet Archive');

  if (!METRICS) {
    check('Parquet dir resolvable', 'warn', 'metrics_root not set');
    return;
  }

  const parquetPath = path.join(METRICS, PARQUET_DIR);

  if (!fs.existsSync(parquetPath)) {
    check('Parquet directory exists', 'warn',
      `${parquetPath} not found — created on first flush`,
      'Run: npm run flush');
    return;
  }
  check('Parquet directory exists', 'pass');

  const files = fs.readdirSync(parquetPath).filter(f => f.endsWith('.parquet'));

  if (files.length === 0) {
    check('Parquet files present', 'warn',
      'No .parquet files yet',
      'Run: npm run flush');
    return;
  }
  check('Parquet files present', 'pass', files.join(', '));

  // Check freshness (youngest parquet file)
  const mtimes = files.map(f => fs.statSync(path.join(parquetPath, f)).mtimeMs);
  const latestMs = Math.max(...mtimes);
  const hoursAgo = (Date.now() - latestMs) / 3600000;

  if (hoursAgo < 25) {
    check('Parquet flushed within 25h', 'pass', `Last flush: ${new Date(latestMs).toISOString()}`);
  } else {
    check('Parquet flushed within 25h', 'warn',
      `Last flush was ${Math.round(hoursAgo)}h ago`,
      'Run: npm run flush   (or check if Ralph Loop 18 is scheduled)');
  }
}

function checkNodeVersion() {
  console.log('\n[4] Runtime');

  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 22) {
    check(`Node.js ${process.versions.node} (≥22 required)`, 'pass');
  } else {
    check(`Node.js ${process.versions.node} (≥22 required)`, 'fail',
      `node:sqlite requires Node 22+. Current: ${process.versions.node}`,
      'Upgrade Node.js: https://nodejs.org');
  }

  // Check required npm packages
  const pkgPath = path.resolve(__dirname, '../../node_modules/@duckdb/node-api/package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    check(`@duckdb/node-api installed (${pkg.version})`, 'pass');
  } else {
    check('@duckdb/node-api installed', 'fail', 'Missing — run: npm install');
  }
}

function checkHookWiring() {
  console.log('\n[5] Hook Wiring');

  // Check project-level settings.json
  const settingsPath = path.resolve(__dirname, '../../.claude/settings.json');
  if (!fs.existsSync(settingsPath)) {
    check('.claude/settings.json present', 'fail',
      'Hook wiring file not found',
      'Run: npm run install-hooks');
    return;
  }

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (_) {
    check('.claude/settings.json parses', 'fail', 'JSON parse error');
    return;
  }
  check('.claude/settings.json parses', 'pass');

  const hooks = settings.hooks || {};
  const expected = ['SessionStart', 'SessionEnd', 'PostToolUse', 'UserPromptSubmit', 'Stop'];
  const missing  = expected.filter(e => !hooks[e]);

  if (missing.length === 0) {
    check('All expected hook events wired', 'pass', `(${Object.keys(hooks).length} events)`);
  } else {
    check('All expected hook events wired', 'warn',
      `Missing: ${missing.join(', ')}`,
      'Merge .claude/settings.json hooks block into your Claude Code settings');
  }
}

function checkDiscoveries() {
  console.log('\n[6] Discovery Pipeline');

  if (!METRICS) {
    check('Discoveries dir', 'warn', 'metrics_root not set — skip');
    return;
  }

  const discDir = path.join(METRICS, cfg?.storage?.discoveries_dir || 'discoveries');

  if (!fs.existsSync(discDir)) {
    check('Discoveries directory', 'warn', 'No discoveries yet (fires after pattern threshold is crossed)');
    return;
  }

  const files = fs.readdirSync(discDir).filter(f => f.endsWith('.md'));
  if (files.length === 0) {
    check('Discoveries', 'pass', 'Directory exists, no pending discoveries');
    return;
  }

  // Count promoted vs unreviewed
  let promoted = 0;
  let pending  = 0;

  for (const f of files) {
    const content = fs.readFileSync(path.join(discDir, f), 'utf8');
    if (content.includes('promoted: true') || content.includes('promoted: 1')) {
      promoted++;
    } else {
      pending++;
    }
  }

  if (pending === 0) {
    check(`Discoveries (${files.length} total, all promoted)`, 'pass');
  } else {
    check(`Discoveries (${files.length} total)`, 'warn',
      `${pending} unreviewed — review and convert to vault skills`,
      `Open: ${discDir}`);
  }
}

// ── report ──────────────────────────────────────────────────────────────────

function printSummary() {
  const failures = results.filter(r => r.status === 'fail');
  const warnings = results.filter(r => r.status === 'warn');
  const passes   = results.filter(r => r.status === 'pass');

  console.log('\n─────────────────────────────────────────────');
  console.log(`  ${passes.length} passed   ${warnings.length} warnings   ${failures.length} failed`);

  if (failures.length > 0) {
    console.log('\nFailed checks:');
    for (const f of failures) {
      console.log(`  ${FAIL} ${f.label}`);
      if (f.fix) console.log(`    Fix: ${f.fix}`);
    }
  }

  if (warnings.length > 0 && failures.length === 0) {
    console.log('\nWarnings:');
    for (const w of warnings) {
      if (w.fix) console.log(`  ${WARN} ${w.label}: ${w.fix}`);
    }
  }

  console.log('');

  if (failures.length > 0) {
    console.log('Result: FAIL\n');
    process.exit(1);
  } else if (warnings.length > 0) {
    console.log('Result: PASS (with warnings)\n');
  } else {
    console.log('Result: PASS\n');
  }
}

// ── main ────────────────────────────────────────────────────────────────────

console.log('vaultflow audit' + (DO_FIX ? ' --fix' : ''));
console.log('─────────────────────────────────────────────');

checkConfig();
checkDb();
checkParquet();
checkNodeVersion();
checkHookWiring();
checkDiscoveries();
printSummary();
