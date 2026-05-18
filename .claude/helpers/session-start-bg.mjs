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

import { existsSync, readFileSync } from 'node:fs';
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
})();
