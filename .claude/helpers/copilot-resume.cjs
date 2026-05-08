'use strict';
/**
 * copilot-resume.cjs — prints a brief session resume block to stderr
 *
 * Called by copilot-wrapper.ps1 before launching gh copilot.
 * Queries the vaultflow DB for recent edit_events and memory for the
 * current project, then prints a 5-10 line summary.
 *
 * Usage: node copilot-resume.cjs [project-name]
 * If project-name is omitted, uses the basename of process.cwd().
 */

const path = require('node:path');
const fs   = require('node:fs');
const { deriveProject } = require('./project-id.cjs');

// ── config ────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    const configPath = require('../../config/resolve.cjs');
    if (fs.existsSync(configPath)) {
      return require('js-yaml').load(fs.readFileSync(configPath, 'utf8')) || {};
    }
  } catch (_) {}
  return {};
}

// ── init (crash-safe) ─────────────────────────────────────────────────────

let raw;
try {
  const cfg = loadConfig();
  const db  = require('./db.cjs');
  db.initialize(
    (cfg.paths   && cfg.paths.metrics_root)  || null,
    (cfg.storage && cfg.storage.db_file)     || null
  );
  raw = db.raw();
} catch (err) {
  process.stderr.write(`[copilot-resume] DB unavailable — ${err.message}\n`);
  process.exit(0);
}

if (!raw) {
  process.stderr.write('[copilot-resume] DB not initialized — skipping resume\n');
  process.exit(0);
}

// ── args ──────────────────────────────────────────────────────────────────

// Prefer the project name derived from the git root; falls back to cwd basename
// only if we couldn't find a .git/anchor (otherwise we get bogus values like
// "YOU" for C:\Users\YOU\ or "GIT" for C:\GIT\).
const project = process.argv[2] || deriveProject(process.cwd()) || path.basename(process.cwd());

// ── queries (each individually crash-safe) ────────────────────────────────

// Recent files edited (last 72h), excluding build artifacts and generated context files
const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
let recentFiles = [];
try {
  recentFiles = raw.prepare(`
    SELECT file_path, MAX(timestamp) as last_edit, COUNT(*) as edits
    FROM   edit_events
    WHERE  (project = ? OR file_path LIKE ?)
      AND  timestamp > ?
      AND  file_path NOT LIKE '%.tsbuildinfo'
      AND  file_path NOT LIKE '%node_modules%'
      AND  file_path NOT LIKE '%.map'
      AND  file_path NOT LIKE '%\\dist\\%'
      AND  file_path NOT LIKE '%/dist/%'
      AND  file_path NOT LIKE '%AGENTS.md'
      AND  file_path NOT LIKE '%copilot-instructions.md'
      AND  file_path NOT LIKE '%wiki.mdc'
      AND  file_path NOT LIKE '%llms.txt'
    GROUP  BY file_path
    ORDER  BY last_edit DESC
    LIMIT  7
  `).all(project, `%${project}%`, cutoff);
} catch (_) {}

// Last session for this project
let lastSession = null;
try {
  lastSession = raw.prepare(`
    SELECT started_at, ended_at, duration_ms
    FROM   sessions
    WHERE  project = ?
    ORDER  BY started_at DESC
    LIMIT  1
  `).get(project);
} catch (_) {}

// Edit count total for project
let editCount = { cnt: 0 };
try {
  editCount = raw.prepare(`
    SELECT COUNT(*) as cnt FROM edit_events
    WHERE project = ? OR file_path LIKE ?
  `).get(project, `%${project}%`) || { cnt: 0 };
} catch (_) {}

// Top memory entries for this project
let memory = [];
try {
  const db = require('./db.cjs');
  memory = db.searchMemory(project, 3);
} catch (_) {}

// ── format ────────────────────────────────────────────────────────────────

function relTime(iso) {
  if (!iso) return '?';
  const diff = Date.now() - new Date(iso).getTime();
  const h    = Math.floor(diff / 3600000);
  const d    = Math.floor(diff / 86400000);
  if (h < 1)  return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${d}d ago`;
}

const lines = [
  `\x1b[36m── vaultflow resume: ${project} ──────────────────────────\x1b[0m`,
];

if (lastSession) {
  const durMin = Math.round((lastSession.duration_ms || 0) / 60000);
  lines.push(`  Last session : ${relTime(lastSession.started_at)}  (${durMin}m)`);
}
lines.push(`  Total edits  : ${editCount.cnt}`);

if (recentFiles.length) {
  lines.push(`  Recent (72h) :`);
  recentFiles.forEach(r => {
    const short = r.file_path.replace(/^.*[\\/]([^\\/]+[\\/][^\\/]+)$/, '$1');
    lines.push(`    ${short.padEnd(40)} ${r.edits} edit${r.edits !== 1 ? 's' : ''}  ${relTime(r.last_edit)}`);
  });
} else {
  lines.push('  No edits tracked in last 72h.');
}

if (memory.length) {
  lines.push('  Memory :');
  memory.slice(0, 2).forEach(m => {
    const snippet = m.body.replace(/\s+/g, ' ').slice(0, 80);
    lines.push(`    ${m.title}: ${snippet}`);
  });
}

lines.push('\x1b[36m──────────────────────────────────────────────────────────\x1b[0m');

process.stderr.write(lines.join('\n') + '\n');
