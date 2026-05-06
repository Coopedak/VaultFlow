/**
 * app.mjs — screen setup, layout assembly, global keybindings
 *
 * WHY: Central orchestrator. Creates the blessed screen, instantiates all
 * widgets, wires up the global keybinding dispatch, and handles resize.
 *
 * Focus model:
 *   'left'  — session list navigation (↑↓ = cursor, Enter = open)
 *   'right' — right panel (↑↓ = scroll, keystrokes → PTY)
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
import { closeDb }                from './db-reader.mjs';

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
      // Open selected session in right panel
      sessionManager.select(session.id);
    },
  });
  const rightPanel = createRightPanel(screen);
  const helpOverlay = createHelpOverlay(screen);
  const newSessionDialog = createNewSessionDialog(screen, {
    onLaunch: (session) => {
      // Switch right panel to newly launched session
      sessionManager.select(session.id);
      focusMode = 'right';
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
      'Q:quit  G:tail  Space:pgdn  R:reviews  M:models  ?:help{/}',
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
  screen.append(rightPanel.logBox);
  screen.append(footer);
  screen.append(helpOverlay.box);
  screen.append(newSessionDialog.container);

  // ── focus state ───────────────────────────────────────────────────────────

  let focusMode = 'left';  // 'left' | 'right'

  function updateFocusStyle() {
    // Visual indicator: left panel border color when focused
    if (focusMode === 'left') {
      leftPanel.box.style.border = { fg: '#ff8800' };
    } else {
      leftPanel.box.style.border = {};
    }
    screen.render();
  }

  // ── global keybindings ────────────────────────────────────────────────────

  // Track 'g g' double-g sequence
  let lastKey = null;
  let lastKeyTime = 0;

  screen.on('keypress', (ch, key) => {
    const keyName = key?.name || ch;

    // ── modal layers take priority ──

    if (helpOverlay.isVisible()) {
      helpOverlay.hide();
      return;
    }

    if (newSessionDialog.isVisible()) {
      if (newSessionDialog.handleKey(keyName, ch)) return;
      return;  // consume all keys while dialog open
    }

    // ── kill confirm inline prompt ──

    if (_killPending) {
      handleKillConfirm(ch, keyName);
      return;
    }

    // ── always-on global keys ──

    if (keyName === 'q' || (key?.ctrl && keyName === 'c')) {
      quit();
      return;
    }

    if (keyName === '?') {
      helpOverlay.toggle();
      return;
    }

    if (keyName === 'n' || keyName === 'N') {
      newSessionDialog.show();
      return;
    }

    if (keyName === 'tab') {
      focusMode = focusMode === 'left' ? 'right' : 'left';
      updateFocusStyle();
      return;
    }

    // ── number shortcuts 1–9 ──
    if (ch >= '1' && ch <= '9') {
      leftPanel.jumpTo(parseInt(ch, 10));
      sessionManager.select(leftPanel.getCursorSession()?.id);
      return;
    }

    // ── left panel keys ──────────────────────────────────────────────────────

    if (focusMode === 'left') {
      if (keyName === 'up') {
        leftPanel.cursorUp();
        return;
      }
      if (keyName === 'down') {
        leftPanel.cursorDown();
        return;
      }
      if (keyName === 'enter') {
        leftPanel.openCurrent();
        focusMode = 'right';
        updateFocusStyle();
        return;
      }
      if (keyName === 'k' || keyName === 'K') {
        initiateKill();
        return;
      }
      if (keyName === 'd' || keyName === 'D') {
        detachCurrent();
        return;
      }
      if (keyName === 'r' || keyName === 'R') {
        // Jump to reviews — just scroll left panel to REVIEWS section
        leftPanel.box.scroll(20);
        screen.render();
        return;
      }
      if (keyName === 'm' || keyName === 'M') {
        // Jump to model routing — scroll left panel further
        leftPanel.box.scroll(35);
        screen.render();
        return;
      }
      return;
    }

    // ── right panel keys ─────────────────────────────────────────────────────

    if (focusMode === 'right') {
      if (keyName === 'up') {
        rightPanel.scrollUp(3);
        return;
      }
      if (keyName === 'down') {
        rightPanel.scrollDown(3);
        return;
      }
      if (keyName === 'space') {
        rightPanel.scrollPageDown();
        return;
      }
      if (keyName === 'g' || keyName === 'G') {
        // Check for 'g g' sequence (within 500ms)
        const now = Date.now();
        if (keyName === 'g' && lastKey === 'g' && (now - lastKeyTime) < 500) {
          rightPanel.scrollToTop();
          lastKey = null;
          return;
        }
        // Capital G or single g → scroll to bottom
        rightPanel.scrollToBottom();
        lastKey = keyName;
        lastKeyTime = now;
        return;
      }
      if (keyName === 'k' || keyName === 'K') {
        // K in right panel = kill current session
        initiateKill();
        return;
      }
      if (keyName === 'escape') {
        focusMode = 'left';
        updateFocusStyle();
        return;
      }

      // All other keystrokes forward to PTY
      const session = sessionManager.getSelected();
      if (session?.ptyProc) {
        rightPanel.forwardKey(ch || key?.sequence || keyName);
      }
      return;
    }
  });

  // ── kill flow ─────────────────────────────────────────────────────────────

  let _killPending = false;
  let _killTarget  = null;

  function initiateKill() {
    const session = leftPanel.getCursorSession() || sessionManager.getSelected();
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
      'Q:quit  G:tail  Space:pgdn  R:reviews  M:models  ?:help{/}'
    );
  }

  // ── detach ────────────────────────────────────────────────────────────────

  function detachCurrent() {
    const session = leftPanel.getCursorSession() || sessionManager.getSelected();
    if (!session) return;
    // Keep PTY running, remove from list
    sessionManager.remove(session.id);
    leftPanel.render();
  }

  // ── quit ─────────────────────────────────────────────────────────────────

  function quit() {
    // Sessions keep running — just remove from list so they detach
    // ptyManager.killAll() would stop them; we intentionally don't call it
    try { closeDb(); } catch {}
    screen.destroy();
    process.exit(0);
  }

  // ── resize ────────────────────────────────────────────────────────────────

  screen.on('resize', () => {
    try {
      // Resize all active PTYs to match new right panel dimensions
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
  screen.render();

  return { screen, quit };
}
