/**
 * cli-telemetry-backfill.mjs — one-shot Copilot/Codex session metadata backfill
 *
 * WHY: Historical Copilot and Codex session logs already exist on disk, but the
 * watcher only mirrors live events going forward. This helper scans those local
 * logs and upserts session-level metadata into SQLite so older sessions show the
 * correct CLI, CLI version, model, provider, cwd, project, and closed/open state.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const configPath = require('../../config/resolve.cjs');
const db = require('./db.cjs');

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

function loadConfig() {
  return yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function projectFromCwd(cwd) {
  return cwd ? path.basename(cwd) || 'unknown' : 'unknown';
}

function inferCodexModel(payload) {
  if (payload?.model) return payload.model;
  const text = payload?.base_instructions?.text || '';
  const match = text.match(/based on ([A-Za-z0-9.\-]+)/i);
  return match ? match[1].replace(/[.]+$/g, '') : null;
}

function computeEndedAt(lastTimestamp, lastType, mtimeMs) {
  if (!lastTimestamp) return null;
  if (lastType === 'session.shutdown' || lastType === 'task_complete') return lastTimestamp;
  return (Date.now() - mtimeMs) > SESSION_TIMEOUT_MS ? lastTimestamp : null;
}

function* walkJsonlFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return;
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && full.endsWith('.jsonl')) yield full;
    }
  }
}

function backfillCopilotSession(filePath) {
  const events = readJsonl(filePath);
  if (events.length === 0) return null;

  const start = events.find(evt => evt.type === 'session.start');
  if (!start?.data?.sessionId) return null;

  const modelChange = [...events].reverse().find(evt => evt.type === 'session.model_change' && evt?.data?.newModel);
  const shutdown = [...events].reverse().find(evt => evt.type === 'session.shutdown');
  const lastEvent = events[events.length - 1];
  const stat = fs.statSync(filePath);

  const startedAt = start.data.startTime || start.timestamp;
  const endedAt = shutdown?.timestamp || computeEndedAt(lastEvent?.timestamp || null, lastEvent?.type || null, stat.mtimeMs);
  const cwd = start.data.context?.cwd || null;

  return {
    id: start.data.sessionId,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: startedAt && endedAt ? (new Date(endedAt).getTime() - new Date(startedAt).getTime()) : null,
    platform: 'copilot',
    cli: 'copilot',
    cli_version: start.data.copilotVersion || null,
    model: modelChange?.data?.newModel || shutdown?.data?.currentModel || null,
    model_provider: null,
    cwd,
    project: projectFromCwd(cwd),
  };
}

function backfillCodexSession(filePath) {
  const events = readJsonl(filePath);
  if (events.length === 0) return null;

  const meta = events.find(evt => evt.type === 'session_meta' && evt?.payload?.id);
  if (!meta?.payload?.id) return null;

  const taskComplete = [...events].reverse().find(evt => evt.type === 'event_msg' && evt?.payload?.type === 'task_complete');
  const lastEvent = events[events.length - 1];
  const stat = fs.statSync(filePath);
  const payload = meta.payload;
  const startedAt = payload.timestamp || meta.timestamp;
  const endedAt = taskComplete?.timestamp || computeEndedAt(lastEvent?.timestamp || null, taskComplete ? 'task_complete' : lastEvent?.type || null, stat.mtimeMs);
  const cwd = payload.cwd || null;

  return {
    id: payload.id,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: startedAt && endedAt ? (new Date(endedAt).getTime() - new Date(startedAt).getTime()) : null,
    platform: 'codex',
    cli: 'codex',
    cli_version: payload.cli_version || null,
    model: inferCodexModel(payload),
    model_provider: payload.model_provider || null,
    cwd,
    project: projectFromCwd(cwd),
  };
}

export function runCliTelemetryBackfill({ dryRun = false } = {}) {
  const cfg = loadConfig();
  db.initialize(cfg?.paths?.metrics_root, cfg?.storage?.db_file || 'vaultflow.db');

  const copilotRoot = path.join(os.homedir(), '.copilot', 'session-state');
  const codexRoot = path.join(os.homedir(), '.codex', 'sessions');

  let copilotCount = 0;
  let codexCount = 0;

  if (fs.existsSync(copilotRoot)) {
    for (const entry of fs.readdirSync(copilotRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(copilotRoot, entry.name, 'events.jsonl');
      if (!fs.existsSync(filePath)) continue;
      const session = backfillCopilotSession(filePath);
      if (!session) continue;
      copilotCount += 1;
      if (!dryRun) db.upsertSession(session);
    }
  }

  if (fs.existsSync(codexRoot)) {
    for (const filePath of walkJsonlFiles(codexRoot)) {
      const session = backfillCodexSession(filePath);
      if (!session) continue;
      codexCount += 1;
      if (!dryRun) db.upsertSession(session);
    }
  }

  return { dryRun, copilotCount, codexCount, total: copilotCount + codexCount };
}

if (import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const dryRun = process.argv.includes('--dry-run');
  const result = runCliTelemetryBackfill({ dryRun });
  console.log(JSON.stringify(result, null, 2));
}
