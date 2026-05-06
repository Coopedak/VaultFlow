/**
 * widgets/help-overlay.mjs — ? key keybinding reference overlay
 *
 * A centered blessed box that renders static help text.
 * Toggled via the ? key. Any key dismisses it.
 */

import blessed from 'blessed';

const HELP_TEXT = `
{bold}{white-fg} vaultflow TUI — Keybindings{/}
{grey-fg}─────────────────────────────────────────────────────────────────────{/}

{bold}Navigation{/}
  {cyan-fg}Tab{/}          Switch focus: left panel ↔ right panel
  {cyan-fg}↑ / ↓{/}        Navigate sessions (left) or scroll output (right)
  {cyan-fg}Enter{/}        Open session in right panel
  {cyan-fg}1–9{/}          Jump to session by position
  {cyan-fg}/{/}            Search sessions (filter left panel)

{bold}Session Actions{/}
  {cyan-fg}N{/}            New session dialog
  {cyan-fg}K{/}            Kill session (prompts for confirmation)
  {cyan-fg}D{/}            Detach session (background, remove from list)
  {cyan-fg}Q{/}  {cyan-fg}C-c{/}       Quit TUI (sessions keep running)

{bold}Right Panel{/}
  {cyan-fg}Space{/}        Scroll down one page
  {cyan-fg}G{/}            Jump to bottom (live tail)
  {cyan-fg}g g{/}          Jump to top

{bold}Reviews{/}
  {cyan-fg}R{/}            Jump to REVIEWS section
  {cyan-fg}A{/}            Approve (when review overlay shown)
  {cyan-fg}X{/}            Block (when review overlay shown)
  {cyan-fg}V{/}            View diff (when review overlay shown)

{bold}Other{/}
  {cyan-fg}M{/}            Jump to MODEL ROUTING section
  {cyan-fg}Esc{/}          Close dialog / cancel
  {cyan-fg}?{/}            Toggle this help

{grey-fg}─────────────────────────────────────────────────────────────────────{/}
  {grey-fg}Press any key to dismiss{/}
`;

export function createHelpOverlay(screen) {
  let visible = false;

  const box = blessed.box({
    top:     'center',
    left:    'center',
    width:   72,
    height:  32,
    tags:    true,
    hidden:  true,
    border:  { type: 'line' },
    style: {
      fg:     'white',
      bg:     'black',
      border: { fg: '#ff8800' },
    },
    content: HELP_TEXT,
  });

  function show() {
    visible = true;
    box.show();
    box.setFront();
    screen.render();
  }

  function hide() {
    visible = false;
    box.hide();
    screen.render();
  }

  function toggle() {
    if (visible) hide();
    else show();
  }

  function isVisible() {
    return visible;
  }

  return { box, show, hide, toggle, isVisible };
}
