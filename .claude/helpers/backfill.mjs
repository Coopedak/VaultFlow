/**
 * backfill.mjs — one-shot vault + wiki indexer for vaultflow
 *
 * WHY: Crawls the entire vault and all project wikis, parses every .md file
 * into memory entries, and loads them into the SQLite FTS5 index via
 * db.replaceMemorySource(). After this runs, searchMemory() covers the full
 * vault history without waiting for the session-start hook.
 *
 * Run:
 *   node backfill.mjs
 *   node backfill.mjs --dry-run   (parse only — no DB writes)
 *
 * Or import and call programmatically:
 *   import { runBackfill } from './backfill.mjs';
 *   await runBackfill({ dryRun: true });
 */

import { createRequire }  from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import path               from 'node:path';
import { fileURLToPath }  from 'node:url';
import { glob }           from 'glob';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Load CJS data layer via createRequire — keeps files independent
const require = createRequire(import.meta.url);
const db      = require('./db.cjs');

// ── config ────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.resolve(__dirname, '../../config/vaultflow.yaml');

/**
 * Load vaultflow.yaml. Returns a plain object. Requires js-yaml (already a
 * dep of db.cjs so it is guaranteed to be installed).
 */
function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`vaultflow config not found at ${CONFIG_PATH}`);
  }
  const yaml = require('js-yaml');
  return yaml.load(readFileSync(CONFIG_PATH, 'utf8'));
}

// ── file collection ───────────────────────────────────────────────────────

const MAX_FILE_BYTES = 500 * 1024; // 500 KB

/**
 * Return true when the buffer's first 512 bytes contain a null byte —
 * heuristic for binary content.
 */
function isBinary(buf) {
  const probe = Math.min(buf.length, 512);
  for (let i = 0; i < probe; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Collect all .md files to index, deduplicating by absolute path.
 *
 * Sources:
 *  - All .md files under vault_root (recursive)
 *  - Files matching wiki_glob
 *  - Files matching claude_glob
 *
 * @param {object} cfg  Parsed vaultflow.yaml
 * @returns {Promise<string[]>}  Sorted, deduplicated absolute paths
 */
async function collectFiles(cfg) {
  const seen = new Set();
  const files = [];

  // Build exclusion set from config (matched against path segments)
  const excludeProjects = new Set(
    (cfg.paths.exclude_projects || []).map(p => p.toLowerCase())
  );

  function isExcluded(absPath) {
    if (excludeProjects.size === 0) return false;
    const normalized = absPath.replace(/\\/g, '/');
    return normalized.split('/').some(seg => excludeProjects.has(seg.toLowerCase()));
  }

  function add(p) {
    const abs = path.resolve(p);
    if (!seen.has(abs) && !isExcluded(abs)) {
      seen.add(abs);
      files.push(abs);
    }
  }

  const vaultRoot  = cfg.paths.vault_root;
  const wikiGlob   = cfg.paths.wiki_glob;
  const claudeGlob = cfg.paths.claude_glob;

  // 1. Vault root — all .md recursively
  if (vaultRoot && existsSync(vaultRoot)) {
    const vaultFiles = await glob('**/*.md', {
      cwd:     vaultRoot,
      nodir:   true,
      absolute: false,
      windowsPathsNoEscape: true,
    });
    for (const f of vaultFiles) {
      add(path.join(vaultRoot, f));
    }
  }

  // 2. Wiki glob — e.g. C:/GIT/*/wiki/**/*.md
  if (wikiGlob) {
    const wikiFiles = await glob(wikiGlob, {
      nodir:   true,
      absolute: true,
      windowsPathsNoEscape: true,
    });
    for (const f of wikiFiles) add(f);
  }

  // 3. CLAUDE.md glob — e.g. C:/GIT/*/CLAUDE.md
  if (claudeGlob) {
    const claudeFiles = await glob(claudeGlob, {
      nodir:   true,
      absolute: true,
      windowsPathsNoEscape: true,
    });
    for (const f of claudeFiles) add(f);
  }

  return files.sort();
}

// ── markdown parser ───────────────────────────────────────────────────────

/**
 * Extract lowercase, alphanumeric words from text as a space-separated tag
 * string. Filters out stop words and short tokens.
 *
 * @param {string} text
 * @returns {string}
 */
function extractTags(text) {
  const STOP = new Set([
    'the','and','for','are','but','not','you','all','can','her','was',
    'one','our','out','day','get','has','him','his','how','its','may',
    'new','now','off','old','see','two','use','way','who','did','let',
    'put','say','she','too','use','any','had','from','this','that',
    'with','have','will','been','they','were','when','then','than',
    'into','also','each','more','some','what','here','even','such',
    'just','only','over','like','both','well','made','very','must',
  ]);

  return [...text.matchAll(/[a-zA-Z0-9_-]{3,}/g)]
    .map(m => m[0].toLowerCase())
    .filter(w => !STOP.has(w))
    .slice(0, 50)           // cap tag count per entry
    .join(' ');
}

/**
 * Parse a Markdown file into memory entries.
 *
 * Each `##` heading starts a new entry. The preamble before the first `##`
 * (if non-empty) becomes its own entry using the filename as the title.
 *
 * Each entry: { title: string, body: string, tags: string }
 *
 * This logic is intentionally duplicated from auto-memory-hook.mjs so
 * backfill.mjs is independently runnable without cross-file imports.
 *
 * @param {string} filePath   Absolute path (used only for fallback title)
 * @param {string} content    Raw file content
 * @returns {Array<{title: string, body: string, tags: string}>}
 */
function parseMemoryFile(filePath, content) {
  const entries = [];
  const basename = path.basename(filePath, '.md');

  // Split on ## headings — keep the delimiter so we can recover the heading text
  const sections = content.split(/^(?=## )/m);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    let title;
    let body;

    if (trimmed.startsWith('## ')) {
      // First line is the heading
      const newline = trimmed.indexOf('\n');
      if (newline === -1) {
        title = trimmed.slice(3).trim();
        body  = '';
      } else {
        title = trimmed.slice(3, newline).trim();
        body  = trimmed.slice(newline + 1).trim();
      }
    } else {
      // Preamble before the first ## heading
      title = basename;
      body  = trimmed;
    }

    if (!title) continue;

    const tags = extractTags(`${title} ${body}`);
    entries.push({ title, body, tags });
  }

  return entries;
}

// ── registry backfill helpers ─────────────────────────────────────────────

/**
 * Parse a markdown index file (table or list format) into [{name, desc}].
 * Reuses the same three formats supported by router.cjs.
 */
function parseIndexFile(content) {
  const entries = [];
  const seen    = new Set();

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    let name = null;
    let desc = '';

    // Table row: | [name](path) | ... | description |
    const tableMatch = line.match(/^\|\s*\[([^\]]+)\]\([^)]*\)\s*\|(.+)\|$/);
    if (tableMatch) {
      name = tableMatch[1].trim();
      const cells = tableMatch[2].split('|').map(c => c.trim()).filter(Boolean);
      desc = cells[cells.length - 1] || '';
    }

    // List with link: - [name](path) — description
    if (!name) {
      const listLink = line.match(/^[-*]\s+\[([^\]]+)\]\([^)]*\)\s*[—–-]\s*(.+)$/);
      if (listLink) { name = listLink[1].trim(); desc = listLink[2].trim(); }
    }

    // Bold list: - **name** — description
    if (!name) {
      const boldItem = line.match(/^[-*]\s+\*\*([^*]+)\*\*\s*[—–-]\s*(.+)$/);
      if (boldItem) { name = boldItem[1].trim(); desc = boldItem[2].trim(); }
    }

    // Plain list with link: - [name](path)
    if (!name) {
      const bareLink = line.match(/^[-*]\s+\[([^\]]+)\]\([^)]*\)\s*$/);
      if (bareLink) { name = bareLink[1].trim(); desc = ''; }
    }

    if (name && !seen.has(name)) {
      seen.add(name);
      entries.push({ name, desc });
    }
  }

  return entries;
}

/**
 * Parse the vaultflow .agents/config.toml to extract the 15 enabled Codex skills.
 * Returns [{name, triggers}] for skills with enabled=true.
 *
 * Simple line-by-line parse — avoids a TOML dependency.
 */
function parseCodexConfig(configPath) {
  if (!existsSync(configPath)) return [];
  const lines   = readFileSync(configPath, 'utf8').split('\n');
  const skills  = [];
  let current   = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '[[skills.config]]') {
      if (current) skills.push(current);
      current = { path: null, enabled: false, triggers: [] };
      continue;
    }

    if (!current) continue;

    const pathMatch     = trimmed.match(/^path\s*=\s*"(.+)"$/);
    const enabledMatch  = trimmed.match(/^enabled\s*=\s*(true|false)$/);
    const triggerMatch  = trimmed.match(/^triggers\s*=\s*\[(.+)\]$/);

    if (pathMatch)    current.path    = pathMatch[1];
    if (enabledMatch) current.enabled = enabledMatch[1] === 'true';
    if (triggerMatch) {
      current.triggers = triggerMatch[1]
        .split(',')
        .map(t => t.trim().replace(/^"|"$/g, ''));
    }
  }
  if (current) skills.push(current);

  return skills
    .filter(s => s.enabled && s.path)
    .map(s => ({
      name:     path.basename(s.path),
      triggers: s.triggers,
    }));
}

/**
 * Backfill vault_agents from the skills index (claude source) and
 * the .agents/config.toml (codex source).
 *
 * @param {object} cfg
 * @param {boolean} dryRun
 * @returns {{ registered: number }}
 */
function backfillAgents(cfg, dryRun) {
  let registered = 0;

  // ── Claude skills from skills_index ──────────────────────────────────
  const indexPath = cfg.paths && cfg.paths.skills_index;
  if (indexPath && existsSync(indexPath)) {
    const content = readFileSync(indexPath, 'utf8');
    const entries = parseIndexFile(content);
    for (const { name, desc } of entries) {
      if (!dryRun) {
        try {
          db.upsertVaultAgent(name, name, 'claude', desc, null);
          registered++;
        } catch (err) {
          process.stderr.write(`[backfill] claude agent upsert error '${name}': ${err.message}\n`);
        }
      } else {
        registered++;
      }
    }
  } else {
    process.stderr.write('[backfill] skills_index not found — skipping claude agent backfill\n');
  }

  // ── Codex skills from .agents/config.toml ────────────────────────────
  const agentsDir    = cfg.paths && cfg.paths.agents_dir;
  const codexConfig  = agentsDir ? path.join(agentsDir, 'config.toml') : null;
  if (codexConfig && existsSync(codexConfig)) {
    const codexSkills = parseCodexConfig(codexConfig);
    for (const { name, triggers } of codexSkills) {
      const triggerPattern = triggers.join(', ');
      if (!dryRun) {
        try {
          db.upsertVaultAgent(name, name, 'codex', '', triggerPattern);
          registered++;
        } catch (err) {
          process.stderr.write(`[backfill] codex agent upsert error '${name}': ${err.message}\n`);
        }
      } else {
        registered++;
      }
    }
    console.log(`[backfill] Codex agents registered: ${codexSkills.length}${dryRun ? ' (dry-run)' : ''}`);
  } else {
    process.stderr.write('[backfill] .agents/config.toml not found — skipping codex agent backfill\n');
  }

  console.log(`[backfill] Agents total registered: ${registered}${dryRun ? ' (dry-run)' : ''}`);
  return { registered };
}

/**
 * Backfill vault_tools from the tools index.
 *
 * @param {object} cfg
 * @param {boolean} dryRun
 * @returns {{ registered: number }}
 */
function backfillTools(cfg, dryRun) {
  const indexPath = cfg.paths && cfg.paths.vault_tools_index;
  if (!indexPath || !existsSync(indexPath)) {
    process.stderr.write('[backfill] vault_tools_index not found — skipping tool backfill\n');
    return { registered: 0 };
  }

  const content = readFileSync(indexPath, 'utf8');
  const entries = parseIndexFile(content);
  let registered = 0;

  for (const { name, desc } of entries) {
    const toolId = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!dryRun) {
      try {
        db.upsertVaultTool(toolId, name, desc, null, '');
        registered++;
      } catch (err) {
        process.stderr.write(`[backfill] tool upsert error for '${name}': ${err.message}\n`);
      }
    } else {
      registered++;
    }
  }

  console.log(`[backfill] Tools registered: ${registered}${dryRun ? ' (dry-run)' : ''}`);
  return { registered };
}

// ── core backfill logic ───────────────────────────────────────────────────

/**
 * Run the backfill.
 *
 * @param {object}  [options]
 * @param {boolean} [options.dryRun=false]     Parse and report but skip DB writes.
 * @param {boolean} [options.skillsOnly=false] Only backfill vault_agents registry.
 * @param {boolean} [options.toolsOnly=false]  Only backfill vault_tools registry.
 * @param {object}  [options.config]           Pre-parsed config (skip file read).
 * @returns {Promise<{total: number, entries: number, skipped: number, agents: number, tools: number}>}
 */
export async function runBackfill(options = {}) {
  const cfg        = options.config     || loadConfig();
  const dryRun     = options.dryRun     || false;
  const skillsOnly = options.skillsOnly || false;
  const toolsOnly  = options.toolsOnly  || false;

  const metricsRoot = cfg?.paths?.metrics_root;
  const dbFile      = cfg?.storage?.db_file;

  if (!metricsRoot) throw new Error('[backfill] metrics_root not configured in vaultflow.yaml');

  if (!dryRun) {
    db.initialize(metricsRoot, dbFile || 'vaultflow.db');
  }

  let agentsResult = { registered: 0 };
  let toolsResult  = { registered: 0 };

  // ── registry-only modes ───────────────────────────────────────────────
  if (skillsOnly) {
    agentsResult = backfillAgents(cfg, dryRun);
    if (!dryRun) db.close();
    return { total: 0, entries: 0, skipped: 0, agents: agentsResult.registered, tools: 0 };
  }

  if (toolsOnly) {
    toolsResult = backfillTools(cfg, dryRun);
    if (!dryRun) db.close();
    return { total: 0, entries: 0, skipped: 0, agents: 0, tools: toolsResult.registered };
  }

  // ── full backfill: memory + registries ────────────────────────────────
  agentsResult = backfillAgents(cfg, dryRun);
  toolsResult  = backfillTools(cfg, dryRun);

  // Collect all candidate markdown files
  const files  = await collectFiles(cfg);
  const total  = files.length;

  let entriesCount = 0;
  let skipped      = 0;
  let processed    = 0;

  for (const filePath of files) {
    try {
      let buf;
      try {
        buf = readFileSync(filePath);
      } catch (readErr) {
        process.stderr.write(`[backfill] SKIP (unreadable) ${filePath}: ${readErr.message}\n`);
        skipped++;
        continue;
      }

      if (buf.length > MAX_FILE_BYTES) {
        process.stderr.write(`[backfill] SKIP (>500KB) ${filePath}\n`);
        skipped++;
        continue;
      }

      if (isBinary(buf)) {
        process.stderr.write(`[backfill] SKIP (binary) ${filePath}\n`);
        skipped++;
        continue;
      }

      const content = buf.toString('utf8');
      const entries = parseMemoryFile(filePath, content);

      if (entries.length === 0) {
        skipped++;
        continue;
      }

      if (!dryRun) {
        db.replaceMemorySource(filePath, entries);
      }

      entriesCount += entries.length;
      processed++;

      if (processed % 50 === 0) {
        console.log(`[backfill] ${processed}/${total} files processed`);
      }
    } catch (err) {
      process.stderr.write(`[backfill] ERROR ${filePath}: ${err.message}\n`);
      skipped++;
    }
  }

  if (!dryRun) {
    db.close();
  }

  const dryTag = dryRun ? ' (dry-run)' : '';
  console.log(
    `[backfill] Done${dryTag}: ${total} files, ${entriesCount} entries, ${skipped} skipped`
  );

  return { total, entries: entriesCount, skipped, agents: agentsResult.registered, tools: toolsResult.registered };
}

// ── main entrypoint ───────────────────────────────────────────────────────

async function main() {
  const args       = process.argv.slice(2);
  const dryRun     = args.includes('--dry-run');
  const skillsOnly = args.includes('--skills-only');
  const toolsOnly  = args.includes('--tools-only');

  if (dryRun)     console.log('[backfill] Dry-run mode — parsing only, no DB writes');
  if (skillsOnly) console.log('[backfill] Skills-only mode — registering vault_agents only');
  if (toolsOnly)  console.log('[backfill] Tools-only mode — registering vault_tools only');

  try {
    await runBackfill({ dryRun, skillsOnly, toolsOnly });
  } catch (err) {
    process.stderr.write(`[backfill] Fatal: ${err.message}\n`);
    process.exit(1);
  }
}

main();
