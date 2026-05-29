/**
 * widgets/history-panel.mjs — LEFT column. Recent claude sessions from
 * ~/.claude/history.jsonl, grouped by project (case-insensitive). Enter on
 * a row spawns claude --resume <sid> in a new PTY pane.
 */

import blessed from 'blessed';
import { readHistory, shortProject, relTime } from '../history-reader.mjs';

export const HISTORY_WIDTH = 38;

export function createHistoryPanel(screen, { onSelect } = {}) {
  let entries = [];          // flat list of session entries (sorted by last_ts)
  let slots = [];            // rendered slots: { type:'group'|'session', ... }
  let cursor = 0;
  let focused = false;
  const collapsed = new Set();

  const box = blessed.box({
    top: 1,
    left: 0,
    width: HISTORY_WIDTH,
    height: '100%-2',
    tags: true,
    border: { type: 'line' },
    label: ' history ',
    style: { border: { fg: 'grey' }, label: { fg: 'grey' } },
    scrollable: true,
    alwaysScroll: true,
  });

  function rebuild() {
    entries = readHistory({ limit: 300 });
    // Group by project (case-insensitive)
    const groups = new Map();
    for (const e of entries) {
      const key = (e.project || '(none)').toLowerCase();
      if (!groups.has(key)) groups.set(key, { label: shortProject(e.project), sessions: [], lastTs: 0 });
      const g = groups.get(key);
      g.sessions.push(e);
      if (e.lastTs > g.lastTs) g.lastTs = e.lastTs;
    }
    const ordered = Array.from(groups.entries())
      .sort((a, b) => b[1].lastTs - a[1].lastTs);
    slots = [];
    for (const [key, g] of ordered) {
      slots.push({ type: 'group', key, label: g.label, count: g.sessions.length, lastTs: g.lastTs });
      if (!collapsed.has(key)) {
        for (const s of g.sessions) slots.push({ type: 'session', entry: s });
      }
    }
    if (cursor >= slots.length) cursor = Math.max(0, slots.length - 1);
  }

  function render() {
    const w = HISTORY_WIDTH - 2;
    const lines = [];
    slots.forEach((slot, i) => {
      const onCursor = i === cursor && focused;
      if (slot.type === 'group') {
        const chev = collapsed.has(slot.key) ? '▶' : '▼';
        const label = slot.label.length > w - 6 ? slot.label.slice(0, w - 7) + '…' : slot.label;
        const text = `${chev} ${label} (${slot.count})`;
        lines.push(onCursor
          ? `{black-bg}{yellow-fg}${text.padEnd(w)}{/}`
          : `{cyan-fg}${text}{/}`);
      } else {
        const e = slot.entry;
        const name = (e.name || '').replace(/[{}]/g, '');
        const t = relTime(e.lastTs).padStart(3);
        const left = '  ' + name;
        const maxLeft = w - t.length - 1;
        const trimmed = left.length > maxLeft ? left.slice(0, maxLeft - 1) + '…' : left.padEnd(maxLeft);
        const text = `${trimmed} ${t}`;
        lines.push(onCursor ? `{yellow-bg}{black-fg}${text}{/}` : text);
      }
    });
    box.setContent(lines.join('\n'));
    // Keep cursor in view
    const top = box.childBase || 0;
    const visible = box.height - 2;
    if (cursor < top) box.scrollTo(cursor);
    else if (cursor >= top + visible) box.scrollTo(cursor - visible + 1);
    screen.render();
  }

  function cursorUp() {
    if (cursor > 0) cursor--;
    render();
  }
  function cursorDown() {
    if (cursor < slots.length - 1) cursor++;
    render();
  }

  function getCursorSlot() {
    return slots[cursor] || null;
  }

  function openCurrent() {
    const slot = getCursorSlot();
    if (!slot) return;
    if (slot.type === 'group') {
      if (collapsed.has(slot.key)) collapsed.delete(slot.key);
      else collapsed.add(slot.key);
      rebuild();
      render();
      return;
    }
    if (slot.type === 'session' && onSelect) onSelect(slot.entry);
  }

  function setFocused(v) {
    focused = !!v;
    box.style.border.fg = focused ? 'yellow' : 'grey';
    box.style.label.fg = focused ? 'yellow' : 'grey';
    render();
  }

  function refresh() {
    rebuild();
    render();
  }

  rebuild();

  return { box, render, refresh, cursorUp, cursorDown, openCurrent, setFocused, getCursorSlot };
}
