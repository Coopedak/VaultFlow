/**
 * skill-loader.mjs — skill content loader for auto-injection
 *
 * Reads the skills index and caches skill file content so that
 * hook-handler.cjs can inject full skill instructions or descriptions
 * into the UserPromptSubmit content field without re-reading disk
 * on every prompt.
 *
 * Used by the route event in hook-handler.cjs for auto-spawn injection.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path              from 'node:path';
import fs                from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);

// ── module state ──────────────────────────────────────────────────────────

// skillName → { description, fullContent, path, loadedAt }
const _cache = new Map();

let _config = null;

// ── config ────────────────────────────────────────────────────────────────

function loadConfig() {
  if (_config) return _config;
  try {
    const yaml       = require('js-yaml');
    const configPath = require('../../config/resolve.cjs');
    if (fs.existsSync(configPath)) {
      _config = yaml.load(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (_) {}
  return _config || {};
}

function getSkillsRoot() {
  const cfg = loadConfig();
  // Skills live next to skills/index.md — derive root from that path
  const indexPath = cfg.paths && cfg.paths.skills_index;
  if (indexPath && fs.existsSync(indexPath)) {
    return path.dirname(indexPath);
  }
  // Fallback: user's .claude/skills
  return path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'skills');
}

// ── markdown parser helpers ───────────────────────────────────────────────

/**
 * Extract the first paragraph after the first H1/H2 in a markdown file.
 * Used as the short description when injecting description-only.
 */
function extractDescription(content) {
  const lines = content.split('\n');
  let pastHeader = false;
  const descLines = [];

  for (const line of lines) {
    if (!pastHeader && /^#{1,2}\s/.test(line)) {
      pastHeader = true;
      continue;
    }
    if (pastHeader) {
      if (line.trim() === '') {
        if (descLines.length > 0) break; // end of first paragraph
        continue;
      }
      if (/^#{1,6}\s/.test(line)) break; // hit next heading
      descLines.push(line.trim());
    }
  }

  return descLines.join(' ').slice(0, 300) || content.slice(0, 300);
}

// ── cache management ──────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isCacheStale(entry) {
  return Date.now() - entry.loadedAt > CACHE_TTL_MS;
}

/**
 * Load a skill by name. Searches:
 *   1. {skills_root}/{skillName}.md
 *   2. {skills_root}/{skillName}/{skillName}.md
 *   3. {skills_root}/{skillName}/index.md
 *
 * Returns null if not found.
 *
 * @param {string} skillName
 * @returns {{ description: string, fullContent: string, path: string } | null}
 */
export function loadSkill(skillName) {
  const cached = _cache.get(skillName);
  if (cached && !isCacheStale(cached)) return cached;

  const root       = getSkillsRoot();
  const candidates = [
    path.join(root, `${skillName}.md`),
    path.join(root, skillName, `${skillName}.md`),
    path.join(root, skillName, 'index.md'),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;

    try {
      const fullContent = fs.readFileSync(candidate, 'utf8');
      const description = extractDescription(fullContent);
      const entry = { description, fullContent, path: candidate, loadedAt: Date.now() };
      _cache.set(skillName, entry);
      return entry;
    } catch (err) {
      process.stderr.write(`[skill-loader] could not read ${candidate}: ${err.message}\n`);
    }
  }

  return null;
}

/**
 * Clear the in-memory skill cache (e.g., after skills are updated on disk).
 */
export function clearCache() {
  _cache.clear();
}

/**
 * Build the injection payload for a UserPromptSubmit hook.
 *
 * Injection tiers based on router confidence:
 *   >= high_threshold (0.6): inject full skill instructions
 *   >= low_threshold  (0.3): inject description only
 *   <  low_threshold       : return null (no injection)
 *
 * Also respects session-level suppression: if the same skill was injected
 * within the last 10 minutes, returns null to avoid redundant context.
 *
 * @param {string}  skillName
 * @param {number}  confidence
 * @param {string}  [lastInjectedSkill]  From session state
 * @param {number}  [lastInjectedAt]     Epoch ms from session state
 * @returns {{ text: string, tier: 'full'|'description'|'none' } | null}
 */
export function buildInjection(skillName, confidence, lastInjectedSkill, lastInjectedAt) {
  const cfg             = loadConfig();
  const intel           = (cfg && cfg.intelligence) || {};
  const HIGH            = intel.skill_inject_high_threshold ?? 0.6;
  const LOW             = intel.skill_inject_low_threshold  ?? 0.3;
  const SUPPRESS_MS     = 10 * 60 * 1000;

  if (confidence < LOW) return null;

  // Suppress if the same skill was injected recently in this session
  if (
    lastInjectedSkill === skillName &&
    lastInjectedAt    &&
    Date.now() - lastInjectedAt < SUPPRESS_MS
  ) {
    return null;
  }

  const skill = loadSkill(skillName);
  if (!skill) return null;

  if (confidence >= HIGH) {
    return {
      tier: 'full',
      text: `\n\n---\n<!-- vaultflow skill injection: ${skillName} -->\n${skill.fullContent}\n---\n`,
    };
  }

  return {
    tier: 'description',
    text: `\n\n<!-- vaultflow: suggested skill — ${skillName} -->\n${skill.description}\n`,
  };
}

/**
 * List all available skill names (from the skills root directory).
 * @returns {string[]}
 */
export function listSkills() {
  const root = getSkillsRoot();
  if (!fs.existsSync(root)) return [];

  const names = new Set();
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md') {
        names.add(entry.name.replace(/\.md$/, ''));
      } else if (entry.isDirectory()) {
        const sub = path.join(root, entry.name);
        const subFiles = fs.readdirSync(sub).filter(f => f.endsWith('.md'));
        if (subFiles.length > 0) names.add(entry.name);
      }
    }
  } catch (_) {}

  return Array.from(names).sort();
}

// ── CLI ───────────────────────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'list') {
    const skills = listSkills();
    console.log(`${skills.length} skills found:`);
    skills.forEach(s => console.log(`  ${s}`));
  } else if (cmd === 'show' && process.argv[3]) {
    const skill = loadSkill(process.argv[3]);
    if (!skill) {
      console.error(`Skill not found: ${process.argv[3]}`);
      process.exit(1);
    }
    console.log(`Path: ${skill.path}`);
    console.log(`Description: ${skill.description}`);
    console.log(`\nFull content (${skill.fullContent.length} chars)`);
  } else {
    console.log('Usage: node skill-loader.mjs list | show <skill-name>');
  }
}
