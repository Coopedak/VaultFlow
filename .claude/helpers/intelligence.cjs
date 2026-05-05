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

    // Clear the file after successful processing
    fs.writeFileSync(insightsPath, '', 'utf8');

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
        `Review and convert to a skill: C:\\Users\\YOU\\vault\\skills\\index.md\n`;

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
    const results = getDb().searchMemory(prompt, 5);
    return results.map((r) => ({
      title:  r.title,
      body:   r.body,
      source: r.source,
      rank:   r.rank,
    }));
  } catch {
    return [];
  }
}

// ── exports ───────────────────────────────────────────────────────────────
module.exports = { init, consolidate, feedback, getContext };
