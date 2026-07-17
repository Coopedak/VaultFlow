#!/usr/bin/env node
/**
 * Dev Team analytics logger.
 *
 * Invoked by the plugin's hooks (SessionStart, PostToolUse[Task], Stop). Reads the hook payload
 * from stdin, derives an event, and appends one JSON line to <dataDir>/events.jsonl.
 *
 * Hard rule: this script must NEVER break a session. It swallows every error and always exits 0
 * with no stdout, so a logging failure can never block tool use or stop the agent.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Roles that belong to the dev-team plugin. A Task dispatch to one of these is "team" activity.
const TEAM_ROLES = new Set([
  'project-manager',
  'researcher',
  'code-developer',
  'code-reviewer',
  'documenter',
  'integrator',
  'voice-of-reason',
]);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}

function resolveDataDir() {
  // ${CLAUDE_PLUGIN_DATA} is passed in; fall back to the env var, then a stable home location.
  const fromArg = arg('--data');
  const fromEnv = process.env.CLAUDE_PLUGIN_DATA || '';
  const chosen = (fromArg && fromArg !== '${CLAUDE_PLUGIN_DATA}') ? fromArg
    : (fromEnv || join(homedir(), '.claude', 'dev-team-analytics'));
  return chosen;
}

async function readStdinAsync() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let raw = '';
  try {
    raw = await readStdinAsync();
  } catch {
    raw = '';
  }

  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }

  const event = String(payload.hook_event_name || '');
  const session = payload.session_id || '';
  const project = arg('--project') || payload.cwd || '';
  const ts = new Date().toISOString();

  let record = null;

  if (event === 'PostToolUse' && payload.tool_name === 'Task') {
    const input = payload.tool_input || {};
    const role = input.subagent_type || 'unknown';
    record = {
      ts,
      event: 'dispatch',
      role,
      team: TEAM_ROLES.has(role),
      label: String(input.description || '').slice(0, 120),
      session,
      project,
    };
  } else if (event === 'SessionStart') {
    record = { ts, event: 'session_start', session, project };
  } else if (event === 'Stop') {
    record = { ts, event: 'session_end', session, project };
  }

  if (!record) return; // event we don't track

  const dataDir = resolveDataDir();
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(join(dataDir, 'events.jsonl'), JSON.stringify(record) + '\n', 'utf8');
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
