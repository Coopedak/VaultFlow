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
let _idf    = null;   // cached IDF function over the loaded corpus
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

/**
 * Load the routable skill/agent set.
 *
 * PRIMARY source is the vault_agents registry, not the markdown index. The
 * index only ever described one directory, and once the user's skills moved to
 * ~/.claude/agents it listed none of them — the router silently dropped to the
 * 7 hardcoded FALLBACK_SKILLS below and routed against those while 68 real
 * agents sat registered and invisible. The registry is the actual source of
 * truth: backfill keeps it current across ~/.claude/agents, ~/.claude/skills,
 * .agents/skills and project agents.
 *
 * Index and hardcoded list remain as fallbacks for a machine with no DB yet.
 */
function loadSkills() {
  if (_skills) return _skills;

  try {
    const db = require('./db.cjs');
    db.initialize(null, null);
    const rows = db.raw().prepare(`
      SELECT name,
             COALESCE(description, '')     AS desc,
             COALESCE(trigger_pattern, '') AS triggers
      FROM   vault_agents
      WHERE  name IS NOT NULL AND trim(name) <> ''
    `).all();
    // A description is the entire match surface — a nameless-only entry would
    // match on its slug alone and mostly generate noise.
    const usable = rows
      .filter(r => (r.desc && r.desc.trim()) || (r.triggers && r.triggers.trim()))
      .map(r => ({ name: r.name, desc: `${r.desc} ${r.triggers}`.trim() }));
    if (usable.length > 0) {
      _skills = usable;
      return _skills;
    }
  } catch (_) { /* no DB on this machine yet — fall through */ }

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
 * Inverse document frequency over the skill corpus.
 *
 * WHY weighting is required, not a refinement: a plain token ratio is driven by
 * LENGTH, and both normalizations are degenerate. Dividing by max() means a
 * 5-token prompt matching an 80-token description perfectly scores 0.06 — the
 * better a description is written, the less it can ever be chosen (measured: 1
 * injection in 1,222 decisions). Dividing by min() inverts the failure: short
 * prompts trivially clear any threshold, and replaying 800 real prompts fired
 * on 41% of them with matches like "even with the max plan ?" -> a migration
 * agent, on the shared word "plan".
 *
 * IDF fixes both by scoring INFORMATIVENESS instead of length: "plan", "code"
 * and "process" appear in most descriptions and carry almost no weight, while a
 * distinctive term does the work.
 *
 * @param {Array<{tokens: Set<string>}>} skills
 * @returns {(term: string) => number}
 */
function buildIdf(skills) {
  const df = new Map();
  for (const s of skills) {
    for (const t of s.tokens) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = skills.length || 1;
  // +1 smoothing keeps an unseen term finite and always above a ubiquitous one.
  return (term) => Math.log((N + 1) / ((df.get(term) || 0) + 1)) + 1;
}

// A single shared term may carry a match only if it is genuinely distinctive —
// roughly "appears in under ~15% of skills" at typical corpus sizes. Otherwise
// at least two shared terms are required, which is what stops one incidental
// common word from selecting an agent.
const RARE_TERM_IDF = 2.5;
const MIN_SHARED_TERMS = 2;

// Matched IDF weight at which the evidence dampener reaches 0.5. Tuned by
// replaying 800 real prompts: see weightedCoverage() for why a ratio alone is
// not enough.
const EVIDENCE_HALF_WEIGHT = 6;

/**
 * IDF-weighted coverage of the prompt's informative terms, in 0.0–1.0.
 *
 * Coverage is measured over the PROMPT, so the score answers "how much of what
 * the user asked for does this skill speak to?" — a question whose answer does
 * not degrade as a description grows.
 *
 * @param {Set<string>} promptSet  Unique prompt tokens.
 * @param {Set<string>} descSet    Unique skill description tokens.
 * @param {(t: string) => number} idf
 * @returns {number}
 */
function weightedCoverage(promptSet, descSet, idf) {
  if (promptSet.size === 0 || descSet.size === 0) return 0;

  let sharedWeight = 0, totalWeight = 0, sharedCount = 0, bestSharedIdf = 0;
  for (const t of promptSet) {
    const w = idf(t);
    totalWeight += w;
    if (descSet.has(t)) {
      sharedWeight += w;
      sharedCount++;
      if (w > bestSharedIdf) bestSharedIdf = w;
    }
  }
  if (totalWeight === 0) return 0;

  // Evidence floor: ratios alone let a 3-token prompt score 0.33 off one
  // incidental word. Demand either corroboration or a genuinely rare term.
  if (sharedCount < MIN_SHARED_TERMS && bestSharedIdf < RARE_TERM_IDF) return 0;

  const coverage = sharedWeight / totalWeight;

  // Dampen by ABSOLUTE evidence, because coverage is a ratio and therefore
  // rewards short prompts: "how is the deploy" reduces to one informative token,
  // matches it, and scores a perfect 1.00 on pure coverage. Conversational
  // asides are the majority of real prompts, and they must stay silent.
  //
  // saturation = w / (w + K) rises smoothly with accumulated matched weight and
  // never reaches 1, so a thin prompt is capped no matter how well it "covers".
  // K is set so one rare term lands near the description-only threshold while
  // two solid terms clear it comfortably.
  const saturation = sharedWeight / (sharedWeight + EVIDENCE_HALF_WEIGHT);
  return coverage * saturation;
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

  // Tokenize once per skill and cache on the loaded list — routeTask runs on
  // every UserPromptSubmit, and re-tokenizing ~70 descriptions per prompt is
  // pure waste. Building IDF needs the same token sets anyway.
  for (const skill of skills) {
    if (!skill.tokens) {
      skill.tokens = new Set(tokenize(`${skill.desc} ${skill.name.replace(/-/g, ' ')}`));
    }
  }
  const idf = _idf || (_idf = buildIdf(skills));

  const promptSet = new Set(promptTokens);
  let best      = null;
  let bestScore = 0;

  for (const skill of skills) {
    const score = applyPromotedBoost(weightedCoverage(promptSet, skill.tokens, idf), !!skill.promoted);
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
// buildIdf/weightedCoverage/tokenize are exported for tests: the scoring
// properties (length-independence, evidence floor, rare-term weighting) are
// what previously regressed silently, so they are pinned directly.
module.exports = { routeTask, getContext, applyPromotedBoost, buildIdf, weightedCoverage, tokenize };
