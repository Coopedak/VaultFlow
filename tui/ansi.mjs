/**
 * ansi.mjs — ANSI escape sequence → blessed color tag converter
 *
 * WHY: PTY output arrives with raw ANSI codes. Blessed renders its own
 * tag markup like {green-fg}. This module bridges the two formats so
 * PTY output can be displayed in a blessed box with correct colors.
 *
 * Brace escaping: literal { and } in PTY output are replaced with
 * {open} and {close} (blessed's documented escape sequences) so that
 * they render as actual braces rather than being parsed as tag syntax.
 */

const COLOR_MAP = {
  '0':  '{/}',
  '1':  '{bold}',
  '2':  '{grey-fg}',
  '22': '{/bold}',
  '30': '{black-fg}',
  '31': '{red-fg}',
  '32': '{green-fg}',
  '33': '{yellow-fg}',
  '34': '{blue-fg}',
  '35': '{magenta-fg}',
  '36': '{cyan-fg}',
  '37': '{white-fg}',
  '39': '{/}',
  '90': '{grey-fg}',
  '91': '{red-fg}',
  '92': '{green-fg}',
  '93': '{yellow-fg}',
  '94': '{blue-fg}',
  '95': '{magenta-fg}',
  '96': '{cyan-fg}',
  '97': '{white-fg}',
};

// Unique placeholder strings that will not appear in normal PTY output
const OPEN  = '\x00BOPEN\x00';
const CLOSE = '\x00BCLOSE\x00';

/**
 * Convert a raw ANSI string to a blessed-tagged string.
 *
 * @param {string} raw — raw string potentially containing ANSI codes
 * @returns {string} blessed-tagged string safe for use in blessed content
 */
export function ansiToBlessed(raw) {
  if (!raw || typeof raw !== 'string') return '';

  // Step 1: protect literal braces before we insert blessed tags
  let out = raw
    .replace(/\{/g, OPEN)
    .replace(/\}/g, CLOSE);

  // Step 2: convert ANSI SGR sequences → blessed color tags
  out = out.replace(/\x1b\[([0-9;]*)m/g, (_match, codes) => {
    if (!codes) return '{/}';
    const parts = codes.split(';');
    const tags = [];
    for (const code of parts) {
      const tag = COLOR_MAP[code];
      if (tag) tags.push(tag);
    }
    return tags.join('') || '';
  });

  // Step 3: strip all remaining unrecognized escape sequences
  out = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');          // CSI sequences
  out = out.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, ''); // OSC sequences
  out = out.replace(/\x1b[^[\]]/g, '');                       // other ESC
  out = out.replace(/\x1b/g, '');                             // leftover bare ESC

  // Step 4: strip \r — leave \n intact for line splitting upstream
  out = out.replace(/\r/g, '');

  // Step 5: restore protected braces using blessed's documented escape tags
  out = out.replace(new RegExp(OPEN,  'g'), '{open}');
  out = out.replace(new RegExp(CLOSE, 'g'), '{close}');

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
