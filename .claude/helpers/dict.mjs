/**
 * dict.mjs — dictionary management CLI and programmatic import API
 *
 * Manages the structured knowledge dictionary in the vaultflow SQLite DB.
 * Auto-populates from vault/domain/ markdown files on session start.
 * Provides BM25 search and term-match injection for anti-hallucination.
 *
 * Categories: domain, acronym, api, schema, command, config, error, stack, pattern
 *
 * CLI usage:
 *   node dict.mjs --import           Import from vault/domain/
 *   node dict.mjs --search <query>   BM25 search
 *   node dict.mjs --add <term> <cat> <definition>
 *   node dict.mjs --list [category]  List all terms
 *   node dict.mjs --stats            Show counts per category
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path              from 'node:path';
import fs                from 'node:fs';
import { glob }          from 'glob';

const require = createRequire(import.meta.url);

// ── config ────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    const yaml       = require('js-yaml');
    const configPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../config/vaultflow.yaml'
    );
    if (fs.existsSync(configPath)) {
      return yaml.load(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function getDb() {
  const db  = require('./db.cjs');
  const cfg = loadConfig();
  const root = cfg.paths && cfg.paths.metrics_root;
  const file = cfg.storage && cfg.storage.db_file;
  db.initialize(root || null, file || null);
  return db;
}

// ── markdown parser ───────────────────────────────────────────────────────

const VALID_CATEGORIES = new Set([
  'domain', 'acronym', 'api', 'schema', 'command', 'config', 'error', 'stack', 'pattern'
]);

/**
 * Parse a markdown file into dictionary entries.
 *
 * Supported formats:
 *
 * 1. Definition list (domain knowledge):
 *    ## Term Name
 *    Definition text here.
 *
 * 2. Table rows:
 *    | Term | Definition | category |
 *
 * 3. Front-matter category hint:
 *    ---
 *    category: acronym
 *    ---
 *
 * Returns an array of { term, category, definition, source } objects.
 */
function parseMarkdownFile(content, filePath) {
  const entries  = [];
  const lines    = content.split('\n');

  // Detect front-matter category override
  let fileCategory = 'domain';
  if (lines[0] === '---') {
    const fmEnd = lines.indexOf('---', 1);
    if (fmEnd !== -1) {
      for (let i = 1; i < fmEnd; i++) {
        const m = lines[i].match(/^category:\s*(.+)$/);
        if (m) {
          const c = m[1].trim().toLowerCase();
          if (VALID_CATEGORIES.has(c)) fileCategory = c;
        }
      }
    }
  }

  // Infer category from filename
  const base = path.basename(filePath, '.md').toLowerCase();
  if (VALID_CATEGORIES.has(base)) fileCategory = base;
  // common file name patterns
  if (base.includes('acronym')) fileCategory = 'acronym';
  if (base.includes('api'))     fileCategory = 'api';
  if (base.includes('schema'))  fileCategory = 'schema';
  if (base.includes('command')) fileCategory = 'command';
  if (base.includes('error'))   fileCategory = 'error';

  // ── scan for table rows ──────────────────────────────────────────────
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    // Skip separator rows (--|--|--)
    if (cells.every(c => /^[-:]+$/.test(c))) continue;
    // Skip header rows that look like column names
    const term = cells[0];
    const def  = cells[1];
    if (!term || !def || term.toLowerCase() === 'term' || term.toLowerCase() === 'name') continue;
    const cat = (cells[2] && VALID_CATEGORIES.has(cells[2].toLowerCase()))
      ? cells[2].toLowerCase()
      : fileCategory;
    entries.push({ term, category: cat, definition: def, source: filePath });
  }

  // ── scan for ## Heading + paragraph pairs ────────────────────────────
  let currentHeading = null;
  let bodyLines      = [];

  const flushHeading = () => {
    if (!currentHeading) return;
    const definition = bodyLines.join(' ').replace(/\s+/g, ' ').trim();
    if (definition.length >= 10) {
      // Skip if it looks like a section title, not a term definition
      entries.push({ term: currentHeading, category: fileCategory, definition, source: filePath });
    }
    currentHeading = null;
    bodyLines      = [];
  };

  let inFrontMatter = lines[0] === '---';
  let fmClosed      = false;

  for (const line of lines) {
    if (inFrontMatter && !fmClosed) {
      if (line === '---' && bodyLines.length === 0) { fmClosed = true; }
      continue;
    }

    // Skip table lines — already handled
    if (line.startsWith('|')) continue;

    const headingMatch = line.match(/^#{2,4}\s+(.+)$/);
    if (headingMatch) {
      flushHeading();
      const h = headingMatch[1].trim()
        .replace(/\*\*/g, '')
        .replace(/`/g, '')
        .trim();
      // Only treat as a term if it looks like a term (< 60 chars, not a full sentence)
      if (h.length < 60 && !h.includes('.')) {
        currentHeading = h;
      }
      continue;
    }

    if (currentHeading) {
      const stripped = line.trim();
      if (stripped.startsWith('#')) {
        flushHeading();
      } else if (stripped !== '') {
        bodyLines.push(stripped);
      } else if (bodyLines.length > 0) {
        // Blank line after content — flush if we have enough
        if (bodyLines.join(' ').length > 20) flushHeading();
      }
    }
  }
  flushHeading();

  // Deduplicate within this file (same term+category)
  const seen = new Set();
  return entries.filter(e => {
    const k = `${e.term.toLowerCase()}::${e.category}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── public API ────────────────────────────────────────────────────────────

/**
 * Import dictionary entries from a directory of markdown files.
 *
 * @param {string} [domainDir]  Absolute path to vault/domain/ (or override)
 * @returns {Promise<{imported: number, files: number}>}
 */
export async function importFromDirectory(domainDir) {
  const cfg      = loadConfig();
  const dir      = domainDir
    || (cfg.paths && cfg.paths.vault_domain_dir)
    || path.join(cfg.paths && cfg.paths.vault_root || '', 'domain');

  if (!fs.existsSync(dir)) {
    return { imported: 0, files: 0 };
  }

  const db    = getDb();
  const files = await glob('**/*.md', { cwd: dir, absolute: true, nodir: true });

  let totalImported = 0;

  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      // Skip files over 500KB
      if (content.length > 500 * 1024) continue;

      const entries = parseMarkdownFile(content, filePath);
      for (const e of entries) {
        db.upsertDictionaryEntry(e.term, e.category, e.definition, e.source, '');
        totalImported++;
      }
    } catch (err) {
      process.stderr.write(`[dict] error parsing ${filePath}: ${err.message}\n`);
    }
  }

  return { imported: totalImported, files: files.length };
}

/**
 * Add or update a single dictionary entry.
 */
export function addEntry(term, category, definition, source) {
  const cat = VALID_CATEGORIES.has((category || '').toLowerCase())
    ? category.toLowerCase()
    : 'domain';
  getDb().upsertDictionaryEntry(term, cat, definition, source || null, '');
}

/**
 * BM25 search over the dictionary.
 *
 * @param {string} query
 * @param {number} [limit=10]
 */
export function search(query, limit) {
  return getDb().searchDictionary(query, limit || 10);
}

/**
 * Return dictionary terms that appear verbatim in the given text.
 * Used to inject relevant definitions before prompt routing.
 *
 * @param {string} text
 */
export function matchTerms(text) {
  return getDb().getTermMatches(text);
}

// ── CLI ───────────────────────────────────────────────────────────────────

const thisPath = fileURLToPath(import.meta.url);

if (process.argv[1] === thisPath) {
  const args = process.argv.slice(2);
  const cmd  = args[0];

  (async () => {
    try {
      if (cmd === '--import' || cmd === 'import') {
        const dir    = args[1] || undefined;
        const result = await importFromDirectory(dir);
        console.log(`Imported ${result.imported} terms from ${result.files} files.`);

      } else if (cmd === '--search' || cmd === 'search') {
        const query = args.slice(1).join(' ');
        if (!query) { console.error('Usage: dict.mjs --search <query>'); process.exit(1); }
        const rows = search(query, 10);
        if (rows.length === 0) {
          console.log('No matches found.');
        } else {
          rows.forEach(r => {
            console.log(`[${r.category}] ${r.term}`);
            console.log(`  ${r.definition}`);
            console.log();
          });
        }

      } else if (cmd === '--add' || cmd === 'add') {
        const [, term, category, ...defWords] = args;
        if (!term || !category || defWords.length === 0) {
          console.error('Usage: dict.mjs --add <term> <category> <definition...>');
          process.exit(1);
        }
        addEntry(term, category, defWords.join(' '));
        console.log(`Added: [${category}] ${term}`);

      } else if (cmd === '--list' || cmd === 'list') {
        console.log('Use --stats to see counts, --search to find terms.');

      } else if (cmd === '--stats' || cmd === 'stats') {
        const { DatabaseSync } = require('node:sqlite');
        const cfg      = loadConfig();
        const root     = cfg.paths && cfg.paths.metrics_root;
        const file     = (cfg.storage && cfg.storage.db_file) || 'vaultflow.db';
        if (!root) { console.error('metrics_root not configured'); process.exit(1); }
        const rawDb = new DatabaseSync(path.join(root, file), { readOnly: true });
        const rows  = rawDb.prepare(
          'SELECT category, COUNT(*) AS cnt FROM dictionary GROUP BY category ORDER BY category'
        ).all();
        rawDb.close();
        const total = rows.reduce((s, r) => s + r.cnt, 0);
        console.log(`Dictionary: ${total} total entries`);
        rows.forEach(r => console.log(`  ${r.category.padEnd(12)} ${r.cnt}`));

      } else {
        console.log([
          'Usage:',
          '  node dict.mjs --import [dir]              Import from vault/domain/',
          '  node dict.mjs --search <query>            BM25 search',
          '  node dict.mjs --add <term> <cat> <def>    Add a term',
          '  node dict.mjs --stats                     Show category counts',
        ].join('\n'));
      }
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  })();
}
