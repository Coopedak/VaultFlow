'use strict';

/**
 * shell-intent.cjs — extract read-intent file paths from a Bash command string.
 *
 * Borrowed pattern: claude-mem's `codex-file-context.ts` uses `shell-quote` to
 * detect when a command implies "read this file" (cat, head, tail, …). We
 * apply this to vaultflow tool_calls so every Bash read-intent surfaces the
 * same way an explicit `Read` tool invocation does — letting the dashboard,
 * resume preamble, and PreToolUse(Read) injection all see the file.
 *
 * No `shell-quote` dependency: a small, intentionally-narrow tokenizer is
 * enough for the surface we care about (cat/head/tail/less/more/bat/view/nl/
 * tac/file/wc, optionally piped or chained). It is not a full Bash parser.
 *
 * Returns an array of distinct file paths, capped at 10 to avoid runaway
 * captures from globs or argument-laden commands.
 */

const READ_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'bat', 'view',
  'nl', 'tac', 'file', 'wc', 'md5sum', 'sha1sum', 'sha256sum',
  'type',                            // Windows / PowerShell equivalents
  'Get-Content', 'gc', 'gci',
]);

const STATEMENT_SPLIT_RE = /\s*(?:&&|\|\||;|\||\n|\r)\s*/;
const FLAG_RE = /^-/;

// Tokenize one statement honoring single/double quotes and backslash escapes.
function tokenize(stmt) {
  const out = [];
  let buf = '';
  let quote = null; // "'" | '"' | null
  let i = 0;
  while (i < stmt.length) {
    const ch = stmt[i];
    if (quote) {
      // Inside double quotes, bash only honors \" \\ \$ \` \<newline>; any
      // other backslash is literal. This is essential on Windows where paths
      // like "C:\GIT\foo" must round-trip without the backslashes being eaten.
      if (ch === '\\' && quote === '"' && i + 1 < stmt.length) {
        const next = stmt[i + 1];
        if (next === '"' || next === '\\' || next === '$' || next === '`' || next === '\n') {
          buf += next;
          i += 2;
          continue;
        }
        // Not an escape — keep both characters literal.
        buf += ch;
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
        i++;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < stmt.length) {
      buf += stmt[i + 1];
      i += 2;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf) { out.push(buf); buf = ''; }
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf) out.push(buf);
  return out;
}

// Cheap path-shape check: rejects bare flags, env exports, and argv noise.
function looksLikePath(tok) {
  if (!tok) return false;
  if (FLAG_RE.test(tok)) return false;       // -n, --stdin
  if (tok.startsWith('=')) return false;     // KEY=VAL leftovers
  if (/^[A-Z_][A-Z0-9_]*=$/i.test(tok)) return false;
  if (tok.includes('=')) return false;       // KEY=VAL
  // Reject things that are obviously not paths (no separator, no dot, no slash)
  // unless they look like a bare filename with extension (foo.md).
  if (!/[\\/]/.test(tok) && !/\.[A-Za-z0-9]+$/.test(tok)) return false;
  return true;
}

/**
 * Extract read-intent file paths from a single Bash command string.
 * Returns up to `cap` distinct paths.
 *
 * @param {string} cmd       The Bash command string from tool_input.command
 * @param {number} [cap=10]
 * @returns {string[]}
 */
function extractReadIntents(cmd, cap = 10) {
  if (!cmd || typeof cmd !== 'string') return [];
  const seen = new Set();
  const out  = [];

  for (const stmt of cmd.split(STATEMENT_SPLIT_RE)) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;

    const tokens = tokenize(trimmed);
    if (tokens.length === 0) continue;

    // Skip env-var preamble (`FOO=bar baz cmd args`)
    let i = 0;
    while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/i.test(tokens[i])) i++;
    if (i >= tokens.length) continue;

    const head = tokens[i];
    if (!READ_COMMANDS.has(head)) continue;

    for (let j = i + 1; j < tokens.length; j++) {
      const tok = tokens[j];
      if (FLAG_RE.test(tok)) continue;
      if (!looksLikePath(tok)) continue;
      if (seen.has(tok)) continue;
      seen.add(tok);
      out.push(tok);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

module.exports = { extractReadIntents, tokenize, READ_COMMANDS };
