/**
 * widgets/left-panel.mjs — sessions list + reviews + model routing + tools
 *
 * Layout (36 cols fixed):
 *   SESSIONS (collapsible groups per tool)
 *   REVIEWS
 *   MODEL ROUTING
 *   TOOLS
 *
 * The panel is a blessed list-like widget with custom content rendering.
 * Navigation is handled by app.mjs via focusLeft / cursor management here.
 */

import blessed            from 'blessed';
import { sessionManager } from '../session-manager.mjs';
import { getModelRouting, getTopTools } from '../db-reader.mjs';

const PANEL_WIDTH = 36;

// Tool display metadata
const TOOL_META = {
  'claude':     { label: 'Claude Code', badge: 'CC', color: '{#ff8800-fg}' },
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
  // Collapsed state per tool group
  const collapsed = { 'claude': false, 'gh-copilot': false, 'codex': false };

  // Cursor position — index into the flat list of rendered "slots"
  let cursor = 0;

  // The rendered slots: each slot is { type, session?, tool? }
  let slots = [];

  const box = blessed.box({
    top:     1,          // below header
    left:    0,
    width:   PANEL_WIDTH,
    height:  '100%-2',   // minus header + footer
    tags:    true,
    scrollable: true,
    alwaysScroll: true,
    mouse:   true,
    keys:    false,       // we handle keys in app.mjs
    style: {
      fg:       'white',
      bg:       'black',
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
          const warn        = s.status === 'notification' ? ' ⚠' : '';

          // Pad to panel width (account for tag overhead)
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
          slots.push({ type: 'session', session: s });
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

  /** Move cursor up, skipping non-session slots. */
  function cursorUp() {
    for (let i = cursor - 1; i >= 0; i--) {
      if (slots[i]?.type === 'session') {
        cursor = i;
        render();
        return;
      }
    }
  }

  /** Move cursor down, skipping non-session slots. */
  function cursorDown() {
    for (let i = cursor + 1; i < slots.length; i++) {
      if (slots[i]?.type === 'session') {
        cursor = i;
        render();
        return;
      }
    }
  }

  /** Open the session currently under the cursor. */
  function openCurrent() {
    const slot = slots[cursor];
    if (slot?.type === 'session' && slot.session) {
      sessionManager.select(slot.session.id);
      if (onSessionSelect) onSessionSelect(slot.session);
    }
  }

  /** Get session under cursor (may be null). */
  function getCursorSession() {
    const slot = slots[cursor];
    if (slot?.type === 'session') return slot.session;
    return null;
  }

  /** Jump to session by 1-based position in flat list. */
  function jumpTo(n) {
    const flat = sessionManager.getFlat();
    const target = flat[n - 1];
    if (!target) return;
    // Find its slot
    const idx = slots.findIndex(s => s.type === 'session' && s.session?.id === target.id);
    if (idx >= 0) {
      cursor = idx;
      sessionManager.select(target.id);
      render();
    }
  }

  /** Toggle collapse for a tool group. */
  function toggleGroup(tool) {
    collapsed[tool] = !collapsed[tool];
    render();
  }

  // Wire events
  sessionManager.on('added',    render);
  sessionManager.on('removed',  render);
  sessionManager.on('updated',  render);
  sessionManager.on('selected', render);
  // Output events are high-frequency — only re-render on token/edit changes
  // (that's handled via 'updated' which fires from pty output parsing)

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
  };
}
