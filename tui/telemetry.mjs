import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let db = null;
let initialized = false;

function loadDb() {
  if (db || initialized) return db;
  initialized = true;

  try {
    const configPath = require('../config/resolve.cjs');
    const yaml = require('js-yaml');
    const config = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
    const metricsRoot = config?.paths?.metrics_root;
    const dbFile = config?.storage?.db_file || 'vaultflow.db';
    if (!metricsRoot) return null;

    db = require('../.claude/helpers/db.cjs');
    db.initialize(metricsRoot, dbFile);
  } catch {
    db = null;
  }

  return db;
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value || Date.now()).toISOString();
}

function safeRecordToolCall(sessionId, toolName, payload) {
  const store = loadDb();
  if (!store) return;
  try {
    store.recordToolCall(sessionId, toolName, JSON.stringify(payload || {}));
  } catch {
  }
}

export function recordSessionStart(session, { initialPrompt = '' } = {}) {
  const store = loadDb();
  if (!store || !session) return;

  const commands = initialPrompt ? 1 : 0;
  try {
    store.upsertSession({
      id: session.id,
      started_at: iso(session.startedAt),
      platform: `tui:${session.tool}`,
      cli: session.tool,
      cwd: session.cwd,
      edits: session.edits || 0,
      commands,
      tasks: session.tasks || 0,
      errors: session.errors || 0,
      project: session.project,
    });
    safeRecordToolCall(session.id, 'TuiLaunch', {
      tool: session.tool,
      cwd: session.cwd,
      project: session.project,
      launchName: session.launchName || null,
      initialPrompt: Boolean(initialPrompt),
    });
    if (initialPrompt) {
      store.recordPrompt(session.id, initialPrompt, { source: `tui:${session.tool}` });
    }
  } catch {
  }
}

export function recordSessionAction(session, action, payload = {}) {
  if (!session) return;
  safeRecordToolCall(session.id, action, {
    tool: session.tool,
    cwd: session.cwd,
    project: session.project,
    ...payload,
  });
}

export function recordSessionEnd(session, { status = 'idle', errors = null } = {}) {
  const store = loadDb();
  if (!store || !session) return;

  const startedAt = session.startedAt instanceof Date ? session.startedAt : new Date(session.startedAt || Date.now());
  const endedAt = new Date();
  const errorCount = errors != null ? errors : (status === 'crashed' ? 1 : (session.errors || 0));

  try {
    store.upsertSession({
      id: session.id,
      started_at: iso(startedAt),
      ended_at: iso(endedAt),
      duration_ms: Math.max(0, endedAt.getTime() - startedAt.getTime()),
      platform: `tui:${session.tool}`,
      cli: session.tool,
      cwd: session.cwd,
      edits: session.edits || 0,
      commands: session.commands || 0,
      tasks: session.tasks || 0,
      errors: errorCount,
      project: session.project,
    });
  } catch {
  }
}
