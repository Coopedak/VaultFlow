/**
 * widgets/header.mjs — full-width header bar
 *
 * Renders: vaultflow  ● N sessions  Tokens: ████████░░  61k/200k  30%
 * Updates whenever the selected session changes or output arrives.
 */

import blessed            from 'blessed';
import { sessionManager } from '../session-manager.mjs';

// Token bar total width (blocks)
const BAR_BLOCKS = 20;

/**
 * Build the token bar string (blessed-tagged).
 */
function tokenBar(tokens, maxTokens) {
  const pct    = maxTokens > 0 ? tokens / maxTokens : 0;
  const filled = Math.min(BAR_BLOCKS, Math.floor(pct * BAR_BLOCKS));
  const empty  = BAR_BLOCKS - filled;

  const color = pct <= 0.50 ? '{green-fg}' :
                pct <= 0.80 ? '{yellow-fg}' :
                              '{red-fg}';

  const bar =
    color +
    '█'.repeat(filled) +
    '{/}' +
    '{grey-fg}' +
    '░'.repeat(empty) +
    '{/}';

  const pctStr  = Math.round(pct * 100) + '%';
  const tokStr  = formatTokens(tokens) + '/' + formatTokens(maxTokens);

  return `Tokens: ${bar}  ${tokStr}  ${pctStr}`;
}

function formatTokens(n) {
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

/**
 * Build the session count + status indicator.
 */
function sessionStatus(sessions) {
  const count = sessions.length;
  const hasNotification = sessions.some(s => s.status === 'notification');

  if (hasNotification) {
    return `{yellow-fg}⚠ AWAITING REVIEW{/}`;
  }
  if (count === 0) {
    return `{grey-fg}○ No sessions{/}`;
  }
  return `{green-fg}● ${count} session${count === 1 ? '' : 's'}{/}`;
}

export function createHeader(screen) {
  const box = blessed.box({
    top:    0,
    left:   0,
    width:  '100%',
    height: 1,
    tags:   true,
    style: {
      fg: 'white',
      bg: 'black',
    },
  });

  function render() {
    const sessions = sessionManager.getAll();
    const selected = sessionManager.getSelected();

    // Pick session for token bar: selected, or highest token usage
    let displaySession = selected;
    if (!displaySession && sessions.length > 0) {
      displaySession = sessions.reduce((a, b) => a.tokens > b.tokens ? a : b);
    }

    const tokens    = displaySession?.tokens    ?? 0;
    const maxTokens = displaySession?.maxTokens ?? 200000;

    const title  = '{bold}{white-fg}vaultflow{/}';
    const status = sessionStatus(sessions);
    const bar    = tokenBar(tokens, maxTokens);

    box.setContent(`  ${title}    ${status}    ${bar}`);
    screen.render();
  }

  // Wire up events
  sessionManager.on('added',    render);
  sessionManager.on('removed',  render);
  sessionManager.on('updated',  render);
  sessionManager.on('selected', render);
  sessionManager.on('output',   render);

  render();

  return { box, render };
}
