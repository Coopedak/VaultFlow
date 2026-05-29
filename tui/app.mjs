/**
 * app.mjs — three-column layout
 *
 *   LEFT   — history of past claude sessions (~/.claude/history.jsonl)
 *   MIDDLE — focused PTY's live output
 *   RIGHT  — currently-running PTY sessions
 *
 * Focus model:
 *   'history' | 'middle' | 'live' | 'dialog'
 *
 * Workflow:
 *   - Enter on history row → spawn `claude --resume <sid>` as a new live PTY.
 *     That session appears in the right column and its output streams in
 *     the middle.
 *   - Enter on live row    → focus that PTY in the middle column.
 *   - N anywhere           → new-session dialog (unchanged).
 */

import blessed from 'blessed';
import fs      from 'node:fs';
import pty     from 'node-pty';
import { spawnSync } from 'node:child_process';

import { findSessionCwd }         from './history-reader.mjs';
import { createHeader }           from './widgets/header.mjs';
import { createHistoryPanel, HISTORY_WIDTH } from './widgets/history-panel.mjs';
import { createRightPanel }       from './widgets/right-panel.mjs';
import { createLivePanel, LIVE_WIDTH } from './widgets/live-panel.mjs';
import { createHelpOverlay }      from './widgets/help-overlay.mjs';
import { createNewSessionDialog } from './widgets/new-session-dialog.mjs';
import { sessionManager }         from './session-manager.mjs';
import { ptyManager }             from './pty-manager.mjs';
import { launchExternalTerminal } from './terminal-launcher.mjs';
import { closeDb }                from './db-reader.mjs';
import { recordSessionAction, recordSessionEnd } from './telemetry.mjs';

export function createApp() {
  const screen = blessed.screen({
    smartCSR:     true,
    fastCSR:      true,
    title:        'vaultflow',
    terminal:     'xterm-256color',
    fullUnicode:  true,
    forceUnicode: true,
    dockBorders:  true,
    ignoreLocked: ['C-c'],
  });

  const header        = createHeader(screen);
  const historyPanel  = createHistoryPanel(screen, {
    onSelect: (entry) => spawnResumeSession(entry),
  });
  const middlePanel   = createRightPanel(screen);
  const livePanel     = createLivePanel(screen, {
    onSelect: (session) => {
      sessionManager.select(session.id);
      focusMode = 'middle';
      updateFocusStyle();
    },
  });
  const helpOverlay      = createHelpOverlay(screen);
  const newSessionDialog = createNewSessionDialog(screen, {
    onLaunch: (session) => {
      sessionManager.select(session.id);
      focusMode = 'middle';
      updateFocusStyle();
    },
  });

  const footer = blessed.box({
    bottom: 0, left: 0, width: '100%', height: 1,
    tags: true,
    content:
      '  {grey-fg}Tab:focus  ↑↓:nav  Enter:open/resume  N:new  K:kill  ' +
      'D:detach  P:popout  Q:quit  ?:help{/}',
    style: { fg: 'grey', bg: 'black' },
  });

  screen.append(header.box);
  screen.append(historyPanel.box);
  screen.append(middlePanel.divider);
  screen.append(middlePanel.headerBox);
  screen.append(middlePanel.headerSep);
  screen.append(middlePanel.logBox);
  screen.append(livePanel.box);
  screen.append(footer);
  screen.append(helpOverlay.box);
  screen.append(newSessionDialog.container);

  // ── focus ────────────────────────────────────────────────────────────────
  let focusMode = 'history';

  function updateFocusStyle() {
    historyPanel.setFocused(focusMode === 'history');
    livePanel.setFocused(focusMode === 'live');
    screen.render();
  }

  // ── spawn-from-history flow ──────────────────────────────────────────────
  // claude --resume <sid> requires the cwd to match the directory the
  // session's transcript lives under. We locate that transcript directly
  // instead of trusting history.jsonl's `project` field, which can diverge.
  function spawnResumeSession(entry) {
    const located = findSessionCwd(entry.sid);
    if (!located) {
      // No resumable transcript exists — make this visible in middle pane
      // instead of spawning a claude that will exit 1 immediately.
      const session = sessionManager.create({
        tool: 'claude',
        project: entry.project || 'session',
        cwd: process.cwd(),
      });
      session.sessionId = entry.sid;
      sessionManager.appendLine(session.id,
        `\x1b[33m[vaultflow] Session ${entry.sid.slice(0, 8)} has no transcript on disk — cannot resume.\x1b[0m`);
      sessionManager.appendLine(session.id,
        `\x1b[90mhistory.jsonl knows about it, but ~/.claude/projects/*/${entry.sid}.jsonl is missing.\x1b[0m`);
      sessionManager.update(session.id, { status: 'idle' });
      sessionManager.select(session.id);
      focusMode = 'middle';
      updateFocusStyle();
      return;
    }

    const cwd = fs.existsSync(located.cwd) ? located.cwd : process.cwd();
    const session = sessionManager.create({
      tool: 'claude',
      project: cwd,
      cwd,
    });
    session.sessionId = entry.sid;
    recordSessionAction(session, 'TuiResume', { sid: entry.sid, cwd });

    // claude is a real .exe (Bun-bundled). Spawn it DIRECTLY via node-pty —
    // no `cmd.exe /d /c` wrapper, no .cmd shim. The wrapper adds a process
    // layer that breaks conpty's TTY chain on the --resume codepath. Strip
    // CLAUDE_* env vars in case any are inherited from a parent session.
    const cleanEnv = { ...process.env, TERM: 'xterm-256color' };
    for (const k of Object.keys(cleanEnv)) {
      if (k.startsWith('CLAUDE_') || k.startsWith('ANTHROPIC_')) delete cleanEnv[k];
    }
    const claudeExe = resolveClaudeExe();
    const cols = Math.max(80, screen.width - HISTORY_WIDTH - LIVE_WIDTH - 2);
    const rows = Math.max(20, screen.height - 5);

    let ptyProc;
    try {
      ptyProc = pty.spawn(claudeExe, ['--resume', entry.sid], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: cleanEnv,
        useConpty: true,
      });
    } catch (err) {
      sessionManager.appendLine(session.id,
        `\x1b[31m[vaultflow] pty.spawn failed: ${err.message}\x1b[0m`);
      sessionManager.update(session.id, { status: 'crashed' });
      sessionManager.select(session.id);
      focusMode = 'middle';
      updateFocusStyle();
      return;
    }

    session.ptyProc = ptyProc;
    sessionManager.update(session.id, { status: 'running', ptyProc });
    ptyManager._procs?.set?.(session.id, ptyProc); // let killAll/resize find it
    let carry = '';
    ptyProc.onData((data) => {
      try {
        const combined = carry + data;
        const lines = combined.split('\n');
        carry = lines.pop();
        for (const line of lines) sessionManager.appendLine(session.id, line);
      } catch {}
    });
    ptyProc.onExit(({ exitCode, signal }) => {
      try {
        if (carry) sessionManager.appendLine(session.id, carry);
        carry = '';
        const crashed = exitCode !== 0 && exitCode !== null;
        sessionManager.appendLine(session.id,
          crashed
            ? `\x1b[31m[vaultflow] claude exited (code ${exitCode})\x1b[0m`
            : `\x1b[90m[vaultflow] claude exited (code ${exitCode ?? signal})\x1b[0m`);
        sessionManager.update(session.id, { status: crashed ? 'crashed' : 'idle', ptyProc: null });
        ptyManager._procs?.delete?.(session.id);
      } catch {}
    });

    sessionManager.select(session.id);
    focusMode = 'middle';
    updateFocusStyle();
  }

  // Resolve the absolute path to claude.exe once. `where.exe claude` is the
  // truth source (handles user-level installs under ~/.local/bin).
  function resolveClaudeExe() {
    try {
      const r = spawnSync('where.exe', ['claude'], { encoding: 'utf8' });
      const lines = (r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const exe = lines.find(l => l.toLowerCase().endsWith('.exe')) || lines[0];
      if (exe) return exe;
    } catch {}
    return 'claude.exe';
  }

  // ── keys ─────────────────────────────────────────────────────────────────
  screen.on('keypress', (ch, key) => {
    const keyName = key?.name || ch;

    if (helpOverlay.isVisible()) { helpOverlay.hide(); return; }

    if (newSessionDialog.isVisible()) {
      newSessionDialog.handleKey(keyName, ch);
      return;
    }

    if (_killPending) { handleKillConfirm(ch, keyName); return; }

    if (keyName === 'tab') {
      const order = ['history', 'middle', 'live'];
      focusMode = order[(order.indexOf(focusMode) + 1) % order.length];
      updateFocusStyle();
      return;
    }

    if (key?.ctrl && keyName === 'c') { quit(); return; }
    if (keyName === 'q')                { quit(); return; }
    if (keyName === '?')                { helpOverlay.toggle(); return; }
    if (keyName === 'n' || keyName === 'N') { newSessionDialog.show(); return; }
    if (keyName === 'p' || keyName === 'P') { popoutCurrent(); return; }
    if (keyName === 'd' || keyName === 'D') { detachCurrent(); return; }

    if (focusMode === 'history') {
      if (keyName === 'up')    { historyPanel.cursorUp();   return; }
      if (keyName === 'down')  { historyPanel.cursorDown(); return; }
      if (keyName === 'enter') { historyPanel.openCurrent(); return; }
      if (keyName === 'r' || keyName === 'R') { historyPanel.refresh(); return; }
      return;
    }

    if (focusMode === 'live') {
      if (keyName === 'up')    { livePanel.cursorUp();   return; }
      if (keyName === 'down')  { livePanel.cursorDown(); return; }
      if (keyName === 'enter') { livePanel.openCurrent(); return; }
      if (keyName === 'k' || keyName === 'K') { initiateKill(); return; }
      return;
    }

    if (focusMode === 'middle') {
      if (keyName === 'escape') {
        focusMode = 'history';
        updateFocusStyle();
        return;
      }
      if (keyName === 'up')    { middlePanel.scrollUp(3);    return; }
      if (keyName === 'down')  { middlePanel.scrollDown(3);  return; }
      if (keyName === 'space') { middlePanel.scrollPageDown(); return; }
      if (keyName === 'g' || keyName === 'G') {
        const now = Date.now();
        if (keyName === 'g' && lastKey === 'g' && (now - lastKeyTime) < 500) {
          middlePanel.scrollToTop();
          lastKey = null;
          return;
        }
        middlePanel.scrollToBottom();
        lastKey = keyName; lastKeyTime = now;
        return;
      }
      if (keyName === 'k' || keyName === 'K') { initiateKill(); return; }
      return;
    }
  });

  let lastKey = null;
  let lastKeyTime = 0;

  // ── kill flow ────────────────────────────────────────────────────────────
  let _killPending = false;
  let _killTarget  = null;

  function targetSession() {
    if (focusMode === 'live')   return livePanel.getCursorSession();
    if (focusMode === 'middle') return sessionManager.getSelected();
    return null;
  }

  function initiateKill() {
    const session = targetSession();
    if (!session) return;
    _killTarget = session;
    _killPending = true;
    footer.setContent(
      `  {red-fg}Kill session ${session.project}? [y/N]{/}  ` +
      '{grey-fg}(press Y to confirm, any other key cancels){/}'
    );
    screen.render();
  }

  function handleKillConfirm(ch, _keyName) {
    _killPending = false;
    if (ch === 'y' || ch === 'Y') {
      if (_killTarget) {
        recordSessionAction(_killTarget, 'TuiKill', { source: 'kill-confirm' });
        recordSessionEnd(_killTarget, { status: 'idle', errors: _killTarget.errors || 0 });
        ptyManager.kill(_killTarget.id);
        sessionManager.remove(_killTarget.id);
      }
    }
    _killTarget = null;
    restoreFooter();
    screen.render();
  }

  function restoreFooter() {
    footer.setContent(
      '  {grey-fg}Tab:focus  ↑↓:nav  Enter:open/resume  N:new  K:kill  ' +
      'D:detach  P:popout  Q:quit  ?:help{/}'
    );
  }

  // ── detach / popout (unchanged behavior) ─────────────────────────────────
  async function detachCurrent() {
    const session = targetSession();
    if (!session) return;
    const previousStatus = session.status || 'idle';
    try {
      await launchExternalTerminal(session);
      recordSessionAction(session, 'TuiDetach', { mode: 'external-terminal' });
      recordSessionEnd(session, { status: 'idle', errors: session.errors || 0 });
      sessionManager.update(session.id, {
        externalLaunches: (session.externalLaunches || 0) + 1,
        lastPoppedOutAt: new Date(),
      });
      ptyManager.kill(session.id);
      sessionManager.remove(session.id);
    } catch (err) {
      sessionManager.appendLine(session.id,
        `\x1b[31m[vaultflow] Failed to detach session: ${err.message}\x1b[0m`);
      sessionManager.update(session.id, { status: previousStatus });
    }
  }

  async function popoutCurrent() {
    const session = targetSession();
    if (!session) return;
    try {
      const result = await launchExternalTerminal(session);
      recordSessionAction(session, 'TuiPopout', { resumable: Boolean(result?.resumable) });
      sessionManager.appendLine(session.id,
        result.resumable
          ? '\x1b[90m[vaultflow] Opened a real terminal window for this tool.\x1b[0m'
          : '\x1b[90m[vaultflow] Opened a real terminal window for this tool in the same project directory.\x1b[0m');
      sessionManager.update(session.id, {
        externalLaunches: (session.externalLaunches || 0) + 1,
        lastPoppedOutAt: new Date(),
      });
    } catch (err) {
      sessionManager.appendLine(session.id,
        `\x1b[31m[vaultflow] Failed to open external terminal: ${err.message}\x1b[0m`);
    }
  }

  // ── quit ─────────────────────────────────────────────────────────────────
  function quit() {
    for (const session of sessionManager.getAll()) {
      recordSessionAction(session, 'TuiQuit', { source: 'app-quit' });
      recordSessionEnd(session, { status: session.status || 'idle', errors: session.errors || 0 });
    }
    try { ptyManager.killAll(); } catch {}
    try { closeDb(); } catch {}
    screen.destroy();
    process.exit(0);
  }

  // ── resize ───────────────────────────────────────────────────────────────
  screen.on('resize', () => {
    try {
      const cols = Math.max(80, screen.width - HISTORY_WIDTH - LIVE_WIDTH - 2);
      const rows = Math.max(20, screen.height - 5);
      for (const s of sessionManager.getAll()) {
        if (s.ptyProc) ptyManager.resize(s.id, cols, rows);
      }
      historyPanel.render();
      livePanel.render();
      header.render();
      screen.render();
    } catch {}
  });

  updateFocusStyle();
  historyPanel.render();
  livePanel.render();
  screen.render();

  return { screen, quit };
}
