'use strict';

/**
 * code-graph.cjs — lightweight per-file symbol + import indexer.
 *
 * WHY: FTS5 indexes text. It doesn't know that ArgoController.cs is imported
 * by 7 files, so Claude greps blind for callers before any edit. This module
 * extracts exported symbols and imports per file with regex (no tree-sitter)
 * and stores them in code_symbols / code_imports. Queryable as "blast radius
 * for file X" at session start.
 *
 * Languages: TypeScript/JavaScript (ts/tsx/js/jsx/mjs/cjs), C#, Python.
 * Regex passes are intentionally shallow — they catch the 90% case and never
 * block the hook (catches all errors). Tree-sitter can replace this later
 * without touching consumers.
 */

const fs   = require('fs');
const path = require('path');

const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.cs',
  '.py',
]);

const MAX_BYTES = 512 * 1024; // skip anything over 512KB

function langFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.cs') return 'csharp';
  if (ext === '.py') return 'python';
  if (SOURCE_EXTS.has(ext)) return 'ts';
  return null;
}

function shouldIndex(filePath) {
  if (!filePath) return false;
  const norm = filePath.replace(/\\/g, '/');
  if (norm.includes('/node_modules/')) return false;
  if (norm.includes('/.git/')) return false;
  if (norm.includes('/dist/') || norm.includes('/build/') || norm.includes('/bin/') || norm.includes('/obj/')) return false;
  if (norm.match(/\.(min|bundle)\.(js|ts)$/)) return false;
  if (norm.endsWith('.d.ts')) return false;
  return SOURCE_EXTS.has(path.extname(norm).toLowerCase());
}

// ── extractors ────────────────────────────────────────────────────────────

function extractTs(content) {
  const symbols = [];
  const imports = [];
  const lines = content.split('\n');

  const symRe = [
    // export function foo / async function foo
    [/^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, 'function'],
    [/^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
    [/^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/, 'interface'],
    [/^\s*export\s+type\s+([A-Za-z_$][\w$]*)/, 'type'],
    [/^\s*export\s+enum\s+([A-Za-z_$][\w$]*)/, 'enum'],
    [/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, 'const'],
    [/^\s*export\s+default\s+(?:function|class)?\s*([A-Za-z_$][\w$]*)/, 'default'],
    // Top-level CJS: function foo() / async function foo() — captures any
    // top-level function declaration even without `export`, since CJS modules
    // export via module.exports = { ... } at the bottom. Without this rule
    // the vaultflow .cjs files had zero indexed symbols.
    [/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/, 'function'],
    [/^class\s+([A-Za-z_$][\w$]*)/, 'class'],
    // module.exports = { foo, bar } / exports.foo =
    [/^\s*module\.exports\s*=\s*([A-Za-z_$][\w$]*)/, 'cjs-default'],
    [/^\s*exports\.([A-Za-z_$][\w$]*)\s*=/, 'cjs-named'],
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 1000) continue;
    for (const [re, kind] of symRe) {
      const m = line.match(re);
      if (m && m[1]) {
        symbols.push({ kind, name: m[1], line: i + 1 });
        break;
      }
    }
    // import ... from 'x' | require('x')
    const im1 = line.match(/^\s*import\s+(?:[^'"]+from\s+)?['"]([^'"]+)['"]/);
    if (im1) imports.push({ target: im1[1], raw: line.trim(), line: i + 1 });
    const im2 = line.match(/require\(\s*['"]([^'"]+)['"]\s*\)/);
    if (im2) imports.push({ target: im2[1], raw: line.trim().slice(0, 200), line: i + 1 });
    const im3 = line.match(/^\s*(?:const|let|var)\s+[^=]+=\s*await\s+import\(\s*['"]([^'"]+)['"]/);
    if (im3) imports.push({ target: im3[1], raw: line.trim().slice(0, 200), line: i + 1 });
  }

  // CJS object-literal exports: `module.exports = { foo, bar, baz };`
  // Walk lines after `module.exports = {` until the matching `}` and capture
  // each `name,` or `name: alias,` entry as a cjs-export symbol.
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*module\.exports\s*=\s*\{/.test(lines[i])) continue;
    let depth = 0, started = false;
    for (let j = i; j < Math.min(i + 200, lines.length); j++) {
      const ln = lines[j];
      for (const ch of ln) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
      if (started && j > i) {
        // collect bare identifiers / shorthand entries
        const matches = ln.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:,|$|:)/);
        if (matches && !['return','if','else','for','while'].includes(matches[1])) {
          symbols.push({ kind: 'cjs-export', name: matches[1], line: j + 1 });
        }
      }
      if (started && depth === 0) break;
    }
    break; // only process the first module.exports block
  }
  return { symbols, imports };
}

function extractCSharp(content) {
  const symbols = [];
  const imports = [];
  const lines = content.split('\n');

  const symRe = [
    [/^\s*(?:public|internal|protected|private)?\s*(?:static\s+|abstract\s+|sealed\s+|partial\s+)*class\s+([A-Za-z_][\w]*)/, 'class'],
    [/^\s*(?:public|internal|protected|private)?\s*(?:partial\s+)?interface\s+([A-Za-z_][\w]*)/, 'interface'],
    [/^\s*(?:public|internal|protected|private)?\s*(?:partial\s+)?struct\s+([A-Za-z_][\w]*)/, 'struct'],
    [/^\s*(?:public|internal|protected|private)?\s*(?:partial\s+)?record\s+([A-Za-z_][\w]*)/, 'record'],
    [/^\s*(?:public|internal|protected|private)?\s*enum\s+([A-Za-z_][\w]*)/, 'enum'],
    // public async Task<X> MethodName( — method
    [/^\s*(?:public|internal|protected|private)\s+(?:static\s+|virtual\s+|override\s+|async\s+|abstract\s+)*[A-Za-z_<>,\s\[\]?]+\s+([A-Za-z_][\w]*)\s*\(/, 'method'],
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 1000) continue;
    for (const [re, kind] of symRe) {
      const m = line.match(re);
      if (m && m[1] && !['if', 'for', 'while', 'switch', 'return', 'using', 'new'].includes(m[1])) {
        symbols.push({ kind, name: m[1], line: i + 1 });
        break;
      }
    }
    const im = line.match(/^\s*using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/);
    if (im) imports.push({ target: im[1], raw: line.trim(), line: i + 1 });
  }
  return { symbols, imports };
}

function extractPython(content) {
  const symbols = [];
  const imports = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 1000) continue;
    const fn = line.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/);
    if (fn) { symbols.push({ kind: 'function', name: fn[1], line: i + 1 }); continue; }
    const cls = line.match(/^class\s+([A-Za-z_]\w*)/);
    if (cls) { symbols.push({ kind: 'class', name: cls[1], line: i + 1 }); continue; }
    const im1 = line.match(/^\s*from\s+([\w.]+)\s+import\s+/);
    if (im1) { imports.push({ target: im1[1], raw: line.trim(), line: i + 1 }); continue; }
    const im2 = line.match(/^\s*import\s+([\w.]+)/);
    if (im2) imports.push({ target: im2[1], raw: line.trim(), line: i + 1 });
  }
  return { symbols, imports };
}

function extractFor(lang, content) {
  if (lang === 'ts')     return extractTs(content);
  if (lang === 'csharp') return extractCSharp(content);
  if (lang === 'python') return extractPython(content);
  return { symbols: [], imports: [] };
}

// ── DB ops ────────────────────────────────────────────────────────────────

function clearFile(rawDb, filePath) {
  rawDb.prepare('DELETE FROM code_symbols WHERE file = ?').run(filePath);
  rawDb.prepare('DELETE FROM code_imports WHERE file = ?').run(filePath);
  rawDb.prepare('DELETE FROM code_calls   WHERE caller_file = ?').run(filePath);
}

// Reserved words that look like function calls in regex but aren't —
// excluded from callee extraction to keep code_calls signal-dense.
const CALL_KEYWORDS = new Set([
  // generic
  'if','for','while','switch','return','typeof','new','await','yield','throw','catch','do','else','case','break','continue','default','this','super','void','delete','in','of','as',
  'function','arguments','constructor','set','get','static','final','public','private','protected','internal','virtual','override','abstract','sealed',
  // C# / Java / Python control flow
  'foreach','using','lock','fixed','unsafe','checked','unchecked','sizeof','nameof','default','async','await','readonly','volatile','out','ref','params','from','where','select','let','orderby','group','into','join','on','equals','by','ascending','descending',
  'def','class','elif','except','finally','lambda','pass','raise','with','yield','assert','del','global','nonlocal','None','True','False','and','or','not','is',
  // very common methods that aren't usually the call you care about
  'print','println','log','toString','valueOf','equals','hashCode','console',
]);

/**
 * Extract callees per top-level function in `symbols`. Walks lines bottom-up
 * from each function's declaration looking for `identifier(` patterns inside
 * the body (heuristic: until the next top-level def or end of file).
 *
 * Regex-based — doesn't do scope analysis. Filters keywords and stdlib noise.
 */
function extractCalls(lang, content, symbols) {
  const calls = [];
  const lines = content.split('\n');

  const fnSymbols = symbols.filter(s =>
    ['function','method','class','default'].includes(s.kind)
  ).sort((a,b) => a.line - b.line);

  for (let i = 0; i < fnSymbols.length; i++) {
    const sym  = fnSymbols[i];
    const next = fnSymbols[i + 1];
    const start = sym.line;
    const end   = next ? next.line - 1 : Math.min(lines.length, start + 300);
    if (end - start < 1) continue;

    const seen = new Set();
    for (let li = start; li < end && li < lines.length; li++) {
      const line = lines[li];
      if (!line || line.length > 1000) continue;
      // Match both bare-name calls (`fn(`) AND method calls (`x.fn(` /
      // `x.y.fn(`). The dotted form is the most common pattern (imported
      // modules: db.recordEdit, fs.readFileSync). For dotted, we record the
      // tail name as the callee — that's what matches the symbol table.
      const re = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g;
      let m;
      while ((m = re.exec(line))) {
        const name = m[1];
        if (CALL_KEYWORDS.has(name)) continue;
        if (name === sym.name) continue; // direct recursion not interesting
        // Skip very-common stdlib methods that flood the index without signal
        if (STDLIB_NOISE.has(name)) continue;
        const key = name + ':' + (li + 1);
        if (seen.has(key)) continue;
        seen.add(key);
        calls.push({ caller: sym.name, callee: name, line: li + 1 });
      }
    }
  }
  return calls;
}

// Method names so common they drown the signal. Includes prototype builtins
// and the most frequent C# / Java methods.
const STDLIB_NOISE = new Set([
  // JS / TS
  'toString','valueOf','hasOwnProperty','toLowerCase','toUpperCase','trim','split','join','slice','splice','push','pop','shift','unshift','indexOf','includes','startsWith','endsWith','replace','replaceAll','match','test','exec','concat','reverse','sort','map','filter','reduce','forEach','find','findIndex','some','every','flat','flatMap','keys','values','entries','assign','freeze','seal','isArray','from','of','parse','stringify','then','catch','finally','resolve','reject','all','race','allSettled','any',
  // common globals/utility
  'parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent',
  // C# common
  'ToString','GetType','GetHashCode','Equals','Compare','CompareTo','GetEnumerator','MoveNext','Dispose','Add','Remove','Contains','TryGetValue','TryParse','Parse','Format','Substring','IndexOf','Trim','Split','Join','ToList','ToArray','ToDictionary','Where','Select','SelectMany','OrderBy','OrderByDescending','GroupBy','First','FirstOrDefault','Single','SingleOrDefault','Any','All','Count','Sum','Min','Max','Average','Distinct','Skip','Take','Concat','Union','Intersect','Except','Reverse','Empty','Range','Repeat','Cast','OfType','Aggregate','Zip',
  // python builtins
  'len','range','str','int','float','list','dict','set','tuple','enumerate','zip','map','filter','sorted','reversed','sum','min','max','abs','round','print','isinstance','hasattr','getattr','setattr',
]);

function indexFile(db, filePath, project) {
  if (!shouldIndex(filePath)) return { skipped: true };

  let stat;
  try { stat = fs.statSync(filePath); }
  catch (_) {
    // File deleted: clear its rows
    try {
      db.initialize(null, null);
      clearFile(db.raw(), filePath);
    } catch (_) {}
    return { deleted: true };
  }
  if (stat.size > MAX_BYTES) return { skipped: true, reason: 'too-large' };

  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); }
  catch (_) { return { skipped: true, reason: 'read-failed' }; }

  const lang = langFor(filePath);
  const { symbols, imports } = extractFor(lang, content);

  db.initialize(null, null);
  const conn = db.raw();
  const now = new Date().toISOString();

  const tx = conn.prepare('BEGIN');
  const co = conn.prepare('COMMIT');
  const rb = conn.prepare('ROLLBACK');

  tx.run();
  try {
    clearFile(conn, filePath);

    const insertSym = conn.prepare(
      `INSERT OR REPLACE INTO code_symbols
         (file, project, lang, kind, name, line, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const s of symbols) {
      insertSym.run(filePath, project || null, lang, s.kind, s.name, s.line, now);
    }

    const insertImp = conn.prepare(
      `INSERT OR REPLACE INTO code_imports
         (file, project, lang, target, raw, line, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const im of imports) {
      insertImp.run(filePath, project || null, lang, im.target, im.raw || '', im.line, now);
    }

    // Call graph
    const calls = extractCalls(lang, content, symbols);
    const insertCall = conn.prepare(
      `INSERT OR REPLACE INTO code_calls
         (caller_file, caller_name, callee_name, project, lang, line, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const c of calls) {
      insertCall.run(filePath, c.caller, c.callee, project || null, lang, c.line, now);
    }

    co.run();
    return { lang, symbols: symbols.length, imports: imports.length, calls: calls.length };
  } catch (err) {
    try { rb.run(); } catch (_) {}
    return { error: err.message };
  }
}

/**
 * Read just the lines that define one symbol. Replaces a full Read of a
 * large file with a targeted slice. Saves 90%+ tokens on "show me how X
 * works" style queries.
 *
 * Strategy: find the symbol's line, then read up to the next symbol's
 * line - 1 (or +maxLines if no next symbol). Returns null if not found.
 */
function getSymbolBody(db, filePath, symbolName, maxLines = 200) {
  db.initialize(null, null);
  const fs = require('fs');
  const wsep = filePath.replace(/\//g, '\\');
  const fsep = filePath.replace(/\\/g, '/');

  const syms = db.raw().prepare(
    `SELECT name, line FROM code_symbols
      WHERE (file = ? OR file = ?) ORDER BY line`
  ).all(wsep, fsep);
  if (syms.length === 0) return null;

  const idx = syms.findIndex(s => s.name === symbolName);
  if (idx === -1) return null;
  const startLine = syms[idx].line;
  const nextLine  = syms[idx + 1] ? syms[idx + 1].line : null;
  const endLine   = nextLine
    ? Math.min(nextLine - 1, startLine + maxLines)
    : startLine + maxLines;

  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); }
  catch (_) {
    try { content = fs.readFileSync(wsep === filePath ? fsep : wsep, 'utf8'); }
    catch (_) { return null; }
  }
  const lines = content.split('\n');
  const slice = lines.slice(startLine - 1, endLine).join('\n');
  return {
    name: symbolName,
    file: filePath,
    start_line: startLine,
    end_line: Math.min(endLine, lines.length),
    body: slice,
  };
}

function getCallers(db, calleeName, project) {
  db.initialize(null, null);
  const sql = `
    SELECT caller_file, caller_name, line, lang
      FROM code_calls
     WHERE callee_name = ?
       ${project ? 'AND project = ?' : ''}
     ORDER BY caller_file, line
  `;
  const params = project ? [calleeName, project] : [calleeName];
  return db.raw().prepare(sql).all(...params);
}

function getCallees(db, callerFile, callerName) {
  db.initialize(null, null);
  return db.raw().prepare(`
    SELECT callee_name, line
      FROM code_calls
     WHERE caller_file = ? AND caller_name = ?
     ORDER BY line
  `).all(callerFile, callerName);
}

// ── query helpers ─────────────────────────────────────────────────────────

function getSymbols(db, filePath) {
  db.initialize(null, null);
  const wsep = filePath.replace(/\//g, '\\');
  const fsep = filePath.replace(/\\/g, '/');
  return db.raw().prepare(
    'SELECT kind, name, line FROM code_symbols WHERE file = ? OR file = ? ORDER BY line'
  ).all(wsep, fsep);
}

/**
 * Files that import this file. Matches require a path component (starts with
 * './' or '../' or '/' or contains '/') or an exact dotted-name match. Bare
 * basename matches are intentionally NOT supported — they produced false
 * positives like `require('scanner.db')` (sqlite file) matching `db.cjs`.
 *
 * Examples for target file `helpers/db.cjs`:
 *   ✓ require('./db')      → target './db'      matches like2
 *   ✓ require('./db.cjs')  → target './db.cjs'  matches like1
 *   ✓ require('../helpers/db') → matches like3
 *   ✗ require('scanner.db') → no longer matches
 *   ✗ Python 'from .db import' → no longer matches (relative not to our path)
 */
function getBlastRadius(db, filePath, project) {
  db.initialize(null, null);
  // Normalize to whatever separator the DB uses (we store backslash-windows
  // paths). Try the platform default; fall back to swapped if no match.
  const wsep = filePath.replace(/\//g, '\\');
  const fsep = filePath.replace(/\\/g, '/');
  const ext  = path.extname(filePath);
  const base = path.basename(filePath, ext);
  if (!base || base.length < 2) return [];

  // Auto-scope to the project of the target file when caller didn't specify.
  // Cross-project blast-radius is rarely what you want — two unrelated repos
  // both having a './db' module would otherwise pollute the result.
  if (!project) {
    try {
      const row = db.raw().prepare(
        'SELECT project FROM code_symbols WHERE file = ? OR file = ? LIMIT 1'
      ).get(wsep, fsep);
      if (row && row.project) project = row.project;
    } catch (_) {}
  }

  // For .py we still allow dotted-module form: foo.bar.db → ends with .db
  const isPy = ext === '.py';

  // Require a slash-separated path OR a literal `./<base>` / `../<base>` etc.
  // No bare `<base>` matches unless it's a Python dotted module ending in `.<base>`.
  const params = [
    `%/${base}${ext}`,     // ./helpers/db.cjs
    `%/${base}`,           // ./helpers/db (no extension)
    `./${base}`,           // ./db
    `./${base}${ext}`,     // ./db.cjs
    `../${base}`,          // ../db
    `../${base}${ext}`,    // ../db.cjs
  ];
  const placeholders = params.map(() => 'target = ? OR target LIKE ?').join(' OR ');
  // For LIKE clauses we pass the same value (param dup). Build the SQL.
  // Simpler: just use both '=' and 'LIKE' on each pattern via separate ORs.
  // Reorganize:
  const exactParams = [`./${base}`, `./${base}${ext}`, `../${base}`, `../${base}${ext}`];
  const likeParams  = [`%/${base}`, `%/${base}${ext}`];
  if (isPy) likeParams.push(`%.${base}`); // foo.bar.db for Python only

  const placeholderExact = exactParams.map(() => '?').join(',');
  const placeholderLike  = likeParams.map(() => 'target LIKE ?').join(' OR ');

  const sql = `
    SELECT file, lang, target, line
      FROM code_imports
     WHERE (target IN (${placeholderExact}) OR ${placeholderLike})
       ${project ? 'AND project = ?' : ''}
       AND file != ?
     ORDER BY file, line
  `;
  const allParams = [...exactParams, ...likeParams];
  if (project) allParams.push(project);
  allParams.push(wsep);
  // Exclude both separator variants of the target file from results.
  const sqlFinal = sql.replace('AND file != ?', 'AND file != ? AND file != ?');
  allParams.push(fsep);
  return db.raw().prepare(sqlFinal).all(...allParams);
}

function getGraphStats(db, project) {
  db.initialize(null, null);
  const where = project ? 'WHERE project = ?' : '';
  const args  = project ? [project] : [];
  const conn  = db.raw();
  const files = conn.prepare(`SELECT COUNT(DISTINCT file) AS n FROM code_symbols ${where}`).get(...args).n;
  const syms  = conn.prepare(`SELECT COUNT(*) AS n FROM code_symbols ${where}`).get(...args).n;
  const imps  = conn.prepare(`SELECT COUNT(*) AS n FROM code_imports ${where}`).get(...args).n;
  const langs = conn.prepare(`SELECT lang, COUNT(*) AS n FROM code_symbols ${where} GROUP BY lang ORDER BY n DESC`).all(...args);
  return { files, symbols: syms, imports: imps, by_lang: langs };
}

function searchSymbols(db, query, limit = 50) {
  db.initialize(null, null);
  const like = `%${String(query).slice(0, 100)}%`;
  return db.raw().prepare(
    `SELECT file, lang, kind, name, line FROM code_symbols
      WHERE name LIKE ? ORDER BY name LIMIT ?`
  ).all(like, limit);
}

module.exports = {
  shouldIndex,
  indexFile,
  clearFile,
  getSymbols,
  getBlastRadius,
  getGraphStats,
  searchSymbols,
  getCallers,
  getCallees,
  getSymbolBody,
};
