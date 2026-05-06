/**
 * pty-manager.mjs — node-pty spawn/kill/output management
 *
 * WHY: Wraps node-pty with Windows-compatible spawning and crash handling.
 * PTY output is piped through ansi.mjs then appended to the session via
 * session-manager so all widgets get a consistent update event.
 *
 * Windows note: node-pty on Windows uses conpty. The shell must be specified
 * as 'cmd.exe' or 'powershell.exe'. We use 'cmd.exe /c' to launch CLIs.
 */

import pty            from 'node-pty';
import fs             from 'node:fs';
import { sessionManager } from './session-manager.mjs';

// Tool → command mapping
const TOOL_COMMANDS = {
  'claude':     { cmd: 'claude',               args: [] },
  'gh-copilot': { cmd: 'gh',                   args: ['copilot', 'chat'] },
  'codex':      { cmd: 'codex',                args: [] },
};

class PtyManager {
  constructor() {
    this._procs = new Map();  // session.id → pty process
  }

  /**
   * Spawn a PTY process for the given session.
   * Sets session.ptyProc and starts piping output to session-manager.
   *
   * @param {object} session — session object from session-manager
   * @param {{ cols?: number, rows?: number, initialPrompt?: string }} opts
   */
  spawn(session, { cols = 130, rows = 40, initialPrompt = '' } = {}) {
    const toolDef = TOOL_COMMANDS[session.tool] || TOOL_COMMANDS['claude'];

    // Validate cwd — node-pty throws error 267 on Windows if cwd is invalid
    let cwd = session.cwd || process.cwd();
    try {
      if (!fs.statSync(cwd).isDirectory()) cwd = process.cwd();
    } catch {
      cwd = process.cwd();
    }

    let ptyProc;
    try {
      // On Windows, node-pty works best spawning the shell directly.
      // Pass the CLI command as shell args so the PTY is properly sized.
      const isWindows = process.platform === 'win32';

      if (isWindows) {
        // Use cmd.exe to invoke the CLI — keeps the PTY open and interactive.
        ptyProc = pty.spawn('cmd.exe', ['/k', toolDef.cmd, ...toolDef.args], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env: { ...process.env, TERM: 'xterm-256color' },
          useConpty: true,
        });
      } else {
        ptyProc = pty.spawn(toolDef.cmd, toolDef.args, {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env: { ...process.env, TERM: 'xterm-256color' },
        });
      }
    } catch (err) {
      sessionManager.appendLine(session.id,
        `\x1b[31m[vaultflow] Failed to spawn ${session.tool}: ${err.message}\x1b[0m`);
      sessionManager.update(session.id, { status: 'crashed' });
      return null;
    }

    session.ptyProc = ptyProc;
    this._procs.set(session.id, ptyProc);
    sessionManager.update(session.id, { status: 'running', ptyProc });

    // Pipe PTY output → session lines
    ptyProc.onData((data) => {
      try {
        // Split on newlines but keep partial lines in a carry buffer
        const carry = this._carries.get(session.id) || '';
        const combined = carry + data;
        const lines = combined.split('\n');
        // Last element may be incomplete — carry it forward
        const last = lines.pop();
        this._carries.set(session.id, last);

        for (const line of lines) {
          sessionManager.appendLine(session.id, line);
        }
      } catch (err) {
        // Must never crash the TUI — swallow
        try {
          sessionManager.appendLine(session.id,
            `\x1b[31m[vaultflow] output error: ${err.message}\x1b[0m`);
        } catch {
          // truly unreachable
        }
      }
    });

    ptyProc.onExit(({ exitCode, signal }) => {
      try {
        // Flush carry buffer
        const carry = this._carries.get(session.id) || '';
        if (carry) sessionManager.appendLine(session.id, carry);
        this._carries.delete(session.id);

        const crashed = exitCode !== 0 && exitCode !== null;
        sessionManager.appendLine(session.id,
          crashed
            ? `\x1b[31m[vaultflow] Session exited unexpectedly (exit code ${exitCode})\x1b[0m`
            : `\x1b[90m[vaultflow] Session ended (exit code ${exitCode ?? signal})\x1b[0m`
        );
        sessionManager.update(session.id, {
          status: crashed ? 'crashed' : 'idle',
          ptyProc: null,
        });
        this._procs.delete(session.id);
      } catch {
        // swallow
      }
    });

    // If an initial prompt was given, send it after a short delay
    if (initialPrompt) {
      setTimeout(() => {
        try {
          ptyProc.write(initialPrompt + '\r');
        } catch {
          // PTY may have exited
        }
      }, 300);
    }

    return ptyProc;
  }

  // Per-session carry buffers for partial lines
  _carries = new Map();

  /**
   * Send input to the active PTY process for a session.
   * Used when the right panel has focus and keystrokes pass through.
   */
  write(sessionId, data) {
    const proc = this._procs.get(sessionId);
    if (proc) {
      try {
        proc.write(data);
      } catch {
        // PTY may have exited
      }
    }
  }

  /**
   * Resize the PTY to match the right panel dimensions.
   */
  resize(sessionId, cols, rows) {
    const proc = this._procs.get(sessionId);
    if (proc) {
      try {
        proc.resize(Math.max(1, cols), Math.max(1, rows));
      } catch {
        // ignore resize errors
      }
    }
  }

  /**
   * Kill the PTY process for a session.
   * On Windows, SIGTERM is not available — we call kill() directly.
   */
  kill(sessionId) {
    const proc = this._procs.get(sessionId);
    if (proc) {
      try {
        proc.kill();
      } catch {
        // already dead
      }
      this._procs.delete(sessionId);
      this._carries.delete(sessionId);
    }
  }

  /**
   * Kill all managed PTY processes. Called on TUI quit.
   */
  killAll() {
    for (const id of this._procs.keys()) {
      this.kill(id);
    }
  }
}

export const ptyManager = new PtyManager();
