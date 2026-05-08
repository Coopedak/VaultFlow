/**
 * ensure-watcher.mjs — idempotent watcher daemon launcher
 *
 * WHY: The vaultflow watcher must be running for tool-agnostic edit capture
 * and periodic gen-context refreshes to work. Any CLI (Claude SessionStart,
 * Copilot launch wrapper, Codex launch wrapper, scheduled task at logon) can
 * call this helper to "ensure the watcher is up" without caring whether it's
 * already running.
 *
 * Behavior:
 *   - Reads the PID file the watcher writes on startup
 *   - If the PID is alive, no-op (returns { running: true, started: false })
 *   - If absent or stale, spawns watcher.mjs --daemon <watchDir> detached
 *
 * Usage:
 *   import { ensureWatcher } from './ensure-watcher.mjs';
 *   await ensureWatcher();          // uses configured watch dir
 *   await ensureWatcher('C:/GIT');  // explicit override
 *
 * CLI:
 *   node ensure-watcher.mjs [watchDir]
 *     exits 0 with one line of status to stdout
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { spawn }         from 'node:child_process';
import path              from 'node:path';
import os                from 'node:os';
import { fileURLToPath } from 'node:url';

const require    = createRequire(import.meta.url);
const __dirname  = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  try {
    const yaml       = require('js-yaml');
    const configPath = require('../../config/resolve.cjs');
    if (existsSync(configPath)) {
      return yaml.load(readFileSync(configPath, 'utf8')) || {};
    }
  } catch (_) {}
  return {};
}

function resolveWatchDir(cfg) {
  if (cfg.paths && cfg.paths.watcher_watch_dir) return cfg.paths.watcher_watch_dir;
  // Derive from wiki_glob: C:/GIT/*/wiki/... → C:/GIT
  if (cfg.paths && cfg.paths.wiki_glob) {
    return cfg.paths.wiki_glob.replace(/\\/g, '/').split('/').slice(0, -3).join('/');
  }
  return null;
}

function pidFilePath(cfg) {
  // Mirror the path the watcher itself writes — keep both in sync.
  const metricsRoot = (cfg.paths && cfg.paths.metrics_root)
    || path.join(os.homedir(), 'vault', 'methodology', '.metrics');
  return path.join(metricsRoot, 'watcher.pid');
}

function isAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

/**
 * @param {string} [watchDir] override; defaults to config-derived
 * @returns {Promise<{running: boolean, started: boolean, pid: number|null, watchDir: string|null}>}
 */
export async function ensureWatcher(watchDir) {
  const cfg = loadConfig();
  const dir = watchDir || resolveWatchDir(cfg);
  if (!dir || !existsSync(dir)) {
    return { running: false, started: false, pid: null, watchDir: dir };
  }

  const pidFile = pidFilePath(cfg);
  let existingPid = null;
  if (existsSync(pidFile)) {
    try { existingPid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10); } catch (_) {}
  }

  if (isAlive(existingPid)) {
    return { running: true, started: false, pid: existingPid, watchDir: dir };
  }

  // No live daemon — spawn one detached. The daemon writes its own PID file.
  const watcherPath = path.resolve(__dirname, 'watcher.mjs');
  const child = spawn(
    process.execPath,
    ['--no-warnings', watcherPath, '--daemon', dir],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();

  return { running: true, started: true, pid: child.pid || null, watchDir: dir };
}

// ── CLI ───────────────────────────────────────────────────────────────────
const thisPath = fileURLToPath(import.meta.url);
if (process.argv[1] === thisPath) {
  ensureWatcher(process.argv[2]).then((r) => {
    if (!r.running) {
      console.log(`vaultflow watcher: not running (no valid watchDir: ${r.watchDir || '<none>'})`);
      process.exit(1);
    }
    if (r.started) {
      console.log(`vaultflow watcher: started (pid=${r.pid}, watchDir=${r.watchDir})`);
    } else {
      console.log(`vaultflow watcher: already running (pid=${r.pid}, watchDir=${r.watchDir})`);
    }
  }).catch((err) => {
    console.error(`vaultflow watcher: ensure failed — ${err.message}`);
    process.exit(1);
  });
}
