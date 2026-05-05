'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const crypto = require('crypto');

// ── lazy-loaded deps ──────────────────────────────────────────────────────
let _yaml = null;

function getYaml() {
  if (!_yaml) {
    _yaml = require('js-yaml');
  }
  return _yaml;
}

// ── module state ──────────────────────────────────────────────────────────
let _session     = null;
let _config      = null;
let _sessionsDir = null;

// ── config loader ─────────────────────────────────────────────────────────
function loadConfig() {
  if (_config) return _config;

  const configPath = require('../../config/resolve.cjs');
  if (!fs.existsSync(configPath)) {
    return null;
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  _config = getYaml().load(raw);
  return _config;
}

function getSessionsDir() {
  if (_sessionsDir) return _sessionsDir;

  const cfg         = loadConfig();
  // sessions_dir is under storage (relative to metrics_root), not under paths
  const metricsRoot = (cfg && cfg.paths   && cfg.paths.metrics_root)      || '';
  const subDir      = (cfg && cfg.storage && cfg.storage.sessions_dir)    || 'sessions';

  _sessionsDir = metricsRoot
    ? path.join(metricsRoot, subDir)
    : path.join(os.homedir(), 'vault', 'methodology', '.metrics', 'sessions');

  if (!fs.existsSync(_sessionsDir)) {
    fs.mkdirSync(_sessionsDir, { recursive: true });
  }
  return _sessionsDir;
}

// ── internal helpers ──────────────────────────────────────────────────────
function currentJsonPath() {
  return path.join(getSessionsDir(), 'current.json');
}

function archivePath(id) {
  return path.join(getSessionsDir(), `session-${id}.json`);
}

function writeCurrentJson(session) {
  fs.writeFileSync(currentJsonPath(), JSON.stringify(session, null, 2), 'utf8');
}

function readCurrentJson() {
  const p = currentJsonPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    process.stderr.write('session: current.json corrupt or unreadable — starting fresh\n');
    return null;
  }
}

function isRecent(isoTimestamp) {
  // "Recent" = started less than 10 minutes ago
  const TEN_MIN_MS = 10 * 60 * 1000;
  return (Date.now() - new Date(isoTimestamp).getTime()) < TEN_MIN_MS;
}

function newSession() {
  const cwd = process.cwd();
  return {
    id:          crypto.randomUUID(),
    startedAt:   new Date().toISOString(),
    endedAt:     null,
    restoredAt:  null,
    durationMs:  null,
    platform:    os.platform(),
    cwd,
    context:     'claude-code',
    metrics: {
      edits:    0,
      commands: 0,
      tasks:    0,
      errors:   0,
    },
    project:            path.basename(cwd) || null,
    // Skill injection tracking — used by skill-loader.mjs to suppress
    // redundant injections within the same session.
    lastInjectedSkill:  null,
    lastInjectedAt:     null,
  };
}

function dbUpsert(session) {
  try {
    const db = require('./db.cjs');
    const cfg = loadConfig();
    const metricsRoot = cfg && cfg.paths && cfg.paths.metrics_root;
    db.initialize(metricsRoot, null);
    db.upsertSession({
      id:          session.id,
      started_at:  session.startedAt,
      ended_at:    session.endedAt,
      duration_ms: session.durationMs,
      platform:    session.platform,
      cwd:         session.cwd,
      edits:       session.metrics.edits,
      commands:    session.metrics.commands,
      tasks:       session.metrics.tasks,
      errors:      session.metrics.errors,
      project:     session.project,
    });
  } catch (err) {
    // DB write failure must not crash hooks — log to stderr only
    process.stderr.write(`session: db upsert failed: ${err.message}\n`);
  }
}

// ── public API ────────────────────────────────────────────────────────────

/**
 * Create a new session or restore an existing one if it started < 10 min ago.
 * Idempotent — calling start() multiple times returns the same session object.
 *
 * @returns {object} The active session object.
 */
function start() {
  if (_session) return _session;

  const existing = readCurrentJson();
  // Use restoredAt (last activity) when available so long sessions (> 10 min)
  // don't create orphan sessions on every hook invocation.
  const checkTime = (existing && (existing.restoredAt || existing.startedAt)) || null;
  if (existing && checkTime && isRecent(checkTime)) {
    existing.restoredAt = new Date().toISOString();
    _session = existing;
    writeCurrentJson(_session);
    return _session;
  }

  _session = newSession();
  writeCurrentJson(_session);
  dbUpsert(_session);
  return _session;
}

/**
 * Alias for start() — restores if recent, creates otherwise.
 *
 * @returns {object} The active session object.
 */
function restore() {
  return start();
}

/**
 * Mark the active session as ended, archive it, and upsert to DB.
 * No-op if no session is active.
 */
function end() {
  if (!_session) {
    const existing = readCurrentJson();
    if (!existing) {
      process.stderr.write('session: end() called but no active session found\n');
      return;
    }
    _session = existing;
  }

  const now       = new Date().toISOString();
  const startMs   = _session.startedAt ? new Date(_session.startedAt).getTime() : NaN;
  _session.endedAt    = now;
  _session.durationMs = Number.isFinite(startMs) ? Date.now() - startMs : null;

  // Archive before clearing current.json so a crash here doesn't lose the file
  fs.writeFileSync(archivePath(_session.id), JSON.stringify(_session, null, 2), 'utf8');
  dbUpsert(_session);

  // Overwrite current.json with the closed state so subsequent reads know it ended
  writeCurrentJson(_session);

  _session = null;
}

/**
 * Increment a named counter on the active session.
 * Silently no-ops if the counter name is not one of: edits, commands, tasks, errors.
 *
 * @param {'edits'|'commands'|'tasks'|'errors'} name
 */
function metric(name) {
  if (!_session) {
    const loaded = readCurrentJson();
    if (!loaded) return;
    _session = loaded;  // restore to in-memory so subsequent calls don't re-read disk
  }

  if (name in _session.metrics) {
    _session.metrics[name]++;
    writeCurrentJson(_session);
  }
}

/**
 * Return the current session object, or null if no session is active.
 *
 * @returns {object|null}
 */
function get() {
  return _session || null;
}

/**
 * Record that a skill was injected so subsequent prompts can suppress
 * a re-injection of the same skill within the 10-minute window.
 *
 * @param {string} skillName
 */
function setInjectedSkill(skillName) {
  if (!_session) {
    _session = readCurrentJson();
    if (!_session) return;
  }
  _session.lastInjectedSkill = skillName;
  _session.lastInjectedAt    = Date.now();
  writeCurrentJson(_session);
}

/**
 * Return the last-injected skill and when it was injected.
 *
 * @returns {{ skill: string|null, at: number|null }}
 */
function getInjectedSkill() {
  const s = _session || readCurrentJson();
  if (!s) return { skill: null, at: null };
  return {
    skill: s.lastInjectedSkill || null,
    at:    s.lastInjectedAt    || null,
  };
}

// ── exports ───────────────────────────────────────────────────────────────
module.exports = {
  start,
  restore,
  end,
  metric,
  get,
  setInjectedSkill,
  getInjectedSkill,
};
