/**
 * path-filter.cjs — one definition of "is this a real, authored edit?"
 *
 * WHY THIS EXISTS: edit_events drives hot-files, churn coloring, the treemap,
 * and the health score. Anything that leaks in gets ranked as if a human wrote
 * it, and three separate leaks each produced a wrong top-of-list:
 *
 *   - vaultflow's own .metrics/ writes (it watches a root containing itself)
 *   - other projects' binary data files (.duckdb ranked as the hottest file)
 *   - static-site build output (a Quartz public/ tree swept the top 15)
 *
 * The rule is applied in TWO places and they must never disagree:
 *   1. WRITE time (watcher.mjs) — keeps new junk out of the table.
 *   2. READ time  (db.cjs queryEditFrequency) — hides rows recorded before the
 *      rule was tightened, since edit_events is an append-only log we do not
 *      retroactively delete.
 *
 * Both import from here, so tightening the rule fixes history and the future in
 * one edit. CJS because db.cjs is CJS; watcher.mjs (ESM) can require() it.
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

// Generated / binary / IDE noise, by shape of the path alone.
const IGNORE_PATTERNS = [
  /node_modules/,
  /\.git[\/\\]/,
  /\.git-[^\/\\]*[\/\\]/,        // .git-rewrite/, .git-rebase-merge/, …
  /[\/\\]\.metrics[\/\\]/,       // vaultflow's own telemetry — never self-record
  /[\/\\](?:dist|build|coverage|\.next|\.venv)[\/\\]/,
  /[\/\\](?:bin|obj)[\/\\](?:Debug|Release)[\/\\]/i,   // .NET build output
  /[\/\\]__pycache__[\/\\]/,
  /\.(?:duckdb|sqlite3?|db|db-shm|db-wal|wal|parquet|pid|log|pyc)$/,
  /\.gitkeep$/,                  // placeholder touched by pipelines, never authored
  /\.(?:png|jpg|jpeg|gif|ico|ttf|woff2?)$/,
  /\.DS_Store/,
  // Context files vaultflow GENERATES via gen-context.mjs, refreshed on every
  // session start and by the watcher's periodic sweep. Recording them made
  // vaultflow's own output the top "hot files" in projects it had merely
  // visited (AGENTS.md: 378 "edits"). Same self-pollution class as .metrics/,
  // but these live at project roots so the .metrics rule cannot catch them,
  // and they are file-level gitignores that the directory-level git check
  // deliberately does not pay a subprocess to detect.
  /[\/\\]AGENTS\.md$/,
  /[\/\\]\.github[\/\\]copilot-instructions\.md$/,
  /[\/\\]\.cursor[\/\\]rules[\/\\]wiki\.mdc$/,
  /[\/\\]\.vscode[\/\\]mcp\.json$/,
  /[\/\\]\.mcp\.json$/,
];

function matchesIgnorePattern(filePath) {
  return IGNORE_PATTERNS.some((re) => re.test(filePath));
}

// ── gitignore awareness ───────────────────────────────────────────────────
//
// A fixed pattern list can only guess at what a given project treats as
// generated. Each repo already states it exactly in its own .gitignore — e.g.
// `public/` is a build directory for Quartz/Hugo but authored source in a React
// app, so no global list can safely decide. Deferring to git makes the answer
// per-project and correct.
//
// Cost is contained by checking DIRECTORIES rather than files and consulting
// cached ancestors first, so an entire ignored tree costs one `git check-ignore`
// at its root and every file beneath it is answered from memory.
const _ignoredDirCache = new Map();
const IGNORE_CACHE_MAX = 5000;

function isGitIgnoredDir(dir) {
  if (!dir) return false;
  if (_ignoredDirCache.has(dir)) return _ignoredDirCache.get(dir);

  for (const [cached, ignored] of _ignoredDirCache) {
    if (ignored && dir.startsWith(cached + path.sep)) {
      _ignoredDirCache.set(dir, true);
      return true;
    }
  }

  let ignored = false;
  try {
    // check-ignore exits 0 when the path IS ignored, 1 when it is not.
    const r = spawnSync('git', ['check-ignore', '-q', dir], {
      cwd: dir, stdio: 'ignore', timeout: 3000, windowsHide: true,
    });
    ignored = r.status === 0;
  } catch (_) { /* no git, not a repo, or timeout — treat as not ignored */ }

  if (_ignoredDirCache.size >= IGNORE_CACHE_MAX) _ignoredDirCache.clear();
  _ignoredDirCache.set(dir, ignored);
  return ignored;
}

/**
 * True when a path should not be recorded or ranked as an authored edit.
 *
 * @param {string} filePath
 * @param {{ useGit?: boolean }} [opts]  useGit=false skips the subprocess check,
 *        for callers that only want the cheap pattern test.
 * @returns {boolean}
 */
function isNoiseEditPath(filePath, opts) {
  if (!filePath) return false;
  if (matchesIgnorePattern(filePath)) return true;
  if (opts && opts.useGit === false) return false;
  try { return isGitIgnoredDir(path.dirname(filePath)); } catch (_) { return false; }
}

/**
 * Resolve a path to the casing the filesystem actually uses.
 *
 * WHY: Windows paths are case-insensitive but stored as strings, so the same
 * file arrives spelled differently depending on the reporter — Claude Code's
 * hook uses the session cwd's casing (C:\Git\…), the watcher uses the watch
 * root's (C:\GIT\…). 214 files were split across two spellings covering 3,300
 * events, halving their apparent churn and listing each file twice.
 *
 * Falls back to the input when the file is gone (deletes) or already exact.
 */
function canonicalizePath(filePath) {
  if (!filePath) return filePath;
  try { return fs.realpathSync.native(filePath); } catch (_) { return filePath; }
}

/**
 * Merge aggregate rows whose paths differ only by case, summing their counts.
 * Complements canonicalizePath: that fixes rows written from now on, this
 * repairs the historical split at read time.
 *
 * @param {Array<{file_path: string, project: string|null, edit_count: number}>} rows
 */
function mergePathCasing(rows) {
  const merged = new Map();
  for (const r of rows) {
    // NUL as the field separator: it is the one byte that cannot occur in a
    // Windows path or a project name, so two different (path, project) pairs
    // can never collide on the same key. Written as an escape, never as a
    // literal control character — a raw NUL in the source makes git classify
    // the file as binary and silently stop diffing it.
    const key = `${String(r.file_path || '').toLowerCase()}\u0000${r.project || ''}`;
    const hit = merged.get(key);
    const n = Number(r.edit_count);
    if (!hit) { merged.set(key, { ...r, edit_count: n, _top: n }); continue; }
    // Keep the spelling most reporters used.
    if (n > hit._top) { hit.file_path = r.file_path; hit._top = n; }
    hit.edit_count += n;
  }
  return [...merged.values()]
    .map(({ _top, ...r }) => r)
    .sort((a, b) => b.edit_count - a.edit_count);
}

module.exports = {
  IGNORE_PATTERNS,
  matchesIgnorePattern,
  isGitIgnoredDir,
  isNoiseEditPath,
  canonicalizePath,
  mergePathCasing,
};
