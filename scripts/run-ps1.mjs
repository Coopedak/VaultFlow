#!/usr/bin/env node
/**
 * run-ps1.mjs - launch a PowerShell script using whichever shell is
 * available on this machine.
 *
 * Why this exists:
 * - Some Windows environments expose `pwsh` only.
 * - Others still rely on Windows PowerShell (`powershell`).
 * - Repository scripts should not hard-code one or the other.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const scriptArg = args[0];

if (!scriptArg) {
  process.stderr.write('Usage: node scripts/run-ps1.mjs <script.ps1> [args...]\n');
  process.exit(1);
}

const scriptPath = path.isAbsolute(scriptArg) ? scriptArg : path.resolve(ROOT, scriptArg);
const scriptArgs = args.slice(1);

const candidates = ['pwsh', 'powershell'];
let lastError = null;

for (const shell of candidates) {
  const result = spawnSync(shell, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    ...scriptArgs,
  ], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: false,
  });

  if (!result.error) {
    process.exit(result.status ?? 0);
  }

  lastError = result.error;
  if (result.error.code !== 'ENOENT') {
    break;
  }
}

const detail = lastError ? ` (${lastError.code}: ${lastError.message})` : '';
process.stderr.write(`Failed to launch PowerShell script: ${scriptPath}${detail}\n`);
process.exit(1);
