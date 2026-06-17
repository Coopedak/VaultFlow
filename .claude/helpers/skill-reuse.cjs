'use strict';

/**
 * skill-reuse.cjs — reuse-before-build scoring for SKILLS.
 *
 * WHY: vault TOOLS already have a "search before you build" gate
 * (search_vault_tools). Skills (vault_agents) are the skill-equivalent of vault
 * tools, but had no such gate — nothing nudged an author to reuse/modify an
 * existing skill before writing a new one. This module is the shared scorer
 * behind three surfaces that now do: the MCP `search_skills` tool, the
 * `vaultflow find-skill` CLI, and the PreToolUse(Write) pre-authoring gate.
 *
 * The confidence score is a token-overlap measure. router.cjs's overlapScore
 * (not exported) uses shared / max(set sizes) — symmetric Jaccard-ish — but that
 * SKEWS against this module's primary input: a short free-text query (3–5 tokens)
 * scored against a long skill description (10+ tokens). With max() in the
 * denominator, a perfect partial match like "build a backend service" vs a rich
 * backend-skill description scores ~0.07 (1 shared / 11 desc tokens) and is
 * wrongly bucketed BUILD-NEW-OK. We therefore use the OVERLAP COEFFICIENT —
 * shared / min(set sizes) — which measures "how much of the SMALLER set is
 * covered" and is the right metric for asymmetric short-query-vs-long-doc
 * matching. (lowercase, strip punctuation, drop <2-char + stopwords, then
 * shared / min(set sizes)). The empty-set early-return keeps min() safe from a
 * zero denominator.
 *
 * The verdict is ADVISORY ONLY. BM25 (searchVaultAgents) provides the ranking;
 * this overlap score is an uncalibrated confidence layered on top to bucket the
 * results into REUSE / MODIFY / BUILD-NEW-OK. It is a hint, never a hard gate.
 */

// Mirror of router.cjs STOP_WORDS intent — a compact stopword set so single
// shared words ("the", "for") don't inflate confidence. Kept local to avoid
// importing router.cjs (which loads the skills index as a side effect).
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'have', 'from', 'are', 'was',
  'will', 'can', 'you', 'our', 'its', 'but', 'not', 'they', 'what', 'when',
  'how', 'why', 'should', 'would', 'could', 'about', 'any', 'all', 'one',
  'also', 'just', 'like', 'need', 'want', 'your', 'their', 'there', 'here',
  'now', 'then', 'some', 'more', 'than', 'only', 'make', 'add', 'use', 'using',
  'run', 'set', 'get', 'put', 'let', 'new', 'into',
]);

// Verdict thresholds (advisory). Re-verified under the overlap-coefficient
// (min-denominator) metric. Tuned so:
//   >= 0.30  REUSE        — strong token overlap; almost certainly the same job
//                           (e.g. "build a backend service" vs a backend skill
//                            scores 0.33 → REUSE, the case max() under-scored)
//   >= 0.15  MODIFY       — partial overlap; adapt an existing skill, don't rebuild
//   <  0.15  BUILD-NEW-OK — too little overlap to claim a match (e.g. an
//                           unrelated query scores 0 → BUILD-NEW-OK)
// The 0.15 MODIFY floor doubles as the gate's MIN_CONFIDENCE: below it, a
// candidate is BM25 noise (short-query false positives) and is dropped.
const REUSE_THRESHOLD  = 0.30;
const MODIFY_THRESHOLD = 0.15;
const MIN_CONFIDENCE   = MODIFY_THRESHOLD;

/** Tokenize exactly as router.cjs does: lowercase, strip punctuation, drop short/stop tokens. */
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Token-overlap confidence in 0.0–1.0: shared unique tokens / min(set sizes)
 * (the OVERLAP COEFFICIENT). Differs from router.cjs overlapScore, which divides
 * by max — see the module header for why min is correct for short-query matching.
 *
 * @param {string} query
 * @param {string} descText
 * @returns {number}
 */
function overlapScore(query, descText) {
  const queryTokens = tokenize(query);
  const descTokens  = tokenize(descText);
  if (queryTokens.length === 0 || descTokens.length === 0) return 0;

  const querySet = new Set(queryTokens);
  const descSet  = new Set(descTokens);

  let shared = 0;
  for (const w of querySet) {
    if (descSet.has(w)) shared++;
  }

  // min() denominator (overlap coefficient): measures coverage of the SMALLER
  // set. The empty-set guard above guarantees both sizes >= 1, so min >= 1 —
  // no divide-by-zero possible.
  const denom = Math.min(querySet.size, descSet.size);
  return denom > 0 ? shared / denom : 0;
}

/** Bucket a confidence into an advisory verdict label. */
function verdictFor(confidence) {
  if (confidence >= REUSE_THRESHOLD)  return 'REUSE';
  if (confidence >= MODIFY_THRESHOLD) return 'MODIFY';
  return 'BUILD-NEW-OK';
}

/**
 * Score a query against a list of searchVaultAgents rows. Returns the same rows
 * augmented with { confidence, verdict }, preserving BM25 order (rows arrive
 * already ranked best-first; we do NOT re-sort — BM25 is the ranking, overlap
 * is only the advisory bucket).
 *
 * @param {string} query
 * @param {Array<{name?:string, description?:string}>} rows
 * @returns {Array<object>} rows + { confidence, verdict }
 */
function scoreSkillRows(query, rows) {
  return (rows || []).map(r => {
    const confidence = overlapScore(query, `${r.name || ''} ${r.description || ''}`);
    return { ...r, confidence, verdict: verdictFor(confidence) };
  });
}

module.exports = {
  REUSE_THRESHOLD,
  MODIFY_THRESHOLD,
  MIN_CONFIDENCE,
  tokenize,
  overlapScore,
  verdictFor,
  scoreSkillRows,
};
