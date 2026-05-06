'use strict';

/**
 * model-router.cjs — automatic model tier demotion for sub-agents
 *
 * WHY: Sub-agents that consistently receive voice-of-reason APPROVED verdicts
 * and have enough completed sessions on the current model may be over-provisioned.
 * This module tracks per-(agent, model, task_type) approval rates plus session
 * counts and recommends a cheaper tier only when both guards are satisfied.
 *
 * Pinned agents (project-manager, security-reviewer) are never demoted —
 * failures in these roles are catastrophic.
 *
 * Usage:
 *   const router = require('./model-router.cjs');
 *   router.recordVerdict(agent, model, taskType, approved);
 *   const result = router.checkAndDemote(agent, taskType);
 *   // result: { demoted: true, from: 'claude-sonnet-4-6', to: 'claude-haiku-4-5-20251001' } | null
 */

const path = require('path');
const fs   = require('fs');

// ── model ladder (ordered high → low cost/capability) ─────────────────────
const MODEL_LADDER = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];

// Default pinned agents — never demoted regardless of approval rate
const DEFAULT_PINNED = ['project-manager', 'security-reviewer'];

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

// ── config readers ────────────────────────────────────────────────────────

function getPinnedAgents() {
  const cfg = loadConfig();
  const pinned = cfg.model_routing && Array.isArray(cfg.model_routing.pinned_agents)
    ? cfg.model_routing.pinned_agents
    : DEFAULT_PINNED;
  return pinned;
}

function getDemotionThreshold() {
  const cfg = loadConfig();
  return (cfg.model_routing && cfg.model_routing.demotion_threshold != null)
    ? cfg.model_routing.demotion_threshold
    : 0.95;
}

function getDemotionMinSessions() {
  const cfg = loadConfig();
  return (cfg.model_routing && cfg.model_routing.demotion_min_sessions != null)
    ? cfg.model_routing.demotion_min_sessions
    : 10;
}

// ── core logic ────────────────────────────────────────────────────────────

/**
 * Record a model verdict for an agent/model/taskType triple.
 * Crash-safe — never throws.
 *
 * @param {string}  agent
 * @param {string}  model
 * @param {string}  [taskType='general']
 * @param {boolean} approved
 */
function recordVerdict(agent, model, taskType, approved) {
  try {
    const db = getDb();
    db.initialize(null, null);
    db.recordModelVerdict(
      String(agent    || 'unknown'),
      String(model    || 'unknown'),
      String(taskType || 'general'),
      Boolean(approved)
    );
  } catch (err) {
    process.stderr.write(`[model-router] recordVerdict error — ${err.message}\n`);
  }
}

/**
 * Record one completed run/session on a model for an agent/taskType triple.
 * Crash-safe — never throws.
 *
 * @param {string} agent
 * @param {string} model
 * @param {string} [taskType='general']
 */
function recordSession(agent, model, taskType) {
  try {
    const db = getDb();
    db.initialize(null, null);
    db.recordModelSession(
      String(agent    || 'unknown'),
      String(model    || 'unknown'),
      String(taskType || 'general')
    );
  } catch (err) {
    process.stderr.write(`[model-router] recordSession error — ${err.message}\n`);
  }
}

/**
 * Check if an agent/model/taskType triple meets the demotion criteria.
 *
 * Returns true when:
 *   - A performance row exists for the triple (or falls back to task_type='general')
 *   - sessions_on_model >= getDemotionMinSessions()
 *   - verdicts_total >= getDemotionMinSessions()
 *   - verdicts_approved / verdicts_total >= getDemotionThreshold()
 *
 * @param {string} agent
 * @param {string} model
 * @param {string} taskType
 * @returns {boolean}
 */
function demotionEligible(agent, model, taskType) {
  try {
    const db   = getDb();
    db.initialize(null, null);
    const rows = db.getModelPerformance(agent);
    if (!rows || rows.length === 0) return false;

    const type = taskType || 'general';

    // Prefer exact task_type match, fall back to 'general'
    let row = rows.find(r => r.model === model && r.task_type === type);
    if (!row && type !== 'general') {
      row = rows.find(r => r.model === model && r.task_type === 'general');
    }
    if (!row) return false;

    const minSessions = getDemotionMinSessions();
    const threshold   = getDemotionThreshold();

    if (row.sessions_on_model < minSessions) return false;
    if (row.verdicts_total < minSessions) return false;

    const rate = row.verdicts_approved / row.verdicts_total;
    return rate >= threshold;
  } catch (_) {
    return false;
  }
}

/**
 * Return a recommended lower-tier model if the agent is eligible for demotion,
 * or null if no change is needed.
 *
 * Pinned agents always return null.
 *
 * @param {string} agent
 * @param {string} [taskType='general']
 * @returns {string|null}
 */
function getRecommendedModel(agent, taskType) {
  try {
    if (getPinnedAgents().includes(agent)) return null;

    const db   = getDb();
    db.initialize(null, null);
    const rows = db.getModelPerformance(agent);
    if (!rows || rows.length === 0) return null;

    // Find the active model row
    const currentRow = rows.find(r => r.current === 1);
    if (!currentRow) return null;

    const currentModel = currentRow.model;

    if (!demotionEligible(agent, currentModel, taskType || 'general')) return null;

    // Find the next lower model in the ladder
    const idx = MODEL_LADDER.indexOf(currentModel);
    if (idx === -1 || idx === MODEL_LADDER.length - 1) return null;

    return MODEL_LADDER[idx + 1];
  } catch (_) {
    return null;
  }
}

/**
 * Check demotion eligibility and apply the demotion atomically if eligible.
 *
 * On demotion:
 *   - Old row: current=0, demoted_at=now
 *   - New row: current=1, promoted_at=now
 *
 * @param {string} agent
 * @param {string} [taskType='general']
 * @returns {{ demoted: boolean, from: string, to: string } | null}
 */
function checkAndDemote(agent, taskType) {
  try {
    if (getPinnedAgents().includes(agent)) return null;

    const db   = getDb();
    db.initialize(null, null);
    const rows = db.getModelPerformance(agent);
    if (!rows || rows.length === 0) return null;

    const currentRow = rows.find(r => r.current === 1);
    if (!currentRow) return null;

    // Check demotion eligibility using the already-fetched rows (avoids TOCTOU re-read)
    if (!demotionEligible(agent, currentRow.model, taskType || 'general')) return null;

    const idx = MODEL_LADDER.indexOf(currentRow.model);
    if (idx === -1 || idx === MODEL_LADDER.length - 1) return null;
    const newModel = MODEL_LADDER[idx + 1];

    const oldModel = currentRow.model;
    const now      = new Date().toISOString();
    const type     = taskType || 'general';

    // Mark old row as demoted
    db.upsertModelPerformance(agent, oldModel, {
      task_type:          type,
      verdicts_total:     currentRow.verdicts_total,
      verdicts_approved:  currentRow.verdicts_approved,
      sessions_on_model:  currentRow.sessions_on_model,
      promoted_at:        currentRow.promoted_at,
      demoted_at:         now,
      current:            0,
    });

    // Insert new row for the lower model
    db.upsertModelPerformance(agent, newModel, {
      task_type:          type,
      verdicts_total:     0,
      verdicts_approved:  0,
      sessions_on_model:  0,
      promoted_at:        now,
      demoted_at:         null,
      current:            1,
    });

    process.stderr.write(
      `[model-router] demoted "${agent}" ${oldModel} → ${newModel} ` +
      `(approval rate ${(currentRow.verdicts_approved / currentRow.verdicts_total * 100).toFixed(1)}% ` +
      `over ${currentRow.verdicts_total} verdicts)\n`
    );

    return { demoted: true, from: oldModel, to: newModel };
  } catch (err) {
    process.stderr.write(`[model-router] checkAndDemote error — ${err.message}\n`);
    return null;
  }
}

/**
 * Return a status table row for every (agent, model, task_type) triple.
 *
 * @returns {Array<{agent, model, task_type, verdicts_total, verdicts_approved, approval_rate, sessions_on_model, current, pinned}>}
 */
function getStatusTable() {
  try {
    const db = getDb();
    db.initialize(null, null);

    const rawDb = db.raw();
    if (!rawDb) return [];
    const rows = rawDb.prepare(`
      SELECT agent, model, task_type, verdicts_total, verdicts_approved,
             sessions_on_model, current
      FROM   model_performance
      ORDER  BY agent, current DESC, model
    `).all();

    const pinned = getPinnedAgents();

    return rows.map(r => ({
      agent:            r.agent,
      model:            r.model,
      task_type:        r.task_type,
      verdicts_total:   r.verdicts_total,
      verdicts_approved: r.verdicts_approved,
      approval_rate:    r.verdicts_total > 0
        ? Math.round((r.verdicts_approved / r.verdicts_total) * 10000) / 100
        : 0,
      sessions_on_model: r.sessions_on_model,
      current:          r.current,
      pinned:           pinned.includes(r.agent),
    }));
  } catch (err) {
    process.stderr.write(`[model-router] getStatusTable error — ${err.message}\n`);
    return [];
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────

if (require.main === module && process.argv.includes('--status')) {
  const rows = getStatusTable();

  if (rows.length === 0) {
    process.stdout.write('No model performance data yet.\n');
    process.exit(0);
  }

  // Column widths
  const W = {
    agent:    Math.max(5,  ...rows.map(r => r.agent.length)),
    model:    Math.max(5,  ...rows.map(r => r.model.length)),
    type:     Math.max(9,  ...rows.map(r => r.task_type.length)),
    verdicts: 8,
    approval: 10,
    sessions: 8,
    current:  7,
    pinned:   6,
  };

  function pad(str, w) { return String(str).padEnd(w); }
  function padL(str, w) { return String(str).padStart(w); }

  const header = [
    pad('Agent',       W.agent),
    pad('Model',       W.model),
    pad('Task Type',   W.type),
    padL('Verdicts',   W.verdicts),
    padL('Approval%',  W.approval),
    padL('Sessions',   W.sessions),
    pad('Current',     W.current),
    pad('Pinned',      W.pinned),
  ].join('  ');

  const sep = '-'.repeat(header.length);

  process.stdout.write(`\n${header}\n${sep}\n`);

  for (const r of rows) {
    const agentLabel = r.pinned ? `${r.agent} 🔒` : r.agent;
    const line = [
      pad(agentLabel,          W.agent + (r.pinned ? 3 : 0)),
      pad(r.model,             W.model),
      pad(r.task_type,         W.type),
      padL(r.verdicts_total,   W.verdicts),
      padL(`${r.approval_rate}%`, W.approval),
      padL(r.sessions_on_model, W.sessions),
      pad(r.current ? 'yes' : 'no', W.current),
      pad(r.pinned  ? 'yes' : 'no', W.pinned),
    ].join('  ');
    process.stdout.write(`${line}\n`);
  }

  process.stdout.write('\n');
  process.exit(0);
}

// ── exports ───────────────────────────────────────────────────────────────

module.exports = {
  recordVerdict,
  recordSession,
  demotionEligible,
  getRecommendedModel,
  checkAndDemote,
  getStatusTable,
};
