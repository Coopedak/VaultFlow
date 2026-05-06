/**
 * project-audit.mjs — inventory C:\GIT projects and correlate vaultflow history
 *
 * Usage:
 *   node .claude/helpers/project-audit.mjs
 *   node .claude/helpers/project-audit.mjs --json
 *   node .claude/helpers/project-audit.mjs --root C:\GIT
 */

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const configPath = require('../../config/resolve.cjs');
const config = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const rootArgIdx = args.indexOf('--root');
const ROOT = rootArgIdx !== -1 ? args[rootArgIdx + 1] : (
  config?.paths?.watcher_watch_dir ||
  deriveRootFromGlob(config?.paths?.wiki_glob) ||
  'C:\\GIT'
);
const METRICS_ROOT = config?.paths?.metrics_root || '';
const DB_FILE = config?.storage?.db_file || 'vaultflow.db';
const DB_PATH = METRICS_ROOT ? path.join(METRICS_ROOT, DB_FILE) : null;

function deriveRootFromGlob(globValue) {
  if (!globValue) return null;
  const normalized = String(globValue).replace(/\//g, '\\');
  const idx = normalized.indexOf('*');
  return idx === -1 ? path.dirname(normalized) : normalized.slice(0, idx).replace(/[\\]+$/, '');
}

function runGit(repoPath, gitArgs) {
  try {
    const result = spawnSync('git', ['-C', repoPath, ...gitArgs], { encoding: 'utf8' });
    if (result.status !== 0) return '';
    return (result.stdout || '').trim();
  } catch {
    return '';
  }
}

function countDirty(repoPath) {
  const output = runGit(repoPath, ['status', '--porcelain']);
  if (!output) return 0;
  return output.split(/\r?\n/).filter(Boolean).length;
}

function daysSince(isoText) {
  if (!isoText) return null;
  const value = new Date(isoText);
  if (Number.isNaN(value.getTime())) return null;
  return Math.floor((Date.now() - value.getTime()) / 86400000);
}

function formatDays(days) {
  return days == null ? '-' : `${days}d`;
}

function buildPathLike(projectPath) {
  return `${projectPath
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')}\\%`;
}

function printTable(rows) {
  const headers = ['Project', 'Git', 'Sessions', 'Edits', 'Files', 'Tools', 'Last Commit', 'Last Seen', 'Dirty', 'Candidate'];
  const data = rows.map(r => [
    r.name,
    r.isGit ? 'yes' : 'no',
    String(r.sessionCount),
    String(r.editCount),
    String(r.fileCount),
    String(r.toolCount),
    formatDays(r.lastCommitDays),
    formatDays(r.lastSeenDays),
    String(r.dirtyCount),
    r.deadCandidate ? 'yes' : 'no',
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...data.map(row => row[i].length)));
  const line = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(headers));
  console.log(line(widths.map(w => '-'.repeat(w))));
  for (const row of data) console.log(line(row));
}

function computeDeadCandidate(project) {
  const staleCommit = project.lastCommitDays != null && project.lastCommitDays >= 21;
  const staleSeen = project.lastSeenDays != null && project.lastSeenDays >= 21;
  const noHistory = project.sessionCount === 0 && project.editCount === 0 && project.toolCount === 0;
  const noOrigin = project.isGit && !project.origin;
  const nonGit = !project.isGit;
  return (nonGit && noHistory) || (staleCommit && noHistory) || (staleSeen && noHistory) || (noOrigin && noHistory);
}

function loadDb() {
  if (!DB_PATH || !fs.existsSync(DB_PATH)) return null;
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

function queryProjectStats(db, projectName, projectPath) {
  if (!db) {
    return { sessionCount: 0, lastSeen: null, editCount: 0, fileCount: 0, toolCount: 0, topFiles: [] };
  }

  const pathLike = buildPathLike(projectPath);

  const sessionRow = db.prepare(`
    SELECT COUNT(*) AS cnt, MAX(COALESCE(ended_at, started_at)) AS last_seen
    FROM sessions
    WHERE project = ? OR cwd = ? OR cwd LIKE ? ESCAPE '\\'
  `).get(projectName, projectPath, pathLike);

  const editRow = db.prepare(`
    SELECT COUNT(*) AS edit_count, COUNT(DISTINCT file_path) AS file_count
    FROM edit_events
    WHERE project = ? OR file_path LIKE ? ESCAPE '\\'
  `).get(projectName, pathLike);

  const toolRow = db.prepare(`
    SELECT COUNT(*) AS tool_count
    FROM tool_calls tc
    JOIN sessions s ON s.id = tc.session_id
    WHERE s.project = ? OR s.cwd = ? OR s.cwd LIKE ? ESCAPE '\\'
  `).get(projectName, projectPath, pathLike);

  const topFiles = db.prepare(`
    SELECT file_path, COUNT(*) AS edit_count, MAX(timestamp) AS last_edit
    FROM edit_events
    WHERE project = ? OR file_path LIKE ? ESCAPE '\\'
    GROUP BY file_path
    ORDER BY edit_count DESC, last_edit DESC
    LIMIT 5
  `).all(projectName, pathLike);

  return {
    sessionCount: sessionRow?.cnt || 0,
    lastSeen: sessionRow?.last_seen || null,
    editCount: editRow?.edit_count || 0,
    fileCount: editRow?.file_count || 0,
    toolCount: toolRow?.tool_count || 0,
    topFiles,
  };
}

function auditProjects() {
  if (!fs.existsSync(ROOT)) {
    throw new Error(`Project root not found: ${ROOT}`);
  }

  const db = loadDb();
  try {
    const dirs = fs.readdirSync(ROOT, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b));

    return dirs.map((name) => {
      const projectPath = path.join(ROOT, name);
      const isGit = fs.existsSync(path.join(projectPath, '.git'));
      const branch = isGit ? runGit(projectPath, ['branch', '--show-current']) : '';
      const lastCommit = isGit ? runGit(projectPath, ['log', '-1', '--format=%cI']) : '';
      const origin = isGit ? runGit(projectPath, ['remote', 'get-url', 'origin']) : '';
      const dirtyCount = isGit ? countDirty(projectPath) : 0;
      const stats = queryProjectStats(db, name, projectPath);
      const project = {
        name,
        path: projectPath,
        isGit,
        branch,
        origin,
        dirtyCount,
        lastCommit: lastCommit || null,
        lastCommitDays: daysSince(lastCommit),
        sessionCount: stats.sessionCount,
        lastSeen: stats.lastSeen,
        lastSeenDays: daysSince(stats.lastSeen),
        editCount: stats.editCount,
        fileCount: stats.fileCount,
        toolCount: stats.toolCount,
        topFiles: stats.topFiles.map(file => ({
          path: file.file_path,
          editCount: file.edit_count,
          lastEdit: file.last_edit,
        })),
      };
      project.deadCandidate = computeDeadCandidate(project);
      return project;
    });
  } finally {
    try { db?.close(); } catch {}
  }
}

const projects = auditProjects();
const candidates = projects.filter(p => p.deadCandidate);

if (jsonMode) {
  console.log(JSON.stringify({
    root: ROOT,
    dbPath: DB_PATH,
    projectCount: projects.length,
    candidateCount: candidates.length,
    projects,
  }, null, 2));
} else {
  console.log(`vaultflow project audit`);
  console.log(`Root: ${ROOT}`);
  if (DB_PATH) console.log(`DB:   ${DB_PATH}`);
  console.log('');
  printTable(projects);
  console.log('');
  console.log(`Dead-project candidates: ${candidates.length}`);
  for (const candidate of candidates) {
    console.log(`- ${candidate.name} (${candidate.isGit ? 'git' : 'non-git'}, sessions=${candidate.sessionCount}, edits=${candidate.editCount}, tools=${candidate.toolCount})`);
  }
  console.log('');
  console.log('Projects with tracked file history:');
  for (const project of projects.filter(p => p.topFiles.length > 0)) {
    console.log(`- ${project.name}`);
    for (const file of project.topFiles.slice(0, 3)) {
      console.log(`  ${file.editCount}x  ${file.path}`);
    }
  }
}
