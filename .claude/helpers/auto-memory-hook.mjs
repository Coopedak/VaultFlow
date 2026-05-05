/**
 * auto-memory-hook.mjs — vaultflow memory bridge
 *
 * WHY: MEMORY.md files are the authoritative cross-session knowledge store.
 * This hook indexes them into SQLite FTS5 at SessionStart so every prompt
 * benefits from ranked memory retrieval, and re-sorts the main MEMORY.md at
 * Stop so the most actively-used projects surface first.
 *
 * Exports:
 *   doImport()        — fires at SessionStart
 *   doSync()          — fires at Stop
 *   parseMemoryFile() — pure parser, exported for testing
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath }                            from 'node:url';
import { createRequire }                            from 'node:module';
import { glob }                                     from 'glob';

// ── CJS interop ───────────────────────────────────────────────────────────
// db.cjs and js-yaml are CommonJS modules; load them via require() from ESM.
const require = createRequire(import.meta.url);
const db      = require('./db.cjs');
const yaml    = require('js-yaml');

// ── config ────────────────────────────────────────────────────────────────

function loadConfig() {
  const configPath = require('../../config/resolve.cjs');
  if (!existsSync(configPath)) {
    throw new Error(`vaultflow config not found: ${configPath}`);
  }
  return yaml.load(readFileSync(configPath, 'utf8')) || {};
}

// Cached after first call
let _config = null;

function getConfig() {
  if (!_config) _config = loadConfig();
  return _config;
}

function getMetricsRoot() {
  const cfg = getConfig();
  return (cfg.paths && cfg.paths.metrics_root) || '';
}

function getParquetDir() {
  const cfg = getConfig();
  return (cfg.storage && cfg.storage.parquet_dir) || 'parquet';
}

function getProjectsMemory() {
  const cfg = getConfig();
  return (cfg.paths && cfg.paths.projects_memory) || '';
}

function getVaultRoot() {
  const cfg = getConfig();
  return (cfg.paths && cfg.paths.vault_root) || '';
}

function getVaultDomainDir() {
  const cfg = getConfig();
  return (cfg.paths && cfg.paths.vault_domain_dir) || '';
}

function isDictionaryAutoPopulate() {
  const cfg = getConfig();
  return (cfg.intelligence && cfg.intelligence.dictionary_auto_populate) !== false;
}

function getMaxGraphNodes() {
  const cfg = getConfig();
  return (cfg.intelligence && cfg.intelligence.max_graph_nodes) || 5000;
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Ensure db is initialised before any DB operation.
 * Safe to call multiple times — db.initialize() is idempotent.
 */
function ensureDb() {
  const cfg  = getConfig();
  const root = getMetricsRoot();
  const file = (cfg.storage && cfg.storage.db_file) || 'vaultflow.db';
  db.initialize(root, file);
}

// ── parser ────────────────────────────────────────────────────────────────

/**
 * Extract hashtag-style (#word) and wikilink-style ([[word]]) tokens
 * from a block of text.
 *
 * Returns a space-separated string for storage in the tags column.
 *
 * @param {string} text
 * @returns {string}
 */
function extractTags(text) {
  const tags = new Set();

  // #hashtag — must start with # then one or more word chars
  for (const m of text.matchAll(/#([\w-]+)/g)) {
    tags.add(m[1].toLowerCase());
  }

  // [[wikilink]] — strip the brackets
  for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
    // A wikilink may contain display text after | — use only the target
    const target = m[1].split('|')[0].trim();
    if (target) tags.add(target.toLowerCase());
  }

  return Array.from(tags).join(' ');
}

/**
 * Parse a MEMORY.md file into an array of memory entries.
 *
 * Splitting strategy:
 *   - Split on lines that start with exactly `## ` (h2 headings only).
 *   - Content before the first h2 (frontmatter / intro) is discarded.
 *   - Each entry: { title, body, tags }
 *
 * @param {string} content     Raw file contents.
 * @param {string} sourcePath  Absolute path (unused in parsing; included for
 *                             callers that want it attached to each entry).
 * @returns {Array<{title: string, body: string, tags: string}>}
 */
export function parseMemoryFile(content, sourcePath) {
  if (!content || !content.trim()) return [];

  const entries = [];
  const lines   = content.split('\n');

  let currentTitle = null;
  let bodyLines    = [];

  for (const line of lines) {
    // Match h2 headings: `## ` at the start of the line (not h3+)
    if (/^## /.test(line)) {
      // Flush the previous entry if we had one
      if (currentTitle !== null) {
        const body = bodyLines.join('\n').trim();
        entries.push({ title: currentTitle, body, tags: extractTags(body) });
      }
      currentTitle = line.replace(/^## /, '').trim();
      bodyLines    = [];
    } else if (currentTitle !== null) {
      bodyLines.push(line);
    }
    // Lines before the first h2 are ignored
  }

  // Flush the last entry
  if (currentTitle !== null) {
    const body = bodyLines.join('\n').trim();
    entries.push({ title: currentTitle, body, tags: extractTags(body) });
  }

  return entries;
}

// ── doImport ──────────────────────────────────────────────────────────────

/**
 * doImport — fires at SessionStart
 *
 * 1. Globs for all MEMORY.md files under projects_memory and vault_root.
 * 2. Parses each file into memory entries.
 * 3. Calls db.replaceMemorySource() for each file (atomic replace in DB).
 * 4. Returns { filesLoaded, entriesLoaded }.
 *
 * One bad file does not abort the rest — errors are caught per-file and
 * written to stderr.
 *
 * @returns {Promise<{filesLoaded: number, entriesLoaded: number}>}
 */
export async function doImport() {
  let filesLoaded   = 0;
  let entriesLoaded = 0;

  try {
    ensureDb();
  } catch (err) {
    process.stderr.write(`auto-memory-hook doImport: db init failed: ${err.message}\n`);
    return { filesLoaded, entriesLoaded };
  }

  const projectsMemory = getProjectsMemory();
  const vaultRoot      = getVaultRoot();

  // Build the list of patterns to glob.
  // Convert Windows backslashes to forward slashes for glob compatibility.
  const patterns = [];

  if (projectsMemory) {
    // Every MEMORY.md in any subdirectory of projects_memory
    patterns.push(projectsMemory.replace(/\\/g, '/') + '/**/MEMORY.md');
  }

  if (vaultRoot) {
    // The top-level vault MEMORY.md
    patterns.push(vaultRoot.replace(/\\/g, '/') + '/MEMORY.md');
  }

  // Collect all matching paths (deduplicated by Set)
  const filePaths = new Set();

  for (const pattern of patterns) {
    try {
      const matches = await glob(pattern, { absolute: true, windowsPathsNoEscape: true });
      for (const m of matches) filePaths.add(m);
    } catch (err) {
      process.stderr.write(`auto-memory-hook doImport: glob failed for "${pattern}": ${err.message}\n`);
    }
  }

  // Parse and index each file
  for (const filePath of filePaths) {
    try {
      const content = readFileSync(filePath, 'utf8');
      const entries = parseMemoryFile(content, filePath);

      if (entries.length === 0) continue;

      db.replaceMemorySource(filePath, entries);

      filesLoaded++;
      entriesLoaded += entries.length;
    } catch (err) {
      process.stderr.write(`auto-memory-hook doImport: skipped "${filePath}": ${err.message}\n`);
    }
  }

  // ── dictionary auto-populate from vault/domain/ ──────────────────────
  if (isDictionaryAutoPopulate()) {
    const domainDir = getVaultDomainDir();
    if (domainDir) {
      try {
        const { importFromDirectory } = await import('./dict.mjs');
        const dictResult = await importFromDirectory(domainDir);
        if (dictResult.imported > 0) {
          process.stderr.write(
            `[vaultflow] doImport: dictionary — ${dictResult.imported} terms from ${dictResult.files} files\n`
          );
        }
      } catch (err) {
        process.stderr.write(`auto-memory-hook doImport: dict import error: ${err.message}\n`);
      }
    }
  }

  return { filesLoaded, entriesLoaded };
}

// ── doSync ────────────────────────────────────────────────────────────────

/**
 * Score an entry's relevance to recently-edited projects.
 *
 * @param {{title: string, body: string}} entry
 * @param {Array<{file_path: string, edit_count: number, project: string|null}>} recentEdits
 * @returns {number}  Raw score (higher = more relevant)
 */
function scoreEntry(entry, recentEdits) {
  let score = 0;
  const haystack = (entry.title + ' ' + entry.body).toLowerCase();

  for (const edit of recentEdits) {
    // Derive candidate project names from file_path and the project column
    const candidates = [];

    if (edit.project) {
      candidates.push(edit.project.toLowerCase());
    }

    if (edit.file_path) {
      // Extract the project-level folder name from the path
      // e.g. C:/GIT/BUZZ/wiki/index.md → 'buzz'
      const parts = edit.file_path.replace(/\\/g, '/').split('/');
      // The project folder is typically two levels before the leaf file
      for (let i = parts.length - 2; i >= 0; i--) {
        const part = parts[i].toLowerCase();
        if (part && part !== 'wiki' && part !== 'src' && part !== 'helpers') {
          candidates.push(part);
          break;
        }
      }
    }

    for (const candidate of candidates) {
      if (candidate && haystack.includes(candidate)) {
        // Weight by edit frequency: more edits → higher relevance boost
        score += edit.edit_count || 1;
      }
    }
  }

  return score;
}

/**
 * doSync — fires at Stop
 *
 * 1. Finds the primary MEMORY.md (projects_memory root, or first match).
 * 2. Parses it into entries.
 * 3. Scores each entry against recent edit frequency data from the DB.
 * 4. If the sorted order differs from current order, rewrites the file.
 * 5. Returns { reordered, entriesScored }.
 *
 * Errors are caught and must not crash the Stop hook.
 *
 * @returns {Promise<{reordered: boolean, entriesScored: number}>}
 */
export async function doSync() {
  let reordered     = false;
  let entriesScored = 0;

  try {
    const projectsMemory = getProjectsMemory();
    if (!projectsMemory) return { reordered, entriesScored };

    // ── find the primary MEMORY.md ────────────────────────────────────────
    // Try the direct root first, then fall back to the first glob match.
    const primaryPath = projectsMemory.replace(/\\/g, '/') + '/MEMORY.md';
    let memoryFilePath = null;

    if (existsSync(primaryPath)) {
      memoryFilePath = primaryPath;
    } else {
      const matches = await glob(
        projectsMemory.replace(/\\/g, '/') + '/**/MEMORY.md',
        { absolute: true, windowsPathsNoEscape: true }
      );
      if (matches.length > 0) memoryFilePath = matches[0];
    }

    if (!memoryFilePath) return { reordered, entriesScored };

    // ── read and parse ────────────────────────────────────────────────────
    const rawContent = readFileSync(memoryFilePath, 'utf8');
    const entries    = parseMemoryFile(rawContent, memoryFilePath);

    if (entries.length === 0) return { reordered, entriesScored };

    entriesScored = entries.length;

    // ── get recent edit data ──────────────────────────────────────────────
    let recentEdits = [];
    try {
      ensureDb();
      recentEdits = await db.queryEditFrequency(getMetricsRoot(), getParquetDir(), 30);
    } catch (err) {
      // Degraded mode: no edit data — skip reordering
      process.stderr.write(`auto-memory-hook doSync: queryEditFrequency failed: ${err.message}\n`);
      return { reordered, entriesScored };
    }

    // ── score and sort ────────────────────────────────────────────────────
    const maxNodes = getMaxGraphNodes();

    const scored = entries.map((entry, originalIndex) => ({
      entry,
      originalIndex,
      score: scoreEntry(entry, recentEdits),
    }));

    // Stable sort: higher score first; ties preserve original order
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.originalIndex - b.originalIndex;
    });

    // Respect max_graph_nodes cap (applies to entries, not total file lines)
    const capped = scored.slice(0, maxNodes);

    // ── check if order changed ────────────────────────────────────────────
    const orderChanged = capped.some((s, i) => s.originalIndex !== i);

    if (!orderChanged) {
      return { reordered: false, entriesScored };
    }

    // ── rebuild file ──────────────────────────────────────────────────────
    // Preserve everything before the first ## heading (frontmatter, intro text)
    const firstH2 = rawContent.search(/^## /m);
    const preamble = firstH2 === -1 ? '' : rawContent.slice(0, firstH2);

    const sortedSections = capped.map((s) => {
      // Reconstruct the section: heading + body
      const heading = `## ${s.entry.title}`;
      const body    = s.entry.body;
      return body ? `${heading}\n${body}` : heading;
    });

    // Join sections with a blank line between them for readability
    const newContent = preamble + sortedSections.join('\n\n') + '\n';

    writeFileSync(memoryFilePath, newContent, 'utf8');
    reordered = true;
  } catch (err) {
    // Must not crash the Stop hook
    process.stderr.write(`auto-memory-hook doSync: ${err.message}\n`);
  }

  return { reordered, entriesScored };
}
