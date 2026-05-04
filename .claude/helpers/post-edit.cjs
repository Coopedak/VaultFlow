'use strict';

const path = require('path');

// ── stdin collection ──────────────────────────────────────────────────────
process.stdin.resume();
let _raw = '';
process.stdin.on('data', (chunk) => { _raw += chunk; });
process.stdin.on('end', () => {
  try {
    run(JSON.parse(_raw));
  } catch (err) {
    process.stderr.write(`post-edit: parse failed: ${err.message}\n`);
    process.exit(0);
  }
});

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Resolve the edited file path from the tool_input regardless of tool variant.
 * MultiEdit uses edits[].file_path; Write and Edit use file_path directly.
 */
function resolveFilePath(toolName, toolInput) {
  if (toolName === 'MultiEdit') {
    return toolInput.edits && toolInput.edits[0] && toolInput.edits[0].file_path
      ? toolInput.edits[0].file_path
      : null;
  }
  return toolInput.file_path || null;
}

/**
 * Derive project name from a file path: the segment of the path that sits
 * two levels below a known project root anchor (e.g. C:\GIT\<project>\...).
 * Falls back to the directory name directly containing the file.
 */
function deriveProject(filePath) {
  if (!filePath) return null;
  const parts = filePath.replace(/\\/g, '/').split('/');
  // Walk up looking for a GIT or Projects segment and take the next part
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i].toUpperCase() === 'GIT' || parts[i] === 'Projects') {
      return parts[i + 1] || null;
    }
  }
  // Fallback: basename of immediate parent directory
  return path.basename(path.dirname(filePath)) || null;
}

/**
 * Build the pattern key from a file path: '<ext>::<parent-dir-basename>'.
 * E.g. a TypeScript file in src/ yields 'ts::src'.
 */
function buildPatternKey(filePath) {
  if (!filePath) return 'unknown::unknown';
  const ext    = path.extname(filePath).replace('.', '') || 'noext';
  const parent = path.basename(path.dirname(filePath)) || 'root';
  return `${ext}::${parent}`;
}

// ── main hook handler ─────────────────────────────────────────────────────
function run(input) {
  try {
    const toolName  = input.tool_name  || '';
    const toolInput = input.tool_input || {};

    const filePath   = resolveFilePath(toolName, toolInput);
    const project    = deriveProject(filePath);
    const changeType = toolName === 'Write' ? 'create' : 'edit';
    const patternKey = buildPatternKey(filePath);

    const db      = require('./db.cjs');
    const session = require('./session.cjs');

    // Initialize DB via config (db.initialize reads config internally when
    // metricsRoot is null)
    db.initialize(null, null);

    // Restore or start session (idempotent)
    const sess = session.start();
    if (!sess || !sess.id) {
      process.stderr.write('post-edit: no active session — skipping DB recording\n');
      return;
    }
    const sessionId = sess.id;

    if (filePath) {
      db.recordEdit(sessionId, filePath, project, changeType);
    }

    session.metric('edits');

    // Agent field is intentionally null here — post-edit fires outside any
    // named agent context; the pattern_key alone carries the signal.
    db.upsertPattern(patternKey, null);

    // Record as a tool call for deduplication telemetry. Serialise only the
    // file_path so the hash is stable across calls to the same file.
    const toolCallInput = JSON.stringify({ file_path: filePath, tool: toolName });
    db.recordToolCall(sessionId, toolName, toolCallInput);

  } catch (err) {
    // Hooks must always exit 0 — only write to stderr
    process.stderr.write(`post-edit: error: ${err.message}\n`);
  }

  process.exit(0);
}
