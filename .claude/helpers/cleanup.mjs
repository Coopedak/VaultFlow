/**
 * cleanup.mjs — vaultflow repo-hygiene cleanup tool
 *
 * Scans for and (optionally) removes known junk categories produced by bugs or
 * runtime cruft. Report-only by default; --fix performs safe deletions.
 *
 * Categories:
 *   1. Mangled-path artifacts — files/dirs whose basename encodes a stripped
 *      filesystem path (a buggy writer stripped path separators, producing names
 *      like "C:GITvaultflow.claudehelpers…" in the repo root). Never normal filenames.
 *   2. Crash/debug logs — gitignored *.log files at well-known runtime paths.
 *   3. Empty orphaned directories — truly empty dirs (excl. .git/, node_modules/).
 *   4. Stray 0-byte *.db files at repo root — REPORT ONLY, never deleted even with --fix.
 *
 *   Additionally reports untracked .md/.txt docs with a brain-FTS mapped/unmapped hint
 *   so a human can decide whether to commit, move, or discard them.
 *
 * Usage:
 *   node .claude/helpers/cleanup.mjs           # report only
 *   node .claude/helpers/cleanup.mjs --fix     # delete safe junk
 *   node .claude/helpers/cleanup.mjs --json    # machine-readable report
 *   npm run cleanup
 *   npm run cleanup:fix
 *
 * Exit codes:
 *   0 — always (errors logged, never crash the nightly)
 */

import fs   from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Derive repo root from this file's location (.claude/helpers/cleanup.mjs → ../../)
// This works on the portable D:\ and E:\ copies without hardcoding any path.
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const DO_FIX  = process.argv.includes('--fix');
const DO_JSON = process.argv.includes('--json');

// ── terminal colours (suppressed in --json mode) ──────────────────────────
const C = {
  reset:  '\x1b[0m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  green:  '\x1b[32m',
  cyan:   '\x1b[36m',
  bold:   '\x1b[1m',
};
function col(c, s) { return DO_JSON ? s : `${c}${s}${C.reset}`; }

// ── mangled-path heuristic ────────────────────────────────────────────────
//
// WHY: A buggy writer (or misconfigured template) stripped path separators
// from absolute paths, producing basenames like:
//   "C:GITvaultflow.claudehelpersdashboardvendorchart.umd.min.js"
//   "GITvaultflowfoo"
// These are never legitimate filenames. Detect conservatively:
//   • Starts with a drive letter prefix (C:GIT, D:GIT …) — Windows absolute path
//   • Starts with "GIT" immediately followed by a known repo name
//   • Contains the project name glued to ".claude", ".superpowers", or "helpers"
//     with no path separator (the separator was stripped)
//
// The project name is derived from the repo root directory name so it adapts
// to the portable copies without hardcoding "vaultflow".
const PROJECT_NAME = path.basename(REPO_ROOT);

// Heuristic: basename looks like a flattened filesystem path
function isMangledPath(basename) {
  // Drive-letter prefix: C:GIT... or D:GIT...
  if (/^[A-Za-z]:GIT/i.test(basename)) return true;
  // Bare GIT prefix (no drive letter): GITvaultflow...
  if (/^GIT[A-Za-z]/i.test(basename)) return true;
  // Project name glued to .claude / .superpowers / helpers / dashboard (no separator)
  const glued = new RegExp(`${PROJECT_NAME}(?:\\.claude|\\.superpowers|helpers|dashboard)`, 'i');
  if (glued.test(basename)) return true;
  return false;
}

// ── git safety guard ──────────────────────────────────────────────────────
// Returns true if the path is tracked by git (MUST NOT delete).
// repoRoot is passed explicitly so the function works with fixture dirs in tests.
function isGitTracked(absPath, repoRoot) {
  try {
    execSync(`git ls-files --error-unmatch "${absPath}"`, {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    return true;
  } catch (_) {
    return false;
  }
}

// ── directory utilities ───────────────────────────────────────────────────
const SKIP_DIRS = new Set(['.git', 'node_modules', 'desktop']);

// Walk a directory one level at a time (non-recursive for perf; the empty-dir
// check recurses explicitly only when needed).
function readdirSafe(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return []; }
}

// Truly empty = no entries at all (or only empty subdirs — check recursively)
function isDirEmpty(dir) {
  const entries = readdirSafe(dir);
  if (entries.length === 0) return true;
  // Treat dirs whose only content is empty subdirs as empty too
  for (const e of entries) {
    if (e.isFile() || e.isSymbolicLink()) return false;
    if (e.isDirectory() && !isDirEmpty(path.join(dir, e.name))) return false;
  }
  return true;
}

// Collect empty dirs under a root, skipping noise dirs
function collectEmptyDirs(root, results = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (_) { return results; }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(root, e.name);
    if (isDirEmpty(full)) {
      results.push(full);
    } else {
      collectEmptyDirs(full, results);
    }
  }
  return results;
}

// ── gitignore check for *.log files ───────────────────────────────────────
// Returns true if the file is gitignored (safe to flag as junk).
// repoRoot is passed explicitly so the function works with fixture dirs in tests.
function isGitIgnored(absPath, repoRoot) {
  try {
    execSync(`git check-ignore -q "${absPath}"`, {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    return true;  // exit 0 = ignored
  } catch (_) {
    return false; // exit 1 = not ignored (or not a git error)
  }
}

// ── safe delete ───────────────────────────────────────────────────────────
// Verifies the item is NOT git-tracked before deleting.
// *.db files are NEVER deleted regardless of any other condition — the live DB
// and any stray db file must survive every code path, not just the 0-byte loop.
// repoRoot is passed explicitly so the function works with fixture dirs in tests.
// Returns { deleted: bool, reason: string }
function safeDelete(absPath, isDir, repoRoot) {
  // Absolute hard stop: never delete any *.db file on any code path.
  if (!isDir && absPath.endsWith('.db')) {
    return { deleted: false, reason: '*.db — report-only, never deleted' };
  }
  if (isGitTracked(absPath, repoRoot)) {
    return { deleted: false, reason: 'git-tracked — skipped' };
  }
  try {
    if (isDir) {
      fs.rmSync(absPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(absPath);
    }
    return { deleted: true, reason: '' };
  } catch (err) {
    return { deleted: false, reason: err.message };
  }
}

// ── brain FTS hint ────────────────────────────────────────────────────────
// Best-effort: if DB is available, check if a doc's content has a strong FTS
// hit in memory_entries. Degrades gracefully — never throws.
let _db = null;
function getDb() {
  if (_db !== null) return _db;
  try {
    const require = createRequire(import.meta.url);
    const dbMod = require('./db.cjs');
    dbMod.initialize(null, null);
    _db = dbMod;
  } catch (_) {
    _db = false; // mark unavailable
  }
  return _db;
}

function brainHint(absPath) {
  try {
    const snippet = fs.readFileSync(absPath, 'utf8').slice(0, 1500);
    // Extract a concise query: first heading or first non-empty line
    const lines = snippet.split('\n').map(l => l.trim()).filter(Boolean);
    const heading = lines.find(l => l.startsWith('#'));
    const query   = (heading || lines[0] || '').replace(/^#+\s*/, '').slice(0, 120);
    if (!query) return 'unknown (no readable content)';

    const db = getDb();
    if (!db) return 'unknown (brain unavailable)';

    const hits = db.searchMemory(query, 3);
    if (!hits || !hits.length) return 'unmapped (review before removing)';

    // A BM25 rank < -3 is a strong signal the content is already in the brain
    const strong = hits.some(h => h.rank !== undefined && h.rank < -3);
    return strong ? 'mapped (content found in brain)' : 'unmapped (review before removing)';
  } catch (_) {
    return 'unknown (brain unavailable)';
  }
}

// ── untracked doc enumeration ─────────────────────────────────────────────
// Noise exclusions: auto-generated files that gen-context.mjs regenerates,
// and paths covered by the mangled-junk class.
const UNTRACKED_DOC_EXCLUDE = new Set([
  'AGENTS.md',
  path.join('.github', 'copilot-instructions.md'),
  path.join('.cursor', 'rules', 'wiki.mdc'),
  path.join('.vscode', 'mcp.json'),
  '.mcp.json',
  path.join('.claude', 'settings.local.json'),
]);

function isExcludedUntrackedDoc(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  // Any node_modules anywhere in the path (top-level or nested, e.g. electron-tui/node_modules/)
  if (normalized.includes('node_modules/') || normalized === 'node_modules') return true;
  if (normalized.includes('desktop/') && normalized.includes('/obj/')) return true;
  if (normalized.startsWith('.git/')) return true;

  // Match against the exclusion set (normalise to forward slashes)
  const fwd = relPath.replace(/\\/g, '/');
  for (const excl of UNTRACKED_DOC_EXCLUDE) {
    if (fwd === excl.replace(/\\/g, '/')) return true;
  }
  return false;
}

function getUntrackedDocs(repoRoot) {
  const docs = [];
  try {
    // Unignored untracked files
    const unignored = execSync('git ls-files --others --exclude-standard', {
      cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n').filter(Boolean);

    // Ignored untracked files
    const ignored = execSync('git ls-files --others --ignored --exclude-standard', {
      cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n').filter(Boolean);

    const all = [...new Set([...unignored, ...ignored])];

    for (const rel of all) {
      if (!rel.endsWith('.md') && !rel.endsWith('.txt')) continue;
      if (isExcludedUntrackedDoc(rel)) continue;
      // Skip items already flagged by mangled-junk heuristic
      if (isMangledPath(path.basename(rel))) continue;
      docs.push(rel);
    }
  } catch (_) { /* git unavailable — return empty */ }
  return docs;
}

// ── main scan ─────────────────────────────────────────────────────────────

/**
 * Run the repo-hygiene cleanup scan.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.fix=false]         — when true, delete safe junk (mangled files,
 *                                             gitignored logs, empty dirs). *.db are NEVER
 *                                             deleted on any path regardless of this flag.
 * @param {string}  [opts.repoRoot=REPO_ROOT] — override the repo root; used by tests to
 *                                             point at a fixture dir without touching the
 *                                             real repo. Defaults to the real repo root
 *                                             derived from this file's location.
 */
export async function runCleanup({ fix = false, repoRoot = REPO_ROOT } = {}) {
  // When called from CLI, DO_FIX takes precedence (CLI argv always wins over
  // a programmatic false). When called from nightly or tests, the passed fix
  // value is used as-is and DO_FIX is intentionally ignored (nightly always
  // passes fix:false; tests pass fix:true to exercise the deletion path).
  const doFix = fix || DO_FIX;

  const report = {
    mangled:    [],   // { path, type, action, reason }
    logs:       [],
    emptyDirs:  [],
    zeroDbs:    [],   // report-only, never deleted
    docs:       [],   // { path, hint }
    summary:    {},
  };

  // ── 1a. mangled-path artifacts at repo root ──────────────────────────────
  // Scan repo root only — mangled names always land at the root because the
  // buggy writer resolved relative to CWD (the repo root).
  for (const entry of readdirSafe(repoRoot)) {
    const basename = entry.name;
    if (!isMangledPath(basename)) continue;

    const absPath = path.join(repoRoot, basename);
    let action = 'would remove';
    let reason = '';

    if (doFix) {
      // safeDelete has an absolute *.db guard — it refuses to delete any .db
      // file regardless of what isMangledPath returned. This covers the edge
      // case of a mangled filename that also ends in .db (e.g. "C:GITfoo.db").
      const r = safeDelete(absPath, entry.isDirectory(), repoRoot);
      action = r.deleted ? 'removed' : 'skipped';
      reason = r.reason;
    }

    report.mangled.push({
      path:   absPath,
      type:   entry.isDirectory() ? 'dir' : 'file',
      action,
      reason,
    });
  }

  // ── 1b. gitignored *.log files ────────────────────────────────────────────
  // Walk a small fixed set of likely locations rather than a full recursive walk,
  // then extend with any *.log at repo root. All must be gitignored and untracked.
  // Note: *.log extensions can never collide with *.db, so no extra guard needed.
  const logCandidates = [];

  // Repo root *.log
  for (const entry of readdirSafe(repoRoot)) {
    if (entry.isFile() && entry.name.endsWith('.log')) {
      logCandidates.push(path.join(repoRoot, entry.name));
    }
  }
  // Known runtime log location (only relevant for the real repo root)
  const knownLog = path.join(repoRoot, '.claude', 'helpers', 'dashboard', 'dashboard-launcher.log');
  if (fs.existsSync(knownLog)) logCandidates.push(knownLog);

  for (const absPath of logCandidates) {
    if (!fs.existsSync(absPath)) continue;
    if (!isGitIgnored(absPath, repoRoot)) continue;   // only flag gitignored logs
    if (isGitTracked(absPath, repoRoot))  continue;   // never touch tracked files

    let action = 'would remove';
    let reason = '';
    if (doFix) {
      const r = safeDelete(absPath, false, repoRoot);
      action = r.deleted ? 'removed' : 'skipped';
      reason = r.reason;
    }
    report.logs.push({ path: absPath, action, reason });
  }

  // ── 1c. empty orphaned directories ───────────────────────────────────────
  const emptyDirs = collectEmptyDirs(repoRoot);
  for (const absPath of emptyDirs) {
    if (isGitTracked(absPath, repoRoot)) continue;

    let action = 'would remove';
    let reason = '';
    if (doFix) {
      const r = safeDelete(absPath, true, repoRoot);
      action = r.deleted ? 'removed' : 'skipped';
      reason = r.reason;
    }
    report.emptyDirs.push({ path: absPath, action, reason });
  }

  // ── 1d. 0-byte *.db files at repo root — REPORT ONLY ────────────────────
  // This is a reporting surface only. Deletion of *.db is also blocked at the
  // safeDelete level so there is no risk of a *.db being deleted via other paths.
  for (const entry of readdirSafe(repoRoot)) {
    if (!entry.isFile() || !entry.name.endsWith('.db')) continue;
    const absPath = path.join(repoRoot, entry.name);
    let size = -1;
    try { size = fs.statSync(absPath).size; } catch (_) { continue; }
    if (size === 0) {
      report.zeroDbs.push({ path: absPath, note: 'report-only — never deleted' });
    }
  }

  // ── 2. untracked docs with brain hint ────────────────────────────────────
  const untrackedRels = getUntrackedDocs(repoRoot);
  for (const rel of untrackedRels) {
    const absPath = path.join(repoRoot, rel);
    const hint    = brainHint(absPath);
    report.docs.push({ path: rel, hint });
  }

  // ── summary ───────────────────────────────────────────────────────────────
  report.summary = {
    mangled:   report.mangled.length,
    logs:      report.logs.length,
    emptyDirs: report.emptyDirs.length,
    zeroDbs:   report.zeroDbs.length,
    docs:      report.docs.length,
  };

  return report;
}

// ── print helpers ─────────────────────────────────────────────────────────

function printReport(report, repoRoot) {
  const mode = DO_FIX ? ' --fix' : '';
  console.log(`\n${col(C.bold, `vaultflow cleanup${mode}`)}`);
  console.log('─'.repeat(52));

  // 1a mangled artifacts
  console.log(`\n${col(C.bold, 'Mangled-path artifacts')} (${report.mangled.length})`);
  if (report.mangled.length === 0) {
    console.log(`  ${col(C.green, '✓')}  none found`);
  } else {
    for (const item of report.mangled) {
      const icon  = item.action === 'removed'    ? col(C.green, '✓') :
                    item.action === 'would remove'? col(C.yellow, '⚠') :
                                                   col(C.red,    '✗');
      const label = `[${item.type}] ${path.relative(repoRoot, item.path)}`;
      const note  = item.reason ? ` — ${item.reason}` : '';
      console.log(`  ${icon}  ${item.action}: ${label}${note}`);
    }
  }

  // 1b logs
  console.log(`\n${col(C.bold, 'Gitignored log files')} (${report.logs.length})`);
  if (report.logs.length === 0) {
    console.log(`  ${col(C.green, '✓')}  none found`);
  } else {
    for (const item of report.logs) {
      const icon = item.action === 'removed' ? col(C.green, '✓') :
                   item.action === 'would remove' ? col(C.yellow, '⚠') :
                                                    col(C.red, '✗');
      const note = item.reason ? ` — ${item.reason}` : '';
      console.log(`  ${icon}  ${item.action}: ${path.relative(repoRoot, item.path)}${note}`);
    }
  }

  // 1c empty dirs
  console.log(`\n${col(C.bold, 'Empty orphaned directories')} (${report.emptyDirs.length})`);
  if (report.emptyDirs.length === 0) {
    console.log(`  ${col(C.green, '✓')}  none found`);
  } else {
    for (const item of report.emptyDirs) {
      const icon = item.action === 'removed' ? col(C.green, '✓') :
                   item.action === 'would remove' ? col(C.yellow, '⚠') :
                                                    col(C.red, '✗');
      const note = item.reason ? ` — ${item.reason}` : '';
      console.log(`  ${icon}  ${item.action}: ${path.relative(repoRoot, item.path)}${note}`);
    }
  }

  // 1d 0-byte dbs
  console.log(`\n${col(C.bold, 'Stray 0-byte *.db files')} — ${col(C.cyan, 'report-only, never deleted')} (${report.zeroDbs.length})`);
  if (report.zeroDbs.length === 0) {
    console.log(`  ${col(C.green, '✓')}  none found`);
  } else {
    for (const item of report.zeroDbs) {
      console.log(`  ${col(C.cyan, 'ℹ')}  ${path.relative(repoRoot, item.path)} — ${item.note}`);
    }
  }

  // 2 untracked docs
  console.log(`\n${col(C.bold, 'Untracked docs — review for unmapped knowledge (never auto-removed)')} (${report.docs.length})`);
  if (report.docs.length === 0) {
    console.log(`  ${col(C.green, '✓')}  none`);
  } else {
    for (const item of report.docs) {
      const mapped = item.hint.startsWith('mapped');
      const icon   = mapped ? col(C.green, '✓') : col(C.yellow, '⚠');
      console.log(`  ${icon}  ${item.path}`);
      console.log(`       ${col(C.cyan, item.hint)}`);
    }
  }

  console.log('\n' + '─'.repeat(52));
  const s = report.summary;
  console.log(`  junk: ${s.mangled} mangled  ${s.logs} logs  ${s.emptyDirs} empty-dirs  ${s.zeroDbs} 0-byte-db (report-only)`);
  console.log(`  docs: ${s.docs} untracked doc(s) to review`);
  if (!DO_FIX && (s.mangled + s.logs + s.emptyDirs) > 0) {
    console.log(`\n  Run with --fix to delete safe junk.\n`);
  } else {
    console.log('');
  }
}

// ── entry point ───────────────────────────────────────────────────────────
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

if (isMain) {
  // CLI always uses the default REPO_ROOT; capture it so both runCleanup and
  // printReport (and the --json relativiser) use exactly the same root.
  const cliRoot = REPO_ROOT;
  const report  = await runCleanup({ repoRoot: cliRoot });

  if (DO_JSON) {
    // Normalise paths to relative for portability
    const relativise = items => items.map(i => ({
      ...i,
      path: typeof i.path === 'string' ? path.relative(cliRoot, i.path) : i.path,
    }));
    const out = {
      mangled:   relativise(report.mangled),
      logs:      relativise(report.logs),
      emptyDirs: relativise(report.emptyDirs),
      zeroDbs:   relativise(report.zeroDbs),
      docs:      report.docs,
      summary:   report.summary,
    };
    console.log(JSON.stringify(out, null, 2));
  } else {
    printReport(report, cliRoot);
  }

  process.exit(0);
}
