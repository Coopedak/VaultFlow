/**
 * widgets/right-panel.mjs — session header bar + scrollable PTY output log
 *
 * Layout:
 *   [2-row session header]
 *   [scrollable PTY output — blessed log box]
 *
 * When focused: keystrokes pass through to the active PTY process.
 * When live tail (scrollPos === -1): auto-scrolls to bottom on new output.
 */

import blessed            from 'blessed';
import { sessionManager } from '../session-manager.mjs';
import { ptyManager }     from '../pty-manager.mjs';
import { ansiToBlessed }  from '../ansi.mjs';

const LEFT_WIDTH = 37;  // left panel (36) + divider (1)

// Tool color tags
const TOOL_COLORS = {
  'claude':     '{#ff8800-fg}',
  'gh-copilot': '{magenta-fg}',
  'codex':      '{cyan-fg}',
};

function elapsed(startedAt) {
  const ms  = Date.now() - new Date(startedAt).getTime();
  const s   = Math.floor(ms / 1000);
  const m   = Math.floor(s / 60);
  const h   = Math.floor(m / 60);
  const mm  = String(m % 60).padStart(2, '0');
  const ss  = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

function buildHeaderContent(session) {
  if (!session) {
    return '{grey-fg}  No session open  Press N to launch one{/}';
  }

  const color   = TOOL_COLORS[session.tool] || '{white-fg}';
  const project = session.project;
  const tool    = session.tool === 'claude' ? 'claude' :
                  session.tool === 'gh-copilot' ? 'gh copilot' : 'codex';
  const dur     = elapsed(session.startedAt);
  const tokens  = session.tokens.toLocaleString();
  const edits   = `${session.edits} edit${session.edits !== 1 ? 's' : ''}`;
  const sId     = session.sessionId ? `s#${session.sessionId}` : 'live';

  let statusTag;
  if (session.status === 'running') {
    statusTag = '{green-fg}● LIVE{/}';
  } else if (session.status === 'idle') {
    statusTag = '{grey-fg}○ IDLE{/}';
  } else if (session.status === 'notification') {
    statusTag = '{yellow-fg}⚠ REVIEW{/}';
  } else if (session.status === 'crashed') {
    statusTag = '{red-fg}✗ CRASHED{/}';
  } else {
    statusTag = '{grey-fg}○ IDLE{/}';
  }

  return (
    `  ${color}${project} [${tool}]{/}` +
    `  ── ${dur} ──` +
    ` ${tokens} tok ──` +
    ` ${edits} ──` +
    ` ${sId}  ${statusTag}`
  );
}

export function createRightPanel(screen) {
  const left   = LEFT_WIDTH;
  const width  = `100%-${left}`;

  // Session header box (2 rows)
  const headerBox = blessed.box({
    top:    1,
    left,
    width,
    height: 2,
    tags:   true,
    style: {
      fg: 'white',
      bg: 'black',
      border: { fg: 'grey' },
    },
    border: { type: 'line', bottom: true },
  });

  // Output log box (scrollable)
  const logBox = blessed.box({
    top:          3,   // below header row + border
    left,
    width,
    height:       '100%-4',  // minus header(2) + border(1) + footer(1)
    tags:         true,
    scrollable:   true,
    alwaysScroll: true,
    mouse:        true,
    keys:         false,
    wrap:         true,
    style: {
      fg:        'white',
      bg:        'black',
      scrollbar: { bg: 'grey' },
    },
  });

  // Divider between left and right panels
  const divider = blessed.line({
    top:         1,
    left:        LEFT_WIDTH - 1,
    orientation: 'vertical',
    height:      '100%-2',
    style:       { fg: 'grey', bg: 'black' },
  });

  let liveTail = true;  // track whether we're auto-scrolling

  // ── content management ────────────────────────────────────────────────────

  function renderHeader(session) {
    try {
      headerBox.setContent(buildHeaderContent(session));
    } catch {
      // never crash
    }
  }

  function renderLog(session) {
    if (!session) {
      logBox.setContent(
        '\n\n  {grey-fg}vaultflow{/}\n\n' +
        '  {grey-fg}No session open.{/}\n' +
        '  {grey-fg}Press N to launch one, or select a session in the left panel.{/}'
      );
      return;
    }

    const lines = session.lines.map(l => {
      try { return ansiToBlessed(l); }
      catch { return l; }
    });

    logBox.setContent(lines.join('\n'));

    if (liveTail) {
      logBox.setScrollPerc(100);
    }
  }

  // ── event wiring ──────────────────────────────────────────────────────────

  sessionManager.on('selected', (session) => {
    renderHeader(session);
    liveTail = true;
    renderLog(session);
    screen.render();
  });

  sessionManager.on('updated', (session) => {
    const selected = sessionManager.getSelected();
    if (selected?.id === session.id) {
      renderHeader(session);
      screen.render();
    }
  });

  // High-frequency output event — append efficiently
  sessionManager.on('output', (session, _line) => {
    const selected = sessionManager.getSelected();
    if (selected?.id !== session.id) return;

    try {
      // Re-render the full content (blessed doesn't support append-only well)
      // For large buffers, render just the last 200 lines to keep it fast
      const lines = session.lines.slice(-200).map(l => {
        try { return ansiToBlessed(l); }
        catch { return l; }
      });
      logBox.setContent(lines.join('\n'));
      if (liveTail) {
        logBox.setScrollPerc(100);
      }
      screen.render();
    } catch {
      // never crash
    }
  });

  // ── scroll controls ───────────────────────────────────────────────────────

  function scrollDown(lines = 5) {
    liveTail = false;
    logBox.scroll(lines);
    screen.render();
  }

  function scrollUp(lines = 5) {
    liveTail = false;
    logBox.scroll(-lines);
    screen.render();
  }

  function scrollPageDown() {
    liveTail = false;
    const h = logBox.height || 20;
    logBox.scroll(h - 2);
    screen.render();
  }

  function scrollToBottom() {
    liveTail = true;
    logBox.setScrollPerc(100);
    screen.render();
  }

  function scrollToTop() {
    liveTail = false;
    logBox.setScrollPerc(0);
    screen.render();
  }

  // ── PTY passthrough ───────────────────────────────────────────────────────

  /**
   * Called by app.mjs when right panel has focus and a key is pressed.
   * Forwards keystrokes to the active PTY.
   */
  function forwardKey(key) {
    const session = sessionManager.getSelected();
    if (!session) return;
    ptyManager.write(session.id, key);
  }

  // Initial empty render
  renderHeader(null);
  renderLog(null);

  return {
    headerBox,
    logBox,
    divider,
    scrollDown,
    scrollUp,
    scrollPageDown,
    scrollToBottom,
    scrollToTop,
    forwardKey,
    setLiveTail: (val) => { liveTail = val; },
  };
}
