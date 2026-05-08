'use strict';

/**
 * pre-read.cjs — PreToolUse(Read) file-context injection.
 *
 * Borrowed from claude-mem's `src/cli/handlers/file-context.ts`. When the model
 * is about to Read a file, query vaultflow's history for that path and surface
 * a compact "what we already know about this file" preamble via
 * hookSpecificOutput.additionalContext. Cuts duplicate exploration and grounds
 * decisions in prior session work.
 *
 * Output schema (PreToolUse):
 *   { "hookSpecificOutput": {
 *       "hookEventName":      "PreToolUse",
 *       "permissionDecision": "allow",
 *       "additionalContext":  "<text>"
 *     }
 *   }
 *
 * Behaviour:
 *  - Skip files smaller than the gate threshold (cheap reads don't need help)
 *  - Pull last 10 edits across all sessions, dedupe by session, group by day
 *  - Append up to 3 memory entries whose body or title matches the file
 *  - Cap output at ~1.5k chars so injection is bounded
 *  - On any error, emit no context (never block the Read)
 *
 * Stdin: Claude Code PreToolUse JSON payload.
 * Stdout: hookSpecificOutput JSON, or empty for no-injection.
 */

const fs   = require('node:fs');
const path = require('node:path');

// Gate: don't inject context for tiny files (1.5KB threshold mirrors
// claude-mem's FILE_READ_GATE_MIN_BYTES). Cheap reads don't pay for the lookup.
const GATE_MIN_BYTES = 1500;
const MAX_EDITS      = 10;
const MAX_MEMORY     = 3;
const MAX_OUT_CHARS  = 1500;
const LOOKBACK_DAYS  = 90;

function emit(obj) {
  // PreToolUse expects hookSpecificOutput at the top level.
  process.stdout.write(JSON.stringify(obj));
}

function noop() {
  // Empty stdout = "no decision, no context" — Read proceeds normally.
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end',  () => resolve(raw));
  });
}

function relTime(iso) {
  if (!iso) return '?';
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (h < 1)  return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${d}d ago`;
}

async function main() {
  let input;
  try {
    const raw = await readStdin();
    input = JSON.parse(raw || '{}');
  } catch (_) { return noop(); }

  const toolName = input.tool_name || '';
  const filePath = input.tool_input && input.tool_input.file_path;
  if (toolName !== 'Read' || !filePath || typeof filePath !== 'string') return noop();

  // Gate on file size — claude-mem's "File Read Gate" pattern.
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < GATE_MIN_BYTES) return noop();
  } catch (_) {
    // File doesn't exist locally (yet) — still allow context if DB has history.
  }

  let db, raw;
  try {
    db = require('./db.cjs');
    db.initialize();
    raw = db.raw();
    if (!raw) return noop();
  } catch (_) { return noop(); }

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400 * 1000).toISOString();
  const norm   = filePath.replace(/\\/g, '/');
  const baseLike = path.basename(norm);

  let edits = [];
  try {
    edits = raw.prepare(`
      SELECT file_path, project, change_type, timestamp, session_id
      FROM   edit_events
      WHERE  (file_path = ? OR REPLACE(file_path,'\\','/') = ?)
        AND  timestamp >= ?
      ORDER  BY timestamp DESC
      LIMIT  ?
    `).all(filePath, norm, cutoff, MAX_EDITS);
  } catch (_) { /* swallow */ }

  // Dedupe by session_id (one row per session, latest first).
  const seenSession = new Set();
  const uniqEdits = [];
  for (const e of edits) {
    if (!e.session_id || seenSession.has(e.session_id)) continue;
    seenSession.add(e.session_id);
    uniqEdits.push(e);
  }

  // Memory entries that mention this file. Cheap LIKE — full FTS would be
  // overkill for a per-Read hook.
  let memory = [];
  try {
    memory = raw.prepare(`
      SELECT title, body
      FROM   memory_entries
      WHERE  body LIKE ? OR title LIKE ?
      LIMIT  ?
    `).all(`%${baseLike}%`, `%${baseLike}%`, MAX_MEMORY);
  } catch (_) {}

  if (uniqEdits.length === 0 && memory.length === 0) return noop();

  // Build the preamble.
  const lines = [];
  lines.push(`vaultflow context for ${path.basename(filePath)}:`);
  if (uniqEdits.length) {
    const projectGuess = uniqEdits.find(e => e.project)?.project || '';
    if (projectGuess) lines.push(`  project: ${projectGuess}`);
    lines.push(`  recent activity (${uniqEdits.length} sessions):`);
    for (const e of uniqEdits) {
      lines.push(`    - ${e.change_type.padEnd(6)} ${relTime(e.timestamp)}  (session ${e.session_id.slice(0, 8)})`);
    }
  }
  if (memory.length) {
    lines.push(`  related memory:`);
    for (const m of memory) {
      const snippet = String(m.body || '').replace(/\s+/g, ' ').slice(0, 120);
      lines.push(`    - ${m.title}: ${snippet}`);
    }
  }

  let text = lines.join('\n');
  if (text.length > MAX_OUT_CHARS) text = text.slice(0, MAX_OUT_CHARS - 3) + '...';

  emit({
    hookSpecificOutput: {
      hookEventName:      'PreToolUse',
      permissionDecision: 'allow',
      additionalContext:  text,
    },
  });
}

main().catch(() => noop());

// Don't let the hook hang if stdin is empty / never closes.
process.on('uncaughtException', () => noop());
process.on('unhandledRejection', () => noop());
