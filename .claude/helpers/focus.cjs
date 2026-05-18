'use strict';

/**
 * focus.cjs — load and write the per-project "current focus" file.
 *
 * WHY: vaultflow records what happened (events, edits, prompts). It doesn't
 * record what the user is *trying* to do this week. A single focus.md per
 * project, surfaced at SessionStart and inside agent-context.json, lets every
 * agent align without the user re-stating intent.
 *
 * Location: {vault_root}/projects/{project}/focus.md
 * Format: free-form markdown. First non-empty H1/H2 line is treated as the
 * headline. Body returned verbatim (capped at 4 KB).
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const MAX_BYTES = 4 * 1024;

function _vaultRoot() {
  try {
    const cfgPath = require('../../config/resolve.cjs');
    if (!fs.existsSync(cfgPath)) return null;
    const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
    return (cfg.paths && cfg.paths.vault_root) || null;
  } catch (_) { return null; }
}

function focusPath(project) {
  if (!project) return null;
  const root = _vaultRoot();
  if (!root) return null;
  return path.join(root, 'projects', project, 'focus.md');
}

function load(project) {
  const fp = focusPath(project);
  if (!fp || !fs.existsSync(fp)) return null;

  let body;
  try { body = fs.readFileSync(fp, 'utf8'); }
  catch (_) { return null; }

  if (body.length > MAX_BYTES) body = body.slice(0, MAX_BYTES) + '\n…(truncated)';

  let headline = null;
  for (const line of body.split('\n')) {
    const m = line.match(/^#{1,3}\s+(.+)$/);
    if (m) { headline = m[1].trim(); break; }
    const trimmed = line.trim();
    if (trimmed && !headline) { headline = trimmed.slice(0, 200); break; }
  }

  const stat = fs.statSync(fp);
  return {
    project,
    path: fp,
    headline,
    body,
    updated_at: stat.mtime.toISOString(),
  };
}

function save(project, body) {
  const fp = focusPath(project);
  if (!fp) throw new Error('focus.save: vault_root not configured');
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, body, 'utf8');
  return fp;
}

module.exports = { focusPath, load, save };
