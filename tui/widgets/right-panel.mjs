/**
 * widgets/right-panel.mjs — session header bar + scrollable PTY output log
 *
 * Layout:
 *   [2-row session header]
 *   [1-row horizontal separator]
 *   [scrollable PTY output log]
 *
 * When focused: keystrokes pass through to the active PTY process.
 * When live tail (liveTail === true): auto-scrolls to bottom on new output.
 *
 * Output events are debounced to 16ms to prevent re-rendering every PTY line
 * from a fast-outputting CLI (e.g. ng build, cargo build).
 */

import blessed            from 'blessed';
import { sessionManager } from '../session-manager.mjs';
import { ptyManager }     from '../pty-manager.mjs';
import { ansiToBlessed }  from '../ansi.mjs';

const LEFT_WIDTH = 37;  // left panel (36) + divider (1)

const TOOL_COLORS = {
  'claude':     '{yellow-fg}',
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
  const tool    = session.tool === 'claude'     ? 'claude' :
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

  // Vertical divider between left and right panels
  const divider = blessed.box({
    top:    1,
    left:   LEFT_WIDTH - 1,
    width:  1,
    height: '100%-2',
    content: '',
    style:  { fg: 'grey', bg: 'grey' },
  });

  // Session header box (2 rows, no border — separator drawn separately)
  const headerBox = blessed.box({
    top:    1,
    left,
    width,
    height: 2,
    tags:   true,
    style: {
      fg: 'white',
      bg: 'black',
    },
  });

  // Horizontal separator below header
  const headerSep = blessed.box({
    top:     3,
    left,
    width,
    height:  1,
    tags:    false,
    content: '',
    style:   { fg: 'grey', bg: 'black' },
  });

  // Output log box (scrollable)
  const logBox = blessed.box({
    top:          4,   // below header(2) + header-row-1 + separator(1)
    left,
    width,
    height:       '100%-5',  // minus header(2) + top-row(1) + separator(1) + footer(1)
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

  let liveTail = true;

  // ── separator fill ────────────────────────────────────────────────────────

  function updateSepContent() {
    try {
      const w = screen.width - LEFT_WIDTH;
      headerSep.setContent('─'.repeat(Math.max(0, w)));
    } catch {}
  }

  screen.on('resize', updateSepContent);
  // Initial fill after first render
  setTimeout(updateSepContent, 0);

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

  // Debounced output handler — at most one re-render per 16ms animation frame.
  // Without this, a fast-outputting CLI causes hundreds of setContent() calls/sec.
  let _outputTimer = null;

  sessionManager.on('output', (session) => {
    const selected = sessionManager.getSelected();
    if (selected?.id !== session.id) return;

    if (_outputTimer) return;  // render already scheduled
    _outputTimer = setTimeout(() => {
      _outputTimer = null;
      const sel = sessionManager.getSelected();
      if (!sel) return;
      try {
        const lines = sel.lines.slice(-200).map(l => {
          try { return ansiToBlessed(l); }
          catch { return l; }
        });
        logBox.setContent(lines.join('\n'));
        if (liveTail) logBox.setScrollPerc(100);
        screen.render();
      } catch {}
    }, 16);
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
    headerSep,
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
