/**
 * ansi.mjs — ANSI escape sequence → blessed color tag converter
 *
 * WHY: PTY output arrives with raw ANSI codes. Blessed renders its own
 * tag markup like {green-fg}. This module bridges the two formats so
 * PTY output can be displayed in a blessed box with correct colors.
 */

// Map ANSI color codes to blessed tags.
// Only foreground colors are mapped; background and 256-color are stripped.
const COLOR_MAP = {
  '0':  '{/}',
  '1':  '{bold}',
  '2':  '{grey-fg}',
  '3':  '{italic}',          // blessed may not support — ignored gracefully
  '22': '{/bold}',
  '30': '{black-fg}',
  '31': '{red-fg}',
  '32': '{green-fg}',
  '33': '{yellow-fg}',
  '34': '{blue-fg}',
  '35': '{magenta-fg}',
  '36': '{cyan-fg}',
  '37': '{white-fg}',
  '39': '{/fg}',
  '90': '{grey-fg}',
  '91': '{red-fg}',
  '92': '{green-fg}',
  '93': '{yellow-fg}',
  '94': '{blue-fg}',
  '95': '{magenta-fg}',
  '96': '{cyan-fg}',
  '97': '{white-fg}',
};

/**
 * Convert a raw ANSI string to a blessed-tagged string.
 *
 * @param {string} raw — raw string potentially containing ANSI codes
 * @returns {string} blessed-tagged string safe for use in blessed content
 */
export function ansiToBlessed(raw) {
  if (!raw || typeof raw !== 'string') return '';

  // First, escape any literal { and } that aren't part of blessed tags.
  // We'll do this before inserting tags, then unescape our own tags.
  // Strategy: replace all { and } with placeholders, insert tags, restore.
  const OPEN  = '\x00OPEN\x00';
  const CLOSE = '\x00CLOSE\x00';

  let out = raw
    .replace(/\{/g, OPEN)
    .replace(/\}/g, CLOSE);

  // Replace known ANSI sequences with blessed tags.
  // \x1b[ ... m — SGR (Select Graphic Rendition)
  out = out.replace(/\x1b\[([0-9;]*)m/g, (_match, codes) => {
    if (!codes) return '{/}';
    const parts = codes.split(';');
    const tags = [];
    for (const code of parts) {
      const tag = COLOR_MAP[code];
      if (tag) tags.push(tag);
      // 256-color sequences (38;5;N or 48;5;N) — skip, will be stripped below
    }
    return tags.join('') || '';
  });

  // Strip all remaining unrecognized escape sequences (cursor moves, etc.)
  out = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  out = out.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, ''); // OSC sequences
  out = out.replace(/\x1b[^[\]]/g, ''); // other ESC sequences
  out = out.replace(/\x1b/g, '');       // any leftover bare ESC

  // Strip \r (carriage return) — leave \n intact
  out = out.replace(/\r/g, '');

  // Restore escaped braces (not part of any tag we inserted)
  out = out.replace(new RegExp(OPEN, 'g'), '{\\{');
  out = out.replace(new RegExp(CLOSE, 'g'), '\\}');

  return out;
}

/**
 * Strip all ANSI codes, returning plain text.
 * Used for width calculations and search.
 */
export function stripAnsi(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[^[\]]/g, '')
    .replace(/\x1b/g, '')
    .replace(/\r/g, '');
}
