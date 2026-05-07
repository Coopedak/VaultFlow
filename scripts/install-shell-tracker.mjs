#!/usr/bin/env node
/**
 * install-shell-tracker.mjs — wire the vaultflow PowerShell shell-tracker
 * into the user's $PROFILE so every command they type lands in
 * shell-commands.jsonl, which the watcher daemon ingests into SQLite.
 *
 * Idempotent: appending the dot-source line a second time is a no-op (the
 * marker block is detected and skipped). `--uninstall` removes the block.
 *
 * Usage:
 *   node scripts/install-shell-tracker.mjs           # install
 *   node scripts/install-shell-tracker.mjs --check   # report current state
 *   node scripts/install-shell-tracker.mjs --uninstall
 *
 * Profile target:
 *   resolveProfilePath() picks $PROFILE.CurrentUserCurrentHost via pwsh.
 *   Fallback if pwsh is missing: standard Documents\PowerShell path.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT     = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRACKER_PATH  = path.join(REPO_ROOT, 'config', 'vaultflow-shell-tracker.ps1');
const MARKER_BEGIN  = '# >>> vaultflow shell-tracker (managed) >>>';
const MARKER_END    = '# <<< vaultflow shell-tracker (managed) <<<';

function resolveProfilePath() {
  // Ask PowerShell where its CurrentUserCurrentHost profile lives.
  try {
    const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PROFILE.CurrentUserCurrentHost'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    if (out) return out;
  } catch (_) {}
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '$PROFILE.CurrentUserCurrentHost'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    if (out) return out;
  } catch (_) {}
  // Last-resort fallback (PowerShell 7 default location).
  return path.join(os.homedir(), 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
}

export function buildBlock(trackerPath = TRACKER_PATH) {
  return [
    MARKER_BEGIN,
    `# Loads the vaultflow shell-tracker so every PowerShell command is`,
    `# appended to shell-commands.jsonl for ingestion by the watcher daemon.`,
    `# Remove this block (or run \`node scripts/install-shell-tracker.mjs --uninstall\`) to opt out.`,
    `if (Test-Path '${trackerPath}') { . '${trackerPath}' }`,
    MARKER_END,
    '',
  ].join('\r\n');
}

export function readProfile(profilePath) {
  if (!fs.existsSync(profilePath)) return '';
  return fs.readFileSync(profilePath, 'utf8');
}

export function hasMarker(content) {
  return content.includes(MARKER_BEGIN) && content.includes(MARKER_END);
}

export function stripMarker(content) {
  // Remove everything from MARKER_BEGIN through MARKER_END (inclusive),
  // plus exactly one trailing newline if present, to avoid blank-line drift.
  const re = new RegExp(
    `(?:\\r?\\n)?${escape(MARKER_BEGIN)}[\\s\\S]*?${escape(MARKER_END)}(?:\\r?\\n)?`,
    'g',
  );
  return content.replace(re, '');
}

function escape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function install({ profilePath, trackerPath = TRACKER_PATH, write = fs.writeFileSync } = {}) {
  if (!fs.existsSync(trackerPath)) {
    throw new Error(`tracker script not found at ${trackerPath}`);
  }

  const target = profilePath || resolveProfilePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const before = readProfile(target);
  if (hasMarker(before)) {
    return { action: 'noop', profile: target, reason: 'marker block already present' };
  }

  const sep = before.length > 0 && !before.endsWith('\n') ? '\r\n\r\n' : (before.length > 0 ? '\r\n' : '');
  const after = before + sep + buildBlock(trackerPath);
  write(target, after, 'utf8');
  return { action: 'installed', profile: target };
}

export function uninstall({ profilePath, write = fs.writeFileSync } = {}) {
  const target = profilePath || resolveProfilePath();
  const before = readProfile(target);
  if (!hasMarker(before)) {
    return { action: 'noop', profile: target, reason: 'marker block not present' };
  }
  const after = stripMarker(before);
  write(target, after, 'utf8');
  return { action: 'uninstalled', profile: target };
}

export function check({ profilePath } = {}) {
  const target = profilePath || resolveProfilePath();
  const content = readProfile(target);
  return {
    profile:        target,
    profile_exists: fs.existsSync(target),
    tracker_exists: fs.existsSync(TRACKER_PATH),
    installed:      hasMarker(content),
  };
}

const isMain = (() => {
  try { return import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href; }
  catch { return false; }
})();

if (isMain) {
  const arg = process.argv[2] || '--install';
  let result;
  if (arg === '--check' || arg === 'check')           result = check();
  else if (arg === '--uninstall' || arg === 'uninstall') result = uninstall();
  else                                                  result = install();
  console.log(JSON.stringify(result, null, 2));
}
