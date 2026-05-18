'use strict';

/**
 * commit-indexer.cjs — index git commit messages into FTS5 across projects.
 *
 * WHY: Commit messages are the densest record of "why we did X" — and we
 * never indexed them. This fills git_commits + git_commits_fts so the LLM
 * can search "ralph promotion" or "blast radius bug" and see the commit
 * that produced the change. Pairs with unified_search.
 *
 * Usage:
 *   const ci = require('./commit-indexer.cjs');
 *   ci.indexProject('/path/to/repo', 'project-name');
 *   ci.indexAllProjects('C:/GIT');  // sweep all sibling repos
 */

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const COMMIT_LIMIT = 500;

// Use unit/record separator control chars — not shell-special, not in commit text.
const FIELD = '\x1F';   // ASCII Unit Separator
const RECORD = '\x1E';  // ASCII Record Separator

function gitLog(args, cwd) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15000,
    windowsHide: true,
    shell: false,
  });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout;
}

function indexProject(db, repoDir, projectName) {
  if (!fs.existsSync(path.join(repoDir, '.git'))) return { skipped: true, reason: 'not-a-repo' };

  const fmt = `${FIELD}%H${FIELD}%an${FIELD}%aI${FIELD}%s${FIELD}%b${RECORD}`;
  const raw = gitLog(['log', `-${COMMIT_LIMIT}`, `--pretty=format:${fmt}`], repoDir);
  if (!raw) return { skipped: true, reason: 'git-log-failed' };

  const records = raw.split(RECORD).map(r => r.trim()).filter(Boolean);
  db.initialize(null, null);
  const conn = db.raw();
  const now = new Date().toISOString();

  const upsert = conn.prepare(`
    INSERT INTO git_commits (sha, project, author, committed_at, subject, body, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project, sha) DO UPDATE SET
      author       = excluded.author,
      committed_at = excluded.committed_at,
      subject      = excluded.subject,
      body         = excluded.body,
      indexed_at   = excluded.indexed_at
  `);

  let inserted = 0;
  conn.exec('BEGIN');
  try {
    for (const rec of records) {
      const parts = rec.split(FIELD);
      // parts[0] is empty (leading delimiter), then sha, author, date, subject, body
      const [, sha, author, date, subject, body] = parts;
      if (!sha) continue;
      upsert.run(
        sha.trim(),
        projectName,
        (author || '').slice(0, 200),
        date || null,
        (subject || '').slice(0, 500),
        (body || '').slice(0, 4000),
        now
      );
      inserted++;
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    return { error: err.message };
  }
  return { project: projectName, indexed: inserted };
}

function indexAllProjects(db, gitRoot) {
  if (!fs.existsSync(gitRoot)) return { skipped: true, reason: 'no-git-root' };
  const projects = fs.readdirSync(gitRoot, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name);

  const results = [];
  let total = 0;
  for (const p of projects) {
    const r = indexProject(db, path.join(gitRoot, p), p);
    if (r && r.indexed) { total += r.indexed; results.push(r); }
  }
  return { projects: results.length, commits: total, results };
}

function searchCommits(db, query, limit = 20) {
  db.initialize(null, null);
  // FTS5 phrase-escape: wrap query in quotes, escape internal quotes
  const phrase = `"${String(query).replace(/"/g, '""').slice(0, 200)}"`;
  return db.raw().prepare(`
    SELECT gc.sha, gc.project, gc.author, gc.committed_at, gc.subject,
           substr(gc.body, 1, 300) AS body_preview,
           bm25(git_commits_fts) AS rank
      FROM git_commits_fts f
      JOIN git_commits gc ON gc.rowid = f.rowid
     WHERE git_commits_fts MATCH ?
     ORDER BY rank
     LIMIT ?
  `).all(phrase, limit);
}

module.exports = { indexProject, indexAllProjects, searchCommits };
