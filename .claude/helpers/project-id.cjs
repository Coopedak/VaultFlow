'use strict';

const fs   = require('fs');
const path = require('path');

// Anchors that mark a project root. The dirname containing the .git directory
// wins; if no .git is found, the segment immediately following one of these
// anchors is used. Last resort: null (caller may default to its own bucket).
const PATH_ANCHORS = ['GIT', 'Projects', 'projects', 'src', 'work'];

// Project names we never want to record — these come from path-anchor or
// home-folder basenames and are meaningless as project labels.
const BLOCKLIST = new Set([
  'system32', 'System32', 'Windows', 'windows',
  'YOU', 'Users', 'users', 'AppData', 'AppData', 'Local', 'Roaming', 'Temp', 'temp', 'tmp',
  'GIT', 'Projects', 'projects',
  '.claude', '.cursor', '.vscode', '.git', '.github',
  'memory', 'rules', 'skills', 'agents',
  'helpers', 'dashboard',
]);

function normalize(p) {
  return p ? p.replace(/\\/g, '/') : '';
}

function dirname(p) {
  return path.dirname(p);
}

/**
 * Walk up from `start` looking for a directory containing `.git`. Returns the
 * basename of that directory (the project name) or null. Stops at the
 * filesystem root or after 12 levels.
 */
function gitRootName(start) {
  let cur = start;
  if (!cur) return null;
  for (let i = 0; i < 12; i++) {
    try {
      if (fs.existsSync(path.join(cur, '.git'))) {
        return path.basename(cur) || null;
      }
    } catch (_) { /* unreadable — keep walking */ }
    const parent = dirname(cur);
    if (!parent || parent === cur) return null;
    cur = parent;
  }
  return null;
}

/**
 * Derive a project name from a file or directory path.
 *  1. Walk up the tree looking for a `.git` directory — its parent dir
 *     basename is the project (the canonical path).
 *  2. If no `.git` is found, look for a path anchor segment (`GIT`, `Projects`)
 *     and return the segment after it.
 *  3. If neither matches, return null. NEVER fall back to `basename(dirname)` —
 *     that produces noise like `system32`, `.claude`, `memory`, `rules`.
 *
 * Always returns null (never an empty string or 'unknown') when the path is
 * not associable with a project. Callers should treat null as "no project".
 *
 * @param {string} filePath  An absolute file or directory path
 * @returns {string|null}
 */
function deriveProject(filePath) {
  if (!filePath) return null;
  const startDir = isProbablyDir(filePath) ? filePath : dirname(filePath);

  const fromGit = gitRootName(startDir);
  if (fromGit && !BLOCKLIST.has(fromGit)) return fromGit;

  const norm  = normalize(filePath);
  const parts = norm.split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    if (PATH_ANCHORS.includes(parts[i]) || parts[i].toUpperCase() === 'GIT') {
      const candidate = parts[i + 1];
      if (candidate && !BLOCKLIST.has(candidate)) return candidate;
    }
  }
  return null;
}

function isProbablyDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

module.exports = { deriveProject, gitRootName };
