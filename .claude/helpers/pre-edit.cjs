'use strict';

/**
 * pre-edit.cjs — PreToolUse(Edit|Write|MultiEdit) blast-radius warning.
 *
 * WHY: vaultflow's code-graph knows that some files are hubs (50+ dependents).
 * Editing those without auditing callers is the easiest way to ship breaking
 * changes. The data exists; the warning didn't. This hook injects a compact
 * warning into the agent's context BEFORE the edit is applied.
 *
 * Behaviour:
 *  - Only fires for Edit / Write / MultiEdit (NOT Read — pre-read.cjs handles that)
 *  - Looks up blast-radius via code-graph.cjs
 *  - If dependents >= THRESHOLD, injects a warning block listing the top 5
 *  - Always emits "permissionDecision: allow" — never blocks the edit
 *  - Silent for non-source files or low-blast-radius files
 *
 * Output: hookSpecificOutput JSON for PreToolUse, or empty for no-injection.
 */

const HUB_THRESHOLD = 10;

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

  const toolName = input.tool_name || '';
  if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) return noop();

  // Resolve target file path(s). MultiEdit uses edits[].file_path; others use file_path.
  const tin = input.tool_input || {};
  const files = toolName === 'MultiEdit'
    ? [...new Set((tin.edits || []).map(e => e.file_path).filter(Boolean))]
    : (tin.file_path ? [tin.file_path] : []);
  if (files.length === 0) return noop();

  let cg, db;
  try {
    db = require('./db.cjs');
    db.initialize();
    cg = require('./code-graph.cjs');
  } catch (_) { return noop(); }

  const warnings = [];
  for (const fp of files) {
    try {
      if (!cg.shouldIndex(fp)) continue; // Only warn about source files we'd index
      const deps = cg.getBlastRadius(db, fp);
      if (!deps || deps.length < HUB_THRESHOLD) continue;

      const top = deps.slice(0, 5).map(d => {
        const idx = Math.max(d.file.lastIndexOf('/'), d.file.lastIndexOf('\\'));
        const base = idx >= 0 ? d.file.slice(idx + 1) : d.file;
        return `  - ${base}:${d.line}`;
      });
      const more = deps.length > 5 ? `\n  …and ${deps.length - 5} more` : '';
      warnings.push(
        `⚠ **Hub file** — ${fp} has ${deps.length} dependents in this project.\n` +
        `Before changing exported names/signatures, audit callers:\n` +
        top.join('\n') + more
      );
    } catch (_) { /* skip this file */ }
  }

  if (warnings.length === 0) return noop();

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName:      'PreToolUse',
      permissionDecision: 'allow',
      additionalContext:  warnings.join('\n\n') + '\n\nUse `mcp__vaultflow__blast_radius` for the full list before changing public surface area.',
    },
  }));
  process.exit(0);
})();
