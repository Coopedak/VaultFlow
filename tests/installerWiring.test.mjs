/**
 * Installer wiring — the guarantees a fresh-machine install depends on.
 * Run: node --test tests/installerWiring.test.mjs
 *
 * These are contract tests over scripts/install.mjs and the CLI surfaces it
 * drives. They assert on source and on real subprocess behavior rather than
 * mutating the developer's own ~/.claude, which the installer targets.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const installSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'install.mjs'), 'utf8');

test('installer never starts the watcher with a blocking foreground call', () => {
  // watcher.mjs treats an unrecognized argument as "run in the foreground".
  // `spawnSync(watcher, ['--start'])` therefore hung the installer forever on
  // any machine where the watcher was not already running — i.e. every fresh
  // install. The daemon must be launched via ensure-watcher.mjs or --daemon.
  assert.ok(!/\[watcher, '--start'\]/.test(installSrc), 'must not spawn watcher.mjs --start');
  assert.ok(/ensure-watcher\.mjs/.test(installSrc), 'should delegate to ensure-watcher.mjs');
});

test('watcher --start starts a daemon instead of blocking', () => {
  // Belt-and-braces for callers that still pass --start: it must be an alias
  // for --daemon, never a fall-through to the foreground branch.
  const src = fs.readFileSync(path.join(ROOT, '.claude', 'helpers', 'watcher.mjs'), 'utf8');
  const branch = src.match(/cmd === '--daemon'[^\n]*/);
  assert.ok(branch, 'daemon branch should exist');
  assert.ok(/--start/.test(branch[0]), '--start must be handled by the daemon branch');
});

test('watcher --status exits promptly and does not block', () => {
  // ensureWatcher() probes status synchronously before deciding to start.
  const r = spawnSync(process.execPath, [path.join(ROOT, '.claude', 'helpers', 'watcher.mjs'), '--status'], {
    encoding: 'utf8', timeout: 30_000,
  });
  assert.notEqual(r.signal, 'SIGTERM', '--status must not hang until timeout');
  assert.match(r.stdout || '', /Status:/);
});

test('install.ps1 forwards unknown flags to install.mjs', () => {
  // [CmdletBinding()] made PowerShell reject unknown args outright, so the
  // documented `install.ps1 --dry-run` died with a binding error rather than
  // passing the flag through.
  const ps1 = fs.readFileSync(path.join(ROOT, 'scripts', 'install.ps1'), 'utf8');
  assert.ok(!/^\[CmdletBinding\(\)\]/m.test(ps1), 'CmdletBinding blocks arg passthrough');
  assert.ok(/ValueFromRemainingArguments/.test(ps1), 'must collect remaining args');
  assert.ok(/@Forward/.test(ps1), 'must splat collected args into install.mjs');
});

test('--dry-run writes nothing and reports every install step', () => {
  const before = fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'install.mjs'), '--dry-run'], {
    cwd: ROOT, encoding: 'utf8', timeout: 180_000,
  });
  const after = fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');

  assert.equal(r.status, 0, r.stderr);
  assert.equal(before, after, 'dry-run must not modify user settings');
  // Every step a fresh machine needs must be represented in the report.
  for (const step of ['prereqs', 'config', 'skeleton', 'global-hooks', 'cli-link', 'mcp-server', 'user-skills', 'watcher']) {
    assert.match(r.stdout, new RegExp(step), `dry-run should report the ${step} step`);
  }
});

test('the MCP server is registered at user scope, not just project scope', () => {
  // .mcp.json is project scope: without a user-scope entry the vaultflow MCP
  // tools exist only while cwd is this repo, which defeats a machine-wide brain.
  assert.ok(/\.claude\.json/.test(installSrc), 'must write ~/.claude.json');
  assert.ok(/mcpServers/.test(installSrc), 'must register under mcpServers');
});

test('install and uninstall preserve hooks vaultflow does not own', () => {
  // Replacing user.hooks wholesale silently deleted every hook another tool had
  // configured. A backup file is not a substitute for not destroying config.
  assert.ok(/isVaultflowHook/.test(installSrc), 'must identify its own hooks');
  assert.ok(/mergeHooks/.test(installSrc), 'must merge rather than assign');
  assert.ok(!/^\s*user\.hooks = CANONICAL_HOOKS;\s*$/m.test(installSrc), 'must not clobber the hooks object');
});

test('project settings do not duplicate the user-global hooks', () => {
  // Duplicated entries made pre-read and pre-skill fire twice per event inside
  // this repo, and hardcoded an absolute path that breaks on a clone elsewhere.
  const proj = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
  assert.equal(proj.hooks, undefined, 'project settings must not redeclare lifecycle hooks');
  assert.ok(Array.isArray(proj.denyList), 'denyList should still be enforced');
});
