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
 * Resolve all edited file paths from the tool_input regardless of tool variant.
 * MultiEdit uses edits[].file_path; Write and Edit use file_path directly.
 * Returns an array of unique non-empty paths.
 */
function resolveFilePaths(toolName, toolInput) {
  if (toolName === 'MultiEdit') {
    const paths = (toolInput.edits || [])
      .map(e => e.file_path)
      .filter(Boolean);
    return [...new Set(paths)];
  }
  return toolInput.file_path ? [toolInput.file_path] : [];
}

// Project derivation lives in project-id.cjs so post-edit, watcher, session,
// and copilot-resume all share one source of truth (and one bug surface).
const { deriveProject } = require('./project-id.cjs');

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
  db.initialize(null, null);
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

  // Pull `description` from YAML frontmatter — that's the skill's trigger
  // pattern. Falls back to '' on missing/malformed frontmatter.
  let desc = '';
  try {
    const yaml = require('js-yaml');
    const raw  = fs.readFileSync(filePath, 'utf8');
    if (raw.startsWith('---')) {
      const end = raw.indexOf('\n---', 3);
      if (end !== -1) {
        const block = raw.slice(3, end).replace(/^\r?\n/, '');
        try {
          const fm = yaml.load(block) || {};
          if (typeof fm.description === 'string') desc = fm.description.trim().slice(0, 500);
        } catch (_) { /* malformed YAML — leave desc empty */ }
      }
    }
  } catch (_) {}

  const agentId = source.startsWith('project:')
    ? `${source.slice(8)}::${name}`
    : name;

  try {
    // description AND trigger_pattern get the same value: the frontmatter
    // description IS the routing trigger.
    db.upsertVaultAgent(agentId, name, source, desc, desc);
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

  // Tools live alongside the index file: prefer `<id>/`, fall back to `<id>.md`.
  const toolsRoot = path.dirname(filePath);
  let count = 0;
  for (const { name, desc } of entries) {
    const toolId   = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const toolDir  = path.join(toolsRoot, toolId);
    const toolFile = path.join(toolsRoot, `${toolId}.md`);
    let toolPath = null;
    try {
      if (fs.existsSync(toolDir)) toolPath = toolDir;
      else if (fs.existsSync(toolFile)) toolPath = toolFile;
    } catch (_) {}
    try { db.upsertVaultTool(toolId, name, desc, toolPath, ''); count++; } catch (_) {}
  }
  process.stderr.write(`post-edit: refreshed tool index — ${count} tools upserted\n`);
}

// ── main hook handler ─────────────────────────────────────────────────────
function run(input) {
  try {
    const toolName  = input.tool_name  || '';
    const toolInput = input.tool_input || {};

    const filePaths  = resolveFilePaths(toolName, toolInput);
    const changeType = toolName === 'Write' ? 'create' : 'edit';

    const db      = require('./db.cjs');
    const session = require('./session.cjs');

    db.initialize(null, null);

    const sess = session.start();
    if (!sess || !sess.id) {
      process.stderr.write('post-edit: no active session — skipping DB recording\n');
      return;
    }
    const sessionId = sess.id;

    // ── active-subagent attribution ───────────────────────────────────────
    // PreToolUse:Task writes {metrics_root}/active-subagent.json with the
    // running subagent's identity; SubagentStop clears it. When set, attribute
    // pattern fires to that agent so the dashboard's Patterns tab can show
    // which agent (developer-backend, researcher, etc.) caused the pattern.
    let activeAgent = null;
    try {
      const fsLocal   = require('fs');
      const pathLocal = require('path');
      const yaml      = require('js-yaml');
      const cfgPath   = require('../../config/resolve.cjs');
      const cfg       = fsLocal.existsSync(cfgPath) ? yaml.load(fsLocal.readFileSync(cfgPath, 'utf8')) : {};
      const metrics   = (cfg.paths && cfg.paths.metrics_root) || '';
      if (metrics) {
        const trackerPath = pathLocal.join(metrics, 'active-subagent.json');
        if (fsLocal.existsSync(trackerPath)) {
          const tracker = JSON.parse(fsLocal.readFileSync(trackerPath, 'utf8'));
          if (tracker && tracker.agent) activeAgent = String(tracker.agent);
        }
      }
    } catch (_) { /* leave activeAgent null on any read failure */ }

    // Resolve exclude_index_prefixes ONCE before the loop — reading config per
    // file was wasteful (N yaml parses for N edited files in a MultiEdit call).
    // Mirrors how code-graph.cjs caches _excludePrefixes via getExcludePrefixes().
    let _excludePrefixes = null;
    function getExcludePrefixes() {
      if (_excludePrefixes !== null) return _excludePrefixes;
      try {
        const yaml    = require('js-yaml');
        const fsLocal = require('fs');
        const cfgPath = require('../../config/resolve.cjs');
        const cfg     = fsLocal.existsSync(cfgPath) ? yaml.load(fsLocal.readFileSync(cfgPath, 'utf8')) : {};
        _excludePrefixes = ((cfg.paths && cfg.paths.exclude_index_prefixes) || ['d:/vaultflow', 'e:/git/vaultflow'])
          .map(p => String(p).replace(/\\/g, '/').toLowerCase());
      } catch (_) {
        // If config fails to load, fall back to the hardcoded defaults.
        _excludePrefixes = ['d:/vaultflow', 'e:/git/vaultflow'];
      }
      return _excludePrefixes;
    }

    // Record all edited files (MultiEdit may touch multiple paths).
    // db.recordEdit now also fires upsertPattern internally so the watcher
    // daemon and Copilot/Codex paths get pattern coverage too — pass the
    // active subagent through so attribution survives the consolidation.
    for (const filePath of filePaths) {
      // Skip transient DB files — WAL journals and SHM files are write-ahead
      // logs that change on every DB transaction and produce enormous noise in
      // edit_events and the Brain graph. Also skip excluded path prefixes for
      // defense-in-depth against snapshot copies (mirrors of D:/vaultflow etc).
      const fpNorm = filePath.replace(/\\/g, '/').toLowerCase();
      if (/\.(wal|duckdb\.wal|db-wal|db-shm)$/.test(fpNorm)) continue;
      if (getExcludePrefixes().some(pfx => fpNorm.startsWith(pfx))) continue;

      const project = deriveProject(filePath);

      db.recordEdit(sessionId, filePath, project, changeType, activeAgent);

      const regKind = classifyRegistryFile(filePath);
      if (regKind === 'agent' || regKind === 'user-skill') {
        upsertAgentFromFile(db, filePath, regKind);
      } else if (regKind === 'tool-index') {
        refreshToolIndex(db, filePath);
      }

      if (isMemoryFile(filePath)) {
        reindexMemoryFile(db, filePath);
      }

      // Code graph: regex-extract symbols + imports for source files. Cheap,
      // never blocks the hook on errors.
      try {
        const codeGraph = require('./code-graph.cjs');
        if (codeGraph.shouldIndex(filePath)) {
          const r = codeGraph.indexFile(db, filePath, project);
          if (r && (r.symbols || r.imports)) {
            process.stderr.write(`post-edit: code-graph "${path.basename(filePath)}" — ${r.symbols||0} syms / ${r.imports||0} imports\n`);
          }
        }
      } catch (err) {
        process.stderr.write(`post-edit: code-graph error: ${err.message}\n`);
      }
    }

    // Record one tool call entry for the overall operation
    const toolCallInput = JSON.stringify({
      file_paths: filePaths,
      tool: toolName,
    });
    db.recordToolCall(sessionId, toolName, toolCallInput);

    session.metric('edits');

  } catch (err) {
    process.stderr.write(`post-edit: error: ${err.message}\n`);
  }

  process.exit(0);
}
