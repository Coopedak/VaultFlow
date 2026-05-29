/**
 * widgets/live-panel.mjs — RIGHT column. Currently-running PTY sessions.
 * Enter on a row selects the session (its output shows in the middle panel).
 */

import blessed from 'blessed';
import { sessionManager } from '../session-manager.mjs';

export const LIVE_WIDTH = 30;

const STATUS_DOT = {
  running:      '{green-fg}●{/}',
  idle:         '{grey-fg}○{/}',
  notification: '{yellow-fg}●{/}',
  crashed:      '{red-fg}✗{/}',
};

export function createLivePanel(screen, { onSelect } = {}) {
  let sessions = [];
  let cursor = 0;
  let focused = false;

  const box = blessed.box({
    top: 1,
    right: 0,
    width: LIVE_WIDTH,
    height: '100%-2',
    tags: true,
    border: { type: 'line' },
    label: ' live ',
    style: { border: { fg: 'grey' }, label: { fg: 'grey' } },
    scrollable: true,
    alwaysScroll: true,
  });

  function rebuild() {
    sessions = sessionManager.getAll();
    if (cursor >= sessions.length) cursor = Math.max(0, sessions.length - 1);
  }

  function render() {
    const w = LIVE_WIDTH - 2;
    const sel = sessionManager.getSelected();
    if (sessions.length === 0) {
      box.setContent('  {grey-fg}No live sessions.{/}\n  {grey-fg}Press Enter on a{/}\n  {grey-fg}history row, or N{/}\n  {grey-fg}to spawn one.{/}');
      screen.render();
      return;
    }
    const lines = [];
    sessions.forEach((s, i) => {
      const dot = STATUS_DOT[s.status] || STATUS_DOT.idle;
      const isSelected = sel && sel.id === s.id;
      const isCursor = i === cursor && focused;
      const tool = s.tool.padEnd(3).slice(0, 3);
      const proj = String(s.project || 'session').replace(/[{}]/g, '');
      const inner = `${dot} ${tool} ${proj}`;
      const plain = `  ${s.tool[0].toUpperCase()} ${proj}`;
      const trim = plain.length > w ? plain.slice(0, w - 1) + '…' : plain.padEnd(w);
      const prefix = isSelected ? '{cyan-fg}▶{/}' : ' ';
      const text = `${prefix}${inner}`;
      lines.push(isCursor
        ? `{yellow-bg}{black-fg}${trim}{/}`
        : (isSelected ? `{cyan-fg}${trim}{/}` : trim));
    });
    box.setContent(lines.join('\n'));
    screen.render();
  }

  function cursorUp()   { if (cursor > 0) cursor--; render(); }
  function cursorDown() { if (cursor < sessions.length - 1) cursor++; render(); }

  function openCurrent() {
    const s = sessions[cursor];
    if (s && onSelect) onSelect(s);
  }

  function getCursorSession() { return sessions[cursor] || null; }

  function setFocused(v) {
    focused = !!v;
    box.style.border.fg = focused ? 'yellow' : 'grey';
    box.style.label.fg = focused ? 'yellow' : 'grey';
    render();
  }

  // React to session lifecycle
  sessionManager.on('added',    () => { rebuild(); render(); });
  sessionManager.on('removed',  () => { rebuild(); render(); });
  sessionManager.on('updated',  () => { render(); });
  sessionManager.on('selected', () => { render(); });

  rebuild();

  return { box, render, cursorUp, cursorDown, openCurrent, setFocused, getCursorSession };
}
