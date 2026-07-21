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
 *   3. MCP SERVER    — registered in ~/.claude.json (user scope). The repo's
 *      .mcp.json is project scope, so without this the vaultflow MCP tools
 *      (find_symbol, blast_radius, search_memory …) exist only inside this repo.
 *   4. SKILLS        — the curated .agents/skills set copied into
 *      ~/.claude/skills so the CLI can use them from any project.
 *   5. NIGHTLY TASK  — a Scheduled Task so maintenance (session summary, embed
 *      queue drain, orphan purge, parquet flush) actually runs. Without it the
 *      embed queue starves and the heartbeat goes stale.
 *   6. WATCHER       — the chokidar daemon that catches edits from tools that
 *      don't fire Claude Code hooks.
 *
 * This script does all four, idempotently, and finishes by running the doctor.
 * Before any wiring it also makes the machine fresh-start-ready: verifies
 * prerequisites (Node 22+, deps installed), generates config/vaultflow.local.yaml
 * from the example with this machine's real paths (never overwrites), and
 * scaffolds the vault/skills skeleton files the config points at.
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
 *   node scripts/install.mjs --no-mcp         # skip user-scope MCP registration
 *   node scripts/install.mjs --no-skills      # skip copying curated skills
 *   node scripts/install.mjs --no-watcher     # skip starting the watcher
 *   node scripts/install.mjs --no-dev-team    # skip installing the dev-team plugin
 *   node scripts/install.mjs --dev-team-only  # install ONLY the dev-team plugin
 *   node scripts/install.mjs --uninstall      # remove global hooks + nightly task + dev-team
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ROOT_POSIX = ROOT.split(path.sep).join('/');
const H = `${ROOT_POSIX}/.claude/helpers`;
const require = createRequire(import.meta.url);

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
const NO_DEVTEAM = has('--no-dev-team');
const DEVTEAM_ONLY = has('--dev-team-only');
const NO_MCP = has('--no-mcp');
const NO_SKILLS = has('--no-skills');

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

// ── Step 0a: prerequisites ─────────────────────────────────────────────────
// Node version is a hard gate (can't be fixed from inside a running node —
// scripts/install.ps1 handles installing Node itself on a fresh machine).
// Missing npm dependencies are INSTALLED here, not just reported: npm is
// guaranteed present alongside node, and --ignore-scripts avoids node-gyp.
function checkPrereqs() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    record('prereqs', 'fail', `Node ${process.versions.node} — vaultflow needs Node 22+ (node:sqlite). Run scripts/install.ps1 to upgrade.`);
    return false;
  }
  const nm = path.join(ROOT, 'node_modules');
  const probes = ['express', 'js-yaml', '@duckdb/node-api', 'chokidar'];
  const missing = probes.filter((p) => !fs.existsSync(path.join(nm, p)));
  if (missing.length) {
    if (DRY) { record('prereqs', 'skip', `would run \`npm install --ignore-scripts\` (missing: ${missing.join(', ')}) [dry-run]`); return true; }
    console.log(c.dim(`  installing npm dependencies (missing: ${missing.join(', ')}) …`));
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const r = spawnSync(npm, ['install', '--ignore-scripts'], {
      cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32',
    });
    if (r.status !== 0) {
      record('prereqs', 'fail', '`npm install --ignore-scripts` failed — fix the npm error above and re-run');
      return false;
    }
    const still = probes.filter((p) => !fs.existsSync(path.join(nm, p)));
    if (still.length) { record('prereqs', 'fail', `still missing after install: ${still.join(', ')}`); return false; }
    record('prereqs', 'ok', `node ${process.versions.node}, dependencies installed`);
    return true;
  }
  record('prereqs', 'ok', `node ${process.versions.node}, dependencies present`);
  return true;
}

// ── Step 0b: config bootstrap ──────────────────────────────────────────────
// A fresh clone has no config/vaultflow.local.yaml, so everything silently
// runs off vaultflow.example.yaml's "C:/Users/YOU" placeholders — the exact
// dead-path failure the doctor's config_paths check exists to catch. Generate
// a real local config from the example with this machine's paths. Never
// overwrites an existing config.
function bootstrapConfig() {
  const cfgDir  = path.join(ROOT, 'config');
  const localA  = path.join(cfgDir, 'vaultflow.local.yaml');
  const localB  = path.join(cfgDir, 'vaultflow.yaml');
  const example = path.join(cfgDir, 'vaultflow.example.yaml');

  if (fs.existsSync(localA) || fs.existsSync(localB)) {
    record('config', 'ok', `already present (${fs.existsSync(localA) ? 'vaultflow.local.yaml' : 'vaultflow.yaml'})`);
    return;
  }
  if (!fs.existsSync(example)) { record('config', 'warn', 'vaultflow.example.yaml missing — cannot bootstrap'); return; }

  const home    = os.homedir().split(path.sep).join('/');
  const gitRoot = path.dirname(ROOT).split(path.sep).join('/');
  let text = fs.readFileSync(example, 'utf8');

  // Order matters: replace the repo-specific placeholder before the generic
  // git-root one, and pin metrics_root next to the repo (self-contained
  // install; the example's vault-relative location assumes a vault exists).
  text = text
    .replace(/metrics_root:\s*"[^"]*"/, `metrics_root: "${ROOT_POSIX}/.metrics"`)
    .replace(/C:\/GIT\/vaultflow/g, ROOT_POSIX)
    .replace(/C:\/GIT/g, gitRoot)
    .replace(/C:\/Users\/YOU/g, home)
    .replace(
      '# Copy this file to config/vaultflow.local.yaml and fill in your paths.',
      `# Generated by scripts/install.mjs on ${new Date().toISOString().slice(0, 10)} — adjust paths as needed.`,
    );

  if (DRY) { record('config', 'skip', 'would generate config/vaultflow.local.yaml [dry-run]'); return; }
  fs.writeFileSync(localA, text);
  record('config', 'ok', `generated vaultflow.local.yaml (home: ${home}, projects: ${gitRoot})`);
}

// ── Step 0c: vault + skills skeleton ───────────────────────────────────────
// Create the minimal files the config points at so every pipeline (dictionary
// import, tool/agent registries, skill router) starts functional instead of
// silently dead. Only creates what's missing — never touches existing content.
function scaffoldSkeleton() {
  let cfg = {};
  try {
    const yaml = require('js-yaml');
    const cfgPath = require('../config/resolve.cjs');
    cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
  } catch (e) { record('skeleton', 'warn', `cannot read config — ${e.message}`); return; }

  const p = cfg.paths || {};
  const stubs = [
    [p.metrics_root, null],      // directories only —
    [p.projects_memory, null],   // Claude Code creates this lazily; empty is fine
    [p.claude_export_dir, null], // watched drop-folder for claude.ai chat exports
    [p.vault_root && path.join(p.vault_root, 'index.md'),
      '# Vault\n\nKnowledge vault consumed by vaultflow. Subdirs: tools/, agents/, domain/, methodology/.\n'],
    [p.vault_tools_index,
      '# Reusable Tools (Flat Structure)\n\nRegistry of reusable tools — one `### tool-name` section per tool.\n'],
    [p.vault_agents_index,
      '# Agent Registry\n\nRegistry of reusable agents — one `### agent-name` section per agent.\n'],
    [p.vault_domain_dir && path.join(p.vault_domain_dir, 'README.md'),
      '# Domain Knowledge\n\nMarkdown dropped here is auto-imported into the vaultflow dictionary nightly.\n'],
    [p.ai_workflow,
      '# AI Workflow\n\nModel tier routing guidance for model-router.cjs. Defaults apply until customized.\n'],
    [p.skills_index,
      '# User Skills Index\n\nUser-level Claude Code skills index, read by the vaultflow router.\n'],
  ];

  let created = 0, present = 0;
  for (const [target, content] of stubs) {
    if (!target) continue;
    try {
      if (content === null) {
        if (!fs.existsSync(target)) { if (!DRY) fs.mkdirSync(target, { recursive: true }); created++; }
        else present++;
        continue;
      }
      if (fs.existsSync(target)) { present++; continue; }
      if (!DRY) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
      created++;
    } catch (_) { /* per-item best effort */ }
  }
  record('skeleton', 'ok', `${created} created, ${present} already present${DRY ? ' [dry-run]' : ''}`);
}

// ── Step 1: global hooks ──────────────────────────────────────────────────
// A vaultflow hook is any command that runs a script under THIS repo's
// .claude/helpers. That is the identity used to add, refresh, and remove our
// entries without touching anyone else's.
function isVaultflowHook(entry) {
  return (entry?.hooks || []).some((h) => typeof h?.command === 'string' && h.command.includes(`${H}/`));
}

/**
 * Merge the canonical vaultflow hooks into an existing hooks object.
 *
 * Replacing `user.hooks` wholesale (the previous behavior) silently deleted
 * every hook the user or another tool had configured — a backup file is not a
 * substitute for not destroying live config. Merging keeps foreign entries and
 * replaces only vaultflow's own, so re-running the installer is safe and
 * re-pointing a moved repo still cleans up the stale commands.
 */
function mergeHooks(existing) {
  const merged = {};
  for (const [event, entries] of Object.entries(existing || {})) {
    const foreign = (entries || []).filter((e) => !isVaultflowHook(e));
    if (foreign.length) merged[event] = foreign;
  }
  for (const [event, entries] of Object.entries(CANONICAL_HOOKS)) {
    merged[event] = [...(merged[event] || []), ...entries];
  }
  return merged;
}

function installGlobalHooks() {
  const user = readJson(USER_SETTINGS) || {};

  if (UNINSTALL) {
    if (!user.hooks) { record('global-hooks', 'skip', 'no global hooks to remove'); return; }
    const backup = backupUserSettings();
    const kept = {};
    for (const [event, entries] of Object.entries(user.hooks)) {
      const foreign = (entries || []).filter((e) => !isVaultflowHook(e));
      if (foreign.length) kept[event] = foreign;
    }
    if (Object.keys(kept).length) user.hooks = kept; else delete user.hooks;
    if (!DRY) {
      fs.mkdirSync(path.dirname(USER_SETTINGS), { recursive: true });
      fs.writeFileSync(USER_SETTINGS, JSON.stringify(user, null, 2) + '\n');
    }
    record('global-hooks', 'ok', `vaultflow hooks removed, ${Object.keys(kept).length} foreign event(s) kept${backup ? ` (backup: ${path.basename(backup)})` : ''}`);
    return;
  }

  const next = mergeHooks(user.hooks);
  if (JSON.stringify(user.hooks || null) === JSON.stringify(next)) { record('global-hooks', 'ok', 'already up to date'); return; }

  const foreignCount = Object.values(next).flat().filter((e) => !isVaultflowHook(e)).length;
  const backup = backupUserSettings();
  user.hooks = next;
  if (!DRY) {
    fs.mkdirSync(path.dirname(USER_SETTINGS), { recursive: true });
    fs.writeFileSync(USER_SETTINGS, JSON.stringify(user, null, 2) + '\n');
  }
  const events = Object.keys(CANONICAL_HOOKS).length;
  record('global-hooks', 'ok', `${events} events → ~/.claude/settings.json${foreignCount ? `, ${foreignCount} foreign hook(s) preserved` : ''}${backup ? ` (backup: ${path.basename(backup)})` : ''}${DRY ? ' [dry-run]' : ''}`);
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
// Start via ensure-watcher.mjs, NOT `watcher.mjs --start`. watcher.mjs treats
// any unrecognized argument as "run in the foreground", so the old --start call
// under spawnSync blocked the installer forever on every machine where the
// watcher was not already running — i.e. on exactly the fresh installs this
// script exists to serve. ensure-watcher.mjs spawns a detached daemon and exits.
function ensureWatcher() {
  const watcher = path.join(ROOT, '.claude', 'helpers', 'watcher.mjs');
  const ensure  = path.join(ROOT, '.claude', 'helpers', 'ensure-watcher.mjs');
  const status = spawnSync(process.execPath, [watcher, '--status'], { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 20_000 });
  const running = /Status: running/i.test(status.stdout || '');
  if (UNINSTALL) {
    if (DRY) { record('watcher', 'skip', 'dry-run'); return; }
    spawnSync(process.execPath, [watcher, '--stop'], { cwd: ROOT, stdio: 'ignore', timeout: 20_000 });
    record('watcher', 'ok', 'stopped');
    return;
  }
  if (running) { record('watcher', 'ok', (status.stdout || '').trim().split('\n')[0]); return; }
  if (DRY) { record('watcher', 'skip', 'would start watcher daemon [dry-run]'); return; }
  const launcher = fs.existsSync(ensure) ? [ensure] : [watcher, '--daemon'];
  const r = spawnSync(process.execPath, launcher, { cwd: ROOT, stdio: 'ignore', timeout: 60_000 });
  record('watcher', r.status === 0 ? 'ok' : 'warn', r.status === 0 ? 'daemon started' : 'could not start — run `npm run watcher`');
}

// ── Step 4b: vaultflow MCP server, user scope ──────────────────────────────
// The repo's .mcp.json is PROJECT scope: it gives find_symbol / search_memory /
// blast_radius only while cwd is the vaultflow repo. Registering the same
// server in ~/.claude.json's top-level mcpServers makes vaultflow's tools
// available from every project on the machine — which is the whole point of a
// machine-wide brain. Idempotent: rewrites only when the entry is absent or
// points at a different path (e.g. the repo moved).
function installMcpServer() {
  const claudeJson = path.join(os.homedir(), '.claude.json');
  const serverPath = `${ROOT_POSIX}/.claude/helpers/mcp-server.cjs`;
  const desired = { type: 'stdio', command: 'node', args: [serverPath], env: {} };

  const cfg = readJson(claudeJson);
  if (!cfg) {
    // No ~/.claude.json yet — Claude Code writes it on first run. Creating a
    // file with only mcpServers is safe and is merged with defaults later.
    if (UNINSTALL) { record('mcp-server', 'skip', 'no ~/.claude.json'); return; }
    if (DRY) { record('mcp-server', 'skip', 'would create ~/.claude.json with vaultflow server [dry-run]'); return; }
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { vaultflow: desired } }, null, 2) + '\n');
    record('mcp-server', 'ok', 'registered user-scope (new ~/.claude.json)');
    return;
  }

  cfg.mcpServers = cfg.mcpServers || {};
  if (UNINSTALL) {
    if (!cfg.mcpServers.vaultflow) { record('mcp-server', 'skip', 'not registered'); return; }
    if (DRY) { record('mcp-server', 'skip', 'dry-run'); return; }
    delete cfg.mcpServers.vaultflow;
    fs.writeFileSync(claudeJson, JSON.stringify(cfg, null, 2) + '\n');
    record('mcp-server', 'ok', 'unregistered');
    return;
  }

  const current = cfg.mcpServers.vaultflow;
  if (current && JSON.stringify(current.args || []) === JSON.stringify(desired.args)) {
    record('mcp-server', 'ok', 'already registered user-scope');
    return;
  }
  if (DRY) { record('mcp-server', 'skip', `would register vaultflow MCP in ~/.claude.json [dry-run]`); return; }
  cfg.mcpServers.vaultflow = desired;
  fs.writeFileSync(claudeJson, JSON.stringify(cfg, null, 2) + '\n');
  record('mcp-server', 'ok', `${current ? 're-pointed' : 'registered'} user-scope → tools available in every project`);
}

// ── Step 4c: curated skills → ~/.claude/skills ─────────────────────────────
// .agents/skills/ holds 134 vendored skill folders, but only the ones marked
// `enabled = true` in .agents/config.toml are the curated set. Those were
// reachable from Codex only; Claude Code reads ~/.claude/skills. Copy the
// enabled set there so the same skills are usable from the CLI in every
// project. Copies (not symlinks) because symlink creation on Windows needs
// either elevation or Developer Mode.
function installUserSkills() {
  const skillsDir = path.join(os.homedir(), '.claude', 'skills');
  const srcRoot   = path.join(ROOT, '.agents', 'skills');
  const tomlPath  = path.join(ROOT, '.agents', 'config.toml');
  if (!fs.existsSync(tomlPath) || !fs.existsSync(srcRoot)) { record('user-skills', 'skip', '.agents not vendored'); return; }

  const enabled = parseEnabledSkillPaths(tomlPath);
  if (UNINSTALL) {
    if (DRY) { record('user-skills', 'skip', 'dry-run'); return; }
    let removed = 0;
    for (const name of enabled) {
      const dest = path.join(skillsDir, name);
      // Only remove copies we installed — the marker file proves provenance.
      if (fs.existsSync(path.join(dest, '.vaultflow-managed'))) { fs.rmSync(dest, { recursive: true, force: true }); removed++; }
    }
    record('user-skills', 'ok', `removed ${removed} vaultflow-managed skill(s)`);
    return;
  }

  if (DRY) { record('user-skills', 'skip', `would install ${enabled.length} curated skills → ~/.claude/skills [dry-run]`); return; }

  let copied = 0, skipped = 0;
  for (const name of enabled) {
    const src  = path.join(srcRoot, name);
    const dest = path.join(skillsDir, name);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) continue;
    // Never clobber a hand-authored skill of the same name.
    if (fs.existsSync(dest) && !fs.existsSync(path.join(dest, '.vaultflow-managed'))) { skipped++; continue; }
    try {
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
      fs.writeFileSync(path.join(dest, '.vaultflow-managed'), 'Installed by vaultflow scripts/install.mjs. Safe to delete.\n');
      copied++;
    } catch (_) { /* per-skill best effort */ }
  }
  record('user-skills', 'ok', `${copied} curated skill(s) → ~/.claude/skills${skipped ? `, ${skipped} user-authored left alone` : ''}`);
}

/**
 * Names of `.agents/skills/*` folders marked `enabled = true` in config.toml.
 * Minimal TOML reading — the file only ever uses `[[skills.config]]` blocks
 * with `path` and `enabled` keys, so a full TOML parser would be a new dep for
 * no gain. Mirrors parseCodexConfig() in .claude/helpers/backfill.mjs.
 */
function parseEnabledSkillPaths(tomlPath) {
  const out = [];
  let cur = null;
  for (const line of fs.readFileSync(tomlPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (t === '[[skills.config]]') { if (cur?.enabled && cur.path) out.push(path.basename(cur.path)); cur = { path: null, enabled: false }; continue; }
    if (!cur) continue;
    const p = t.match(/^path\s*=\s*"(.+)"$/);
    const e = t.match(/^enabled\s*=\s*(true|false)$/);
    if (p) cur.path = p[1];
    if (e) cur.enabled = e[1] === 'true';
  }
  if (cur?.enabled && cur.path) out.push(path.basename(cur.path));
  return out;
}

// ── Step 5: dev-team plugin (vendored at plugins/dev-team) ─────────────────
// Registers the in-repo plugin as a local marketplace and installs it so
// Claude Code loads the multi-agent dev team (7 agents + skills + /dev-team-report).
function installDevTeam() {
  const pluginDir = path.join(ROOT, 'plugins', 'dev-team');
  const manifest = path.join(pluginDir, '.claude-plugin', 'marketplace.json');
  if (!fs.existsSync(manifest)) { record('dev-team', 'skip', 'plugins/dev-team not vendored'); return; }

  const claude = (args, opts = {}) =>
    spawnSync('claude', args, { cwd: ROOT, encoding: 'utf8', shell: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' }, ...opts });

  if (UNINSTALL) {
    if (DRY) { record('dev-team', 'skip', 'dry-run'); return; }
    claude(['plugin', 'uninstall', 'dev-team@dev-team']);
    claude(['plugin', 'marketplace', 'remove', 'dev-team']);
    record('dev-team', 'ok', 'uninstalled');
    return;
  }

  // Idempotent: skip if already installed.
  const probe = claude(['plugin', 'details', 'dev-team'], { stdio: 'pipe' });
  if (probe.status === 0 && /dev-team/i.test(probe.stdout || '')) {
    record('dev-team', 'ok', 'plugin already installed');
    return;
  }
  if (DRY) { record('dev-team', 'skip', 'would add marketplace + install dev-team@dev-team [dry-run]'); return; }

  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { stdio: 'ignore', shell: true });
  if (which.status !== 0) { record('dev-team', 'warn', 'claude CLI not on PATH — skipped'); return; }

  const add = claude(['plugin', 'marketplace', 'add', pluginDir]);
  const inst = claude(['plugin', 'install', 'dev-team@dev-team', '--scope', 'user']);
  if (inst.status === 0 || /already installed|Successfully installed/i.test((inst.stdout || '') + (inst.stderr || ''))) {
    record('dev-team', 'ok', '7 agents + skills + /dev-team-report (restart Claude Code to load)');
  } else {
    record('dev-team', 'warn', `install failed — ${((add.stderr || '') + (inst.stderr || '')).trim().split('\n').pop() || 'run scripts/install-local from plugins/dev-team'}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log(c.bold(`\nvaultflow ${UNINSTALL ? 'uninstall' : 'install'}${DRY ? ' (dry-run)' : ''}`));
console.log(c.dim(`  repo: ${ROOT}`));
console.log(c.dim(`  user settings: ${USER_SETTINGS}\n`));

if (DEVTEAM_ONLY) {
  installDevTeam();
  const failedDt = results.filter((r) => r.status === 'fail').length;
  console.log(`\n${failedDt ? c.err('failed') : c.ok('done')}${DRY ? c.dim(' — dry-run') : ''}\n`);
  process.exit(failedDt ? 1 : 0);
}

// Fresh-start groundwork (install only): verify prereqs, then make sure a
// real config + the files it points at exist before wiring anything to them.
if (!UNINSTALL) {
  if (!checkPrereqs()) {
    console.log(`\n${c.err('aborted')} — fix prerequisites and re-run\n`);
    process.exit(1);
  }
  if (!HOOKS_ONLY) {
    bootstrapConfig();
    scaffoldSkeleton();
  }
}

installGlobalHooks();
if (!HOOKS_ONLY) {
  if (!NO_LINK) linkCli(); else record('cli-link', 'skip', '--no-link');
  if (!NO_MCP) installMcpServer(); else record('mcp-server', 'skip', '--no-mcp');
  if (!NO_SKILLS) installUserSkills(); else record('user-skills', 'skip', '--no-skills');
  if (!NO_NIGHTLY) installNightly(); else record('nightly-task', 'skip', '--no-nightly');
  if (!NO_WATCHER) ensureWatcher(); else record('watcher', 'skip', '--no-watcher');
  if (!NO_DEVTEAM) installDevTeam(); else record('dev-team', 'skip', '--no-dev-team');
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
