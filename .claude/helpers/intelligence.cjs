'use strict';

const path = require('path');
const fs   = require('fs');

// ── lazy-loaded deps ──────────────────────────────────────────────────────
let _db     = null;
let _config = null;

function getDb() {
  if (!_db) _db = require('./db.cjs');
  return _db;
}

function loadConfig() {
  if (_config) return _config;
  const yaml       = require('js-yaml');
  const configPath = require('../../config/resolve.cjs');
  if (!fs.existsSync(configPath)) return {};
  _config = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
  return _config;
}

// ── helpers ───────────────────────────────────────────────────────────────

function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

function metricsRoot() {
  const cfg = loadConfig();
  return (cfg.paths && cfg.paths.metrics_root) || '';
}

function pendingInsightsPath() {
  return path.join(metricsRoot(), 'pending-insights.jsonl');
}

function rankedContextPath() {
  return path.join(metricsRoot(), 'ranked-context.json');
}

function discoveriesDir() {
  return path.join(metricsRoot(), 'discoveries');
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureDbOpen() {
  const cfg  = loadConfig();
  const root = metricsRoot();
  const file = (cfg.storage && cfg.storage.db_file) || 'vaultflow.db';
  getDb().initialize(root, file);
}

// ── public API ────────────────────────────────────────────────────────────

/**
 * Load ranked-context.json from metrics_root for context injection at startup.
 * Returns {} if the file is absent.
 */
function init() {
  const ctx = rankedContextPath();
  if (!fs.existsSync(ctx)) return {};
  try {
    return JSON.parse(fs.readFileSync(ctx, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Flush pending-insights.jsonl into the patterns table.
 * Groups by file, calls upsertPattern once per unique file, then clears the file.
 */
function consolidate() {
  try {
    const insightsPath = pendingInsightsPath();
    if (!fs.existsSync(insightsPath)) {
      return { entries: 0, edges: 0, newEntries: 0 };
    }

    let raw;
    try {
      raw = fs.readFileSync(insightsPath, 'utf8').trim();
    } catch (readErr) {
      process.stderr.write(`intelligence: insights file unreadable: ${readErr.message}\n`);
      return { entries: 0, edges: 0, newEntries: 0 };
    }
    const lines   = raw ? raw.split('\n').filter(Boolean) : [];
    const entries = lines.length;

    if (entries === 0) {
      return { entries: 0, edges: 0, newEntries: 0 };
    }

    // Count by file to batch upserts
    const counts = {};
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.file) counts[obj.file] = (counts[obj.file] || 0) + 1;
      } catch {
        // Malformed line — skip
      }
    }

    ensureDbOpen();
    const db = getDb();

    for (const filePath of Object.keys(counts)) {
      const key = path.basename(filePath);
      db.upsertPattern(key, 'auto');
    }

    // Clear AFTER successful DB writes so a crash mid-process doesn't lose the file
    try { fs.writeFileSync(insightsPath, '', 'utf8'); } catch (_) {}

    const edges = Object.keys(counts).length;
    return { entries, edges, newEntries: edges };
  } catch (err) {
    // Must not crash hooks — return safe zero result
    return { entries: 0, edges: 0, newEntries: 0 };
  }
}

/**
 * Called from SubagentStop when a subagent completes.
 * On success: consolidates pending insights, then promotes patterns that have
 * crossed the fire threshold by writing DISCOVERY.md stubs.
 */
function feedback(success) {
  try {
    if (!success) return { promoted: 0 };

    consolidate();

    ensureDbOpen();
    const cfg       = loadConfig();
    const threshold = (cfg.intelligence && cfg.intelligence.pattern_fire_threshold) || 3;
    const db        = getDb();

    const pending = db.getPendingPromotions(threshold);
    if (!pending || pending.length === 0) return { promoted: 0 };

    const today    = new Date().toISOString().slice(0, 10);
    const discDir  = discoveriesDir();
    ensureDir(discDir);

    const promoted = [];

    for (const p of pending) {
      const slug     = p.pattern_key.replace(/[^a-zA-Z0-9._-]/g, '_');
      const fileName = `${today}-${slug}.md`;
      const filePath = path.join(discDir, fileName);

      const content =
        `---\n` +
        `agent: auto\n` +
        `task_type: pattern-promotion\n` +
        `date: ${today}\n` +
        `pattern: ${p.pattern_key}\n` +
        `fire_count: ${p.fire_count}\n` +
        `---\n` +
        `\n` +
        `## Pattern Promoted\n` +
        `This pattern fired ${p.fire_count} times and was promoted automatically.\n` +
        `Review and convert to a skill in your vault/skills/ or .claude/skills/ directory.\n`;

      fs.writeFileSync(filePath, content, 'utf8');
      promoted.push(p.pattern_key);
    }

    if (promoted.length > 0) {
      db.markPromoted(promoted);
    }

    return { promoted: promoted.length };
  } catch (err) {
    // Must not crash hooks
    return { promoted: 0 };
  }
}

/**
 * Search indexed memory for context relevant to the given prompt.
 * Returns up to 5 results via FTS5 BM25. Returns [] if DB not ready.
 */
function getContext(prompt) {
  try {
    ensureDbOpen();
    const session  = require('./session.cjs');
    const fs       = require('fs');

    // ── last-session summary prepend ──────────────────────────────────────
    // Collected outside the token-budget loop and prepended unconditionally.
    const prependItems = [];
    try {
      const sessionObj = session.get() || {};
      const project    = sessionObj.project || path.basename(process.cwd());
      const lastSummary = getDb().getLatestSessionSummary(project);
      const ONE_DAY_MS  = 24 * 60 * 60 * 1000;
      if (lastSummary && (Date.now() - new Date(lastSummary.summary_at).getTime()) < ONE_DAY_MS) {
        const h      = Math.round((Date.now() - new Date(lastSummary.summary_at).getTime()) / 3600000);
        const files  = (lastSummary.top_files  || []).slice(0, 3).join(', ') || 'none';
        const pats   = (lastSummary.patterns   || []).slice(0, 2).join(', ') || 'none';
        const durMin = Math.round((lastSummary.duration_ms || 0) / 60000);
        prependItems.push({
          title:  'Last Session',
          body:   `Last session (${h}h ago): edited [${files}], patterns: [${pats}], duration ${durMin}m`,
          source: 'session_summaries',
          rank:   0,
        });
      }
    } catch (_) {}

    const RANK_FLOOR  = -0.3;  // BM25 is negative; closer to 0 = worse match
    const STALE_MS    = 90 * 24 * 60 * 60 * 1000;
    const cutoff      = Date.now() - STALE_MS;
    const recentSrcs  = new Set(session.getInjectedSources());

    const cfg                  = loadConfig();
    const intel                = (cfg && cfg.intelligence) || {};
    const TOKEN_BUDGET         = intel.context_token_budget      || 400;
    const ENTRY_MAX_TOKENS     = intel.context_entry_max_tokens  || 120;

    const results = getDb().searchMemory(prompt, 10); // fetch more, then filter down to 5
    const filtered = [];
    let tokensSoFar = 0;

    for (const r of results) {
      // Relevance floor — skip poor BM25 matches
      if (typeof r.rank === 'number' && r.rank >= RANK_FLOOR) continue;

      // Staleness — skip if source file is missing or older than 90 days
      if (r.source && (r.source.includes('/') || r.source.includes('\\'))) {
        const filePath = r.source.split(':')[0];
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoff) continue;
        } catch (_) { continue; } // missing file = skip
      }

      // Session dedup — skip source injected recently this session
      if (r.source && recentSrcs.has(r.source)) continue;

      // Per-entry body truncation (non-mutating)
      const maxChars     = ENTRY_MAX_TOKENS * 4;
      const truncatedBody = (r.body && r.body.length > maxChars)
        ? r.body.slice(0, maxChars)
        : r.body;

      // Session token budget — stop if adding this entry would exceed the budget
      const entryTokens = estimateTokens(truncatedBody);
      if (tokensSoFar + entryTokens > TOKEN_BUDGET) break;
      tokensSoFar += entryTokens;

      filtered.push({ ...r, _truncatedBody: truncatedBody });
      if (filtered.length >= 5) break;
    }

    // Record injected sources in session state
    for (const r of filtered) {
      if (r.source) session.addInjectedSource(r.source);
    }

    return [
      ...prependItems,
      ...filtered.map((r) => ({
        title:  r.title,
        body:   r._truncatedBody !== undefined ? r._truncatedBody : r.body,
        source: r.source,
        rank:   r.rank,
      })),
    ];
  } catch {
    return [];
  }
}

// ── exports ───────────────────────────────────────────────────────────────
module.exports = { init, consolidate, feedback, getContext };
