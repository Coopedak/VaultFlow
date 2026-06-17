#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const COMMANDS = {
  tui:             ['tui', 'index.mjs'],
  'tui:dev':       ['tui', 'index.mjs'],
  audit:           ['.claude', 'helpers', 'audit.mjs'],
  lint:            ['.claude', 'helpers', 'lint.mjs'],
  backfill:        ['.claude', 'helpers', 'backfill.mjs'],
  'project-audit': ['.claude', 'helpers', 'project-audit.mjs'],
  flush:           ['.claude', 'helpers', 'flush-parquet.mjs'],
  watcher:         ['.claude', 'helpers', 'watcher.mjs'],
  dict:            ['.claude', 'helpers', 'dict.mjs'],
  'dict:import':   ['.claude', 'helpers', 'dict.mjs'],
  'import-chats':  ['.claude', 'helpers', 'import-claude-chats.mjs'],
  'gen-context':   ['.claude', 'helpers', 'gen-context.mjs'],
  'install-hooks': ['.claude', 'helpers', 'install-git-hooks.mjs'],
  'model-status':  ['.claude', 'helpers', 'model-router.cjs'],
  'mcp-server':    ['.claude', 'helpers', 'mcp-server.cjs'],
  dashboard:       ['.claude', 'helpers', 'dashboard', 'server.mjs'],
  'dashboard:open': ['.claude', 'helpers', 'dashboard', 'server.mjs'],
  'dashboard:serve': ['.claude', 'helpers', 'dashboard', 'server.mjs'],
  status:          ['.claude', 'helpers', 'watcher.mjs'],
};

function printHelp() {
  process.stdout.write(
    `vaultflow CLI\n\n` +
    `Usage:\n` +
    `  vault                     Launch the vaultflow TUI\n` +
    `  vault <command> [args]    Run a vaultflow command\n` +
    `  vaultflow [command]       Same as vault\n\n` +
    `Commands:\n` +
    `  tui               Launch the TUI (default)\n` +
    `  dashboard         Start the dashboard server (http://localhost:7700)\n` +
    `  dashboard:open    Start the dashboard server and open it in the browser\n` +
    `  dashboard:serve   Alias for dashboard\n` +
    `  backfill          Run the index backfill\n` +
    `  project-audit     Audit C:\\GIT projects using git + vaultflow history\n` +
    `  watcher           Start or control the watcher\n` +
    `  audit             Run the health audit\n` +
    `  lint              Run the lint checks\n` +
    `  dict              Run dictionary commands\n` +
    `  import-chats      Import Claude Desktop / claude.ai chat exports\n` +
    `  gen-context       Generate project context files\n` +
    `  install-hooks     Install git hooks into a project\n` +
    `  model-status      Show model routing status\n` +
    `  flush             Flush SQLite data to Parquet\n` +
    `  mcp-server        Start the MCP server\n` +
    `\nQuery (headless brain access):\n` +
    `  search <query>    Search memory/symbols/commits (add --json)\n` +
    `  find-skill <task> Find existing skills before authoring a new one (add --json)\n` +
    `  context [project] Show the context vaultflow would inject\n` +
    `  graph [--center]  Print the brain graph (add --json)\n` +
    `  mission           Mission Control ledger (add --json)\n` +
    `  flows <sub>       Flow catalog: discover|list [project] | declare <file> <symbol> | declared [project] (add --json)\n` +
    `  impact <target>   Change-impact report for a file or symbol (add --project, --json)\n` +
    `  doctor            Run the health audit\n`
  );
}

function runNodeScript(scriptPath, args = [], nodeArgs = []) {
  const child = spawn(process.execPath, [...nodeArgs, scriptPath, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: false,
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

const args = process.argv.slice(2);
const command = args[0] || 'tui';

if (command === '-h' || command === '--help' || command === 'help') {
  printHelp();
  process.exit(0);
}

let forwardedArgs = args.slice(1);
let scriptKey = command;
let nodeArgs = [];

if (command === 'tui:dev') {
  nodeArgs = ['--enable-source-maps'];
} else if (command === 'dashboard:open') {
  forwardedArgs = ['--open', ...forwardedArgs];
} else if (command === 'status') {
  forwardedArgs = ['--status', ...forwardedArgs];
}

const QUERY_COMMANDS = new Set(['search', 'find-skill', 'context', 'graph', 'mission', 'doctor', 'flows', 'impact']);

if (QUERY_COMMANDS.has(command)) {
  // Pass the full args (incl. subcommand) so cli-query.mjs sees argv[0]=subcommand.
  runNodeScript(path.join(ROOT, 'scripts', 'cli-query.mjs'), args, nodeArgs);
} else if (scriptKey === 'dict:import') {
  runNodeScript(path.join(ROOT, '.claude', 'helpers', 'dict.mjs'), ['--import', ...forwardedArgs], nodeArgs);
} else {
  const segments = COMMANDS[scriptKey];
  if (!segments) {
    process.stderr.write(`Unknown command: ${command}\n\n`);
    printHelp();
    process.exit(1);
  }

  const scriptPath = path.join(ROOT, ...segments);
  runNodeScript(scriptPath, forwardedArgs, nodeArgs);
}
