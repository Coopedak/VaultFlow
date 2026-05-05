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

// ── memory re-index helpers ───────────────────────────────────────────────

/**
 * Returns true if the file is a wiki or vault markdown file that should be
 * kept live in memory_entries. Covers:
 *   - C:/GIT/<project>/wiki/**\/*.md
 *   - C:/Users/.../vault/**\/*.md  (but not .metrics/)
 */
function isMemoryFile(filePath) {
  if (!filePath || !filePath.endsWith('.md')) return false;
  const norm = filePath.replace(/\\/g, '/');
  if (norm.includes('/wiki/') && norm.includes('/GIT/')) return true;
  if (norm.includes('/vault/') && !norm.includes('/.metrics/')) return true;
  return false;
}

/**
 * Parse a markdown file into memory entries (same logic as backfill.mjs).
 * Each ## heading becomes an entry; preamble uses the filename as title.
 */
function parseMemoryFile(filePath, content) {
  const entries  = [];
  const basename = path.basename(filePath, '.md');
  const sections = content.split(/^(?=## )/m);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    let title, body;
    if (trimmed.startsWith('## ')) {
      const nl = trimmed.indexOf('\n');
      if (nl === -1) { title = trimmed.slice(3).trim(); body = ''; }
      else           { title = trimmed.slice(3, nl).trim(); body = trimmed.slice(nl + 1).trim(); }
    } else {
      title = basename;
      body  = trimmed;
    }
    if (!title) continue;
    // Simple tag extraction: hashtags and [[wikilinks]]
    const raw   = `${title} ${body}`;
    const tags  = [
      ...(raw.match(/#([a-z][a-z0-9_-]*)/gi) || []),
      ...(raw.match(/\[\[([^\]|]+)/g) || []).map(t => t.slice(2)),
    ].map(t => t.replace(/^#/, '').toLowerCase()).slice(0, 20).join(' ');
    entries.push({ title, body, tags });
  }
  return entries;
}

/**
 * Re-index a wiki or vault file into memory_entries so FTS5 stays current.
 */
function reindexMemoryFile(db, filePath) {
  const fs = require('fs');
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch (_) { return; }

  const entries = parseMemoryFile(filePath, content);
  if (entries.length === 0) return;

  try {
    db.replaceMemorySource(filePath, entries);
    process.stderr.write(`post-edit: re-indexed "${path.basename(filePath)}" — ${entries.length} entries\n`);
  } catch (err) {
    process.stderr.write(`post-edit: re-index error: ${err.message}\n`);
  }
}

// ── live registry update helpers ─────────────────────────────────────────

/**
 * Classify an edited file path to determine if it affects the agent or
 * tool registry. Returns 'agent', 'user-skill', 'tool-index', or null.
 */
function classifyRegistryFile(filePath) {
  if (!filePath) return null;
  const norm = filePath.replace(/\\/g, '/');
  // Project agent: C:/GIT/<project>/.claude/agents/<name>.md
  if (norm.includes('/.claude/agents/') && norm.endsWith('.md')) return 'agent';
  // User skill: C:/Users/.../.claude/skills/...
  if (norm.includes('/.claude/skills/') && norm.endsWith('.md')) return 'user-skill';
  // Vault tools index
  if (norm.endsWith('/vault/tools/index.md')) return 'tool-index';
  return null;
}

/**
 * Re-register a single agent file in vault_agents.
 * Source is derived from the project folder name.
 */
function upsertAgentFromFile(db, filePath, kind) {
  const fs   = require('fs');
  const path = require('path');
  const norm = filePath.replace(/\\/g, '/');
  const name = path.basename(filePath, '.md');

  let source = kind === 'user-skill' ? 'user-skill' : null;
  if (!source) {
    const parts  = norm.split('/');
    const gitIdx = parts.indexOf('GIT');
    source = gitIdx !== -1 ? `project:${parts[gitIdx + 1]}` : 'project';
  }

  let desc = '';
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    let inFm = lines[0] === '---';
    for (const line of lines) {
      if (inFm) { if (line === '---' && desc === '') inFm = false; continue; }
      const t = line.trim();
      if (t && !t.startsWith('#') && !t.startsWith('|') && !t.startsWith('-')) {
        desc = t.slice(0, 120);
        break;
      }
    }
  } catch (_) {}

  const agentId = source.startsWith('project:')
    ? `${source.slice(8)}::${name}`
    : name;

  try {
    db.upsertVaultAgent(agentId, name, source, desc, null);
    process.stderr.write(`post-edit: registered agent "${agentId}" (${source})\n`);
  } catch (err) {
    process.stderr.write(`post-edit: agent upsert error: ${err.message}\n`);
  }
}

/**
 * Re-parse vault/tools/index.md and upsert all tools found.
 * Uses the same H3-section + table/list parser as backfill.mjs.
 */
function refreshToolIndex(db, filePath) {
  const fs = require('fs');
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch (_) { return; }

  const entries = [];
  const seen    = new Set();

  // Line-by-line formats (table / list)
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let name = null, desc = '';
    const tm = line.match(/^\|\s*\[([^\]]+)\]\([^)]*\)\s*\|(.+)\|$/);
    if (tm) { name = tm[1].trim(); const cells = tm[2].split('|').map(c => c.trim()).filter(Boolean); desc = cells[cells.length-1]||''; }
    if (!name) { const m = line.match(/^[-*]\s+\[([^\]]+)\]\([^)]*\)\s*[—–-]\s*(.+)$/); if (m) { name=m[1].trim(); desc=m[2].trim(); } }
    if (!name) { const m = line.match(/^[-*]\s+\*\*([^*]+)\*\*\s*[—–-]\s*(.+)$/);       if (m) { name=m[1].trim(); desc=m[2].trim(); } }
    if (!name) { const m = line.match(/^[-*]\s+\[([^\]]+)\]\([^)]*\)\s*$/);               if (m) { name=m[1].trim(); } }
    if (name && !seen.has(name)) { seen.add(name); entries.push({ name, desc }); }
  }

  // H3 sections (vault tools format: ### tool-name)
  for (const section of content.split(/^(?=### )/m)) {
    const first = section.split('\n')[0];
    if (!first.startsWith('### ')) continue;
    const name = first.slice(4).trim();
    if (!name || seen.has(name)) continue;
    const bodyLines = section.split('\n').slice(1)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('-') && !l.startsWith('*') && !l.startsWith('`') && !l.startsWith('#') && l !== '---');
    const desc = bodyLines[bodyLines.length - 1] || '';
    seen.add(name);
    entries.push({ name, desc });
  }

  let count = 0;
  for (const { name, desc } of entries) {
    const toolId = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    try { db.upsertVaultTool(toolId, name, desc, null, ''); count++; } catch (_) {}
  }
  process.stderr.write(`post-edit: refreshed tool index — ${count} tools upserted\n`);
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

    db.initialize(null, null);

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

    db.upsertPattern(patternKey, null);

    const toolCallInput = JSON.stringify({ file_path: filePath, tool: toolName });
    db.recordToolCall(sessionId, toolName, toolCallInput);

    // ── live registry updates ───────────────────────────────────────────
    // When a registry-relevant file is edited, re-register it immediately
    // so vault_agents / vault_tools stay current without a manual backfill.
    const regKind = classifyRegistryFile(filePath);
    if (regKind === 'agent' || regKind === 'user-skill') {
      upsertAgentFromFile(db, filePath, regKind);
    } else if (regKind === 'tool-index') {
      refreshToolIndex(db, filePath);
    }

    // ── live memory re-index ────────────────────────────────────────────
    // When a wiki or vault .md file is edited, update its memory_entries
    // immediately so FTS5 search reflects the latest content.
    if (isMemoryFile(filePath)) {
      reindexMemoryFile(db, filePath);
    }

  } catch (err) {
    process.stderr.write(`post-edit: error: ${err.message}\n`);
  }

  process.exit(0);
}
