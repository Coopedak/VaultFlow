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

// 4b. record daily brain vitals snapshot (trend data for the dashboard)
results.snapshot = await step('brain-snapshot', () => {
  if (DRY_RUN) return { skipped: true };
  const today = new Date().toISOString().slice(0, 10);
  const conn = db.raw();
  const one = (sql) => { try { return conn.prepare(sql).get()?.v ?? 0; } catch (_) { return 0; } };
  const metrics = {
    'patterns.count':        one(`SELECT COUNT(*) v FROM patterns`),
    'patterns.fires.total':  one(`SELECT COALESCE(SUM(fire_count),0) v FROM patterns`),
    'memory.count':          one(`SELECT COUNT(*) v FROM memory_entries`),
    'memory.stale.count':    one(`SELECT COUNT(*) v FROM memory_stale`),
    'sessions.total':        one(`SELECT COUNT(*) v FROM sessions`),
    'tools.calls.total':     one(`SELECT COUNT(*) v FROM tool_calls`),
    'verdicts.total':        one(`SELECT COUNT(*) v FROM agent_verdicts`),
    'verdicts.approved':     one(`SELECT COUNT(*) v FROM agent_verdicts WHERE verdict='APPROVED'`),
    'embeddings.memory':     one(`SELECT COUNT(*) v FROM memory_embeddings`),
  };
  let n = 0;
  for (const [metric, value] of Object.entries(metrics)) { db.recordBrainSnapshot(today, metric, '', value); n++; }
  return { metrics: n };
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

// 8d. index git commits across all known projects
results.commits = await step('index-git-commits', () => {
  if (DRY_RUN) return { skipped: true };
  const ci = require('./commit-indexer.cjs');
  const ROOT = process.env.VAULTFLOW_GIT_ROOT || 'C:/GIT';
  return ci.indexAllProjects(db, ROOT);
});

// 8e. embeddings backfill — incremental, only embeds new memory entries.
// Skipped if transformers package isn't installed (npm install @xenova/transformers).
results.embeddings = await step('embeddings-backfill', async () => {
  if (DRY_RUN) return { skipped: true };
  try {
    const m = await import('./embeddings.mjs');
    return await m.backfillEmbeddings();
  } catch (err) {
    return { skipped: err.message.includes('@xenova') ? 'transformers-not-installed' : err.message };
  }
});

// 8e2. symbol embeddings — drains embed_queue rows enqueued by code-graph
// for symbols whose content_hash changed. Bounded per-night to avoid the
// nightly run ballooning; remaining queue carries to the next night.
results.symbolEmbeds = await step('symbol-embeddings-drain', async () => {
  if (DRY_RUN) return { skipped: true };
  try {
    const m = await import('./embeddings.mjs');
    const out = await m.processSymbolEmbedQueue({ batchSize: 500 });
    const stats = db.getSymbolEmbeddingStats ? db.getSymbolEmbeddingStats() : null;
    return { ...out, stats };
  } catch (err) {
    return { skipped: err.message.includes('@xenova') ? 'transformers-not-installed' : err.message };
  }
});

// 8f. vault-librarian sync — reconcile dictionary, vault_tools, vault_agents
results.librarian = await step('vault-librarian-sync', async () => {
  if (DRY_RUN) return { skipped: true };
  const conn = db.raw();
  const out = { dict_imported: 0, tools_registered: 0, agents_registered: 0, dict_noise_purged: 0 };

  // dictionary import from vault/domain/
  try {
    const dict = require('./dict.mjs');
    if (dict && typeof dict.importFromVaultDomain === 'function') {
      out.dict_imported = await dict.importFromVaultDomain();
    } else {
      // CLI fallback — module shape may export differently
      const { execSync } = require('child_process');
      const o = execSync(`node "${path.join(__dirname, 'dict.mjs')}" --import`, { encoding: 'utf8' });
      const m = o.match(/Imported (\d+) terms/);
      out.dict_imported = m ? Number(m[1]) : 0;
    }
  } catch (err) { out.dict_error = err.message; }

  // vault_tools + vault_agents backfill via backfill.mjs
  try {
    const { execSync } = require('child_process');
    const bf = path.join(__dirname, 'backfill.mjs');
    const t = execSync(`node "${bf}" --tools-only`, { encoding: 'utf8' });
    const a = execSync(`node "${bf}" --skills-only`, { encoding: 'utf8' });
    out.tools_registered = Number((t.match(/Tools registered: (\d+)/) || [])[1] || 0);
    out.agents_registered = Number((a.match(/Agents total registered: (\d+)/) || [])[1] || 0);
  } catch (err) { out.backfill_error = err.message; }

  // purge auto-detected pattern entries from dictionary (these belong in patterns table, not FTS dictionary)
  try {
    const r = conn.prepare(
      `DELETE FROM dictionary WHERE category = 'pattern' AND definition LIKE 'Auto-detected:%'`
    ).run();
    out.dict_noise_purged = r.changes || 0;
  } catch (err) { out.purge_error = err.message; }

  return out;
});

// 8g. pattern-analyst audit — surface anomalies for monitoring
results.patterns = await step('pattern-analyst-audit', () => {
  if (DRY_RUN) return { skipped: true };
  const conn = db.raw();
  const total = conn.prepare(`SELECT COUNT(*) AS n FROM patterns`).get().n;
  const promoteNow = conn.prepare(
    `SELECT COUNT(*) AS n FROM patterns WHERE fire_count >= 20 AND confidence >= 0.7 AND promoted = 0`
  ).get().n;
  const nullAgent = conn.prepare(`SELECT COUNT(*) AS n FROM patterns WHERE agent IS NULL`).get().n;
  const promoted = conn.prepare(`SELECT COUNT(*) AS n FROM patterns WHERE promoted = 1`).get().n;
  // auto-promote any ready candidates
  const candidates = conn.prepare(
    `SELECT rowid FROM patterns WHERE fire_count >= 20 AND confidence >= 0.7 AND promoted = 0`
  ).all();
  let promotedThisRun = 0;
  for (const c of candidates) {
    try {
      conn.prepare(`UPDATE patterns SET promoted = 1 WHERE rowid = ?`).run(c.rowid);
      promotedThisRun++;
    } catch (_) {}
  }
  return { total, promoteNow, nullAgent, promoted, promotedThisRun };
});

// 8h. agent-usage snapshot — daily JSON of which agents fired, which never have
results.agentUsage = await step('agent-usage-snapshot', () => {
  if (DRY_RUN) return { skipped: true };
  const conn = db.raw();
  const today = new Date().toISOString().slice(0, 10);

  const topUsed = conn.prepare(`
    SELECT name, source, use_count, last_used
    FROM vault_agents
    WHERE use_count > 0
    ORDER BY use_count DESC LIMIT 25
  `).all();

  const recent24h = conn.prepare(`
    SELECT name, source, use_count, last_used
    FROM vault_agents
    WHERE last_used > datetime('now', '-24 hours')
    ORDER BY last_used DESC
  `).all();

  const neverUsed = conn.prepare(`
    SELECT name, source FROM vault_agents
    WHERE use_count = 0 OR use_count IS NULL
    ORDER BY name
  `).all();

  const totals = conn.prepare(`
    SELECT
      COUNT(*) AS registered,
      SUM(CASE WHEN use_count > 0 THEN 1 ELSE 0 END) AS ever_used,
      SUM(CASE WHEN last_used > datetime('now','-24 hours') THEN 1 ELSE 0 END) AS active_24h,
      SUM(use_count) AS total_invocations
    FROM vault_agents
  `).get();

  try {
    const yaml = require('js-yaml');
    const cfgPath = require('../../config/resolve.cjs');
    const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
    const metrics = cfg.paths && cfg.paths.metrics_root;
    if (metrics) {
      const outDir = path.join(metrics, 'agent-usage');
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, `agent-usage-${today}.json`);
      fs.writeFileSync(outPath, JSON.stringify({
        date: today,
        totals,
        topUsed,
        active_last_24h: recent24h,
        never_used_sample: neverUsed.slice(0, 30),
        never_used_count: neverUsed.length,
      }, null, 2), 'utf8');
    }
  } catch (_) {}

  return { ...totals, top: topUsed.length, active_24h: recent24h.length, never: neverUsed.length };
});

// 8i. routing-coverage audit — for prompts in last 24h, what agents *should* have matched?
//     surfaces routing misses so descriptions can be tuned with better trigger phrases.
results.routingAudit = await step('routing-coverage-audit', () => {
  if (DRY_RUN) return { skipped: true };
  const conn = db.raw();
  const today = new Date().toISOString().slice(0, 10);

  // recent prompts (excluding tiny/empty ones)
  let prompts;
  try {
    prompts = conn.prepare(`
      SELECT id, prompt_text, timestamp
      FROM prompts
      WHERE timestamp > datetime('now', '-24 hours')
        AND prompt_text IS NOT NULL
        AND LENGTH(prompt_text) >= 20
      ORDER BY timestamp DESC
      LIMIT 200
    `).all();
  } catch (err) {
    return { skipped: 'prompts-table-missing', error: err.message };
  }

  // BM25 search against vault_agents_fts (added 2026-05-21). Falls back to
  // word-overlap if the FTS table is missing (older DB schemas).
  const STRONG_BM25 = -5;  // bm25 returns negative; <= -5 = clearly relevant
  const misses = [];
  let strongMatches = 0;
  let usedFts = false;
  try {
    // sanity: confirm FTS table exists
    conn.prepare(`SELECT 1 FROM vault_agents_fts LIMIT 1`).get();
    usedFts = true;
  } catch (_) { usedFts = false; }

  if (usedFts) {
    for (const p of prompts) {
      let cands;
      try { cands = db.searchVaultAgents(p.prompt_text, 5); }
      catch (_) { continue; }
      if (!cands || !cands.length) continue;
      const top = cands[0];
      if (top.rank > STRONG_BM25) continue; // weak match
      strongMatches++;
      const promptTs = Date.parse(p.timestamp);
      const fired = cands.slice(0, 3).some(c => {
        if (!c.last_used) return false;
        return Math.abs(Date.parse(c.last_used) - promptTs) < 5 * 60 * 1000;
      });
      if (!fired) {
        misses.push({
          prompt_id: p.id,
          ts: p.timestamp,
          snippet: String(p.prompt_text).slice(0, 140).replace(/\s+/g, ' '),
          candidates: cands.slice(0, 3).map(c => ({
            name: c.name, rank: Number(c.rank.toFixed(2)), use_count: c.use_count,
          })),
        });
      }
    }
  } else {
    // Legacy word-overlap fallback
    const STOP = new Set(['the','and','for','with','that','this','have','from','are','was','will','can','you','our','its','but','not','they','what','when','how','why','should','would','could','about','any','all','one','also','just','like','need','want','your','their','there','here','now','then','some','more','than','only','make','add','use','using','run','set','get','put','let','do','does','did','been','being','were','has','had','out','off','on','to','in','of','it','is','as','at','be','by','or','if','an','a']);
    function tokens(s) {
      return new Set(String(s || '').toLowerCase().replace(/[^\w\s-]/g, ' ').split(/\s+/)
        .filter(w => w.length >= 4 && w.length <= 30 && !STOP.has(w)));
    }
    const agents = conn.prepare(`
      SELECT id, name, description, use_count, last_used FROM vault_agents
      WHERE description IS NOT NULL AND LENGTH(description) > 30
    `).all();
    const agentTokens = agents.map(a => ({ ...a, toks: tokens(a.description + ' ' + a.name) }));
    for (const p of prompts) {
      const pToks = tokens(p.prompt_text);
      if (pToks.size < 3) continue;
      const scored = [];
      for (const a of agentTokens) {
        let overlap = 0;
        for (const t of pToks) if (a.toks.has(t)) overlap++;
        if (overlap >= 3) scored.push({ name: a.name, score: overlap, use_count: a.use_count, last_used: a.last_used });
      }
      if (!scored.length) continue;
      scored.sort((x, y) => y.score - x.score);
      if (scored[0].score < 4) continue;
      strongMatches++;
      const promptTs = Date.parse(p.timestamp);
      const fired = scored.slice(0, 3).some(c => c.last_used && Math.abs(Date.parse(c.last_used) - promptTs) < 5*60*1000);
      if (!fired) {
        misses.push({
          prompt_id: p.id, ts: p.timestamp,
          snippet: String(p.prompt_text).slice(0, 140).replace(/\s+/g, ' '),
          candidates: scored.slice(0, 3).map(c => ({ name: c.name, overlap: c.score, use_count: c.use_count })),
        });
      }
    }
  }

  try {
    const yaml = require('js-yaml');
    const cfgPath = require('../../config/resolve.cjs');
    const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
    const metrics = cfg.paths && cfg.paths.metrics_root;
    if (metrics) {
      const outDir = path.join(metrics, 'routing-audit');
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, `routing-misses-${today}.json`);
      fs.writeFileSync(outPath, JSON.stringify({
        date: today,
        prompts_scanned: prompts.length,
        strong_matches: strongMatches,
        misses_count: misses.length,
        miss_rate: strongMatches ? Number((misses.length / strongMatches).toFixed(3)) : 0,
        misses: misses.slice(0, 50),
      }, null, 2), 'utf8');
    }
  } catch (_) {}

  return {
    prompts_scanned: prompts.length,
    strong_matches: strongMatches,
    misses: misses.length,
    miss_rate: strongMatches ? Number((misses.length / strongMatches).toFixed(3)) : 0,
    method: usedFts ? 'bm25' : 'word-overlap',
  };
});

// 8j. FTS maintenance — optimize weekly (Sun), integrity-check monthly (1st).
//     Triggers keep indexes in sync day-to-day; this catches drift + reclaims space.
results.ftsMaint = await step('fts-maintenance', () => {
  if (DRY_RUN) return { skipped: true };
  const conn = db.raw();
  const now = new Date();
  const isSunday  = now.getDay() === 0;
  const isFirstOfMonth = now.getDate() === 1;
  if (!isSunday && !isFirstOfMonth) return { skipped: 'not-scheduled-today' };

  // Discover all FTS5 virtual tables (skip the *_data / *_idx / *_config helpers)
  const ftsTables = conn.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND sql LIKE '%VIRTUAL TABLE%fts5%'
      AND name NOT LIKE '%\\_data' ESCAPE '\\'
      AND name NOT LIKE '%\\_idx' ESCAPE '\\'
      AND name NOT LIKE '%\\_config' ESCAPE '\\'
      AND name NOT LIKE '%\\_docsize' ESCAPE '\\'
      AND name NOT LIKE '%\\_content' ESCAPE '\\'
  `).all().map(r => r.name);

  const out = { tables: ftsTables.length, optimized: [], integrity: [], errors: [] };

  if (isSunday) {
    for (const t of ftsTables) {
      try {
        conn.exec(`INSERT INTO ${t}(${t}) VALUES('optimize')`);
        out.optimized.push(t);
      } catch (err) { out.errors.push({ table: t, op: 'optimize', error: err.message }); }
    }
  }

  if (isFirstOfMonth) {
    for (const t of ftsTables) {
      try {
        conn.exec(`INSERT INTO ${t}(${t}) VALUES('integrity-check')`);
        out.integrity.push({ table: t, ok: true });
      } catch (err) {
        // integrity-check throws on mismatch — capture as actionable warning
        out.integrity.push({ table: t, ok: false, error: err.message });
        out.errors.push({ table: t, op: 'integrity-check', error: err.message });
      }
    }
  }

  return out;
});

// 8k. doc-drift check — compare CLAUDE.md claims (endpoint counts, file map,
//      skill / agent toggle counts) against repo reality. Writes a dated
//      report to {metrics_root}/doc-drift/ and surfaces a summary in the
//      nightly heartbeat so the doctor command can flag drift.
results.docDrift = await step('doc-drift-check', async () => {
  if (DRY_RUN) return { skipped: true };
  const m = await import(pathToFileURL(path.resolve(__dirname, 'doc-drift-check.mjs')).href);
  let metricsRoot = null;
  try {
    const yaml = require('js-yaml');
    const cfgPath = require('../../config/resolve.cjs');
    if (fs.existsSync(cfgPath)) {
      const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
      metricsRoot = cfg.paths && cfg.paths.metrics_root;
    }
  } catch (_) {}
  const repoRoot = path.resolve(__dirname, '..', '..');
  const r = m.runDocDriftCheck(repoRoot, metricsRoot);
  return {
    ok:          r.ok,
    drift_count: r.drifts ? r.drifts.length : 0,
    sections:    r.drifts ? [...new Set(r.drifts.map(d => d.section))] : [],
    summary:     r.summary,
  };
});

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
