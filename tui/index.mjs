/**
 * tui/index.mjs — vaultflow TUI entry point
 *
 * Usage: node tui/index.mjs
 *        npm run tui
 *
 * Starts the blessed terminal UI for managing multiple AI coding sessions
 * (Claude Code, GitHub Copilot CLI, Codex CLI).
 */

import { createApp } from './app.mjs';
import { ptyManager } from './pty-manager.mjs';
import { sessionManager } from './session-manager.mjs';
import { recordSessionAction, recordSessionEnd } from './telemetry.mjs';

// Suppress Node 22 experimental warnings that would bleed into the TUI
const { emitWarning } = process;
process.emitWarning = (msg, ...rest) => {
  if (typeof msg === 'string' &&
      (msg.includes('ExperimentalWarning') || msg.includes('SQLite'))) {
    return;
  }
  emitWarning.call(process, msg, ...rest);
};

// Crash guard — an unhandled exception must not corrupt the terminal.
// We restore the terminal state before exiting so the user's shell is intact.
let _screen = null;

process.on('uncaughtException', (err) => {
  try {
    for (const session of sessionManager.getAll()) {
      recordSessionAction(session, 'TuiCrash', { source: 'uncaught-exception', message: err.message });
      recordSessionEnd(session, { status: 'crashed', errors: (session.errors || 0) + 1 });
    }
    ptyManager.killAll();
    if (_screen) {
      _screen.destroy();
    }
  } catch {
    // ignore
  }
  process.stderr.write('\n[vaultflow] Uncaught exception: ' + err.message + '\n');
  process.stderr.write(err.stack + '\n');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  try {
    for (const session of sessionManager.getAll()) {
      recordSessionAction(session, 'TuiCrash', { source: 'unhandled-rejection', message: String(reason) });
      recordSessionEnd(session, { status: 'crashed', errors: (session.errors || 0) + 1 });
    }
    ptyManager.killAll();
    if (_screen) {
      _screen.destroy();
    }
  } catch {
    // ignore
  }
  process.stderr.write('\n[vaultflow] Unhandled promise rejection: ' + String(reason) + '\n');
  process.exit(1);
});

// Start the TUI
const { screen } = createApp();
_screen = screen;
