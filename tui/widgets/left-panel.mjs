/**
 * widgets/left-panel.mjs — sessions list + reviews + model routing + tools
 *
 * Layout (36 cols fixed, including 1-char border on each side = 34 content):
 *   SESSIONS (collapsible groups per tool)
 *   REVIEWS
 *   MODEL ROUTING
 *   TOOLS
 *
 * Navigation is handled by app.mjs via cursorUp/cursorDown/openCurrent.
 * Mouse clicks are handled internally via box.on('click').
 */

import blessed            from 'blessed';
import { sessionManager } from '../session-manager.mjs';
import { getModelRouting, getTopTools } from '../db-reader.mjs';

const PANEL_WIDTH = 36;

const TOOL_META = {
  'claude':     { label: 'Claude Code', badge: 'CC', color: '{yellow-fg}' },
  'gh-copilot': { label: 'Copilot',     badge: 'CP', color: '{magenta-fg}' },
  'codex':      { label: 'Codex',       badge: 'CX', color: '{cyan-fg}' },
};

const STATUS_DOTS = {
  running:      '{green-fg}●{/}',
  idle:         '{grey-fg}○{/}',
  notification: '{yellow-fg}●{/}',
  crashed:      '{red-fg}✗{/}',
};

function elapsed(startedAt) {
  const ms = Date.now() - new Date(startedAt).getTime();
  const m  = Math.floor(ms / 60000);
  const h  = Math.floor(m / 60);
  if (h > 0) return `${h}h${m % 60}m`;
  return `${m}m`;
}

function formatTokens(n) {
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

export function createLeftPanel(screen, { onSessionSelect } = {}) {
  const collapsed = { 'claude': false, 'gh-copilot': false, 'codex': false };

  let cursor = 0;        // index into rendered slots
  let _cursorInit = false; // true once cursor has been placed on a session

  // Rendered slots: { type, session?, tool?, label? }
  let slots = [];

  const box = blessed.box({
    top:          1,
    left:         0,
    width:        PANEL_WIDTH,
    height:       '100%-2',
    tags:         true,
    scrollable:   true,
    alwaysScroll: true,
    mouse:        true,
    keys:         false,
    border:       { type: 'line' },
    style: {
      fg:        'white',
      bg:        'black',
      border:    { fg: 'grey' },
      scrollbar: { bg: 'grey' },
    },
  });

  // ── rendering ────────────────────────────────────────────────────────────────

  function buildContent() {
    const groups   = sessionManager.getGrouped();
    const selected = sessionManager.getSelected();
    const lines    = [];
    slots = [];

    // SESSIONS header
    lines.push('{bold}SESSIONS{/}');
    slots.push({ type: 'section-header', label: 'SESSIONS' });

    for (const tool of ['claude', 'gh-copilot', 'codex']) {
      const meta     = TOOL_META[tool];
      const sessions = groups[tool];
      const isOpen   = !collapsed[tool];
      const arrow    = isOpen ? '▼' : '▶';
      const count    = sessions.length;
      const dimCount = count === 0 ? ` {grey-fg}(0){/}` : '';

      const groupLine =
        `${arrow} ${meta.color}${meta.label} [${meta.badge}]{/}${dimCount}`;
      lines.push(groupLine);
      slots.push({ type: 'group-header', tool });

      if (isOpen) {
        if (sessions.length === 0) {
          lines.push('  {grey-fg}(none){/}');
          slots.push({ type: 'empty', tool });
        }
        for (const s of sessions) {
          const isSelected = s.id === selected?.id;
          const isCursor   = slots.length === cursor;
          const dot        = STATUS_DOTS[s.status] || STATUS_DOTS.idle;
          const dur        = elapsed(s.startedAt);
          const tok        = formatTokens(s.tokens);
          const editsStr   = `${s.edits} edit${s.edits !== 1 ? 's' : ''}`;
          const sId        = s.sessionId ? `s#${s.sessionId}` : '';
          const warn       = s.status === 'notification' ? ' ⚠' : '';

          const namePart = s.project.slice(0, 14).padEnd(14);
          const durPart  = dur.padStart(4);

          let line1 = ` ${dot} ${meta.color}${namePart}{/}  ${durPart}${warn}`;
          let line2 = `    ${tok.padEnd(8)} ${editsStr.padEnd(10)} ${sId}`;

          if (isSelected || isCursor) {
            line1 = `{inverse}${line1}{/}`;
            line2 = `{inverse}${line2}{/}`;
          }

          lines.push(line1);
          lines.push(line2);
          slots.push({ type: 'session',       session: s });
          slots.push({ type: 'session-line2', session: s });
        }
      }
    }

    // REVIEWS section
    lines.push('');
    lines.push('{bold}REVIEWS{/}');
    slots.push({ type: 'section-header', label: 'REVIEWS' });

    const withReview = sessionManager.getAll().filter(s => s.pendingReview);
    if (withReview.length === 0) {
      lines.push(' {green-fg}✓ No pending reviews{/}');
    } else {
      lines.push(` {yellow-fg}⚠ ${withReview.length} pending{/}`);
      for (const s of withReview.slice(0, 2)) {
        lines.push(`  plan review — ${s.project.slice(0, 12)}`);
      }
      if (withReview.length > 2) {
        lines.push(`  {grey-fg}+ ${withReview.length - 2} more{/}`);
      }
    }

    // MODEL ROUTING section
    lines.push('');
    lines.push('{bold}MODEL ROUTING{/}');
    slots.push({ type: 'section-header', label: 'MODEL ROUTING' });

    const routing = getModelRouting();
    if (routing.length === 0) {
      lines.push(' {grey-fg}(no data){/}');
    } else {
      for (const r of routing.slice(0, 5)) {
        const pctColor = r.approvalRate >= 95 ? '{green-fg}' :
                         r.approvalRate >= 80 ? '{yellow-fg}' : '{red-fg}';
        const lock     = r.pinned ? '🔒 ' : '';
        const name     = r.agent.slice(0, 13).padEnd(13);
        const model    = r.model.slice(0, 6).padEnd(6);
        const pctStr   = `${pctColor}${r.approvalRate}%{/}`;
        lines.push(` ${lock}${name} ${model} ${pctStr}`);
      }
    }

    // TOOLS section
    lines.push('');
    lines.push('{bold}TOOLS{/}');
    slots.push({ type: 'section-header', label: 'TOOLS' });

    const selectedSession = sessionManager.getSelected();
    const tools = getTopTools(selectedSession?.sessionId || null, 3);
    if (tools.length === 0) {
      lines.push(' {grey-fg}(no data){/}');
    } else {
      tools.forEach((t, i) => {
        const name = t.file.slice(0, 16).padEnd(16);
        lines.push(` ${i + 1}. ${name} ×${t.count}`);
      });
    }

    // On first build that has sessions, place cursor on the first session slot
    if (!_cursorInit) {
      const firstSession = slots.findIndex(s => s.type === 'session');
      if (firstSession >= 0) {
        cursor = firstSession;
        _cursorInit = true;
      }
    }

    // Clamp cursor to valid slot range
    if (cursor >= slots.length) cursor = Math.max(0, slots.length - 1);

    return lines.join('\n');
  }

  function render() {
    try {
      box.setContent(buildContent());
      screen.render();
    } catch {
      // never crash TUI
    }
  }

  // ── cursor navigation ─────────────────────────────────────────────────────

  function cursorUp() {
    for (let i = cursor - 1; i >= 0; i--) {
      if (slots[i]?.type === 'session') {
        cursor = i;
        render();
        return;
      }
    }
  }

  function cursorDown() {
    for (let i = cursor + 1; i < slots.length; i++) {
      if (slots[i]?.type === 'session') {
        cursor = i;
        render();
        return;
      }
    }
  }

  function openCurrent() {
    const slot = slots[cursor];
    if (slot?.type === 'session' && slot.session) {
      sessionManager.select(slot.session.id);
      if (onSessionSelect) onSessionSelect(slot.session);
    }
  }

  function getCursorSession() {
    const slot = slots[cursor];
    if (slot?.type === 'session') return slot.session;
    return null;
  }

  function jumpTo(n) {
    const flat   = sessionManager.getFlat();
    const target = flat[n - 1];
    if (!target) return;
    const idx = slots.findIndex(s => s.type === 'session' && s.session?.id === target.id);
    if (idx >= 0) {
      cursor = idx;
      sessionManager.select(target.id);
      render();
    }
  }

  function toggleGroup(tool) {
    collapsed[tool] = !collapsed[tool];
    render();
  }

  // ── section scroll ────────────────────────────────────────────────────────

  /**
   * Scroll the panel so that the given section header is at the top.
   * Uses the rendered line content to find the section.
   */
  function scrollToSection(name) {
    try {
      const content = buildContent();
      const lines   = content.split('\n');
      const idx     = lines.findIndex(l => l.includes(name));
      if (idx >= 0) {
        box.scrollTo(idx);
        screen.render();
      }
    } catch {}
  }

  // ── mouse click ───────────────────────────────────────────────────────────

  box.on('click', (data) => {
    try {
      // data.y is absolute screen position. atop is the box's absolute top.
      // Border takes 1 row. childBase is the scroll offset.
      const borderOffset = box.border ? 1 : 0;
      const lineIdx = data.y - (box.atop || 0) - borderOffset + (box.childBase || 0);
      if (lineIdx < 0 || lineIdx >= slots.length) return;

      const slot = slots[lineIdx];
      if (!slot?.session) return;

      const session = slot.session;
      const sIdx = slots.findIndex(
        s => s.type === 'session' && s.session?.id === session.id
      );
      if (sIdx < 0) return;

      cursor = sIdx;
      sessionManager.select(session.id);
      if (onSessionSelect) onSessionSelect(session);
      render();
    } catch {}
  });

  // ── group header click (toggle collapse) ─────────────────────────────────

  box.on('click', (data) => {
    try {
      const borderOffset = box.border ? 1 : 0;
      const lineIdx = data.y - (box.atop || 0) - borderOffset + (box.childBase || 0);
      if (lineIdx < 0 || lineIdx >= slots.length) return;
      const slot = slots[lineIdx];
      if (slot?.type === 'group-header' && slot.tool) {
        toggleGroup(slot.tool);
      }
    } catch {}
  });

  // ── event wiring ──────────────────────────────────────────────────────────

  sessionManager.on('added',    render);
  sessionManager.on('removed',  render);
  sessionManager.on('updated',  render);
  sessionManager.on('selected', render);

  render();

  return {
    box,
    render,
    cursorUp,
    cursorDown,
    openCurrent,
    getCursorSession,
    jumpTo,
    toggleGroup,
    scrollToSection,
  };
}
