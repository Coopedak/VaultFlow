'use strict';

/**
 * git-context.cjs — surface current git state at session start.
 *
 * WHY: Every other AI assistant tool surfaces git context (branch, recent
 * commits, dirty files) at start. vaultflow didn't, so agents kept asking
 * "what branch am I on?" or shipping edits that conflicted with uncommitted
 * work. This injects a small, structured block.
 *
 * Errors are swallowed and return null — git missing or non-repo isn't fatal.
 */

const { execSync } = require('child_process');

function git(args, cwd, limitBytes = 8192) {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: limitBytes,
      timeout: 1500,
      windowsHide: true,
    }).trim();
  } catch (_) {
    return null;
  }
}

function ghCli(args, cwd) {
  try {
    return require('child_process').execSync(`gh ${args}`, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16384,
      timeout: 3000,
      windowsHide: true,
    }).trim();
  } catch (_) { return null; }
}

function getOpenPrs(cwd) {
  // Quietly returns [] if gh isn't installed/authed or repo has no remote.
  const out = ghCli('pr list --state open --limit 5 --json number,title,author,headRefName,isDraft', cwd);
  if (!out) return [];
  try {
    return JSON.parse(out).map(p => ({
      number: p.number,
      title:  (p.title || '').slice(0, 100),
      author: p.author && p.author.login,
      branch: p.headRefName,
      draft:  !!p.isDraft,
    }));
  } catch (_) { return []; }
}

function getContext(cwd) {
  if (!cwd) return null;
  const inside = git('rev-parse --is-inside-work-tree', cwd);
  if (inside !== 'true') return null;

  const branch  = git('rev-parse --abbrev-ref HEAD', cwd) || 'detached';
  const head    = git('rev-parse --short HEAD', cwd) || '';
  const upstream = git('rev-parse --abbrev-ref --symbolic-full-name @{u}', cwd);
  const aheadBehindRaw = upstream ? git('rev-list --left-right --count HEAD...@{u}', cwd) : null;
  let ahead = 0, behind = 0;
  if (aheadBehindRaw) {
    const [a, b] = aheadBehindRaw.split(/\s+/);
    ahead  = Number(a) || 0;
    behind = Number(b) || 0;
  }

  // Last 5 commits — first-line subjects only
  const log = git('log -5 --pretty=format:%h\t%s', cwd) || '';
  const commits = log.split('\n').filter(Boolean).map(line => {
    const [h, ...rest] = line.split('\t');
    return { hash: h, subject: rest.join('\t').slice(0, 100) };
  });

  // Uncommitted: short status, capped at 15 lines
  const statusRaw = git('status --short', cwd, 4096) || '';
  const statusLines = statusRaw.split('\n').filter(Boolean);
  const status = statusLines.slice(0, 15);

  const prs = getOpenPrs(cwd);

  return {
    branch,
    head,
    upstream,
    ahead,
    behind,
    commits,
    dirty_count: statusLines.length,
    status,
    open_prs: prs,
  };
}

module.exports = { getContext, getOpenPrs };
