/**
 * watcher.mjs — file system watcher for AI-agnostic session tracking
 *
 * Monitors project directories for file edits made by ANY AI tool
 * (Copilot, Codex, Cursor, Windsurf, etc.) — not just Claude Code.
 * Records edit_events to the vaultflow SQLite DB identically to
 * how post-edit.cjs records Claude Code edits.
 *
 * Session boundary: 30 minutes of inactivity creates a new session.
 *
 * Usage:
 *   node watcher.mjs [watch-dir]         Watch a directory (foreground)
 *   node watcher.mjs --daemon [dir]      Start as background daemon
 *   node watcher.mjs --stop              Stop the running daemon
 *   node watcher.mjs --status            Show daemon status
 */

import { createRequire } from 'node:module';
import path              from 'node:path';
import fs                from 'node:fs';
import os                from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn }         from 'node:child_process';

const require = createRequire(import.meta.url);

// ── config ────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    const yaml       = require('js-yaml');
    const configPath = require('../../config/resolve.cjs');
    if (fs.existsSync(configPath)) {
      return yaml.load(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (_) {}
  return {};
}

const cfg       = loadConfig();
const METRICS   = cfg.paths  && cfg.paths.metrics_root || path.join(os.homedir(), 'vault', 'methodology', '.metrics');
const DB_FILE   = cfg.storage && cfg.storage.db_file   || 'vaultflow.db';
const PID_FILE  = path.join(METRICS, 'watcher.pid');
const LOG_FILE  = path.join(METRICS, 'watcher.log');

// ── session management ────────────────────────────────────────────────────

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes of inactivity

let _session = {
  id:          null,
  startedAt:   null,
  lastActivity: null,
};

function newSessionId() {
  return `watcher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureSession(db) {
  const now = Date.now();

  if (
    _session.id &&
    _session.lastActivity &&
    now - _session.lastActivity < SESSION_TIMEOUT_MS
  ) {
    // Still within the active session
    _session.lastActivity = now;
    return _session.id;
  }

  const cwd = process.cwd();
  const project = deriveProject(cwd);

  // Close previous session if any
  if (_session.id) {
    try {
      db.upsertSession({
        id:          _session.id,
        started_at:  new Date(_session.startedAt).toISOString(),
        ended_at:    new Date().toISOString(),
        duration_ms: now - _session.startedAt,
        platform:    'watcher',
        cli:         'watcher',
        project,
        cwd,
      });
    } catch (_) {}
  }

  // Start new session
  const id = newSessionId();
  _session  = { id, startedAt: now, lastActivity: now };

  try {
    db.upsertSession({
      id,
      started_at: new Date(now).toISOString(),
      platform:   'watcher',
      cli:        'watcher',
      project,
      cwd,
    });
  } catch (_) {}

  log(`New session started: ${id}`);
  return id;
}

// ── logging ───────────────────────────────────────────────────────────────

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stderr.write(`[watcher] ${msg}\n`);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {}
}

// ── file filter ───────────────────────────────────────────────────────────

// Ignore patterns — generated/binary/IDE noise
const IGNORE_PATTERNS = [
  /node_modules/,
  /\.git\//,
  /\.git\\/,
  /dist\//,
  /dist\\/,
  /build\//,
  /build\\/,
  /\.parquet$/,
  /\.db$/,
  /\.db-shm$/,
  /\.db-wal$/,
  /\.pid$/,
  /\.log$/,
  /\.png$/,
  /\.jpg$/,
  /\.gif$/,
  /\.ico$/,
  /\.ttf$/,
  /\.woff/,
  /\/__pycache__\//,
  /\.pyc$/,
  /\.DS_Store/,
];

function shouldIgnore(filePath) {
  return IGNORE_PATTERNS.some(r => r.test(filePath));
}

// Shared with post-edit / session / copilot-resume — see project-id.cjs.
const { deriveProject } = require('./project-id.cjs');

// ── shell history tracking (Option A + B) ────────────────────────────────

const PSREADLINE_HISTORY = path.join(
  process.env.APPDATA || os.homedir(),
  'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt'
);
const SHELL_JSONL = path.join(METRICS, 'shell-commands.jsonl');
const COPILOT_SESSION_ROOT = path.join(os.homedir(), '.copilot', 'session-state');
const COPILOT_POS_FILE = path.join(METRICS, 'copilot-events.pos.json');
const CODEX_SESSION_ROOT = path.join(os.homedir(), '.codex', 'sessions');
const CODEX_POS_FILE = path.join(METRICS, 'codex-events.pos.json');

let _historyPos = -1; // -1 = not yet initialized
let _jsonlPos   = -1;
let _copilotPos = {};
const _copilotState = new Map();
let _codexPos = {};
const _codexState = new Map();
const _codexFileSessions = new Map();

const JSONL_POS_FILE = path.join(METRICS, 'shell-jsonl.pos');

// PSReadLine history: always start from end (old history = noise).
// JSONL: persist position so commands written while watcher was down are not lost.
function initHistoryPos() {
  try { return fs.statSync(PSREADLINE_HISTORY).size; } catch (_) { return 0; }
}

function loadJsonlPos() {
  try { return parseInt(fs.readFileSync(JSONL_POS_FILE, 'utf8').trim(), 10) || 0; } catch (_) { return 0; }
}

function saveJsonlPos(pos) {
  try { fs.writeFileSync(JSONL_POS_FILE, String(pos), 'utf8'); } catch (_) {}
}

function loadCopilotPos() {
  try { return JSON.parse(fs.readFileSync(COPILOT_POS_FILE, 'utf8')) || {}; } catch (_) { return {}; }
}

function saveCopilotPos() {
  try {
    fs.writeFileSync(COPILOT_POS_FILE, JSON.stringify(_copilotPos, null, 2), 'utf8');
  } catch (_) {}
}

function seedCopilotPositions(db) {
  _copilotPos = loadCopilotPos();
  if (!fs.existsSync(COPILOT_SESSION_ROOT)) return;

  for (const sessionDir of fs.readdirSync(COPILOT_SESSION_ROOT)) {
    const file = path.join(COPILOT_SESSION_ROOT, sessionDir, 'events.jsonl');
    if (!fs.existsSync(file)) continue;
    hydrateCopilotSessionFromFile(db, sessionDir, file);
    if (_copilotPos[file] == null) {
      try { _copilotPos[file] = fs.statSync(file).size; } catch (_) { _copilotPos[file] = 0; }
    }
  }
  saveCopilotPos();
}

function loadCodexPos() {
  try { return JSON.parse(fs.readFileSync(CODEX_POS_FILE, 'utf8')) || {}; } catch (_) { return {}; }
}

function saveCodexPos() {
  try {
    fs.writeFileSync(CODEX_POS_FILE, JSON.stringify(_codexPos, null, 2), 'utf8');
  } catch (_) {}
}

function getCodexSessionIdFromFile(filePath) {
  try {
    const firstLine = fs.readFileSync(filePath, 'utf8').split(/\r?\n/, 1)[0];
    if (!firstLine) return null;
    const evt = JSON.parse(firstLine);
    if (evt?.type === 'session_meta' && evt?.payload?.id) {
      return evt.payload.id;
    }
  } catch (_) {}
  return null;
}

function seedCodexPositions() {
  _codexPos = loadCodexPos();
  if (!fs.existsSync(CODEX_SESSION_ROOT)) return;

  const stack = [CODEX_SESSION_ROOT];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !full.endsWith('.jsonl')) continue;

      if (_codexPos[full] == null) {
        try { _codexPos[full] = fs.statSync(full).size; } catch (_) { _codexPos[full] = 0; }
      }
      const sessionId = getCodexSessionIdFromFile(full);
      if (sessionId) _codexFileSessions.set(full, sessionId);
    }
  }

  saveCodexPos();
}

// Read bytes appended to a file since last known position.
// Returns array of non-empty trimmed lines.
function readNewLines(filePath, posRef) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const size = fs.statSync(filePath).size;
    if (size <= posRef.pos) return [];
    const len = size - posRef.pos;
    const buf = Buffer.alloc(len);
    const fd  = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, len, posRef.pos);
    fs.closeSync(fd);
    posRef.pos = size;
    return buf.toString('utf8').split('\n').map(l => l.trim()).filter(Boolean);
  } catch (_) { return []; }
}

function pollShellHistory(db) {
  const posRef = { pos: _historyPos };
  const lines  = readNewLines(PSREADLINE_HISTORY, posRef);
  _historyPos  = posRef.pos;
  if (lines.length === 0) return;

  const sessionId = ensureSession(db);
  for (const rawCmd of lines) {
    try {
      const cmd = rawCmd.slice(0, 1000); // guard against gigantic pastes
      db.recordToolCall(
        sessionId,
        'ShellHistory',
        JSON.stringify({ command: cmd, shell: 'powershell', source: 'psreadline-history' })
      );
    } catch (_) {}
  }
  log(`shell-history: recorded ${lines.length} command(s)`);
}

function pollShellJsonl(db) {
  const posRef = { pos: _jsonlPos };
  const lines  = readNewLines(SHELL_JSONL, posRef);
  _jsonlPos    = posRef.pos;
  if (lines.length > 0) saveJsonlPos(_jsonlPos);
  if (lines.length === 0) return;

  const sessionId = ensureSession(db);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const cmd   = String(entry.cmd || '').slice(0, 1000); // guard against gigantic pastes
      const cwd   = String(entry.cwd || '').slice(0, 500);
      db.recordToolCall(
        sessionId,
        'ShellHistory',
        JSON.stringify({
          command:   cmd,
          shell:     entry.shell || 'powershell',
          cwd:       cwd || null,
          exit_code: entry.exit  != null ? entry.exit : null,
          ts:        entry.ts    || null,
          source:    'profile-hook',
        })
      );
    } catch (_) {}
  }
  log(`shell-jsonl: recorded ${lines.length} command(s)`);
}

function getCopilotProject(cwd) {
  // Prefer git-root project name; only fall back to cwd basename if we cannot
  // resolve a project (the prior order was a bug: basename always wins,
  // producing "YOU", "GIT", etc.).
  return cwd ? (deriveProject(cwd) || path.basename(cwd)) : null;
}

function inferCodexModel(payload) {
  if (payload?.model) return payload.model;
  const text = payload?.base_instructions?.text || '';
  const match = text.match(/based on ([A-Za-z0-9.\-]+)/i);
  return match ? match[1].replace(/[.]+$/g, '') : null;
}

function readFirstJsonlEvent(filePath) {
  try {
    const firstLine = fs.readFileSync(filePath, 'utf8').split(/\r?\n/, 1)[0];
    return firstLine ? JSON.parse(firstLine) : null;
  } catch (_) {
    return null;
  }
}

function readLastJsonlEvent(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return null;

    const chunkSize = Math.min(stat.size, 64 * 1024);
    const buffer = Buffer.alloc(chunkSize);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, chunkSize, stat.size - chunkSize);
    fs.closeSync(fd);

    const lines = buffer.toString('utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch (_) {
    return null;
  }
}

function hydrateCopilotSessionFromFile(db, sessionDir, filePath) {
  const firstEvent = readFirstJsonlEvent(filePath);
  if (!firstEvent || firstEvent.type !== 'session.start') return null;

  const sessionId = firstEvent?.data?.sessionId || sessionDir;
  const cwd = firstEvent?.data?.context?.cwd || null;
  const startedAt = firstEvent?.data?.startTime || firstEvent?.timestamp || null;
  const project = getCopilotProject(cwd || '');
  const lastEvent = readLastJsonlEvent(filePath);
  const fileStat = fs.statSync(filePath);
  const inactive = (Date.now() - fileStat.mtimeMs) > SESSION_TIMEOUT_MS;
  const endedAt = lastEvent?.type === 'session.shutdown'
    ? (lastEvent.timestamp || null)
    : (inactive ? (lastEvent?.timestamp || null) : null);
  const existing = _copilotState.get(sessionId) || { commands: 0, errors: 0, toolCalls: new Map(), cliVersion: null, model: null };

  existing.startedAt = existing.startedAt || startedAt;
  existing.cwd = existing.cwd || cwd;
  existing.project = existing.project && existing.project !== 'unknown' ? existing.project : project;
  existing.cliVersion = existing.cliVersion || firstEvent?.data?.copilotVersion || null;
  _copilotState.set(sessionId, existing);

  if (db && startedAt) {
    db.upsertSession({
      id: sessionId,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: endedAt ? (new Date(endedAt).getTime() - new Date(startedAt).getTime()) : null,
      platform: 'copilot',
      cli: 'copilot',
      cli_version: existing.cliVersion,
      model: existing.model,
      cwd,
      commands: existing.commands,
      errors: existing.errors,
      project,
    });
  }

  return { sessionId, startedAt, cwd, project, endedAt };
}

function getCopilotSessionState(sessionId, evt, fileMeta = null) {
  const existing = _copilotState.get(sessionId) || {
    startedAt: fileMeta?.startedAt || evt.timestamp,
    cwd: fileMeta?.cwd || evt?.data?.context?.cwd || null,
    project: fileMeta?.project || getCopilotProject(evt?.data?.context?.cwd || ''),
    commands: 0,
    errors: 0,
    toolCalls: new Map(),
    cliVersion: fileMeta?.cliVersion || null,
    model: fileMeta?.model || null,
  };

  if (!existing.startedAt && fileMeta?.startedAt) existing.startedAt = fileMeta.startedAt;
  if (!existing.cwd && fileMeta?.cwd) existing.cwd = fileMeta.cwd;
  if ((!existing.project || existing.project === 'unknown') && fileMeta?.project) existing.project = fileMeta.project;
  if (!existing.cliVersion && fileMeta?.cliVersion) existing.cliVersion = fileMeta.cliVersion;
  if (!existing.model && fileMeta?.model) existing.model = fileMeta.model;
  if (evt?.data?.context?.cwd) {
    existing.cwd = evt.data.context.cwd;
    existing.project = getCopilotProject(evt.data.context.cwd);
  }
  if (evt?.data?.startTime) existing.startedAt = evt.data.startTime;
  if (evt?.data?.copilotVersion) existing.cliVersion = evt.data.copilotVersion;

  _copilotState.set(sessionId, existing);
  return existing;
}

function truncateJson(value, limit = 4000) {
  const text = JSON.stringify(value ?? null);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function ingestCopilotEvent(db, evt, sessionIdHint, filePath) {
  const data = evt?.data || {};
  const fileMeta = sessionIdHint && filePath ? hydrateCopilotSessionFromFile(db, sessionIdHint, filePath) : null;
  const sessionId = data.sessionId || data?.context?.sessionId || evt?.sessionId || fileMeta?.sessionId || sessionIdHint || null;
  const candidateId = sessionId;
  if (!candidateId) return;

  const state = getCopilotSessionState(candidateId, evt, fileMeta);

  switch (evt.type) {
    case 'session.start':
      db.upsertSession({
        id: candidateId,
        started_at: data.startTime || evt.timestamp,
        platform: 'copilot',
        cli: 'copilot',
        cli_version: state.cliVersion || data.copilotVersion || null,
        model: state.model || null,
        cwd: state.cwd,
        commands: state.commands,
        errors: state.errors,
        project: state.project,
      });
      db.recordToolCall(candidateId, 'CopilotSessionStart', truncateJson({
        version: data.copilotVersion,
        context: data.context || null,
      }));
      break;

    case 'user.message':
      state.commands += 1;
      db.recordPrompt(candidateId, data.content || '', { source: 'copilot' });
      db.upsertSession({
        id: candidateId,
        started_at: state.startedAt || evt.timestamp,
        platform: 'copilot',
        cli: 'copilot',
        cli_version: state.cliVersion || null,
        model: state.model || null,
        cwd: state.cwd,
        commands: state.commands,
        errors: state.errors,
        project: state.project,
      });
      break;

    case 'session.model_change':
      if (data.newModel) state.model = data.newModel;
      db.recordToolCall(candidateId, 'CopilotSessionModelChange', truncateJson(data));
      db.upsertSession({
        id: candidateId,
        started_at: state.startedAt || evt.timestamp,
        platform: 'copilot',
        cli: 'copilot',
        cli_version: state.cliVersion || null,
        model: state.model || data.newModel || null,
        cwd: state.cwd,
        commands: state.commands,
        errors: state.errors,
        project: state.project,
      });
      break;

    case 'tool.execution_start':
      if (data.toolCallId && data.toolName) {
        state.toolCalls.set(data.toolCallId, data.toolName);
      }
      db.recordToolCall(candidateId, `Copilot:${data.toolName || 'unknown'}:start`, truncateJson({
        toolCallId: data.toolCallId || null,
        arguments: data.arguments || null,
      }));
      break;

    case 'tool.execution_complete':
      if (data.success === false) state.errors += 1;
      db.recordToolCall(candidateId, `Copilot:${state.toolCalls.get(data.toolCallId) || data.toolName || 'unknown'}:complete`, truncateJson({
        toolCallId: data.toolCallId || null,
        success: data.success,
        result: data.result || null,
        toolTelemetry: data.toolTelemetry || null,
      }));
      db.upsertSession({
        id: candidateId,
        started_at: state.startedAt || evt.timestamp,
        platform: 'copilot',
        cli: 'copilot',
        cli_version: state.cliVersion || null,
        model: state.model || null,
        cwd: state.cwd,
        commands: state.commands,
        errors: state.errors,
        project: state.project,
      });
      break;

    case 'permission.requested':
    case 'permission.decided':
    case 'permission.completed':
      db.recordToolCall(candidateId, `Copilot:${evt.type}`, truncateJson(data));
      break;

    case 'session.shutdown':
      if (data.sessionStartTime && !state.startedAt) state.startedAt = data.sessionStartTime;
      db.recordToolCall(candidateId, 'CopilotSessionShutdown', truncateJson(data));
      db.upsertSession({
        id: candidateId,
        started_at: state.startedAt || data.sessionStartTime || evt.timestamp,
        ended_at: evt.timestamp,
        duration_ms: (state.startedAt || data.sessionStartTime) ? (new Date(evt.timestamp).getTime() - new Date(state.startedAt || data.sessionStartTime).getTime()) : null,
        platform: 'copilot',
        cli: 'copilot',
        cli_version: state.cliVersion || null,
        model: state.model || data.currentModel || null,
        cwd: state.cwd,
        commands: state.commands,
        errors: state.errors,
        project: state.project,
      });
      _copilotState.delete(candidateId);
      break;

    case 'session.error':
      state.errors += 1;
      db.recordToolCall(candidateId, 'CopilotSessionError', truncateJson(data));
      break;

    default:
      break;
  }
}

function pollCopilotEvents(db) {
  if (!fs.existsSync(COPILOT_SESSION_ROOT)) return;

  let changed = false;
  for (const sessionDir of fs.readdirSync(COPILOT_SESSION_ROOT)) {
    const file = path.join(COPILOT_SESSION_ROOT, sessionDir, 'events.jsonl');
    if (!fs.existsSync(file)) continue;
    hydrateCopilotSessionFromFile(db, sessionDir, file);
    if (_copilotPos[file] == null) _copilotPos[file] = 0;

    const posRef = { pos: _copilotPos[file] };
    const lines = readNewLines(file, posRef);
    _copilotPos[file] = posRef.pos;
    if (lines.length === 0) continue;

    changed = true;
    for (const line of lines) {
      try {
        ingestCopilotEvent(db, JSON.parse(line), sessionDir, file);
      } catch (_) {}
    }
    log(`copilot-events: recorded ${lines.length} event(s) from ${sessionDir}`);
  }

  if (changed) saveCopilotPos();
}

function getCodexProject(cwd) {
  // Prefer git-root project name; only fall back to cwd basename if we cannot
  // resolve a project (the prior order was a bug: basename always wins,
  // producing "YOU", "GIT", etc.).
  return cwd ? (deriveProject(cwd) || path.basename(cwd)) : null;
}

function getCodexSessionState(sessionId, evt, filePath) {
  const existing = _codexState.get(sessionId) || {
    startedAt: evt.timestamp,
    cwd: evt?.payload?.cwd || null,
    project: getCodexProject(evt?.payload?.cwd || ''),
    commands: 0,
    errors: 0,
    toolCalls: new Map(),
    cliVersion: evt?.payload?.cli_version || null,
    model: inferCodexModel(evt?.payload || {}),
    modelProvider: evt?.payload?.model_provider || null,
    filePath,
  };

  if (evt?.payload?.cwd) {
    existing.cwd = evt.payload.cwd;
    existing.project = getCodexProject(evt.payload.cwd);
  }
  if (evt?.payload?.timestamp) existing.startedAt = evt.payload.timestamp;
  if (evt?.payload?.cli_version) existing.cliVersion = evt.payload.cli_version;
  if (!existing.model) existing.model = inferCodexModel(evt?.payload || {});
  if (evt?.payload?.model_provider) existing.modelProvider = evt.payload.model_provider;
  if (filePath) existing.filePath = filePath;

  _codexState.set(sessionId, existing);
  return existing;
}

function ingestCodexEvent(db, evt, filePath) {
  const payload = evt?.payload || {};
  const sessionId = payload.id || _codexFileSessions.get(filePath) || null;
  if (!sessionId) return;
  _codexFileSessions.set(filePath, sessionId);

  const state = getCodexSessionState(sessionId, evt, filePath);

  switch (evt.type) {
    case 'session_meta':
      db.upsertSession({
        id: sessionId,
        started_at: payload.timestamp || evt.timestamp,
        platform: 'codex',
        cli: 'codex',
        cli_version: state.cliVersion || payload.cli_version || null,
        model: state.model || inferCodexModel(payload),
        model_provider: state.modelProvider || payload.model_provider || null,
        cwd: state.cwd,
        commands: state.commands,
        errors: state.errors,
        project: state.project,
      });
      db.recordToolCall(sessionId, 'CodexSessionStart', truncateJson({
        originator: payload.originator || null,
        cli_version: payload.cli_version || null,
        source: payload.source || null,
        model_provider: payload.model_provider || null,
        cwd: payload.cwd || null,
      }));
      break;

    case 'event_msg':
      if (payload.type === 'task_complete') {
        db.recordToolCall(sessionId, 'CodexTaskComplete', truncateJson(payload));
        db.upsertSession({
          id: sessionId,
          started_at: state.startedAt || evt.timestamp,
          ended_at: evt.timestamp,
          duration_ms: state.startedAt ? (new Date(evt.timestamp).getTime() - new Date(state.startedAt).getTime()) : null,
          platform: 'codex',
          cli: 'codex',
          cli_version: state.cliVersion || null,
          model: state.model || null,
          model_provider: state.modelProvider || null,
          cwd: state.cwd,
          commands: state.commands,
          errors: state.errors,
          project: state.project,
        });
      }
      break;

    case 'response_item':
      switch (payload.type) {
        case 'message': {
          if (payload.role === 'user') {
            const texts = (payload.content || [])
              .filter(item => item.type === 'input_text' && item.text)
              .map(item => item.text);
            for (const text of texts) {
              state.commands += 1;
              db.recordPrompt(sessionId, text, { source: 'codex' });
            }
            db.upsertSession({
              id: sessionId,
              started_at: state.startedAt || evt.timestamp,
              platform: 'codex',
              cli: 'codex',
              cli_version: state.cliVersion || null,
              model: state.model || null,
              model_provider: state.modelProvider || null,
              cwd: state.cwd,
              commands: state.commands,
              errors: state.errors,
              project: state.project,
            });
          }
          break;
        }

        case 'function_call': {
          if (payload.call_id && payload.name) state.toolCalls.set(payload.call_id, payload.name);
          db.recordToolCall(sessionId, `Codex:${payload.name || 'unknown'}:start`, truncateJson({
            call_id: payload.call_id || null,
            arguments: payload.arguments || null,
          }));
          break;
        }

        case 'function_call_output': {
          const toolName = state.toolCalls.get(payload.call_id) || 'unknown';
          db.recordToolCall(sessionId, `Codex:${toolName}:complete`, truncateJson({
            call_id: payload.call_id || null,
            output: payload.output || null,
          }));
          break;
        }

        case 'custom_tool_call': {
          if (payload.call_id && payload.name) state.toolCalls.set(payload.call_id, payload.name);
          db.recordToolCall(sessionId, `Codex:${payload.name || 'custom'}:start`, truncateJson({
            call_id: payload.call_id || null,
            input: payload.input || null,
            status: payload.status || null,
          }));
          break;
        }

        case 'custom_tool_call_output': {
          const toolName = state.toolCalls.get(payload.call_id) || 'custom';
          db.recordToolCall(sessionId, `Codex:${toolName}:complete`, truncateJson({
            call_id: payload.call_id || null,
            output: payload.output || null,
          }));
          break;
        }

        case 'web_search_call':
          db.recordToolCall(sessionId, 'Codex:web_search', truncateJson(payload));
          break;

        default:
          break;
      }
      break;

    default:
      break;
  }
}

function pollCodexEvents(db) {
  if (!fs.existsSync(CODEX_SESSION_ROOT)) return;

  let changed = false;
  const stack = [CODEX_SESSION_ROOT];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !full.endsWith('.jsonl')) continue;
      if (_codexPos[full] == null) {
        _codexPos[full] = 0;
        const sessionId = getCodexSessionIdFromFile(full);
        if (sessionId) _codexFileSessions.set(full, sessionId);
      }

      const posRef = { pos: _codexPos[full] };
      const lines = readNewLines(full, posRef);
      _codexPos[full] = posRef.pos;
      if (lines.length === 0) continue;

      changed = true;
      for (const line of lines) {
        try {
          ingestCodexEvent(db, JSON.parse(line), full);
        } catch (_) {}
      }
      log(`codex-events: recorded ${lines.length} event(s) from ${path.basename(full)}`);
    }
  }

  if (changed) saveCodexPos();
}

// ── watcher core ──────────────────────────────────────────────────────────

let _chokidar = null;

async function startWatcher(watchDir) {
  if (!_chokidar) {
    _chokidar = (await import('chokidar')).default;
  }

  const db = require('./db.cjs');
  try {
    db.initialize(METRICS, DB_FILE);
  } catch (err) {
    log(`DB init error: ${err.message} — watcher cannot run without DB`);
    process.exit(1);
  }

  const dir = watchDir || process.cwd();
  log(`Watching: ${dir}`);

  const watcher = _chokidar.watch(dir, {
    ignored:          (p) => shouldIgnore(p),
    persistent:       true,
    ignoreInitial:    true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    depth:            8,
  });

  // Set of project names dirtied since the last gen-context refresh tick.
  // Cleared each refresh interval after spawning regenerations. Lets us only
  // regenerate projects that actually had edits, not every project we know about.
  const dirtyProjects = new Set();

  const handleChange = (filePath, changeType) => {
    if (shouldIgnore(filePath)) return;

    try {
      const sessionId = ensureSession(db);
      const project   = deriveProject(filePath);
      db.recordEdit(sessionId, filePath, project, changeType);
      if (project) dirtyProjects.add(project);
      log(`${changeType}: ${filePath} [${project}]`);
      try {
        const codeGraph = require('./code-graph.cjs');
        if (codeGraph.shouldIndex(filePath)) codeGraph.indexFile(db, filePath, project);
      } catch (err) { log(`code-graph error: ${err.message}`); }
    } catch (err) {
      log(`recordEdit error: ${err.message}`);
    }
  };

  watcher
    .on('change', f => handleChange(f, 'edit'))
    .on('add',    f => handleChange(f, 'create'))
    .on('unlink', f => handleChange(f, 'delete'))
    .on('error',  err => log(`watcher error: ${err.message}`));

  // PSReadLine: start from end (don't replay old history)
  // JSONL: resume from persisted position (catch commands written while watcher was down)
  _historyPos = initHistoryPos();
  _jsonlPos   = loadJsonlPos();
  seedCopilotPositions(db);
  seedCodexPositions();
  log(`Shell history tail: pos ${_historyPos}`);
  log(`Shell JSONL tail:   pos ${_jsonlPos} (persisted)`);
  setInterval(() => {
    pollShellHistory(db);
    pollShellJsonl(db);
    pollCopilotEvents(db);
    pollCodexEvents(db);
  }, 3000);

  // ── periodic gen-context refresh ──────────────────────────────────────
  // Refreshes AGENTS.md, .github/copilot-instructions.md, and .cursor rules
  // for any project that's been edited since the last tick. This is the
  // tool-agnostic refresh path: Claude/Copilot/Codex/Cursor all read these
  // files at start, so the watcher (always running, doesn't depend on which
  // tool spawned it) becomes the source of fresh context.
  //
  // Interval is 10 min by default. Override with VAULTFLOW_GEN_CONTEXT_INTERVAL_MS.
  // Each project regen is spawned detached so a slow gen-context (~1-2s per
  // project) never blocks the watcher event loop.
  const GEN_CONTEXT_INTERVAL_MS = parseInt(
    process.env.VAULTFLOW_GEN_CONTEXT_INTERVAL_MS || '600000', 10
  );
  setInterval(() => {
    if (dirtyProjects.size === 0) return;
    const projects = Array.from(dirtyProjects);
    dirtyProjects.clear();

    const helpersDir = path.dirname(fileURLToPath(import.meta.url));
    const genCtxPath = path.resolve(helpersDir, 'gen-context.mjs').replace(/\\/g, '/');

    for (const project of projects) {
      const projectPath = path.join(dir, project);
      try {
        if (!fs.existsSync(projectPath)) continue;
        const child = spawn(
          process.execPath,
          ['--no-warnings', '-e',
            `(async () => { const m = await import(${JSON.stringify('file://' + genCtxPath)}); await m.generateForProject(${JSON.stringify(projectPath)}); })().catch(() => process.exit(1));`,
          ],
          { detached: true, stdio: 'ignore' }
        );
        child.unref();
        log(`gen-context refresh queued for ${project}`);
      } catch (err) {
        log(`gen-context spawn error for ${project}: ${err.message}`);
      }
    }
  }, GEN_CONTEXT_INTERVAL_MS);

  log('Watcher running. Press Ctrl+C to stop.');

  // Graceful shutdown
  process.on('SIGINT',  () => shutdown(watcher, db));
  process.on('SIGTERM', () => shutdown(watcher, db));
}

function shutdown(watcher, db) {
  log('Shutting down...');
  // Hard-exit after 5s if cleanup hangs
  setTimeout(() => process.exit(1), 5000).unref();
  if (_session.id) {
    try {
      db.upsertSession({
        id:          _session.id,
        started_at:  new Date(_session.startedAt).toISOString(),
        ended_at:    new Date().toISOString(),
        duration_ms: Date.now() - _session.startedAt,
        platform:    'watcher',
        cwd:         process.cwd(),
      });
    } catch (_) {}
  }
  try { db.close(); } catch (_) {}
  try { watcher.close(); } catch (_) {}
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
  process.exit(0);
}

// ── daemon management ─────────────────────────────────────────────────────

function startDaemon(watchDir) {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });

  if (fs.existsSync(PID_FILE)) {
    const existing = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    let alive = false;
    try { process.kill(existing, 0); alive = true; } catch (_) {}
    if (alive) {
      console.log(`Daemon already running (PID ${existing}). Use --stop first.`);
      process.exit(0);
    }
    // Stale PID file — remove it and continue
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    console.log(`Removed stale PID file (PID ${existing} no longer running).`);
  }

  const self = fileURLToPath(import.meta.url);
  const args = watchDir ? [self, watchDir] : [self];

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio:    'ignore',
    env:      { ...process.env, VAULTFLOW_WATCHER_DAEMON: '1' },
  });

  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
  console.log(`Watcher daemon started (PID ${child.pid})`);
  console.log(`Watching: ${watchDir || process.cwd()}`);
  console.log(`Log: ${LOG_FILE}`);
}

function stopDaemon() {
  if (!fs.existsSync(PID_FILE)) {
    console.log('No daemon running.');
    return;
  }

  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  try {
    process.kill(pid, 'SIGTERM');
    fs.unlinkSync(PID_FILE);
    console.log(`Daemon stopped (PID ${pid})`);
  } catch (err) {
    console.error(`Failed to stop daemon: ${err.message}`);
    if (err?.code === 'ESRCH') {
      try { fs.unlinkSync(PID_FILE); } catch (_) {}
    }
  }
}

function daemonStatus() {
  if (!fs.existsSync(PID_FILE)) {
    console.log('Status: not running');
    return;
  }
  const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
  try {
    process.kill(parseInt(pid, 10), 0); // signal 0 = check if process exists
    console.log(`Status: running (PID ${pid})`);
    console.log(`Log: ${LOG_FILE}`);
  } catch (err) {
    if (err?.code === 'ESRCH') {
      console.log('Status: PID file exists but process is not running (stale)');
      try { fs.unlinkSync(PID_FILE); } catch (_) {}
      return;
    }
    console.log(`Status: unable to verify watcher process (PID ${pid})`);
    console.log(`Error: ${err.message}`);
  }
}

// ── entry point ───────────────────────────────────────────────────────────

const thisPath = fileURLToPath(import.meta.url);

if (process.argv[1] === thisPath) {
  const args = process.argv.slice(2);
  const cmd  = args[0];

  if (cmd === '--stop' || cmd === 'stop') {
    stopDaemon();
  } else if (cmd === '--status' || cmd === 'status') {
    daemonStatus();
  } else if (cmd === '--daemon' || cmd === 'daemon') {
    const watchDir = args[1] || undefined;
    startDaemon(watchDir);
  } else {
    // Foreground (or daemon child — VAULTFLOW_WATCHER_DAEMON set)
    const watchDir = cmd && !cmd.startsWith('--') ? cmd : undefined;
    startWatcher(watchDir);
  }
}
