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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { glob }           from 'glob';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Load CJS data layer via createRequire — keeps files independent
const require = createRequire(import.meta.url);
const db      = require('./db.cjs');
const yaml    = require('js-yaml');

/**
 * Parse YAML frontmatter from a markdown string. Returns { description, name }
 * pulled from the frontmatter block, or empty strings when absent.
 *
 * For Claude/Codex/superpowers-style skills, the `description` field is the
 * agent's TRIGGER PATTERN ("Use when ... triggers ..."), not a generic blurb.
 * Older code grabbed lines[0] which produced garbage like "name: tool-engineer"
 * or "---\r" — rendering the dashboard's trigger_pattern column unusable.
 */
function parseFrontmatter(raw) {
  if (!raw || !raw.startsWith('---')) return { description: '', name: '' };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { description: '', name: '' };
  const block = raw.slice(3, end).replace(/^\r?\n/, '');
  let parsed = {};
  try { parsed = yaml.load(block) || {}; } catch (_) { parsed = {}; }
  return {
    description: typeof parsed.description === 'string' ? parsed.description.trim() : '',
    name:        typeof parsed.name        === 'string' ? parsed.name.trim()        : '',
  };
}

/**
 * True when a frontmatter description is a stub the search can't match on:
 * empty, too short to carry signal (<30 chars), or the auto-generated
 * "Agent skill for X - invoke with $" placeholder. Stub descriptions give
 * searchVaultAgents nothing useful to match, so callers fall back to body text.
 */
function isStubDescription(desc) {
  const d = String(desc || '').trim();
  if (d.length < 30) return true;
  return /^Agent skill for .* - invoke with \$/.test(d);
}

/**
 * Pull the first non-frontmatter paragraph (up to ~200 chars) from a skill
 * markdown body. Used as a description fallback when the frontmatter
 * `description` is a stub. Tolerant: returns '' if there's no readable body.
 */
function firstBodyParagraph(raw) {
  if (!raw) return '';
  let body = raw;
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end !== -1) {
      // Skip past the closing '---' line itself.
      const after = raw.indexOf('\n', end + 1);
      body = after !== -1 ? raw.slice(after + 1) : '';
    }
  }
  // First non-empty block: collapse to the first run of non-blank lines, strip
  // leading markdown headings/markers, and cap length.
  const para = body
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .find(p => p.length > 0) || '';
  return para.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Resolve the best description for a skill: keep the frontmatter description
 * unless it's a stub, in which case fall back to the first body paragraph.
 * Always returns whatever non-empty text it can; never throws.
 */
function resolveSkillDescription(frontmatterDesc, raw) {
  if (!isStubDescription(frontmatterDesc)) return frontmatterDesc;
  // The vendored .agents/skills/* files wrap their original agent definition
  // verbatim, so the real description sits in a SECOND frontmatter block right
  // after the generated stub one. Prefer that over the raw body — otherwise the
  // "first paragraph" fallback indexes a YAML blob (type:/color:/capabilities:)
  // as the skill's description.
  const nested = nestedFrontmatterDescription(raw);
  if (nested && !isStubDescription(nested)) return nested;
  const body = firstBodyParagraph(raw);
  return body || frontmatterDesc || '';
}

/**
 * Extract `description` from a frontmatter block that begins the BODY of a file
 * whose own frontmatter has already been stripped.
 *
 * @param {string} raw  Full file contents, including the outer frontmatter.
 * @returns {string} The nested description, or '' when there is no nested block.
 */
function nestedFrontmatterDescription(raw) {
  if (!raw || !raw.startsWith('---')) return '';
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return '';
  const after = raw.indexOf('\n', end + 1);
  if (after === -1) return '';
  const body = raw.slice(after + 1).replace(/^\s*\n/, '');
  if (!body.startsWith('---')) return '';
  return String(parseFrontmatter(body).description || '').trim();
}

// ── config ────────────────────────────────────────────────────────────────

const CONFIG_PATH = require('../../config/resolve.cjs');

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
 * Parse a markdown index file into [{name, desc}].
 *
 * Handles four formats:
 *   1. Table row:    | [name](path) | ... | description |
 *   2. List + link:  - [name](path) — description
 *   3. Bold list:    - **name** — description
 *   4. H3 section:   ### name\n...\ndescription paragraph  (vault tools format)
 */
function parseIndexFile(content) {
  const entries = [];
  const seen    = new Set();

  // ── pass 1: line-by-line formats (table / list) ──────────────────────────
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

  // ── pass 2: H3 section format (### tool-name + description paragraph) ───
  // Used by vault/tools/index.md — each tool is a ### heading with
  // metadata bullets followed by a free-text description paragraph.
  const h3Sections = content.split(/^(?=### )/m);
  for (const section of h3Sections) {
    const firstLine = section.split('\n')[0];
    if (!firstLine.startsWith('### ')) continue;

    const name = firstLine.slice(4).trim();
    if (!name || seen.has(name)) continue;

    // Description: last non-empty, non-bullet, non-metadata line in the section
    const bodyLines = section.split('\n').slice(1)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('-') && !l.startsWith('*') && !l.startsWith('`') && !l.startsWith('#') && l !== '---');

    const desc = bodyLines[bodyLines.length - 1] || '';
    seen.add(name);
    entries.push({ name, desc });
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
      relPath:  s.path,          // needed to locate the skill's SKILL.md for its description
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
async function backfillAgents(cfg, dryRun) {
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
    const repoRoot = path.resolve(agentsDir, '..');
    for (const { name, relPath, triggers } of codexSkills) {
      const triggerPattern = triggers.join(', ');
      // Read the skill's own SKILL.md for its description. This used to pass a
      // hardcoded '' — which left all 15 curated codex skills searchable by NAME
      // ONLY, silently gutting the reuse-before-build finder (find-skill /
      // search_skills) that ranks on name + description.
      let descText = '';
      const skillFile = path.join(repoRoot, relPath, 'SKILL.md');
      if (existsSync(skillFile)) {
        try {
          const raw = readFileSync(skillFile, 'utf8');
          descText = resolveSkillDescription(parseFrontmatter(raw).description, raw).slice(0, 500);
        } catch (_) { /* unreadable skill file — fall back to name-only matching */ }
      }
      if (!dryRun) {
        try {
          db.upsertVaultAgent(name, name, 'codex', descText, triggerPattern);
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

  // ── User skills from .claude/skills/ ─────────────────────────────────
  const userSkillsDir = cfg.paths && cfg.paths.user_skills_dir;
  if (userSkillsDir && existsSync(userSkillsDir)) {
    const require = createRequire(import.meta.url);
    const fs = require('fs');
    let userCount = 0;
    // Track every agent_id registered this run so orphans (skills that were
    // renamed or deleted) can be pruned from vault_agents after the loop.
    const registeredUserSkillIds = new Set();

    for (const entry of fs.readdirSync(userSkillsDir, { withFileTypes: true })) {
      let skillName = null;
      let descText  = '';

      // Skills are either single .md files or a directory with index.md /
      // SKILL.md inside. Parse YAML frontmatter from whichever applies and
      // pull `description` — that field is the trigger pattern.
      let raw = null;
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md') {
        skillName = entry.name.replace(/\.md$/, '');
        try { raw = readFileSync(path.join(userSkillsDir, entry.name), 'utf8'); } catch (_) {}
      } else if (entry.isDirectory()) {
        skillName = entry.name;
        for (const candidate of ['SKILL.md', 'index.md']) {
          const file = path.join(userSkillsDir, entry.name, candidate);
          if (existsSync(file)) {
            try { raw = readFileSync(file, 'utf8'); } catch (_) {}
            if (raw) break;
          }
        }
      }
      if (raw) {
        const fm = parseFrontmatter(raw);
        // Stub descriptions (empty / too short / auto-generated) give the FTS
        // search nothing to match on — fall back to the skill's body text.
        descText = resolveSkillDescription(fm.description, raw).slice(0, 500);
      }

      if (!skillName) continue;
      registeredUserSkillIds.add(skillName);
      if (!dryRun) {
        try {
          // Pass descText as BOTH description and trigger_pattern. Skills don't
          // have a separate "summary" — the description IS the routing trigger.
          db.upsertVaultAgent(skillName, skillName, 'user-skill', descText, descText);
          registered++;
          userCount++;
        } catch (err) {
          process.stderr.write(`[backfill] user-skill upsert error '${skillName}': ${err.message}\n`);
        }
      } else {
        registered++;
        userCount++;
      }
    }
    console.log(`[backfill] User skills registered: ${userCount}${dryRun ? ' (dry-run)' : ''}`);

    // ── Orphan prune: remove user-skill rows whose agent_id no longer maps to
    // any skill on disk (e.g. a renamed or deleted skill directory). SAFETY
    // GUARD: only prune when the scan found a healthy number of skills.
    // A failed or partial scan (empty dir, permission error) must NOT nuke the
    // table, so we abort the prune entirely when fewer than the minimum were seen.
    const MIN_USER_SKILLS_FOR_PRUNE = 5; // never prune on a failed/partial scan
    if (!dryRun && registeredUserSkillIds.size >= MIN_USER_SKILLS_FOR_PRUNE) {
      const raw = db.raw();
      const existing = raw.prepare(
        `SELECT agent_id FROM vault_agents WHERE source='user-skill'`
      ).all().map(r => r.agent_id);
      const orphans = existing.filter(id => !registeredUserSkillIds.has(id));
      if (orphans.length > 0) {
        const placeholders = orphans.map(() => '?').join(', ');
        raw.prepare(
          `DELETE FROM vault_agents WHERE source='user-skill' AND agent_id IN (${placeholders})`
        ).run(...orphans);
        console.log(`[backfill] User-skill orphans pruned: ${orphans.length} (${orphans.join(', ')})`);
      } else {
        console.log(`[backfill] User-skill orphans pruned: 0`);
      }
    } else if (!dryRun) {
      process.stderr.write(
        `[backfill] Orphan prune skipped — scan returned only ${registeredUserSkillIds.size} skills (< ${MIN_USER_SKILLS_FOR_PRUNE}). Partial scan guard triggered.\n`
      );
    }
  }

  // ── Project agents from C:/GIT/*/.claude/agents/*.md ─────────────────
  const projectAgentsGlob = cfg.paths && cfg.paths.project_agents_glob;
  if (projectAgentsGlob) {
    let agentFiles = [];
    try {
      agentFiles = await glob(projectAgentsGlob, { nodir: true, absolute: true, windowsPathsNoEscape: true });
    } catch (err) {
      process.stderr.write(`[backfill] project_agents_glob error: ${err.message}\n`);
    }

    // Build exclude set from config
    const excludeProjects = new Set((cfg.paths.exclude_projects || []).map(p => p.toLowerCase()));

    let projCount = 0;
    for (const agentFile of agentFiles) {
      const normalized = agentFile.replace(/\\/g, '/');
      if (normalized.split('/').some(seg => excludeProjects.has(seg.toLowerCase()))) continue;

      const agentName = path.basename(agentFile, '.md');
      // Derive project name from path (segment after GIT/)
      const parts     = normalized.split('/');
      const gitIdx    = parts.indexOf('GIT');
      const project   = gitIdx !== -1 ? parts[gitIdx + 1] : null;
      const agentId   = project ? `${project}::${agentName}` : agentName;

      let descText = '';
      try {
        const raw = readFileSync(agentFile, 'utf8');
        const fm  = parseFrontmatter(raw);
        // Stub-description fallback to body text — same reasoning as user skills.
        descText  = resolveSkillDescription(fm.description, raw).slice(0, 500);
      } catch (_) {}

      if (!dryRun) {
        try {
          // descText doubles as trigger_pattern — same reasoning as user skills.
          db.upsertVaultAgent(agentId, agentName, project ? `project:${project}` : 'project', descText, descText);
          registered++;
          projCount++;
        } catch (err) {
          process.stderr.write(`[backfill] project agent upsert error '${agentId}': ${err.message}\n`);
        }
      } else {
        registered++;
        projCount++;
      }
    }
    console.log(`[backfill] Project agents registered: ${projCount}${dryRun ? ' (dry-run)' : ''}`);
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
  // tools live alongside index.md as either `<tool-id>/` directories (preferred)
  // or `<tool-id>.md` files. Derive an absolute path so callers can navigate to
  // each tool. Without this, vault_tools.path is NULL for every row and the
  // dashboard / search has no way to surface the tool's source.
  const toolsRoot = path.dirname(indexPath);
  let registered = 0;

  for (const { name, desc } of entries) {
    const toolId = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const toolDir  = path.join(toolsRoot, toolId);
    const toolFile = path.join(toolsRoot, `${toolId}.md`);
    let toolPath = null;
    try {
      if (existsSync(toolDir)) toolPath = toolDir;
      else if (existsSync(toolFile)) toolPath = toolFile;
    } catch (_) { /* leave as null */ }

    if (!dryRun) {
      try {
        db.upsertVaultTool(toolId, name, desc, toolPath, '');
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
    agentsResult = await backfillAgents(cfg, dryRun);
    if (!dryRun) db.close();
    return { total: 0, entries: 0, skipped: 0, agents: agentsResult.registered, tools: 0 };
  }

  if (toolsOnly) {
    toolsResult = backfillTools(cfg, dryRun);
    if (!dryRun) db.close();
    return { total: 0, entries: 0, skipped: 0, agents: 0, tools: toolsResult.registered };
  }

  // ── full backfill: memory + registries ────────────────────────────────
  agentsResult = await backfillAgents(cfg, dryRun);
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

// Run only when invoked directly as a script — NOT when imported (the module's
// docblock advertises `import { runBackfill }`). Importing previously triggered
// a full backfill against the real DB as a side effect.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
