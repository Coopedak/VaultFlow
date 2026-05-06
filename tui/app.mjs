/**
 * app.mjs — screen setup, layout assembly, global keybindings
 *
 * Focus model:
 *   'left'  — session list navigation (↑↓ = cursor, Enter = open)
 *   'right' — right panel (↑↓ = scroll, keystrokes → PTY)
 *   'dialog' — new-session or help overlay modal (Esc to close)
 *
 * PTY passthrough rule: when focusMode === 'right', ONLY escape/tab/scroll/kill
 * keys are intercepted. Everything else forwards to the active PTY so that
 * q, n, ?, 1-9, etc. reach Claude / Copilot / Codex as intended.
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
      sessionManager.select(session.id);
    },
  });
  const rightPanel = createRightPanel(screen);
  const helpOverlay = createHelpOverlay(screen);
  const newSessionDialog = createNewSessionDialog(screen, {
    onLaunch: (session) => {
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

    // ── left panel keys ─────────────────────────────────────────────────────
    // Only intercept global shortcuts (q, n, ?, 1-9) when left panel is
    // focused. When right panel is focused these must reach the PTY.

    if (focusMode === 'left') {
      if (keyName === 'q') { quit(); return; }
      if (keyName === '?') { helpOverlay.toggle(); return; }
      if (keyName === 'n' || keyName === 'N') { newSessionDialog.show(); return; }

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
      if (keyName === 'd' || keyName === 'D') { detachCurrent();  return; }
      if (keyName === 'r' || keyName === 'R') { leftPanel.scrollToSection('REVIEWS');       return; }
      if (keyName === 'm' || keyName === 'M') { leftPanel.scrollToSection('MODEL ROUTING'); return; }
      return;
    }

    // ── right panel keys ─────────────────────────────────────────────────────
    // Minimal interception: only scroll/kill/escape controls.
    // All other keys (q, n, ?, digits, letters) forward to the PTY so the
    // user can interact with Claude / Copilot / Codex normally.

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

      // All other keystrokes → PTY passthrough
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
    sessionManager.remove(session.id);
  }

  // ── quit ─────────────────────────────────────────────────────────────────

  function quit() {
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
