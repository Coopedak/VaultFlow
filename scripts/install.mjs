#!/usr/bin/env node
/**
 * install.mjs — one-shot vaultflow installer / setup.
 *
 * WHY: vaultflow is a Claude Code hook system. To actually "run" on a machine it
 * needs four things wired up, and each was previously a separate manual step:
 *
 *   1. GLOBAL HOOKS  — the hook commands must live in the *user* settings
 *      (~/.claude/settings.json), not just the vaultflow project settings.
 *      If they only live in the project, vaultflow intercepts events ONLY while
 *      you work inside the vaultflow repo and is silent in every other project.
 *   2. CLI ON PATH   — `npm link` so `vaultflow …` / `vault …` work everywhere.
 *   3. NIGHTLY TASK  — a Scheduled Task so maintenance (session summary, embed
 *      queue drain, orphan purge, parquet flush) actually runs. Without it the
 *      embed queue starves and the heartbeat goes stale.
 *   4. WATCHER       — the chokidar daemon that catches edits from tools that
 *      don't fire Claude Code hooks.
 *
 * This script does all four, idempotently, and finishes by running the doctor.
 *
 * The canonical hook set is defined HERE (see CANONICAL_HOOKS), not read from
 * the project's .claude/settings.json — the project file is intentionally
 * minimal, whereas the full lifecycle wiring belongs in the user-global settings
 * so it fires in every project. Edit CANONICAL_HOOKS to change what gets wired.
 *
 * Usage:
 *   node scripts/install.mjs                 # full install
 *   node scripts/install.mjs --dry-run       # show what would change, write nothing
 *   node scripts/install.mjs --hooks-only     # only install global hooks
 *   node scripts/install.mjs --no-nightly     # skip Scheduled Task registration
 *   node scripts/install.mjs --no-link        # skip `npm link`
 *   node scripts/install.mjs --no-watcher     # skip starting the watcher
 *   node scripts/install.mjs --uninstall      # remove global hooks + nightly task
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ROOT_POSIX = ROOT.split(path.sep).join('/');
const H = `${ROOT_POSIX}/.claude/helpers`;

// Canonical vaultflow hook wiring, parameterized by this repo's location.
// Every command is an absolute path so it works from any project's cwd.
const CANONICAL_HOOKS = {
  PreToolUse: [
    { matcher: 'Bash',              hooks: [{ type: 'command', command: `node ${H}/hook-handler.cjs pre-bash` }] },
    { matcher: 'Read',              hooks: [{ type: 'command', command: `node ${H}/pre-read.cjs` }] },
    { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: `node ${H}/pre-edit.cjs` }] },
    { matcher: 'Grep|Glob',         hooks: [{ type: 'command', command: `node ${H}/pre-search.cjs` }] },
    { matcher: 'Skill',             hooks: [{ type: 'command', command: `node ${H}/hook-handler.cjs pre-skill` }] },
  ],
  PostToolUse: [
    { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: `node ${H}/post-edit.cjs` }] },
  ],
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${H}/hook-handler.cjs route` }] }],
  SessionStart:     [{ hooks: [{ type: 'command', command: `node ${H}/hook-handler.cjs session-start` }] }],
  SessionEnd:       [{ hooks: [{ type: 'command', command: `node ${H}/hook-handler.cjs session-end` }] }],
  Stop:             [{ hooks: [{ type: 'command', command: `node ${H}/hook-handler.cjs post-task` }] }],
  PreCompact:       [{ hooks: [{ type: 'command', command: `node ${H}/hook-handler.cjs compact-manual` }] }],
  SubagentStop:     [{ hooks: [{ type: 'command', command: `node ${H}/hook-handler.cjs post-subagent` }] }],
};

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const DRY = has('--dry-run');
const UNINSTALL = has('--uninstall');
const HOOKS_ONLY = has('--hooks-only');
const NO_NIGHTLY = has('--no-nightly');
const NO_LINK = has('--no-link');
const NO_WATCHER = has('--no-watcher');

const USER_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const BACKUP_DIR = path.join(os.homedir(), '.claude', 'backups');

const c = {
  ok:   (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err:  (s) => `\x1b[31m${s}\x1b[0m`,
  dim:  (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const results = [];
const record = (step, status, detail) => {
  results.push({ step, status, detail });
  const tag = status === 'ok' ? c.ok('OK  ') : status === 'warn' ? c.warn('WARN') : status === 'skip' ? c.dim('SKIP') : c.err('FAIL');
  console.log(`  [${tag}]  ${step.padEnd(22)} ${detail || ''}`);
};

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function backupUserSettings() {
  if (!fs.existsSync(USER_SETTINGS)) return null;
  if (DRY) return '(dry-run: no backup written)';
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, `settings.json.${stamp}.bak`);
  fs.copyFileSync(USER_SETTINGS, dest);
  return dest;
}

// ── Step 1: global hooks ──────────────────────────────────────────────────
function installGlobalHooks() {
  const user = readJson(USER_SETTINGS) || {};

  if (UNINSTALL) {
    if (!user.hooks) { record('global-hooks', 'skip', 'no global hooks to remove'); return; }
    const backup = backupUserSettings();
    delete user.hooks;
    if (!DRY) {
      fs.mkdirSync(path.dirname(USER_SETTINGS), { recursive: true });
      fs.writeFileSync(USER_SETTINGS, JSON.stringify(user, null, 2) + '\n');
    }
    record('global-hooks', 'ok', `removed${backup ? ` (backup: ${path.basename(backup)})` : ''}`);
    return;
  }

  const already = JSON.stringify(user.hooks || null) === JSON.stringify(CANONICAL_HOOKS);
  if (already) { record('global-hooks', 'ok', 'already up to date'); return; }

  const backup = backupUserSettings();
  user.hooks = CANONICAL_HOOKS;
  if (!DRY) {
    fs.mkdirSync(path.dirname(USER_SETTINGS), { recursive: true });
    fs.writeFileSync(USER_SETTINGS, JSON.stringify(user, null, 2) + '\n');
  }
  const events = Object.keys(CANONICAL_HOOKS).length;
  record('global-hooks', 'ok', `${events} events → ~/.claude/settings.json${backup ? ` (backup: ${path.basename(backup)})` : ''}${DRY ? ' [dry-run]' : ''}`);
}

// ── Step 2: npm link (CLI on PATH) ─────────────────────────────────────────
function linkCli() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const winShell = process.platform === 'win32';
  if (UNINSTALL) {
    if (DRY) { record('cli-link', 'skip', 'dry-run'); return; }
    const r = spawnSync(npm, ['unlink', '-g', 'vaultflow'], { cwd: ROOT, stdio: 'ignore', shell: winShell });
    record('cli-link', r.status === 0 ? 'ok' : 'warn', r.status === 0 ? 'unlinked' : 'not linked');
    return;
  }
  const probe = spawnSync(winShell ? 'where' : 'which', ['vaultflow'], { stdio: 'ignore', shell: winShell });
  if (probe.status === 0) { record('cli-link', 'ok', 'vaultflow already on PATH'); return; }
  if (DRY) { record('cli-link', 'skip', 'would run `npm link` [dry-run]'); return; }
  const r = spawnSync(npm, ['link'], { cwd: ROOT, stdio: 'pipe', shell: winShell, encoding: 'utf8' });
  if (r.status === 0) record('cli-link', 'ok', '`npm link` → vaultflow / vault on PATH');
  else record('cli-link', 'warn', `npm link failed — run manually in ${ROOT}. ${(r.stderr || '').trim().split('\n').pop() || ''}`);
}

// ── Step 3: nightly Scheduled Task ─────────────────────────────────────────
function installNightly() {
  const ps1 = path.join(ROOT, '.claude', 'helpers', 'install-nightly-task.ps1');
  if (!fs.existsSync(ps1)) { record('nightly-task', 'warn', 'install-nightly-task.ps1 not found'); return; }
  const extra = UNINSTALL ? ['-Uninstall'] : ['-RunNow'];
  if (DRY) { record('nightly-task', 'skip', `would run install-nightly-task.ps1 ${extra.join(' ')} [dry-run]`); return; }
  const shells = ['pwsh', 'powershell'];
  let r = { status: 1 };
  for (const sh of shells) {
    r = spawnSync(sh, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...extra],
      { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    if (!r.error) break;
  }
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status === 0) record('nightly-task', 'ok', UNINSTALL ? 'unregistered' : 'registered (VaultflowNightly, daily @ 03:00) + ran once');
  else record('nightly-task', 'warn', `PowerShell step failed — ${out.trim().split('\n').pop() || 'see log'}`);
}

// ── Step 4: watcher daemon ─────────────────────────────────────────────────
function ensureWatcher() {
  const watcher = path.join(ROOT, '.claude', 'helpers', 'watcher.mjs');
  const status = spawnSync(process.execPath, [watcher, '--status'], { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
  const running = /running/i.test(status.stdout || '');
  if (UNINSTALL) {
    if (DRY) { record('watcher', 'skip', 'dry-run'); return; }
    spawnSync(process.execPath, [watcher, '--stop'], { cwd: ROOT, stdio: 'ignore' });
    record('watcher', 'ok', 'stopped');
    return;
  }
  if (running) { record('watcher', 'ok', (status.stdout || '').trim().split('\n')[0]); return; }
  if (DRY) { record('watcher', 'skip', 'would start watcher [dry-run]'); return; }
  const r = spawnSync(process.execPath, [watcher, '--start'], { cwd: ROOT, stdio: 'ignore' });
  record('watcher', r.status === 0 ? 'ok' : 'warn', r.status === 0 ? 'started' : 'could not start — run `npm run watcher`');
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log(c.bold(`\nvaultflow ${UNINSTALL ? 'uninstall' : 'install'}${DRY ? ' (dry-run)' : ''}`));
console.log(c.dim(`  repo: ${ROOT}`));
console.log(c.dim(`  user settings: ${USER_SETTINGS}\n`));

installGlobalHooks();
if (!HOOKS_ONLY) {
  if (!NO_LINK) linkCli(); else record('cli-link', 'skip', '--no-link');
  if (!NO_NIGHTLY) installNightly(); else record('nightly-task', 'skip', '--no-nightly');
  if (!NO_WATCHER) ensureWatcher(); else record('watcher', 'skip', '--no-watcher');
}

if (!UNINSTALL && !DRY && !HOOKS_ONLY) {
  const doctor = path.join(ROOT, '.claude', 'helpers', 'doctor.mjs');
  if (fs.existsSync(doctor)) {
    console.log(c.dim('\n  running doctor …\n'));
    spawnSync(process.execPath, [doctor], { cwd: ROOT, stdio: 'inherit' });
  }
}

const failed = results.filter((r) => r.status === 'fail').length;
const warned = results.filter((r) => r.status === 'warn').length;
console.log(
  `\n${failed ? c.err(`${failed} failed`) : c.ok('done')}` +
  `${warned ? c.warn(`, ${warned} warning(s)`) : ''}` +
  (DRY ? c.dim(' — dry-run, nothing written') : '') + '\n',
);
if (!UNINSTALL && !DRY) {
  console.log(c.dim('  Global hooks now fire in every Claude Code project on this machine.'));
  console.log(c.dim('  Open a new shell to pick up the `vaultflow` command.\n'));
}
process.exit(failed ? 1 : 0);
