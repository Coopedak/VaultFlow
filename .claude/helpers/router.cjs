'use strict';

const path = require('path');
const fs   = require('fs');

// ── constants ─────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the','a','an','is','it','to','for','of','in','on','at','and','or','but',
  'not','with','from','by','as','be','was','are','were','has','have','had',
  'do','does','did','will','would','could','should','may','might','can',
  'this','that','these','those','i','you','we','they','he','she','its',
  'how','what','when','where','which','who','why','if','then','than','so',
]);

const FALLBACK_SKILLS = [
  { name: 'developer-backend',   desc: 'C# services viewmodels APIs data access business logic' },
  { name: 'developer-frontend',  desc: 'XAML views Angular React components HTML CSS bindings' },
  { name: 'developer-fullstack', desc: 'full stack view model layer feature implementation' },
  { name: 'researcher',          desc: 'investigate options research approaches recommend solutions' },
  { name: 'security-reviewer',   desc: 'security audit OWASP auth injection vulnerability credentials' },
  { name: 'documenter',          desc: 'documentation write README wiki procedure changelog' },
  { name: 'session-reviewer',    desc: 'session review debrief learnings memory project profile' },
];

const TIER_TOP = new Set(['security','auth','vulnerability','exploit','plan','architect','design','why','approach']);
const TIER_LOW = new Set(['read','search','find','list','check']);

// ── module state ──────────────────────────────────────────────────────────

let _skills = null;   // cached parsed skill list
let _config = null;

// ── config ────────────────────────────────────────────────────────────────

function loadConfig() {
  if (_config) return _config;
  const configPath = require('../../config/resolve.cjs');
  if (!fs.existsSync(configPath)) return null;
  try {
    const yaml = require('js-yaml');
    _config = yaml.load(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {
    _config = null;
  }
  return _config;
}

function getSkillsIndexPath() {
  const cfg = loadConfig();
  return (cfg && cfg.paths && cfg.paths.skills_index) || null;
}

// ── skills parser ─────────────────────────────────────────────────────────

/**
 * Parse a markdown skills index into [{name, desc}].
 *
 * Handles three formats found in the skills index:
 *   1. Table row: | [skill-name](path) | ... | description |
 *   2. List + dash desc: - [skill-name](path) — description
 *   3. Inline list: - **skill-name** — description
 */
function parseSkillsIndex(content) {
  const skills = [];
  const seen   = new Set();

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    let name = null;
    let desc = '';

    // ── table row: | [name](path) | ... | description |
    const tableMatch = line.match(/^\|\s*\[([^\]]+)\]\([^)]*\)\s*\|(.+)\|$/);
    if (tableMatch) {
      name = tableMatch[1].trim();
      // Last pipe-delimited cell is usually the description
      const cells = tableMatch[2].split('|').map(c => c.trim()).filter(Boolean);
      desc = cells[cells.length - 1] || '';
    }

    // ── list with link: - [skill-name](path) — description
    if (!name) {
      const listLink = line.match(/^[-*]\s+\[([^\]]+)\]\([^)]*\)\s*[—–-]\s*(.+)$/);
      if (listLink) {
        name = listLink[1].trim();
        desc = listLink[2].trim();
      }
    }

    // ── bold list: - **skill-name** — description
    if (!name) {
      const boldItem = line.match(/^[-*]\s+\*\*([^*]+)\*\*\s*[—–-]\s*(.+)$/);
      if (boldItem) {
        name = boldItem[1].trim();
        desc = boldItem[2].trim();
      }
    }

    // ── plain list with link (no description): - [skill-name](path)
    if (!name) {
      const bareLink = line.match(/^[-*]\s+\[([^\]]+)\]\([^)]*\)\s*$/);
      if (bareLink) {
        name = bareLink[1].trim();
        desc = '';
      }
    }

    if (name && !seen.has(name)) {
      seen.add(name);
      skills.push({ name, desc });
    }
  }

  return skills;
}

function loadSkills() {
  if (_skills) return _skills;

  const indexPath = getSkillsIndexPath();

  if (indexPath && fs.existsSync(indexPath)) {
    try {
      const content = fs.readFileSync(indexPath, 'utf8');
      const parsed  = parseSkillsIndex(content);
      if (parsed.length > 0) {
        _skills = parsed;
        return _skills;
      }
    } catch (_) {
      // fall through to fallback
    }
  }

  _skills = FALLBACK_SKILLS.slice();
  return _skills;
}

// ── scoring helpers ───────────────────────────────────────────────────────

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Keyword overlap score: (shared unique words) / max(|prompt tokens|, |desc tokens|).
 * Returns 0.0–1.0.
 */
function overlapScore(promptTokens, descText) {
  const descTokens = tokenize(descText);
  if (promptTokens.length === 0 || descTokens.length === 0) return 0;

  const promptSet = new Set(promptTokens);
  const descSet   = new Set(descTokens);

  let shared = 0;
  for (const w of promptSet) {
    if (descSet.has(w)) shared++;
  }

  const denom = Math.max(promptSet.size, descSet.size);
  return denom > 0 ? shared / denom : 0;
}

/** 10% multiplicative boost for promoted skills/tools, capped at 1.0. */
const PROMOTED_BOOST = 1.10;
function applyPromotedBoost(score, promoted) {
  return promoted ? Math.min(1.0, score * PROMOTED_BOOST) : score;
}

function detectTier(promptTokens) {
  for (const w of promptTokens) {
    if (TIER_TOP.has(w)) return 'Top';
  }
  for (const w of promptTokens) {
    if (TIER_LOW.has(w)) return 'Low';
  }
  return 'Mid';
}

// ── public API ────────────────────────────────────────────────────────────

/**
 * Analyze a prompt and return a routing decision.
 *
 * @param {string} prompt
 * @returns {{ skill: string, tier: string, confidence: number, reason: string, fallback: boolean }}
 */
function routeTask(prompt) {
  const skills       = loadSkills();
  const promptTokens = tokenize(prompt || '');
  const tier         = detectTier(promptTokens);

  let best      = null;
  let bestScore = 0;

  for (const skill of skills) {
    // Include name tokens in the match surface
    const combined = skill.desc + ' ' + skill.name.replace(/-/g, ' ');
    const score    = applyPromotedBoost(overlapScore(promptTokens, combined), !!skill.promoted);
    if (score > bestScore) {
      bestScore = score;
      best      = skill;
    }
  }

  if (!best || bestScore < 0.1) {
    return {
      skill:      'general-purpose',
      tier:       'Mid',
      confidence: 0,
      reason:     'No clear skill match',
      fallback:   true,
    };
  }

  const result = {
    skill:      best.name,
    tier,
    confidence: Math.round(bestScore * 1000) / 1000,
    reason:     `Prompt overlaps with '${best.name}' (score ${Math.round(bestScore * 100)}%)`,
    fallback:   false,
  };

  // Track agent usage so the registry stays sorted by actual use
  try {
    const db = require('./db.cjs');
    db.initialize(null, null);
    db.incrementAgentUse(best.name);
  } catch (_) {}

  return result;
}

/**
 * Search memory for context relevant to the prompt.
 *
 * @param {string} prompt
 * @returns {Array}
 */
function getContext(prompt) {
  try {
    const db = require('./db.cjs');
    return db.searchMemory(prompt, 5);
  } catch (_) {
    return [];
  }
}

// ── exports ───────────────────────────────────────────────────────────────
module.exports = { routeTask, getContext, applyPromotedBoost };
