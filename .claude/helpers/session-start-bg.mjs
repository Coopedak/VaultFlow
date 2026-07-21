/**
 * session-start-bg.mjs — background indexing for SessionStart
 *
 * WHY: SessionStart used to block the prompt for 30-50s while it imported
 * memory, detected the stack, regenerated context files, and spawned the
 * watcher. None of that work produces output the model reads at start, so
 * it now runs detached. The foreground hook returns in ~0.1s and this
 * process finishes in the background.
 *
 * Invoked by hook-handler.cjs `session-start` case via spawn() with stdio
 * detached. argv[2] = sess.cwd, argv[3] = sess.project (optional).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn }                    from 'node:child_process';
import { createRequire }            from 'node:module';
import path                         from 'node:path';
import { fileURLToPath }            from 'node:url';

const require    = createRequire(import.meta.url);
const __dirname  = path.dirname(fileURLToPath(import.meta.url));

function safeWrite(msg) {
  try { process.stderr.write(msg); } catch (_) {}
}

const cwd     = process.argv[2] || process.cwd();
const project = process.argv[3] || path.basename(cwd);

(async () => {
  // ── drain embed_queue (real-time semantic indexing for memory + prompts) ──
  try {
    const m = await import('./embeddings.mjs');
    const r = await m.processEmbedQueue();
    if (r.processed > 0) safeWrite(`[vaultflow:bg] embed-queue drained ${r.processed} item(s)\n`);
  } catch (_) { /* transformers not installed — skip */ }

  // ── vault_tools auto-promotion + retrieval learning loop ───────────────
  // SessionEnd misses ~95% of sessions, so the End-only auto-promotion left
  // tools stuck at use_count >= 5 unpromoted. Run promotion + learning loop
  // on Start too — both are idempotent.
  try {
    const db = require('./db.cjs');
    db.initialize(null, null);
    const eligible = db.getUnpromotedVaultTools(5);
    for (const tool of eligible) {
      try { db.promoteVaultTool(tool.id); } catch (_) {}
    }
    if (eligible.length > 0) safeWrite(`[vaultflow:bg] auto-promoted ${eligible.length} vault tool(s)\n`);
    try {
      const r = db.runRetrievalLearningLoop();
      if (r && (r.promoted || r.scored)) {
        safeWrite(`[vaultflow:bg] learning loop — scored:${r.scored||0} promoted:${r.promoted||0}\n`);
      }
    } catch (_) {}
  } catch (err) {
    safeWrite(`[vaultflow:bg] promotion/learning error — ${err.message}\n`);
  }

  // ── close stale sessions + backfill missing summaries ──────────────────
  // SessionEnd hooks miss ~95% of sessions (Ctrl-C, crash, window close), so
  // session_summaries was 5/123 last week. Backfill from edit_events/patterns
  // before any memory query runs — keeps "recent activity" injection honest.
  try {
    const db = require('./db.cjs');
    db.initialize(null, null);
    const stale = db.closeStaleSessions(12);
    if (stale.closed > 0) safeWrite(`[vaultflow:bg] closed ${stale.closed} stale session(s)\n`);
    const bf = db.backfillMissingSessionSummaries(200);
    if (bf.backfilled > 0) safeWrite(`[vaultflow:bg] backfilled ${bf.backfilled} session summaries\n`);
  } catch (err) {
    safeWrite(`[vaultflow:bg] summary backfill error — ${err.message}\n`);
  }

  // ── project focus surfacing ─────────────────────────────────────────────
  try {
    const { load } = require('./focus.cjs');
    const focus = load(project);
    if (focus && focus.headline) {
      safeWrite(`[vaultflow:bg] focus — ${focus.headline}\n`);
    }
  } catch (_) {}

  // ── memory + dictionary import ──────────────────────────────────────────
  try {
    const { doImport } = await import('./auto-memory-hook.mjs');
    const result = await doImport();
    safeWrite(`[vaultflow:bg] doImport — ${JSON.stringify(result)}\n`);
  } catch (err) {
    safeWrite(`[vaultflow:bg] doImport error — ${err.message}\n`);
  }

  // ── load config once for the rest ───────────────────────────────────────
  let cfg = {};
  try {
    const yaml    = require('js-yaml');
    const cfgPath = require('../../config/resolve.cjs');
    if (existsSync(cfgPath)) cfg = yaml.load(readFileSync(cfgPath, 'utf8')) || {};
  } catch (_) { /* fall through with empty cfg */ }

  // ── tech stack detection ────────────────────────────────────────────────
  const doDetect = cfg.intelligence && cfg.intelligence.stack_detect_on_session_start !== false;
  if (doDetect && existsSync(cwd)) {
    try {
      const { detectAndStore } = await import('./stack-detector.mjs');
      const stacks = await detectAndStore(cwd, project);
      if (stacks.length > 0) {
        safeWrite(`[vaultflow:bg] stacks — ${stacks.join(', ')}\n`);
      }
    } catch (err) {
      safeWrite(`[vaultflow:bg] stack-detect error — ${err.message}\n`);
    }
  }

  // ── gen-context auto-refresh ────────────────────────────────────────────
  if (existsSync(cwd)) {
    try {
      const { generateForProject } = await import('./gen-context.mjs');
      const gcResult = await generateForProject(cwd);
      if (gcResult.generated.length > 0) {
        safeWrite(`[vaultflow:bg] gen-context refreshed ${gcResult.generated.length} file(s)\n`);
      }
    } catch (err) {
      safeWrite(`[vaultflow:bg] gen-context error — ${err.message}\n`);
    }
  }

  // ── watcher daemon ──────────────────────────────────────────────────────
  // Delegated to ensure-watcher.mjs so Claude/Copilot/Codex/scheduled-task
  // all share the same idempotent "is it running? if not, start it" logic.
  try {
    const { ensureWatcher } = await import('./ensure-watcher.mjs');
    const r = await ensureWatcher();
    if (r.running) {
      safeWrite(`[vaultflow:bg] watcher ${r.started ? 'started' : 'already running'} (${r.watchDir})\n`);
    } else {
      safeWrite(`[vaultflow:bg] watcher not running — no valid watchDir\n`);
    }
  } catch (err) {
    safeWrite(`[vaultflow:bg] watcher start error — ${err.message}\n`);
  }

  // ── nightly catch-up ────────────────────────────────────────────────────
  catchUpNightly(cfg);
})();

/**
 * Run nightly maintenance if the Scheduled Task has not run recently.
 *
 * WHY: the 3 AM task is registered with an Interactive principal whenever the
 * installer runs non-elevated (S4U needs admin), and an Interactive task is
 * silently skipped while the user is logged off. Observed here: 4 missed runs,
 * 99h since the last heartbeat, and 1759 symbol embeddings stranded in
 * embed_queue because nightly is their only drainer. Tying the health of the
 * whole pipeline to one scheduler entry is also the wrong shape for a tool
 * meant to be deployed onto arbitrary machines.
 *
 * So: whenever a session starts and the heartbeat is stale, run nightly
 * detached. nightly.mjs is idempotent and writes the heartbeat itself, so a
 * successful catch-up run stops the next session from starting another. The
 * Scheduled Task stays the primary path; this is the safety net.
 */
function catchUpNightly(cfg) {
  const STALE_HOURS = 26;   // > 24 so a task that fired on time never triggers a catch-up
  try {
    const metrics = cfg?.paths?.metrics_root;
    if (!metrics) return;

    const hbPath = path.join(metrics, 'nightly-heartbeat.json');
    let ageH = Infinity;
    if (existsSync(hbPath)) {
      const last = JSON.parse(readFileSync(hbPath, 'utf8')).last_run_at;
      if (last) ageH = (Date.now() - new Date(last).getTime()) / 3_600_000;
    }
    if (ageH < STALE_HOURS) return;

    // Guard against two sessions opening at once both spawning a run. The lock
    // is advisory and self-expiring, so a crashed run cannot wedge it shut.
    const lockPath = path.join(metrics, '.nightly-catchup.lock');
    if (existsSync(lockPath)) {
      const lockAgeH = (Date.now() - Number(readFileSync(lockPath, 'utf8').trim() || 0)) / 3_600_000;
      if (lockAgeH < 2) return;
    }
    writeFileSync(lockPath, String(Date.now()), 'utf8');

    const child = spawn(process.execPath, [path.join(__dirname, 'nightly.mjs')], {
      detached: true, stdio: 'ignore', env: { ...process.env, VAULTFLOW_NIGHTLY_CATCHUP: '1' },
    });
    child.unref();
    safeWrite(`[vaultflow:bg] nightly catch-up started (heartbeat ${Math.round(ageH)}h stale)\n`);
  } catch (err) {
    safeWrite(`[vaultflow:bg] nightly catch-up error — ${err.message}\n`);
  }
}
