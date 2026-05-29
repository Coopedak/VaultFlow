#!/usr/bin/env node
/**
 * doctor.mjs — one-command vaultflow health audit.
 *
 * Runs every anomaly check the dashboard knows about plus a few CLI-only
 * ones (scheduled-task status, MCP server boot, etc.) and prints a single
 * report. Exit code = number of failing checks.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require   = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const checks = [];
function ok(name, value, detail = '')   { checks.push({ name, status: 'OK',   value, detail }); }
function warn(name, value, detail = '') { checks.push({ name, status: 'WARN', value, detail }); }
function fail(name, value, detail = '') { checks.push({ name, status: 'FAIL', value, detail }); }

const db = require('./db.cjs');
db.initialize(null, null);
const conn = db.raw();

// 1. DB tables present
try {
  const expected = ['edit_events','sessions','memory_entries','tool_calls','prompts','code_symbols','code_imports','code_calls','git_commits','memory_embeddings','prompt_embeddings','embed_queue'];
  const have = new Set(conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  const missing = expected.filter(t => !have.has(t));
  if (missing.length === 0) ok('schema', 'complete', `${have.size} tables`);
  else fail('schema', `missing ${missing.length}`, `missing: ${missing.join(', ')}`);
} catch (e) { fail('schema', 'error', e.message); }

// 2. Session summary fill rate (last 7d)
try {
  const sess7 = conn.prepare("SELECT COUNT(*) AS n FROM sessions WHERE started_at > date('now','-7 days') AND ended_at IS NOT NULL").get().n;
  const sum7  = conn.prepare("SELECT COUNT(*) AS n FROM session_summaries WHERE summary_at > date('now','-7 days')").get().n;
  const pct = sess7 ? Math.round(100 * sum7 / sess7) : 100;
  const detail = `${sum7}/${sess7} closed sessions summarized`;
  if (pct >= 80) ok('session_fill_rate', `${pct}%`, detail);
  else if (pct >= 50) warn('session_fill_rate', `${pct}%`, detail);
  else fail('session_fill_rate', `${pct}%`, detail);
} catch (e) { fail('session_fill_rate', 'err', e.message); }

// 3. Pattern noise check
try {
  const top = conn.prepare('SELECT pattern_key FROM patterns ORDER BY fire_count DESC LIMIT 1').get();
  const isNoise = top && /^(wal|shm|lock|tmp|cache|pyc)::/.test(top.pattern_key);
  if (!top) ok('pattern_quality', '—', 'no patterns yet');
  else if (isNoise) fail('pattern_quality', top.pattern_key, 'infrastructure noise dominating');
  else ok('pattern_quality', top.pattern_key, 'real signal');
} catch (e) { fail('pattern_quality', 'err', e.message); }

// 4. Vault tools promotion backlog
try {
  const n = conn.prepare('SELECT COUNT(*) AS n FROM vault_tools WHERE use_count >= 5 AND (promoted = 0 OR promoted IS NULL)').get().n;
  if (n === 0) ok('vault_tools_promotion', '0', 'all eligible tools promoted');
  else if (n <= 5) warn('vault_tools_promotion', String(n), 'eligible but not promoted');
  else fail('vault_tools_promotion', String(n), 'large backlog');
} catch (e) { fail('vault_tools_promotion', 'err', e.message); }

// 5. Retrieval activity
try {
  const d7 = conn.prepare("SELECT COUNT(*) AS n FROM retrieval_docs WHERE timestamp > date('now','-7 days')").get().n;
  if (d7 > 0) ok('retrieval_activity', String(d7), 'docs indexed last 7d');
  else warn('retrieval_activity', '0', 'no retrieval activity last 7d');
} catch (e) { fail('retrieval_activity', 'err', e.message); }

// 6. Stale sessions
try {
  const n = conn.prepare("SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL AND started_at < datetime('now','-12 hours')").get().n;
  if (n === 0) ok('stale_sessions', '0', 'no sessions stuck open > 12h');
  else if (n <= 3) warn('stale_sessions', String(n));
  else fail('stale_sessions', String(n), 'many orphaned sessions — nightly will close');
} catch (e) { fail('stale_sessions', 'err', e.message); }

// 7. Nightly heartbeat freshness
try {
  const yaml = require('js-yaml');
  const cfgPath = require('../../config/resolve.cjs');
  const cfg = fs.existsSync(cfgPath) ? yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {} : {};
  const metrics = cfg.paths && cfg.paths.metrics_root;
  if (!metrics) warn('nightly_heartbeat', 'no-metrics-root');
  else {
    const hbPath = path.join(metrics, 'nightly-heartbeat.json');
    if (!fs.existsSync(hbPath)) fail('nightly_heartbeat', 'never', 'install via `npm run nightly:install`');
    else {
      const hb = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
      const ageH = (Date.now() - new Date(hb.last_run_at).getTime()) / 3_600_000;
      if (ageH < 30) ok('nightly_heartbeat', `${ageH.toFixed(1)}h ago`);
      else if (ageH < 72) warn('nightly_heartbeat', `${ageH.toFixed(1)}h ago`, 'nightly hasn\'t run recently');
      else fail('nightly_heartbeat', `${ageH.toFixed(1)}h ago`);
    }
  }
} catch (e) { fail('nightly_heartbeat', 'err', e.message); }

// 8. Embedding coverage
try {
  const total = conn.prepare('SELECT COUNT(*) AS n FROM memory_entries').get().n;
  const emb   = conn.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get().n;
  const pct = total > 0 ? Math.round(100 * emb / total) : 0;
  if (pct >= 95) ok('embedding_coverage', `${pct}%`, `${emb}/${total}`);
  else if (pct >= 50) warn('embedding_coverage', `${pct}%`, `${emb}/${total} — run \`npm run embeddings:backfill\``);
  else if (total === 0) ok('embedding_coverage', 'n/a', 'no memory entries yet');
  else warn('embedding_coverage', `${pct}%`, `${emb}/${total} — likely transformers not installed`);
} catch (e) { warn('embedding_coverage', 'err', e.message); }

// 9. Embed queue backlog
try {
  const n = conn.prepare('SELECT COUNT(*) AS n FROM embed_queue').get().n;
  if (n === 0) ok('embed_queue', '0', 'no pending');
  else if (n < 100) warn('embed_queue', String(n), 'will drain next session-start / watcher tick');
  else fail('embed_queue', String(n), 'backlog growing — check watcher');
} catch (e) { warn('embed_queue', 'err', e.message); }

// 10. Code graph size
try {
  const f = conn.prepare('SELECT COUNT(DISTINCT file) AS n FROM code_symbols').get().n;
  const s = conn.prepare('SELECT COUNT(*) AS n FROM code_symbols').get().n;
  const c = conn.prepare('SELECT COUNT(*) AS n FROM code_calls').get().n;
  if (f > 0) ok('code_graph', `${f}f / ${s}s / ${c}c`, 'files / symbols / call edges');
  else fail('code_graph', '0', 'no files indexed — run watcher or nightly');
} catch (e) { fail('code_graph', 'err', e.message); }

// 11. Watcher daemon
try {
  const r = spawnSync('powershell', ['-Command', "(Get-NetTCPConnection -LocalPort 7700 -ErrorAction SilentlyContinue | Measure-Object).Count"], { encoding: 'utf8', shell: false });
  // Just check whether ANY watcher node process exists
  const w = spawnSync('powershell', ['-Command', "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*watcher.mjs*' -and $_.CommandLine -notlike '*--status*' -and $_.CommandLine -notlike '*--stop*' } | Measure-Object).Count"], { encoding: 'utf8', shell: false });
  const count = parseInt((w.stdout || '0').trim(), 10);
  if (count > 0) ok('watcher_daemon', `${count} proc`);
  else warn('watcher_daemon', 'not running', 'run `npm run watcher`');
} catch (e) { warn('watcher_daemon', 'err', e.message); }

// 13. Doc drift — latest doc-drift report (written by nightly.mjs).
//      Sits next to nightly_heartbeat because it shares the same metrics_root.
try {
  const yaml = require('js-yaml');
  const cfgPath = require('../../config/resolve.cjs');
  const cfg = fs.existsSync(cfgPath) ? yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {} : {};
  const metrics = cfg.paths && cfg.paths.metrics_root;
  if (!metrics) warn('doc_drift', 'no-metrics-root');
  else {
    const latest = path.join(metrics, 'doc-drift', 'latest.json');
    if (!fs.existsSync(latest)) warn('doc_drift', 'never', 'nightly hasn\'t produced a report yet');
    else {
      const r = JSON.parse(fs.readFileSync(latest, 'utf8'));
      const n = (r.drifts || []).length;
      const sections = [...new Set((r.drifts || []).map(d => d.section))].join(', ') || '—';
      if (n === 0) ok('doc_drift', '0', 'CLAUDE.md matches the repo');
      else if (n <= 2) warn('doc_drift', String(n), sections);
      else fail('doc_drift', String(n), sections);
    }
  }
} catch (e) { warn('doc_drift', 'err', e.message); }

// 14. Scheduled task
try {
  const r = spawnSync('powershell', ['-Command', "(Get-ScheduledTask -TaskName 'VaultflowNightly' -ErrorAction SilentlyContinue).State"], { encoding: 'utf8', shell: false });
  const state = (r.stdout || '').trim();
  if (state === 'Ready') ok('scheduled_task', 'Ready');
  else if (!state) warn('scheduled_task', 'not registered', 'run `npm run nightly:install`');
  else warn('scheduled_task', state);
} catch (e) { warn('scheduled_task', 'err', e.message); }

// Report
const colors = { OK: '\x1b[32m', WARN: '\x1b[33m', FAIL: '\x1b[31m', RESET: '\x1b[0m' };
process.stdout.write('\n=== vaultflow doctor ===\n\n');
let nOk = 0, nWarn = 0, nFail = 0;
for (const c of checks) {
  const tag = colors[c.status] + c.status.padEnd(4) + colors.RESET;
  process.stdout.write(`  ${tag}  ${c.name.padEnd(28)} ${String(c.value).padEnd(20)}${c.detail ? '  — ' + c.detail : ''}\n`);
  if (c.status === 'OK') nOk++; else if (c.status === 'WARN') nWarn++; else nFail++;
}
process.stdout.write(`\nSummary: ${nOk} ok / ${nWarn} warn / ${nFail} fail\n`);

db.close();
process.exit(nFail);
