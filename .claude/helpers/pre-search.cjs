'use strict';

/**
 * pre-search.cjs — PreToolUse(Grep|Glob) MCP-tool suggestion.
 *
 * WHY: When Claude greps for a function/class name or globs for a symbol,
 * the answer is already in vaultflow's code-graph index — instantly, with
 * no exploration tokens. This hook detects identifier-like search queries
 * and suggests the MCP alternative. The grep/glob still runs; this just
 * adds a hint.
 *
 * Triggers:
 *  - Grep pattern that looks like a bare identifier (`recordEdit`,
 *    `MyClass`, `find_users`) — suggest find_symbol
 *  - Glob pattern targeting a single named file (e.g. `**\/recordEdit.*`)
 *    — suggest find_symbol
 *
 * Always emits permissionDecision: allow (never blocks).
 */

const IDENT_RE = /^[A-Za-z_][\w$]{2,}$/;

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end',  () => resolve(raw));
  });
}
function noop() { process.exit(0); }

(async () => {
  let input;
  try { input = JSON.parse(await readStdin() || '{}'); }
  catch (_) { return noop(); }

  const tool = input.tool_name;
  if (!['Grep', 'Glob'].includes(tool)) return noop();

  const tin = input.tool_input || {};

  // Telemetry: Grep/Glob calls were never recorded (Bash/Edit/Read/Skill all
  // are), leaving tool-call analytics blind to exploration activity. Mirrors
  // the pre-bash recording pattern; failure never blocks the search.
  try {
    const db      = require('./db.cjs');
    const session = require('./session.cjs');
    db.initialize(null, null);
    const sess = session.get();
    if (sess) db.recordToolCall(sess.id, tool, JSON.stringify({ pattern: String(tin.pattern || '').slice(0, 500) }));
  } catch (_) {}

  let hint = null;

  if (tool === 'Grep') {
    const pattern = String(tin.pattern || '').trim();
    // Bare identifier → likely a symbol lookup
    if (IDENT_RE.test(pattern)) {
      hint = `💡 \`${pattern}\` looks like a symbol name. Try \`mcp__vaultflow__find_symbol\` first — it returns file+line+kind from the indexed symbol table without any file reads.`;
    }
    // Looking for "function FOO" or "class FOO" — definite symbol lookup
    else if (/^(function|class|def|interface|type|enum)\s+[A-Za-z_]/.test(pattern)) {
      const m = pattern.match(/([A-Za-z_][\w$]*)$/);
      if (m) hint = `💡 Searching for a definition of \`${m[1]}\`. Use \`mcp__vaultflow__find_symbol("${m[1]}")\` — indexed across 54k symbols, no grep needed.`;
    }
  } else if (tool === 'Glob') {
    const pattern = String(tin.pattern || '').trim();
    // Looking for a specific named file? Bare basename in **/<name>.* form
    const m = pattern.match(/(?:^|[\/\\*])([A-Za-z_][\w$]+)\.[*A-Za-z]+$/);
    if (m && IDENT_RE.test(m[1])) {
      hint = `💡 Looking for a file named "${m[1]}". If you want its symbols/structure, try \`mcp__vaultflow__find_symbol("${m[1]}")\` or list with \`mcp__vaultflow__file_symbols\` after globbing.`;
    }
  }

  if (!hint) return noop();

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName:      'PreToolUse',
      permissionDecision: 'allow',
      additionalContext:  hint,
    },
  }));
  process.exit(0);
})();
