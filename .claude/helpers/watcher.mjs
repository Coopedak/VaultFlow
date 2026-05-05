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

  // Close previous session if any
  if (_session.id) {
    try {
      db.upsertSession({
        id:          _session.id,
        started_at:  new Date(_session.startedAt).toISOString(),
        ended_at:    new Date().toISOString(),
        duration_ms: now - _session.startedAt,
        platform:    'watcher',
        cwd:         process.cwd(),
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
      cwd:        process.cwd(),
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

function deriveProject(filePath) {
  // Walk up looking for a GIT or Projects segment
  const parts = filePath.replace(/\\/g, '/').split('/');
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] === 'GIT' || parts[i] === 'Projects') {
      return parts[i + 1] || 'unknown';
    }
  }
  return path.basename(path.dirname(filePath)) || 'unknown';
}

// ── shell history tracking (Option A + B) ────────────────────────────────

const PSREADLINE_HISTORY = path.join(
  process.env.APPDATA || os.homedir(),
  'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt'
);
const SHELL_JSONL = path.join(METRICS, 'shell-commands.jsonl');

let _historyPos = -1; // -1 = not yet initialized
let _jsonlPos   = -1;

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

  const handleChange = (filePath, changeType) => {
    if (shouldIgnore(filePath)) return;

    try {
      const sessionId = ensureSession(db);
      const project   = deriveProject(filePath);
      db.recordEdit(sessionId, filePath, project, changeType);
      log(`${changeType}: ${filePath} [${project}]`);
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
  log(`Shell history tail: pos ${_historyPos}`);
  log(`Shell JSONL tail:   pos ${_jsonlPos} (persisted)`);
  setInterval(() => {
    pollShellHistory(db);
    pollShellJsonl(db);
  }, 3000);

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
    // Clean up stale PID file
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
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
  } catch (_) {
    console.log('Status: PID file exists but process is not running (stale)');
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
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
