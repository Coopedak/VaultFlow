#!/usr/bin/env node
/**
 * Embed the Dev Team in another process via the Claude Agent SDK.
 *
 * Unlike scripts/run-team.* (which shell out to `claude -p` and need the plugin INSTALLED),
 * this loads the plugin BY PATH — so a host app can drive the team without a global install.
 *
 * Setup:
 *   npm install @anthropic-ai/claude-agent-sdk
 *   export ANTHROPIC_API_KEY=...                 # or use your Claude Code auth
 *
 * Run:
 *   node examples/run-team.mjs --project /path/to/repo "add a search box to the customer list"
 *   node examples/run-team.mjs --json --yolo --project /path/to/repo "implement issue #42"
 *
 * This is a starting point — adapt the option set and message handling to your app.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// examples/ -> plugin root (the folder containing .claude-plugin/plugin.json)
const pluginPath = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// --- tiny arg parse ---
const argv = process.argv.slice(2);
let project = process.cwd();
let json = false;
let yolo = false;
const taskParts = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--project') project = argv[++i];
  else if (a === '--json') json = true;
  else if (a === '--yolo') yolo = true;
  else taskParts.push(a);
}
const task = taskParts.join(' ').trim();
if (!task) {
  console.error('Usage: node run-team.mjs [--project <dir>] [--json] [--yolo] "<task>"');
  process.exit(1);
}

const results = [];

for await (const message of query({
  prompt: `Use the dev team to: ${task}`,
  options: {
    cwd: project,
    // Load this plugin directly — no `claude plugin install` required for the host.
    plugins: [{ type: 'local', path: pluginPath }],
    // acceptEdits auto-approves file writes; --yolo bypasses all permission checks (sandbox/CI only).
    permissionMode: yolo ? 'bypassPermissions' : 'acceptEdits',
    // The PM needs Task to dispatch the worker subagents; the workers need read/write/build tools.
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task', 'TodoWrite', 'WebSearch', 'WebFetch'],
  },
})) {
  // The SDK streams typed messages; the final one carries `result`.
  if (message && typeof message === 'object' && 'result' in message) {
    results.push(message.result);
  }
}

const out = results.join('\n');
if (json) {
  process.stdout.write(JSON.stringify({ project, task, result: out }, null, 2) + '\n');
} else {
  process.stdout.write(out + '\n');
}
