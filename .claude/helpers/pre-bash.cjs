'use strict';

/**
 * pre-bash.cjs — PreToolUse(Bash) MCP-equivalent suggestion.
 *
 * WHY: Several common shell commands are slower / token-heavier than the MCP
 * equivalent. Surface a hint when we detect one, but never block.
 *
 * Patterns detected:
 *   git log --grep=...   → mcp__vaultflow__search_commits
 *   find . -name X.cs    → mcp__vaultflow__find_symbol or file_symbols
 *   grep -r X .          → mcp__vaultflow__find_symbol or unified_search
 *   ls -R, find . -type f → file_symbols / get_symbol_body for code files
 *   cat file.cs          → get_symbol_body if you only need one symbol
 *
 * Stays silent for short commands or anything not pattern-matching.
 */

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.on('data', c => raw += c);
    process.stdin.on('end',  () => resolve(raw));
  });
}
function noop() { process.exit(0); }

(async () => {
  let input;
  try { input = JSON.parse(await readStdin() || '{}'); }
  catch (_) { return noop(); }

  if (input.tool_name !== 'Bash') return noop();
  const cmd = (input.tool_input && input.tool_input.command) || '';
  if (!cmd || cmd.length < 5) return noop();

  let hint = null;

  // git log --grep / git log -S — searching commit history
  if (/\bgit\s+log\b.*(--grep|--all-match|-S\b)/i.test(cmd)) {
    const m = cmd.match(/(?:--grep[= ]|"-S"?\s*)['"]?([^'"\s]+)/i);
    const q = m ? m[1] : '<term>';
    hint = `💡 Searching commits? \`mcp__vaultflow__search_commits("${q}")\` indexes 3,500+ commits across all your projects in one FTS5 query — no per-repo iteration.`;
  }

  // find . -name foo.* — looking for files by name
  else if (/\bfind\b\s+\S+\s+-name\b/i.test(cmd)) {
    const m = cmd.match(/-name\s+["']?([^"'\s]+?)["']?(?:\s|$)/i);
    if (m) {
      const base = m[1].replace(/\*/g, '').replace(/\.[^.]+$/, '');
      if (base && base.length >= 3) {
        hint = `💡 If "${base}" is a symbol (function/class), \`mcp__vaultflow__find_symbol("${base}")\` is instant. \`file_symbols\` lists everything in a file without reading it.`;
      }
    }
  }

  // grep -r X . or rg X — recursive content search
  else if (/\b(?:grep\s+-r\b|rg\b)/i.test(cmd)) {
    const m = cmd.match(/(?:grep\s+-r\s+|rg\s+)["']?([A-Za-z_][\w$]{2,})["']?(?:\s|$)/);
    if (m) {
      const term = m[1];
      hint = `💡 For symbols, \`mcp__vaultflow__find_symbol("${term}")\` returns file+line+kind without scanning. For broader concept search, \`mcp__vaultflow__unified_search\`.`;
    }
  }

  // cat <file> on indexed source files
  else if (/^cat\s+["']?[^"'\s|;&]+\.(cs|ts|tsx|js|jsx|mjs|cjs|py)["']?\s*$/i.test(cmd.trim())) {
    hint = `💡 If you only need one symbol from this file, \`mcp__vaultflow__get_symbol_body(file, name)\` is ~98% fewer tokens than reading the whole file.`;
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
