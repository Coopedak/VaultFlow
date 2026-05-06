import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { buildDisplayCommand, buildToolCommand, ensureSessionLaunchMeta } from './tool-commands.mjs';

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quotePowerShellArgs(args = []) {
  return args.map(arg => quotePowerShell(arg)).join(' ');
}

function hasCommand(command) {
  try {
    const probe = process.platform === 'win32'
      ? spawnSync('where.exe', [command], { stdio: 'ignore' })
      : spawnSync('which', [command], { stdio: 'ignore' });
    return probe.status === 0;
  } catch {
    return false;
  }
}

function validateCwd(cwd) {
  try {
    if (fs.statSync(cwd).isDirectory()) return cwd;
  } catch {}
  return process.cwd();
}

export function buildExternalTerminalLaunch(session) {
  const cwd = validateCwd(session?.cwd || process.cwd());
  ensureSessionLaunchMeta(session);
  const resumeDef = buildToolCommand(session?.tool, session, { mode: 'resume' });
  const startDef  = buildToolCommand(session?.tool, session, { mode: 'pty' });
  const def = resumeDef.resumable ? resumeDef : startDef;
  const title = `vaultflow • ${session?.project || 'session'} • ${session?.tool || 'claude'}`;

  if (process.platform === 'win32' && hasCommand('wt.exe')) {
    return {
      command: 'wt.exe',
      args: ['new-tab', '--title', title, '-d', cwd, 'cmd.exe', '/k', def.windowsCmd || def.cmd, ...def.args],
      cwd,
      resumable: def.resumable,
    };
  }

  if (process.platform === 'win32') {
    const shell = hasCommand('pwsh.exe') ? 'pwsh.exe' : 'powershell.exe';
    const psScript =
      `Set-Location -LiteralPath ${quotePowerShell(cwd)}; ` +
      `& ${quotePowerShell(def.windowsCmd || def.cmd)} ${quotePowerShellArgs(def.args)}`.trim();
    return {
      command: shell,
      args: ['-NoExit', '-NoLogo', '-Command', psScript],
      cwd,
      resumable: def.resumable,
    };
  }

  return {
    command: def.cmd,
    args: def.args,
    cwd,
    resumable: def.resumable,
  };
}

export function launchExternalTerminal(session) {
  const spec = buildExternalTerminalLaunch(session);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });

    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve({
        ...spec,
        displayCommand: buildDisplayCommand(
          session?.tool,
          session,
          { mode: spec.resumable ? 'resume' : 'pty' }
        ),
      });
    });
  });
}

