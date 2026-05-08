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
