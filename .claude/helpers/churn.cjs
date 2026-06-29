/**
 * churn.cjs — file-level churn metrics for the treemap and code-graph views
 *
 * WHY: Churn (commit frequency per file) is a meaningful proxy for risk and
 * technical debt surface — high-churn files are changed often and more likely
 * to introduce bugs. The treemap view uses this alongside LOC to give each file
 * a heat signal. We prefer git history because it reflects real change events;
 * the edit_events fallback covers repos that aren't git-tracked or where git is
 * unavailable in the process environment.
 *
 * Exported pure functions (parseGitNameOnly, buildChurnList, normalizePath) are
 * kept side-effect-free for unit testing without touching disk or DB.
 */

'use strict';

const { spawnSync } = require('child_process');
const path          = require('path');
const fs            = require('fs');

// ---------------------------------------------------------------------------
// Pure helpers — no I/O, no DB access. Unit-testable in isolation.
// ---------------------------------------------------------------------------

/**
 * Normalize a path to forward slashes. Needed because git log on Windows can
 * output back-slashes, and we compare paths against DB rows that use forward
 * slashes (code_symbols.file).
 *
 * @param {string} p
 * @returns {string}
 */
function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

/**
 * Parse the output of `git log --name-only --format=` into a commit-count map.
 *
 * Each non-empty, non-separator line is treated as a file path. Empty lines
 * (commit separators) are skipped. We intentionally skip lines that look like
 * commit markers (40-char hex hashes) to be defensive, though --format= alone
 * suppresses the header.
 *
 * @param {string} raw  Raw stdout from git log --name-only --format=
 * @returns {Map<string, number>}  normalized-path → commit count
 */
function parseGitNameOnly(raw) {
  const counts = new Map();
  if (!raw) return counts;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    // Skip empty lines (commit separators) and pure hex hashes.
    if (!trimmed || /^[0-9a-f]{40}$/i.test(trimmed)) continue;

    const key = normalizePath(trimmed);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/**
 * Build the churn list from a commit-count map.
 *
 * @param {Map<string, number>} counts  normalized-path → commit count
 * @returns {{ file: string, commits: number, ratio: number }[]}
 *   Sorted descending by commits. ratio = commits / maxCommits (0 if max is 0).
 */
function buildChurnList(counts) {
  if (!counts || counts.size === 0) return [];

  const entries = Array.from(counts.entries())
    .map(([file, commits]) => ({ file, commits }))
    .sort((a, b) => b.commits - a.commits);

  const maxCommits = entries.length > 0 ? entries[0].commits : 0;

  return entries.map(e => ({
    file:    e.file,
    commits: e.commits,
    ratio:   maxCommits > 0 ? e.commits / maxCommits : 0,
  }));
}

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

/**
 * Compute file-level churn for a project.
 *
 * PRIMARY path: parse git log for the repo at repoDir.
 * FALLBACK path: if git is unavailable or repoDir is missing, use
 *   db.queryEditFrequency() which reads edit_events from SQLite + Parquet.
 *
 * @param {string}      project   Project name (used in the DB fallback query).
 * @param {string}      repoDir   Absolute path to the git repository root.
 * @param {object}      [db]      The db.cjs module (required for fallback).
 * @param {string}      [metricsRoot]  Passed through to queryEditFrequency.
 * @param {string}      [parquetDir]   Passed through to queryEditFrequency.
 * @returns {Promise<{
 *   source: 'git'|'edits',
 *   unavailable: boolean,
 *   maxCommits: number,
 *   churn: Array<{ file: string, commits: number, ratio: number }>
 * }>}
 */
async function getChurn(project, repoDir, db, metricsRoot, parquetDir) {
  // --- PRIMARY: git log ---
  const gitAvailable = repoDir && fs.existsSync(repoDir);
  if (gitAvailable) {
    const r = spawnSync(
      'git',
      ['log', '--name-only', '--format='],
      {
        cwd:        repoDir,
        encoding:   'utf8',
        maxBuffer:  64 * 1024 * 1024,
        timeout:    20000,
        windowsHide: true,
        shell:      false,
        stdio:      ['ignore', 'pipe', 'ignore'],
      }
    );

    if (r.status === 0) {
      const counts    = parseGitNameOnly(r.stdout || '');
      const churnList = buildChurnList(counts);
      const max       = churnList.length > 0 ? churnList[0].commits : 0;
      return { source: 'git', unavailable: false, maxCommits: max, churn: churnList };
    }
  }

  // --- FALLBACK: edit_events via db.queryEditFrequency ---
  if (db && typeof db.queryEditFrequency === 'function') {
    try {
      const rows = await db.queryEditFrequency(metricsRoot, parquetDir, 365);
      // Filter to this project and remap edit_count → commits for a uniform shape.
      const projectRows = rows.filter(r => !project || r.project === project);
      const counts = new Map(
        projectRows.map(r => [normalizePath(r.file_path), r.edit_count])
      );
      const churnList = buildChurnList(counts);
      const max       = churnList.length > 0 ? churnList[0].commits : 0;
      if (churnList.length > 0) {
        return { source: 'edits', unavailable: false, maxCommits: max, churn: churnList };
      }
    } catch (_) {
      // Fall through to unavailable.
    }
  }

  return { source: 'edits', unavailable: true, maxCommits: 0, churn: [] };
}

// ---------------------------------------------------------------------------

module.exports = {
  getChurn,
  parseGitNameOnly,
  buildChurnList,
  normalizePath,
};
