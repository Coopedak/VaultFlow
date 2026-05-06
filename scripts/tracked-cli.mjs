#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const TOOL_BINARIES = {
  claude: process.platform === 'win32' ? 'claude.cmd' : 'claude',
  copilot: process.platform === 'win32' ? 'copilot.cmd' : 'copilot',
  codex: process.platform === 'win32' ? 'codex.cmd' : 'codex',
};

function buildSpawnSpec(tool, args) {
  const command = TOOL_BINARIES[tool];
  if (process.platform === 'win32') {
    return {
      file: 'cmd.exe',
      args: ['/d', '/c', command, ...args],
    };
  }

  return {
    file: command,
    args,
  };
}

function usage() {
  process.stdout.write(
    'Usage: node scripts/tracked-cli.mjs <claude|copilot|codex> [--cwd <dir>] [args...]\n'
  );
}

function loadDb() {
  const configPath = require('../config/resolve.cjs');
  const yaml = require('js-yaml');
  const config = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
  const metricsRoot = config?.paths?.metrics_root;
  const dbFile = config?.storage?.db_file || 'vaultflow.db';
  if (!metricsRoot) {
    throw new Error('vaultflow metrics_root is not configured.');
  }

  const db = require('../.claude/helpers/db.cjs');
  db.initialize(metricsRoot, dbFile);
  return db;
}

function resolveArgs(rawArgs) {
  let cwd = process.cwd();
  const passthrough = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--cwd') {
      cwd = rawArgs[i + 1] ? path.resolve(rawArgs[i + 1]) : cwd;
      i++;
      continue;
    }
    passthrough.push(arg);
  }

  return { cwd, passthrough };
}

async function main() {
  const [tool, ...rawArgs] = process.argv.slice(2);
  if (!tool || !(tool in TOOL_BINARIES)) {
    usage();
    process.exit(1);
  }

  const { cwd, passthrough } = resolveArgs(rawArgs);
  const sessionId = randomUUID();
  const startedAt = new Date();
  const project = path.basename(cwd) || 'unknown';
  const db = loadDb();

  db.upsertSession({
    id: sessionId,
    started_at: startedAt.toISOString(),
    platform: `tracked:${tool}`,
    cli: tool,
    cwd,
    edits: 0,
    commands: passthrough.length > 0 ? 1 : 0,
    tasks: 0,
    errors: 0,
    project,
  });

  db.recordToolCall(sessionId, 'TrackedCliLaunch', JSON.stringify({
    tool,
    cwd,
    args: passthrough,
  }));

  if (passthrough.length > 0) {
    db.recordPrompt(sessionId, passthrough.join(' '), `tracked:${tool}`);
  }

  const spec = buildSpawnSpec(tool, passthrough);
  const child = spawn(spec.file, spec.args, {
    cwd,
    stdio: 'inherit',
    windowsHide: false,
  });

  let finalized = false;
  const finalize = (exitCode, signal = null) => {
    if (finalized) return;
    finalized = true;

    const endedAt = new Date();
    const errors = exitCode && exitCode !== 0 ? 1 : 0;
    db.recordToolCall(sessionId, 'TrackedCliExit', JSON.stringify({
      tool,
      exitCode,
      signal,
    }));
    db.upsertSession({
      id: sessionId,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_ms: Math.max(0, endedAt.getTime() - startedAt.getTime()),
      platform: `tracked:${tool}`,
      cli: tool,
      cwd,
      edits: 0,
      commands: passthrough.length > 0 ? 1 : 0,
      tasks: 0,
      errors,
      project,
    });
  };

  child.on('error', (err) => {
    db.recordToolCall(sessionId, 'TrackedCliError', JSON.stringify({
      tool,
      message: err.message,
    }));
    finalize(1);
    process.stderr.write(`[vaultflow tracked-cli] Failed to start ${tool}: ${err.message}\n`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    finalize(code ?? 0, signal ?? null);
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  process.on('SIGINT', () => {
    try { child.kill('SIGINT'); } catch {}
  });

  process.on('SIGTERM', () => {
    try { child.kill('SIGTERM'); } catch {}
  });
}

main().catch((err) => {
  process.stderr.write(`[vaultflow tracked-cli] ${err.message}\n`);
  process.exit(1);
});
