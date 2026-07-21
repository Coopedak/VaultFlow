#!/usr/bin/env node
/**
 * doctor.mjs — one-command vaultflow health audit.
 *
 * Runs every anomaly check the dashboard knows about plus a few CLI-only
 * ones (scheduled-task status, MCP server boot, etc.) and prints a single
 * report. Exit code = number of failing checks.
 *
 * Structure: the OK/WARN/FAIL decision for each metric lives in a pure,
 * exported `classify*` function (unit-tested in tests/doctorClassifiers.test.mjs).
 * The runner does the DB/IO and feeds numbers to the classifiers. Importing
 * this module is side-effect free — the audit only runs when executed directly
 * (the isMain guard), so tests can import the classifiers without opening the
 * DB or exiting the process.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require   = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── pure classifiers (exported, unit-tested) ───────────────────────────────
// Each returns { status: 'OK'|'WARN'|'FAIL', value, detail } from already-
// computed numbers — no DB, no IO, no globals.

const NOISE_PATTERN = /^(wal|shm|lock|tmp|cache|pyc)::/;

function classifySchema(missing, haveCount) {
  return missing.length === 0
    ? { status: 'OK',   value: 'complete',                 detail: `${haveCount} tables` }
    : { status: 'FAIL', value: `missing ${missing.length}`, detail: `missing: ${missing.join(', ')}` };
}

function classifyFillRate(summarized, closed) {
  const pct    = closed ? Math.round(100 * summarized / closed) : 100;
  const detail = `${summarized}/${closed} closed sessions summarized`;
  const status = pct >= 80 ? 'OK' : pct >= 50 ? 'WARN' : 'FAIL';
  return { status, value: `${pct}%`, detail };
}

function classifyPatternQuality(topKey) {
  if (!topKey)                       return { status: 'OK',   value: '—',     detail: 'no patterns yet' };
  if (NOISE_PATTERN.test(topKey))    return { status: 'FAIL', value: topKey,  detail: 'infrastructure noise dominating' };
  return { status: 'OK', value: topKey, detail: 'real signal' };
}

function classifyVaultToolsPromotion(n) {
  if (n === 0) return { status: 'OK',   value: '0',        detail: 'all eligible tools promoted' };
  if (n <= 5)  return { status: 'WARN', value: String(n),  detail: 'eligible but not promoted' };
  return { status: 'FAIL', value: String(n), detail: 'large backlog' };
}

function classifyRetrievalActivity(d7) {
  return d7 > 0
    ? { status: 'OK',   value: String(d7), detail: 'docs indexed last 7d' }
    : { status: 'WARN', value: '0',        detail: 'no retrieval activity last 7d' };
}

function classifyStaleSessions(n) {
  if (n === 0) return { status: 'OK',   value: '0',       detail: 'no sessions stuck open > 12h' };
  if (n <= 3)  return { status: 'WARN', value: String(n), detail: '' };
  return { status: 'FAIL', value: String(n), detail: 'many orphaned sessions — nightly will close' };
}

function classifyHeartbeat(ageH) {
  const v = `${ageH.toFixed(1)}h ago`;
  if (ageH < 30) return { status: 'OK',   value: v, detail: '' };
  if (ageH < 72) return { status: 'WARN', value: v, detail: "nightly hasn't run recently" };
  return { status: 'FAIL', value: v, detail: '' };
}

// Coverage of LIVE entries + orphan-bloat detection. A raw emb/total ratio can
// exceed 100% when source rows are deleted but their vectors linger; counting
// those as "coverage" once hid a 29k-orphan / 4.8x-bloat problem as green.
function classifyEmbeddingCoverage(total, emb, orphans) {
  const live = emb - orphans;
  const pct  = total > 0 ? Math.round(100 * live / total) : 0;
  if (total === 0)                       return { status: 'OK',   value: 'n/a', detail: 'no memory entries yet' };
  if (orphans > 1000 && orphans >= total) return { status: 'FAIL', value: `${orphans} orphans`,        detail: `${live}/${total} live — nightly purge-orphan-embeddings will clear` };
  if (orphans > 500)                      return { status: 'WARN', value: `${pct}% +${orphans} orphans`, detail: `${live}/${total} live — nightly purge-orphan-embeddings will clear` };
  if (pct >= 95)                          return { status: 'OK',   value: `${pct}%`, detail: `${live}/${total}` };
  if (pct >= 50)                          return { status: 'WARN', value: `${pct}%`, detail: `${live}/${total} — run \`npm run embeddings:backfill\`` };
  return { status: 'WARN', value: `${pct}%`, detail: `${live}/${total} — likely transformers not installed` };
}

// Age-aware: a large but fresh backlog is normal and drains. Only a queue whose
// OLDEST row survived a full nightly cycle (>26h) signals a stuck drainer.
function classifyEmbedQueue(n, ageH) {
  if (n === 0)     return { status: 'OK',   value: '0', detail: 'no pending' };
  if (ageH > 26)   return { status: 'FAIL', value: `${n} (oldest ${ageH.toFixed(0)}h)`, detail: 'survived a nightly cycle — drainer stuck, check watcher' };
  if (n >= 100)    return { status: 'WARN', value: String(n), detail: `draining (oldest ${ageH.toFixed(1)}h)` };
  return { status: 'OK', value: String(n), detail: `draining (oldest ${ageH.toFixed(1)}h)` };
}

// `isFresh` = this install has no history at all (no sessions recorded yet).
// A blank machine has an empty code graph BY DEFINITION, and greeting a new
// user with a red FAIL for correctly-completed setup teaches them to ignore the
// doctor. On an established install an empty graph is still a real failure.
// Weekly archive backup freshness. A backup is trusted, so a backup that stops
// running silently is worse than none at all — the nightly task once sat dead
// for 99h with nothing surfacing it. Grace is generous (9d) because the task is
// weekly and may legitimately catch up a day or two late after time off.
function classifyArchiveBackup(ageDays, failed) {
  if (ageDays === null)  return { status: 'WARN', value: 'never',  detail: 'install via `npm run backup:install`' };
  const v = `${ageDays.toFixed(1)}d ago`;
  if (failed > 0)        return { status: 'FAIL', value: v, detail: `${failed} project(s) failed to copy` };
  if (ageDays <= 9)      return { status: 'OK',   value: v, detail: '' };
  if (ageDays <= 21)     return { status: 'WARN', value: v, detail: 'weekly backup is overdue' };
  return { status: 'FAIL', value: v, detail: 'archive backup has not run in 3+ weeks' };
}

function classifyCodeGraph(files, symbols, calls, isFresh) {
  if (files > 0) return { status: 'OK', value: `${files}f / ${symbols}s / ${calls}c`, detail: 'files / symbols / call edges' };
  return isFresh
    ? { status: 'OK',   value: 'pending', detail: 'fresh install — indexes on first watcher/nightly run' }
    : { status: 'FAIL', value: '0',       detail: 'no files indexed — run watcher or nightly' };
}

function classifyWatcher(count) {
  return count > 0
    ? { status: 'OK',   value: `${count} proc`, detail: '' }
    : { status: 'WARN', value: 'not running',   detail: 'run `npm run watcher`' };
}

// Config-path existence. A config copied from another machine (or a renamed
// user profile) leaves every vault path dangling while all DB-only checks stay
// green — exactly how this repo ran "healthy" for weeks with a dead
// C:\Users\<old-user> config. Half-or-more missing is that migration signature.
function classifyConfigPaths(missing, checked) {
  if (checked === 0)        return { status: 'WARN', value: 'none',  detail: 'no checkable paths in config' };
  if (missing.length === 0) return { status: 'OK',   value: `${checked} paths exist`, detail: '' };
  const names = missing.map(m => m.key).join(', ');
  const v = `${missing.length}/${checked} missing`;
  if (missing.length * 2 >= checked) {
    return { status: 'FAIL', value: v, detail: `config likely from another machine — ${names}` };
  }
  return { status: 'WARN', value: v, detail: names };
}

function classifyDocDrift(n, sections) {
  if (n === 0) return { status: 'OK',   value: '0',       detail: 'CLAUDE.md matches the repo' };
  if (n <= 2)  return { status: 'WARN', value: String(n), detail: sections };
  return { status: 'FAIL', value: String(n), detail: sections };
}

function classifyScheduledTask(state) {
  if (state === 'Ready') return { status: 'OK',   value: 'Ready',          detail: '' };
  if (!state)            return { status: 'WARN', value: 'not registered', detail: 'run `npm run nightly:install`' };
  return { status: 'WARN', value: state, detail: '' };
}

// ── runner (DB + IO; only invoked when run as a script) ─────────────────────

function runChecks() {
  const checks = [];
  const emit = (name, r) => checks.push({ name, status: r.status, value: r.value, detail: r.detail });
  // Direct emitters for IO/path branches that aren't pure-numeric decisions.
  const ok   = (name, value, detail = '') => checks.push({ name, status: 'OK',   value, detail });
  const warn = (name, value, detail = '') => checks.push({ name, status: 'WARN', value, detail });
  const fail = (name, value, detail = '') => checks.push({ name, status: 'FAIL', value, detail });

  const db = require('./db.cjs');
  db.initialize(null, null);
  const conn = db.raw();

  // A machine that has recorded no sessions has simply not been used yet. Some
  // checks measure accumulated history, and on a brand-new install those are
  // legitimately empty — reporting them as FAIL makes a correct setup look
  // broken and trains new users to distrust the doctor.
  let isFreshInstall = false;
  try {
    isFreshInstall = conn.prepare('SELECT COUNT(*) AS n FROM sessions').get().n === 0;
  } catch (_) { /* schema check below reports the real problem */ }

  // 1. DB tables present
  try {
    const expected = ['edit_events','sessions','memory_entries','tool_calls','prompts','code_symbols','code_imports','code_calls','git_commits','memory_embeddings','prompt_embeddings','embed_queue'];
    const have = new Set(conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const missing = expected.filter(t => !have.has(t));
    emit('schema', classifySchema(missing, have.size));
  } catch (e) { fail('schema', 'error', e.message); }

  // 2. Session summary fill rate (last 7d)
  try {
    const sess7 = conn.prepare("SELECT COUNT(*) AS n FROM sessions WHERE started_at > date('now','-7 days') AND ended_at IS NOT NULL").get().n;
    const sum7  = conn.prepare("SELECT COUNT(*) AS n FROM session_summaries WHERE summary_at > date('now','-7 days')").get().n;
    emit('session_fill_rate', classifyFillRate(sum7, sess7));
  } catch (e) { fail('session_fill_rate', 'err', e.message); }

  // 3. Pattern noise check
  try {
    const top = conn.prepare('SELECT pattern_key FROM patterns ORDER BY fire_count DESC LIMIT 1').get();
    emit('pattern_quality', classifyPatternQuality(top && top.pattern_key));
  } catch (e) { fail('pattern_quality', 'err', e.message); }

  // 4. Vault tools promotion backlog
  try {
    const n = conn.prepare('SELECT COUNT(*) AS n FROM vault_tools WHERE use_count >= 5 AND (promoted = 0 OR promoted IS NULL)').get().n;
    emit('vault_tools_promotion', classifyVaultToolsPromotion(n));
  } catch (e) { fail('vault_tools_promotion', 'err', e.message); }

  // 5. Retrieval activity
  try {
    const d7 = conn.prepare("SELECT COUNT(*) AS n FROM retrieval_docs WHERE timestamp > date('now','-7 days')").get().n;
    emit('retrieval_activity', classifyRetrievalActivity(d7));
  } catch (e) { fail('retrieval_activity', 'err', e.message); }

  // 6. Stale sessions
  try {
    const n = conn.prepare("SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL AND started_at < datetime('now','-12 hours')").get().n;
    emit('stale_sessions', classifyStaleSessions(n));
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
      if (!fs.existsSync(hbPath)) {
        // Distinguish "never installed" from "installed but has not run yet".
        if (isFreshInstall) emit('nightly_heartbeat', { status: 'OK', value: 'pending', detail: 'fresh install — first run is scheduled for 03:00' });
        else fail('nightly_heartbeat', 'never', 'install via `npm run nightly:install`');
      }
      else {
        const hb = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
        const ageH = (Date.now() - new Date(hb.last_run_at).getTime()) / 3_600_000;
        emit('nightly_heartbeat', classifyHeartbeat(ageH));
      }
    }
  } catch (e) { fail('nightly_heartbeat', 'err', e.message); }

  // 7b. Weekly archive backup (working drive -> long-term archive drive)
  try {
    const yaml = require('js-yaml');
    const cfgPath = require('../../config/resolve.cjs');
    const cfg = fs.existsSync(cfgPath) ? yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {} : {};
    const metrics = cfg.paths && cfg.paths.metrics_root;
    const hbPath = metrics && path.join(metrics, 'archive-backup-heartbeat.json');
    if (!hbPath || !fs.existsSync(hbPath)) {
      emit('archive_backup', classifyArchiveBackup(null, 0));
    } else {
      // stripBom: PowerShell 5.1's `Set-Content -Encoding utf8` writes a BOM,
      // which JSON.parse rejects. The writer avoids it now; tolerate old files.
      const raw = fs.readFileSync(hbPath, 'utf8').replace(/^﻿/, '');
      const hb = JSON.parse(raw);
      const ageDays = (Date.now() - new Date(hb.last_run_at).getTime()) / 86_400_000;
      emit('archive_backup', classifyArchiveBackup(ageDays, hb.failed || 0));
    }
  } catch (e) { warn('archive_backup', 'err', e.message); }

  // 8. Embedding coverage of LIVE entries + orphan-bloat detection
  try {
    const total   = conn.prepare('SELECT COUNT(*) AS n FROM memory_entries').get().n;
    const emb     = conn.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get().n;
    const orphans = conn.prepare('SELECT COUNT(*) AS n FROM memory_embeddings me LEFT JOIN memory_entries m ON m.id = me.memory_id WHERE m.id IS NULL').get().n;
    emit('embedding_coverage', classifyEmbeddingCoverage(total, emb, orphans));
  } catch (e) { warn('embedding_coverage', 'err', e.message); }

  // 9. Embed queue backlog — age-aware
  try {
    const n = conn.prepare('SELECT COUNT(*) AS n FROM embed_queue').get().n;
    let ageH = 0;
    if (n > 0) {
      const oldest = conn.prepare('SELECT MIN(queued_at) AS t FROM embed_queue').get().t;
      ageH = oldest ? (Date.now() - new Date(oldest).getTime()) / 3_600_000 : 0;
    }
    emit('embed_queue', classifyEmbedQueue(n, ageH));
  } catch (e) { warn('embed_queue', 'err', e.message); }

  // 10. Code graph size
  try {
    const f = conn.prepare('SELECT COUNT(DISTINCT file) AS n FROM code_symbols').get().n;
    const s = conn.prepare('SELECT COUNT(*) AS n FROM code_symbols').get().n;
    const c = conn.prepare('SELECT COUNT(*) AS n FROM code_calls').get().n;
    emit('code_graph', classifyCodeGraph(f, s, c, isFreshInstall));
  } catch (e) { fail('code_graph', 'err', e.message); }

  // 11. Watcher daemon
  try {
    const w = spawnSync('powershell', ['-Command', "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*watcher.mjs*' -and $_.CommandLine -notlike '*--status*' -and $_.CommandLine -notlike '*--stop*' } | Measure-Object).Count"], { encoding: 'utf8', shell: false });
    const count = parseInt((w.stdout || '0').trim(), 10);
    emit('watcher_daemon', classifyWatcher(count));
  } catch (e) { warn('watcher_daemon', 'err', e.message); }

  // 12. Config-path existence — every paths.* entry must point at something real.
  try {
    const yaml = require('js-yaml');
    const cfgPath = require('../../config/resolve.cjs');
    const cfg = fs.existsSync(cfgPath) ? yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {} : {};
    const paths = cfg.paths || {};
    const missing = [];
    let checked = 0;
    for (const [key, value] of Object.entries(paths)) {
      if (typeof value !== 'string' || !value.trim()) continue; // skip arrays (exclude lists)
      // Exclusion prefixes may legitimately reference retired drives/machines.
      if (key.startsWith('exclude')) continue;
      // Globs: validate the fixed base directory before the first wildcard.
      const wild = value.search(/[*?]/);
      const probe = wild === -1 ? value : path.dirname(value.slice(0, wild) + '_');
      checked++;
      if (!fs.existsSync(probe)) missing.push({ key, path: probe });
    }
    emit('config_paths', classifyConfigPaths(missing, checked));
  } catch (e) { warn('config_paths', 'err', e.message); }

  // 13. Doc drift — latest doc-drift report (written by nightly.mjs)
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
        emit('doc_drift', classifyDocDrift(n, sections));
      }
    }
  } catch (e) { warn('doc_drift', 'err', e.message); }

  // 14. Scheduled task
  try {
    const r = spawnSync('powershell', ['-Command', "(Get-ScheduledTask -TaskName 'VaultflowNightly' -ErrorAction SilentlyContinue).State"], { encoding: 'utf8', shell: false });
    emit('scheduled_task', classifyScheduledTask((r.stdout || '').trim()));
  } catch (e) { warn('scheduled_task', 'err', e.message); }

  db.close();
  return checks;
}

// ── report ──────────────────────────────────────────────────────────────────

function render(checks) {
  const colors = { OK: '\x1b[32m', WARN: '\x1b[33m', FAIL: '\x1b[31m', RESET: '\x1b[0m' };
  process.stdout.write('\n=== vaultflow doctor ===\n\n');
  let nOk = 0, nWarn = 0, nFail = 0;
  for (const c of checks) {
    const tag = colors[c.status] + c.status.padEnd(4) + colors.RESET;
    process.stdout.write(`  ${tag}  ${c.name.padEnd(28)} ${String(c.value).padEnd(20)}${c.detail ? '  — ' + c.detail : ''}\n`);
    if (c.status === 'OK') nOk++; else if (c.status === 'WARN') nWarn++; else nFail++;
  }
  process.stdout.write(`\nSummary: ${nOk} ok / ${nWarn} warn / ${nFail} fail\n`);
  return nFail;
}

// ── main ──────────────────────────────────────────────────────────────────
// Only run the audit (and exit) when executed directly. Importing this module
// — e.g. a unit test pulling in the classifiers — must not open the DB or exit.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

if (isMain) {
  const nFail = render(runChecks());
  process.exit(nFail);
}

export {
  classifySchema,
  classifyFillRate,
  classifyPatternQuality,
  classifyVaultToolsPromotion,
  classifyRetrievalActivity,
  classifyStaleSessions,
  classifyHeartbeat,
  classifyEmbeddingCoverage,
  classifyEmbedQueue,
  classifyArchiveBackup,
  classifyCodeGraph,
  classifyWatcher,
  classifyConfigPaths,
  classifyDocDrift,
  classifyScheduledTask,
};
