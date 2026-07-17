'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const crypto = require('crypto');
const { deriveProject } = require('./project-id.cjs');

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

  // Explicit override beats config — lets tests run against a temp dir
  // instead of the live session store.
  const envDir = process.env.VAULTFLOW_SESSIONS_DIR;
  if (envDir) {
    _sessionsDir = envDir;
  } else {
    const cfg         = loadConfig();
    // sessions_dir is under storage (relative to metrics_root), not under paths
    const metricsRoot = (cfg && cfg.paths   && cfg.paths.metrics_root)      || '';
    const subDir      = (cfg && cfg.storage && cfg.storage.sessions_dir)    || 'sessions';

    _sessionsDir = metricsRoot
      ? path.join(metricsRoot, subDir)
      : path.join(os.homedir(), 'vault', 'methodology', '.metrics', 'sessions');
  }

  if (!fs.existsSync(_sessionsDir)) {
    fs.mkdirSync(_sessionsDir, { recursive: true });
  }
  return _sessionsDir;
}

// ── internal helpers ──────────────────────────────────────────────────────
// One continuity file PER PROJECT. A single global current.json meant a
// recent session from any other project could be restored into a session
// launched elsewhere — e.g. a StockPicker session bleeding into a vaultflow
// conversation, mislabeling its git context and all downstream telemetry.
function projectSlug() {
  const cwd  = process.cwd();
  const name = deriveProject(cwd) || path.basename(cwd) || 'default';
  return String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
}

function currentJsonPath() {
  return path.join(getSessionsDir(), `current-${projectSlug()}.json`);
}

function legacyJsonPath() {
  return path.join(getSessionsDir(), 'current.json');
}

function sameCwd(sessionCwd) {
  if (!sessionCwd) return false;
  const a = path.resolve(String(sessionCwd));
  const b = path.resolve(process.cwd());
  // Windows paths are case-insensitive; two hooks in the same repo can see
  // different casing (C:\GIT vs c:\git) depending on how claude was launched.
  return os.platform() === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
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

function sniffModel() {
  return process.env.CLAUDE_CODE_MODEL
      || process.env.ANTHROPIC_MODEL
      || process.env.CLAUDE_MODEL
      || null;
}

function sniffModelProvider(model) {
  if (!model) return null;
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'openai';
  if (model.startsWith('gemini')) return 'google';
  return null;
}

function sniffCliVersion() {
  return process.env.CLAUDE_CODE_VERSION
      || process.env.CLAUDECODE_VERSION
      || process.env.npm_package_version
      || null;
}

function newSession() {
  const cwd = process.cwd();
  const model = sniffModel();
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
    // Project comes from the git root of the working dir, never just basename
    // (which produced "YOU", "GIT", "system32" historically).
    project:        deriveProject(cwd),
    model,
    modelProvider:  sniffModelProvider(model),
    cliVersion:     sniffCliVersion(),
    // Skill injection tracking — used by skill-loader.mjs to suppress
    // redundant injections within the same session.
    lastInjectedSkill:  null,
    lastInjectedAt:     null,
    injectedSources:    [],
  };
}

function dbUpsert(session) {
  try {
    const db = require('./db.cjs');
    const cfg = loadConfig();
    const metricsRoot = cfg && cfg.paths && cfg.paths.metrics_root;
    db.initialize(metricsRoot, null);
    db.upsertSession({
      id:             session.id,
      started_at:     session.startedAt,
      ended_at:       session.endedAt,
      duration_ms:    session.durationMs,
      platform:       session.platform,
      cli:            'claude',
      cli_version:    session.cliVersion || null,
      model:          session.model || null,
      model_provider: session.modelProvider || null,
      cwd:            session.cwd,
      edits:          session.metrics.edits,
      commands:       session.metrics.commands,
      tasks:          session.metrics.tasks,
      errors:         session.metrics.errors,
      project:        session.project,
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

  // Drop the pre-per-project global store if it still exists. Nothing reads
  // it anymore, and leaving it around invites exactly the cross-project
  // restore bug the per-project files were introduced to kill.
  try {
    const legacy = legacyJsonPath();
    if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
  } catch (_) { /* best-effort cleanup */ }

  const existing = readCurrentJson();
  // Use restoredAt (last activity) when available so long sessions (> 10 min)
  // don't create orphan sessions on every hook invocation.
  const checkTime = (existing && (existing.restoredAt || existing.startedAt)) || null;
  // Restore only a session that (a) hasn't ended — end() writes the closed
  // state back precisely so this check is possible, (b) belongs to this
  // working directory, and (c) was active recently. Without (a) and (b) a
  // closed session from another repo gets resurrected and every event in the
  // new conversation is attributed to the wrong project.
  if (existing && !existing.endedAt && sameCwd(existing.cwd) && checkTime && isRecent(checkTime)) {
    existing.restoredAt = new Date().toISOString();
    _session = existing;
    writeCurrentJson(_session);
    return _session;
  }

  // Sweep stale sessions before creating a new one. Sessions whose Stop /
  // SessionEnd hook never fired (IDE killed, crash, kill -9) get an ended_at
  // derived from their last tool_call/edit_event so analytics aren't biased
  // by 22% of sessions perpetually appearing "active". Idempotent.
  try {
    const db = require('./db.cjs');
    const cfg = loadConfig();
    db.initialize(cfg && cfg.paths && cfg.paths.metrics_root, null);
    db.closeStaleSessions(12);
  } catch (err) {
    process.stderr.write(`session: stale-session sweep skipped — ${err.message}\n`);
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

  // The in-memory metrics counters were never wired up to the increment paths,
  // so dbUpsert just wrote zeros. Recompute from the event tables now that
  // ended_at is set so the dashboard's session list shows real numbers.
  try {
    const db = require('./db.cjs');
    db.initialize(null, null);
    db.recomputeSessionAggregates(_session.id);
  } catch (err) {
    process.stderr.write(`session: aggregate recompute failed — ${err.message}\n`);
  }

  // Overwrite current.json with the closed state so subsequent reads know it ended
  writeCurrentJson(_session);

  // Write session compaction summary — crash-safe so hook path never throws.
  try {
    const db  = require('./db.cjs');
    db.initialize(null, null);
    const raw = db.raw();
    if (!raw) throw new Error('DB not initialized');

    // Top 5 files by edit count for this session
    const topFiles = raw.prepare(`
      SELECT file_path, COUNT(*) as cnt
      FROM edit_events
      WHERE session_id = ?
      GROUP BY file_path
      ORDER BY cnt DESC
      LIMIT 5
    `).all(_session.id).map(r => path.basename(r.file_path));

    // Patterns fired this session (from patterns table, recent)
    const patterns = raw.prepare(`
      SELECT pattern_key FROM patterns
      WHERE last_fired > ?
      ORDER BY fire_count DESC
      LIMIT 3
    `).all(new Date(Date.now() - (_session.durationMs || 0) - 60000).toISOString())
      .map(r => r.pattern_key);

    db.writeSessionSummary({
      session_id:  _session.id,
      project:     _session.project || path.basename(_session.cwd || ''),
      duration_ms: _session.durationMs || 0,
      top_files:   topFiles,
      patterns:    patterns,
      summary_at:  new Date().toISOString(),
    });
  } catch (err) {
    process.stderr.write(`session: compaction summary failed — ${err.message}\n`);
  }

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
 * Falls back to the persisted current-session file: every hook runs in a
 * fresh process, so the in-memory _session is null unless THIS process
 * started the session. Without the fallback, all recording gated on get()
 * (pre-bash Bash telemetry, Read/Grep/Glob telemetry, MCP-call telemetry)
 * silently no-ops — which is exactly how Bash tool calls went unrecorded
 * for months. Same pattern as getInjectedSkill/getInjectedSources.
 *
 * @returns {object|null}
 */
function get() {
  if (!_session) _session = readCurrentJson();
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

function getInjectedSources() {
  const s = _session || readCurrentJson();
  return (s && Array.isArray(s.injectedSources)) ? s.injectedSources : [];
}

function addInjectedSource(sourcePath) {
  if (!_session) {
    _session = readCurrentJson();
    if (!_session) return;
  }
  if (!Array.isArray(_session.injectedSources)) _session.injectedSources = [];
  _session.injectedSources.push(String(sourcePath || '').slice(0, 500));
  if (_session.injectedSources.length > 10) _session.injectedSources = _session.injectedSources.slice(-10);
  writeCurrentJson(_session);
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
  getInjectedSources,
  addInjectedSource,
};
