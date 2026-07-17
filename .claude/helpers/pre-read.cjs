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

  // Telemetry: record the Read before any gate so small-file reads count too.
  // Reads were the only major tool with no recording (Bash/Edit/Skill/Task all
  // record), which left tool-call analytics and the dashboard's code-graph
  // adoption metric with a permanently empty denominator.
  try {
    const dbT      = require('./db.cjs');
    const sessionT = require('./session.cjs');
    dbT.initialize(null, null);
    const sess = sessionT.get();
    if (sess) dbT.recordToolCall(sess.id, 'Read', JSON.stringify({ file_path: filePath }));
  } catch (_) { /* telemetry is best-effort — never block the Read */ }

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
    // Normalized-only predicate: comparing both sides separator-normalized is
    // a superset of the old (raw = ? OR normalized = ?) match, and it lets the
    // idx_edit_events_path_norm expression index serve the lookup instead of a
    // full edit_events scan on every Read.
    edits = raw.prepare(`
      SELECT file_path, project, change_type, timestamp, session_id
      FROM   edit_events
      WHERE  REPLACE(file_path,'\\','/') = ?
        AND  timestamp >= ?
      ORDER  BY timestamp DESC
      LIMIT  ?
    `).all(norm, cutoff, MAX_EDITS);
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

  // Symbol count for the file (used to suggest token-saving alternatives).
  let symCount = 0;
  let fileSize = 0;
  try {
    symCount = raw.prepare(
      `SELECT COUNT(*) AS n FROM code_symbols WHERE file = ? OR file = ?`
    ).get(filePath, filePath.replace(/\\/g, '/')).n || 0;
  } catch (_) {}
  try { fileSize = fs.statSync(filePath).size; } catch (_) {}

  if (uniqEdits.length === 0 && memory.length === 0 && symCount === 0) return noop();

  // Dedup: skip if this file was already injected in this session. Cuts
  // repeated 200-char vaultflow context blocks from N reads down to 1.
  const sessionId = input.session_id || (input.session && input.session.id) || null;
  const dedupPath = (() => {
    try {
      const yaml = require('js-yaml');
      const cfgPath = require('../../config/resolve.cjs');
      if (!fs.existsSync(cfgPath)) return null;
      const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
      const metrics = cfg.paths && cfg.paths.metrics_root;
      return metrics ? path.join(metrics, 'recent-injections.json') : null;
    } catch (_) { return null; }
  })();

  if (sessionId && dedupPath) {
    try {
      const state = fs.existsSync(dedupPath)
        ? JSON.parse(fs.readFileSync(dedupPath, 'utf8'))
        : {};
      const seen = state[sessionId] || {};
      if (seen[filePath]) return noop(); // already injected this file in this session
      seen[filePath] = Date.now();
      state[sessionId] = seen;
      // Trim other sessions older than 24h
      for (const k of Object.keys(state)) {
        if (k === sessionId) continue;
        const newest = Math.max(0, ...Object.values(state[k] || {}));
        if (Date.now() - newest > 24 * 3600 * 1000) delete state[k];
      }
      fs.writeFileSync(dedupPath, JSON.stringify(state), 'utf8');
    } catch (_) { /* dedup is best-effort; don't fail */ }
  }

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

  // Token-saving hint when the file is large AND indexed.
  if (symCount >= 10 && fileSize > 5000) {
    lines.push(`  💡 ${symCount} symbols indexed (${Math.round(fileSize/1024)}KB).`);
    lines.push(`     Save tokens: \`mcp__vaultflow__file_symbols\` for the map, then`);
    lines.push(`     \`mcp__vaultflow__get_symbol_body(file,name)\` for a single function.`);
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
