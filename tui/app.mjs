/**
 * app.mjs — screen setup, layout assembly, global keybindings
 *
 * Focus model:
 *   'left'  — session list navigation
 *   'right' — session overview + recent output preview
 *   'dialog' — new-session or help overlay modal (Esc to close)
 */

import blessed from 'blessed';

import { createHeader }           from './widgets/header.mjs';
import { createLeftPanel }        from './widgets/left-panel.mjs';
import { createRightPanel }       from './widgets/right-panel.mjs';
import { createHelpOverlay }      from './widgets/help-overlay.mjs';
import { createNewSessionDialog } from './widgets/new-session-dialog.mjs';
import { sessionManager }         from './session-manager.mjs';
import { ptyManager }             from './pty-manager.mjs';
import { launchExternalTerminal } from './terminal-launcher.mjs';
import { closeDb }                from './db-reader.mjs';
import { recordSessionAction, recordSessionEnd } from './telemetry.mjs';

export function createApp() {
  // ── screen ────────────────────────────────────────────────────────────────

  const screen = blessed.screen({
    smartCSR:       true,
    fastCSR:        true,
    title:          'vaultflow',
    terminal:       'xterm-256color',
    fullUnicode:    true,
    forceUnicode:   true,
    dockBorders:    true,
    ignoreLocked:   ['C-c'],
  });

  // ── widgets ────────────────────────────────────────────────────────────────

  const header     = createHeader(screen);
  const leftPanel  = createLeftPanel(screen, {
    onSessionSelect: (session) => {
      sessionManager.select(session.id);
    },
  });
  const rightPanel = createRightPanel(screen);
  const helpOverlay = createHelpOverlay(screen);
  const newSessionDialog = createNewSessionDialog(screen, {
    onLaunch: (session) => {
      leftPanel.selectSession(session.id);
      sessionManager.select(session.id);
      focusMode = 'right';
      updateFocusStyle();
    },
  });

  // ── footer ─────────────────────────────────────────────────────────────────

  const footer = blessed.box({
    bottom:  0,
    left:    0,
    width:   '100%',
    height:  1,
    tags:    true,
    content:
      '  {grey-fg}Tab:focus  ↑↓:nav  Enter:open  N:new  K:kill  D:detach  ' +
      'P:popout  Q:quit  G:tail  Space:pgdn  R:reviews  M:models  ?:help{/}',
    style: {
      fg: 'grey',
      bg: 'black',
    },
  });

  // ── layout: append to screen ─────────────────────────────────────────────

  screen.append(header.box);
  screen.append(leftPanel.box);
  screen.append(rightPanel.divider);
  screen.append(rightPanel.headerBox);
  screen.append(rightPanel.headerSep);
  screen.append(rightPanel.logBox);
  screen.append(footer);
  screen.append(helpOverlay.box);
  screen.append(newSessionDialog.container);

  // ── focus state ───────────────────────────────────────────────────────────

  let focusMode = 'left';  // 'left' | 'right'

  function updateFocusStyle() {
    // Orange border when left panel is focused, grey when not
    if (leftPanel.box.style.border) {
      leftPanel.box.style.border.fg = focusMode === 'left' ? 'yellow' : 'grey';
    }
    screen.render();
  }

  // ── global keybindings ────────────────────────────────────────────────────

  // Track 'g g' double-g sequence
  let lastKey = null;
  let lastKeyTime = 0;

  screen.on('keypress', (ch, key) => {
    const keyName = key?.name || ch;

    // ── modal layers take priority ──────────────────────────────────────────

    if (helpOverlay.isVisible()) {
      helpOverlay.hide();
      return;
    }

    if (newSessionDialog.isVisible()) {
      if (newSessionDialog.handleKey(keyName, ch)) return;
      return;  // consume all keys while dialog open
    }

    // ── kill confirm inline prompt ──────────────────────────────────────────

    if (_killPending) {
      handleKillConfirm(ch, keyName);
      return;
    }

    // ── tab always toggles focus panels ────────────────────────────────────

    if (keyName === 'tab') {
      focusMode = focusMode === 'left' ? 'right' : 'left';
      updateFocusStyle();
      return;
    }

    // ── Ctrl+C always quits (escape hatch even inside PTY passthrough) ──────

    if (key?.ctrl && keyName === 'c') {
      quit();
      return;
    }

    if (keyName === 'q') { quit(); return; }
    if (keyName === '?') { helpOverlay.toggle(); return; }
    if (keyName === 'n' || keyName === 'N') { newSessionDialog.show(); return; }
    if (keyName === 'p' || keyName === 'P') { popoutCurrent(); return; }
    if (keyName === 'd' || keyName === 'D') { detachCurrent(); return; }

    // ── left panel keys ─────────────────────────────────────────────────────

    if (focusMode === 'left') {
      if (ch >= '1' && ch <= '9') {
        leftPanel.jumpTo(parseInt(ch, 10));
        sessionManager.select(leftPanel.getCursorSession()?.id);
        return;
      }

      if (keyName === 'up')    { leftPanel.cursorUp();   return; }
      if (keyName === 'down')  { leftPanel.cursorDown(); return; }

      if (keyName === 'enter') {
        leftPanel.openCurrent();
        focusMode = 'right';
        updateFocusStyle();
        return;
      }
      if (keyName === 'k' || keyName === 'K') { initiateKill();   return; }
      if (keyName === 'r' || keyName === 'R') { leftPanel.scrollToSection('REVIEWS');       return; }
      if (keyName === 'm' || keyName === 'M') { leftPanel.scrollToSection('MODEL ROUTING'); return; }
      return;
    }

    // ── right panel keys ─────────────────────────────────────────────────────
    // Right side is now a smooth overview/preview, not a full PTY passthrough.

    if (focusMode === 'right') {
      if (keyName === 'escape') {
        focusMode = 'left';
        updateFocusStyle();
        return;
      }
      if (keyName === 'up')    { rightPanel.scrollUp(3);    return; }
      if (keyName === 'down')  { rightPanel.scrollDown(3);  return; }
      if (keyName === 'space') { rightPanel.scrollPageDown(); return; }

      if (keyName === 'g' || keyName === 'G') {
        const now = Date.now();
        if (keyName === 'g' && lastKey === 'g' && (now - lastKeyTime) < 500) {
          rightPanel.scrollToTop();
          lastKey = null;
          return;
        }
        rightPanel.scrollToBottom();
        lastKey = keyName;
        lastKeyTime = now;
        return;
      }

      if (keyName === 'k' || keyName === 'K') { initiateKill(); return; }
      return;
    }
  });

  // ── kill flow ─────────────────────────────────────────────────────────────

  let _killPending = false;
  let _killTarget  = null;

  function initiateKill() {
    const session = focusMode === 'right'
      ? sessionManager.getSelected()
      : leftPanel.getCursorSession() || sessionManager.getSelected();
    if (!session) return;

    _killTarget  = session;
    _killPending = true;

    footer.setContent(
      `  {red-fg}Kill session ${session.project}? [y/N]{/}  ` +
      '{grey-fg}(press Y to confirm, any other key cancels){/}'
    );
    screen.render();
  }

  function handleKillConfirm(ch, keyName) {
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
      '  {grey-fg}Tab:focus  ↑↓:nav  Enter:open  N:new  K:kill  D:detach  ' +
      'P:popout  Q:quit  G:tail  Space:pgdn  R:reviews  M:models  ?:help{/}'
    );
  }

  // ── detach ────────────────────────────────────────────────────────────────

  async function detachCurrent() {
    const session = focusMode === 'right'
      ? sessionManager.getSelected()
      : leftPanel.getCursorSession() || sessionManager.getSelected();
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
      recordSessionAction(session, 'TuiDetachFailed', { message: err.message });
      sessionManager.appendLine(session.id,
        `\x1b[31m[vaultflow] Failed to detach session: ${err.message}\x1b[0m`);
      sessionManager.update(session.id, { status: previousStatus });
    }
  }

  async function popoutCurrent() {
    const session = focusMode === 'right'
      ? sessionManager.getSelected()
      : leftPanel.getCursorSession() || sessionManager.getSelected();
    if (!session) return;
    const previousStatus = session.status || 'idle';
    try {
      const result = await launchExternalTerminal(session);
      recordSessionAction(session, 'TuiPopout', { resumable: Boolean(result?.resumable) });
      sessionManager.appendLine(session.id,
        result.resumable
          ? '\x1b[90m[vaultflow] Opened a real terminal window for this tool. Use P again to re-open or resume it from the manager.\x1b[0m'
          : '\x1b[90m[vaultflow] Opened a real terminal window for this tool in the same project directory.\x1b[0m');
      sessionManager.update(session.id, {
        externalLaunches: (session.externalLaunches || 0) + 1,
        lastPoppedOutAt: new Date(),
      });
    } catch (err) {
      recordSessionAction(session, 'TuiPopoutFailed', { message: err.message });
      sessionManager.appendLine(session.id,
        `\x1b[31m[vaultflow] Failed to open external terminal: ${err.message}\x1b[0m`);
      sessionManager.update(session.id, { status: previousStatus });
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

  // ── resize ────────────────────────────────────────────────────────────────

  screen.on('resize', () => {
    try {
      const cols = Math.max(80, screen.width - 37 - 2);
      const rows = Math.max(20, screen.height - 5);
      for (const s of sessionManager.getAll()) {
        if (s.ptyProc) ptyManager.resize(s.id, cols, rows);
      }
      leftPanel.render();
      header.render();
      screen.render();
    } catch {
      // never crash on resize
    }
  });

  // Initial render
  updateFocusStyle();
  screen.render();

  return { screen, quit };
}
