#!/usr/bin/env node
/**
 * nightly.mjs — vaultflow nightly maintenance.
 *
 * One script that runs everything that should happen automatically every
 * night. The dashboard was reporting "healthy" because it surfaced raw row
 * counts (which were growing) rather than anomalies — meanwhile sessions
 * weren't being summarized, patterns were 97% noise, and vault tools sat
 * unpromoted. This script enforces the maintenance contract.
 *
 * Steps (each is idempotent and individually error-isolated):
 *   1. Close stale sessions (no SessionEnd fired)
 *   2. Backfill missing session_summaries from edit_events
 *   3. Recompute session aggregates
 *   4. Auto-promote vault_tools at use_count >= 5
 *   5. Run retrieval learning loop
 *   6. Purge known-noise pattern rows
 *   7. Refresh project stack detection across C:/GIT/*
 *   8. Refresh code-graph for projects touched in the last 24h
 *   9. Flush SQLite → Parquet for archival
 *
 * Usage:
 *   node .claude/helpers/nightly.mjs                  # run all
 *   node .claude/helpers/nightly.mjs --skip-parquet   # skip the long step
 *   node .claude/helpers/nightly.mjs --dry-run        # report only
 *
 * Exit code: 0 always (errors logged to stderr, summary printed to stdout).
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const require   = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DRY_RUN      = process.argv.includes('--dry-run');
const SKIP_PARQUET = process.argv.includes('--skip-parquet');
const SKIP_GRAPH   = process.argv.includes('--skip-graph');

function log(msg)   { process.stdout.write(`[nightly] ${msg}\n`); }
function warn(msg)  { process.stderr.write(`[nightly] WARN ${msg}\n`); }

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    log(`${name} — ok (${dt}s)${r ? ' ' + JSON.stringify(r) : ''}`);
    return r;
  } catch (err) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    warn(`${name} — ${err.message} (${dt}s)`);
    return null;
  }
}

const db = require('./db.cjs');
db.initialize(null, null);

const results = {};
log(`starting ${DRY_RUN ? '(dry-run) ' : ''}@ ${new Date().toISOString()}`);

// 1. close stale sessions
results.stale = await step('close-stale-sessions', () => DRY_RUN ? { skipped: true } : db.closeStaleSessions(12));

// 2. backfill missing summaries
results.summaries = await step('backfill-summaries', () => DRY_RUN ? { skipped: true } : db.backfillMissingSessionSummaries(500));

// 3. recompute aggregates (cheap and always correct)
results.aggregates = await step('recompute-aggregates', () => DRY_RUN ? { skipped: true } : db.recomputeAllSessionAggregates());

// 4. auto-promote vault tools
results.promotion = await step('promote-vault-tools', () => {
  const eligible = db.getUnpromotedVaultTools(5);
  if (DRY_RUN) return { eligible: eligible.length };
  let promoted = 0;
  for (const t of eligible) { try { db.promoteVaultTool(t.id); promoted++; } catch (_) {} }
  return { promoted, eligible: eligible.length };
});

// 5. retrieval learning loop
results.learning = await step('retrieval-learning', () => DRY_RUN ? { skipped: true } : db.runRetrievalLearningLoop());

// 6. purge noise patterns (the denylist now blocks new ones, this catches legacy rows)
results.noise = await step('purge-noise-patterns', () => {
  if (DRY_RUN) return { skipped: true };
  const conn = db.raw();
  const noisyParents = ['cache','.cache','node_modules','dist','build','bin','obj','.next','.parcel-cache','.turbo','__pycache__','.pytest_cache','.vs','.vscode','.idea'];
  let deleted = 0;
  const re = conn.prepare(`DELETE FROM patterns WHERE pattern_key LIKE '%::' || ?`);
  for (const p of noisyParents) deleted += re.run(p).changes || 0;
  deleted += conn.prepare(`DELETE FROM patterns WHERE pattern_key LIKE 'wal::%' OR pattern_key LIKE 'shm::%' OR pattern_key LIKE 'lock::%' OR pattern_key LIKE 'tmp::%' OR pattern_key LIKE 'pyc::%' OR pattern_key = 'noext::data' OR pattern_key = 'noext::cache'`).run().changes || 0;
  return { deleted };
});

// 7. refresh project stacks
results.stacks = await step('detect-stacks', async () => {
  if (DRY_RUN) return { skipped: true };
  const sd = await import(pathToFileURL(path.resolve(__dirname, 'stack-detector.mjs')).href);
  const ROOT = process.env.VAULTFLOW_GIT_ROOT || 'C:/GIT';
  if (!fs.existsSync(ROOT)) return { skipped: 'no-git-root' };
  const projects = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name);
  let detected = 0;
  for (const proj of projects) {
    try {
      const r = await sd.detectAndStore(path.join(ROOT, proj), proj);
      if (r && r.length) detected += r.length;
    } catch (_) {}
  }
  return { projects: projects.length, stacks: detected };
});

// 8. refresh code graph for projects with edits in the last 24h
results.graph = await step('refresh-code-graph', async () => {
  if (DRY_RUN || SKIP_GRAPH) return { skipped: true };
  const cg = require('./code-graph.cjs');
  const conn = db.raw();
  const projects = conn.prepare(
    `SELECT DISTINCT project FROM edit_events WHERE timestamp > datetime('now','-24 hours') AND project IS NOT NULL`
  ).all().map(r => r.project);
  if (!projects.length) return { skipped: 'no-recent-projects' };
  const ROOT = process.env.VAULTFLOW_GIT_ROOT || 'C:/GIT';
  let indexed = 0;
  function* walk(dir, depth = 0) {
    if (depth > 12) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && depth > 0) continue;
      if (['node_modules','.git','dist','build','bin','obj','.next','target','.venv','venv','__pycache__'].includes(e.name)) continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) yield* walk(fp, depth + 1);
      else if (e.isFile() && cg.shouldIndex(fp)) yield fp;
    }
  }
  for (const proj of projects) {
    const projDir = path.join(ROOT, proj);
    if (!fs.existsSync(projDir)) continue;
    for (const fp of walk(projDir)) {
      try { cg.indexFile(db, fp, proj); indexed++; } catch (_) {}
    }
  }
  return { projects: projects.length, files: indexed };
});

// 8b. detect stale memory entries (source files that vanished)
results.staleMemory = await step('detect-stale-memory', () => DRY_RUN ? { skipped: true } : db.detectStaleMemory());

// 8c. detect stale vault tools (registered path no longer exists)
results.staleTools = await step('detect-stale-vault-tools', () => DRY_RUN ? { skipped: true } : db.detectStaleVaultTools());

// 9. flush to Parquet
results.parquet = await step('flush-parquet', async () => {
  if (DRY_RUN || SKIP_PARQUET) return { skipped: true };
  const yaml = require('js-yaml');
  const cfgPath = require('../../config/resolve.cjs');
  if (!fs.existsSync(cfgPath)) return { skipped: 'no-config' };
  const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
  const metrics = cfg.paths && cfg.paths.metrics_root;
  const parquetDir = (cfg.storage && cfg.storage.parquet_dir) || 'parquet';
  if (!metrics) return { skipped: 'no-paths' };
  // flushToParquet expects the relative parquet_dir name; it joins with metrics internally.
  const a = await db.flushToParquet(metrics, parquetDir);
  const b = await db.flushTelemetryToParquet(metrics, parquetDir);
  return { edits: a, telemetry: b };
});

log(`done @ ${new Date().toISOString()}`);
log(`summary: ${JSON.stringify(results)}`);

// Write a heartbeat file so the dashboard health endpoint can flag missing runs.
try {
  const yaml = require('js-yaml');
  const cfgPath = require('../../config/resolve.cjs');
  if (fs.existsSync(cfgPath)) {
    const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
    const metrics = cfg.paths && cfg.paths.metrics_root;
    if (metrics) {
      const hbPath = path.join(metrics, 'nightly-heartbeat.json');
      fs.writeFileSync(hbPath, JSON.stringify({
        last_run_at: new Date().toISOString(),
        results,
        host: os.hostname(),
      }, null, 2), 'utf8');
    }
  }
} catch (err) { warn(`heartbeat write — ${err.message}`); }

db.close();
process.exit(0);
