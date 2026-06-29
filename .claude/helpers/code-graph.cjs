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

// ── excluded path prefixes (loaded once from config) ─────────────────────
// Prevents snapshot copies (D:/vaultflow) from polluting the code graph.
// Falls back to a hardcoded default so the guard works even without config.
let _excludePrefixes = null; // null = not yet loaded

function getExcludePrefixes() {
  if (_excludePrefixes !== null) return _excludePrefixes;
  try {
    const yaml      = require('js-yaml');
    const cfgPath   = require('../../config/resolve.cjs');
    const cfg       = fs.existsSync(cfgPath) ? yaml.load(fs.readFileSync(cfgPath, 'utf8')) : {};
    const raw       = (cfg.paths && cfg.paths.exclude_index_prefixes) || [];
    // Normalize to forward-slash, lowercase for case-insensitive compare.
    _excludePrefixes = (Array.isArray(raw) ? raw : [raw])
      .filter(Boolean)
      .map(p => String(p).replace(/\\/g, '/').toLowerCase());
  } catch (_) {
    // If config can't be loaded, default to blocking the known snapshot paths.
    _excludePrefixes = ['d:/vaultflow', 'e:/git/vaultflow'];
  }
  return _excludePrefixes;
}

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
  const low  = norm.toLowerCase();
  // Excluded path prefixes — snapshot copies, external mirrors, etc.
  for (const prefix of getExcludePrefixes()) {
    if (low.startsWith(prefix)) return false;
  }
  if (norm.includes('/node_modules/')) return false;
  if (norm.includes('/.git/')) return false;
  if (norm.includes('/dist/') || norm.includes('/build/') || norm.includes('/bin/') || norm.includes('/obj/')) return false;
  // Vendored Python deps + bytecode caches — third-party code, not the user's.
  // 16k+ symbols had leaked in from .venv/site-packages (pyarrow, duckdb, …).
  if (norm.includes('/.venv/') || norm.includes('/venv/') || norm.includes('/site-packages/') || norm.includes('/__pycache__/')) return false;
  // Transient git worktrees: agent worktrees under .claude/worktrees/, and the
  // user's "<project>-wt" sibling worktree dirs. These are duplicate trees of
  // real source — indexing them double-counts every symbol under a stale path.
  // The `-wt/` guard matches a path *segment* (e.g. /PRGJSMES-wt/), so a source
  // file merely ending in "-wt" (widget-wt.ts) still indexes.
  if (norm.includes('/.claude/worktrees/')) return false;
  if (/\/[^/]+-wt\//.test(norm)) return false;
  // Auto-generated C# WCF/SOAP proxies — always under "Service References/".
  if (low.includes('/service references/')) return false;
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

/**
 * Retroactive code-graph cleanup. Drops rows whose file path is no longer
 * indexable under shouldIndex (vendored/generated/worktree junk that leaked in
 * before the exclude rules tightened) and — when checkExistence is set — rows
 * for files that no longer exist on disk (deleted files, removed worktrees).
 *
 * Walks the union of files across code_symbols, code_imports and code_calls so
 * a file present in only one table is still reclaimed. Single transaction;
 * also clears orphaned symbol_embeddings. Returns counts — the caller decides
 * whether to VACUUM (deletes alone don't shrink the file).
 */
function purgeCodeGraph(db, opts = {}) {
  const { checkExistence = true } = opts;
  db.initialize(null, null);
  const conn = db.raw();

  const files = new Set();
  for (const r of conn.prepare('SELECT DISTINCT file FROM code_symbols').all())        if (r.file)        files.add(r.file);
  for (const r of conn.prepare('SELECT DISTINCT file FROM code_imports').all())        if (r.file)        files.add(r.file);
  for (const r of conn.prepare('SELECT DISTINCT caller_file FROM code_calls').all())   if (r.caller_file) files.add(r.caller_file);

  let junkFiles = 0, missingFiles = 0;
  const tx = conn.prepare('BEGIN'), co = conn.prepare('COMMIT'), rb = conn.prepare('ROLLBACK');
  tx.run();
  try {
    for (const f of files) {
      let reason = null;
      if (!shouldIndex(f)) reason = 'junk';
      else if (checkExistence) {
        try { fs.statSync(f); } catch (_) { reason = 'missing'; }
      }
      if (!reason) continue;
      clearFile(conn, f);
      if (db.clearSymbolEmbeddings) { try { db.clearSymbolEmbeddings(f); } catch (_) {} }
      if (reason === 'junk') junkFiles++; else missingFiles++;
    }
    co.run();
  } catch (err) {
    try { rb.run(); } catch (_) {}
    throw err;
  }
  return { filesPurged: junkFiles + missingFiles, junkFiles, missingFiles };
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

// Callees that are pure noise in a traced FLOW: SQL keywords that the
// regex call-indexer matches inside SQL string literals (`COUNT(`, `SUM(`,
// `bm25(` …), JS/control-flow words that slip past CALL_KEYWORDS, and bare
// HTTP verbs (`get(`, `post(`, `json(`) that are never the real callee you
// want to follow. Matched case-insensitively in walkTransitive and dropped
// outright — not even recorded as terminal leaves — so flows stay legible.
// This is intentionally broader than CALL_KEYWORDS (which only gates indexing
// of code_calls); some of these legitimately appear in code_calls (e.g. `set`,
// `get` as method names) but are never useful as flow nodes.
const NOISE_CALLEES = new Set([
  // SQL keywords / aggregate fns that appear inside query string literals
  'select', 'from', 'where', 'count', 'sum', 'avg', 'min', 'max', 'group',
  'order', 'limit', 'join', 'on', 'as', 'bm25', 'coalesce', 'distinct',
  'values', 'insert', 'update', 'delete', 'set', 'into', 'case', 'when',
  'then', 'end', 'null', 'and', 'or', 'not', 'exists', 'like', 'desc', 'asc',
  // JS / control-flow noise
  'if', 'for', 'while', 'switch', 'catch', 'map', 'filter', 'foreach',
  'require', 'console', 'json', 'object', 'array', 'string', 'number',
  'promise', 'math',
  // bare HTTP verbs (route-registration call sites, not real callees)
  'get', 'post', 'put', 'patch', 'use', 'status', 'send', 'header',
].map(s => s.toLowerCase()));

/** True when a bare callee name is flow-noise (case-insensitive). */
function isNoiseCallee(name) {
  return NOISE_CALLEES.has(String(name || '').toLowerCase());
}

function indexFile(db, filePath, project) {
  if (!shouldIndex(filePath)) return { skipped: true };

  let stat;
  try { stat = fs.statSync(filePath); }
  catch (_) {
    // File deleted: clear its rows
    try {
      db.initialize(null, null);
      clearFile(db.raw(), filePath);
      // Also remove symbol_embeddings for the deleted file (orphan guard).
      db.clearSymbolEmbeddings && db.clearSymbolEmbeddings(filePath);
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

  // Hash gate: read existing hashes, then compute per-symbol body hash from the
  // already-loaded content. Symbols whose hash matches are flagged as unchanged
  // so the embed worker can skip them (no re-embedding compute). Symbols with a
  // new hash get enqueued for embedding via embed_queue.
  const lines = content.split(/\r?\n/);
  const priorHashes = (db.getSymbolHashes && db.getSymbolHashes(filePath)) || new Map();
  const crypto = require('crypto');

  // Sort symbols by line to compute body slices cheaply.
  const sortedByLine = [...symbols].sort((a, b) => a.line - b.line);
  const lineMap = new Map(sortedByLine.map((s, i) => [s, i]));
  function bodySlice(s) {
    const i = lineMap.get(s);
    const startIdx = Math.max(0, s.line - 1);
    const nextSym = sortedByLine[i + 1];
    const endIdx = nextSym ? Math.max(startIdx, nextSym.line - 1) : Math.min(lines.length, startIdx + 200);
    return lines.slice(startIdx, endIdx).join('\n');
  }
  const symbolHashes = new Map();
  let changedSymbols = 0;
  let unchangedSymbols = 0;
  for (const s of symbols) {
    const body = bodySlice(s);
    if (body.length < 10) { symbolHashes.set(s, null); continue; }
    const h = crypto.createHash('sha256').update(body).digest('hex');
    symbolHashes.set(s, h);
    const key = `${s.name} ${s.kind}`;
    if (priorHashes.get(key) === h) unchangedSymbols++;
    else changedSymbols++;
  }

  const tx = conn.prepare('BEGIN');
  const co = conn.prepare('COMMIT');
  const rb = conn.prepare('ROLLBACK');

  tx.run();
  try {
    clearFile(conn, filePath);

    // line_count is the total physical line count of the file — the same value
    // stored on every symbol row for the same file so the treemap can GROUP BY
    // file and use MAX(line_count) without a separate filesystem read.
    const fileLineCount = content.split('\n').length;

    const insertSym = conn.prepare(
      `INSERT OR REPLACE INTO code_symbols
         (file, project, lang, kind, name, line, indexed_at, content_hash, line_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const enqueueEmbed = conn.prepare(
      `INSERT OR IGNORE INTO embed_queue (kind, target_id, queued_at) VALUES ('symbol', ?, ?)`
    );
    // target_id semantic: for symbols we use rowid of code_symbols. Since we
    // re-insert symbols every indexFile, capture the inserted rowid and enqueue.
    let nextSymbolId = 0;
    for (const s of symbols) {
      const info = insertSym.run(filePath, project || null, lang, s.kind, s.name, s.line, now, symbolHashes.get(s), fileLineCount);
      const symbolId = info.lastInsertRowid;
      nextSymbolId = symbolId;
      const key = `${s.name} ${s.kind}`;
      const h = symbolHashes.get(s);
      if (h && priorHashes.get(key) !== h) {
        try { enqueueEmbed.run(symbolId, now); } catch (_) {}
      }
    }
    process.stderr.write(
      `[code-graph] indexFile "${path.basename(filePath)}" — ${changedSymbols} changed / ${unchangedSymbols} unchanged symbols\n`
    );

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
  // Auto-scope to the project where the callee is defined when caller didn't
  // specify. Avoids "recordEdit" in other repos polluting vaultflow's results.
  if (!project) {
    try {
      const row = db.raw().prepare(
        'SELECT project FROM code_symbols WHERE name = ? AND project IS NOT NULL LIMIT 1'
      ).get(calleeName);
      if (row && row.project) project = row.project;
    } catch (_) {}
  }
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

// ── flow primitives ────────────────────────────────────────────────────────
// Foundation for the flow catalog: trace end-to-end process paths over the
// (approximate) call graph. Resolution is BARE-NAME only — code_calls stores
// the tail identifier of a call, so "db.recordEdit()" lands as 'recordEdit'.
// Every result here is therefore an approximation; callers must flag confidence
// and never present these flows as ground truth.

/**
 * Imports declared by a file (upstream edge of the graph). Thin wrapper over
 * code_imports so flow tooling reuses it rather than issuing raw SQL.
 *
 * @returns {Array<{target, raw, line, lang}>}
 */
function getImports(db, file, project) {
  db.initialize(null, null);
  const wsep = file.replace(/\//g, '\\');
  const fsep = file.replace(/\\/g, '/');
  const sql = `
    SELECT target, raw, line, lang
      FROM code_imports
     WHERE (file = ? OR file = ?)
       ${project ? 'AND project = ?' : ''}
     ORDER BY line
  `;
  const params = project ? [wsep, fsep, project] : [wsep, fsep];
  return db.raw().prepare(sql).all(...params);
}

/**
 * Directory-based module label for a file. Heuristic: the top-level folder
 * under a recognized source root (src/<module>/… → '<module>'); otherwise the
 * immediate parent directory name. Pure string fn — no DB, no project lookup
 * beyond the supplied name. `project` is accepted for symmetry / future use.
 *
 * Examples:
 *   src/billing/charge.ts          → 'billing'
 *   .claude/helpers/db.cjs         → 'helpers'
 *   scripts/cli.mjs                → 'scripts'
 *   foo.ts                         → ''  (no parent dir)
 */
function inferModule(filePath, project) { // eslint-disable-line no-unused-vars
  if (!filePath) return '';
  const norm = String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length <= 1) return ''; // bare file, no directory
  // Drop the filename; we label by directory structure.
  const dirs = parts.slice(0, -1);
  // Recognized source roots: the module is the folder *under* the root.
  const ROOTS = new Set(['src', 'lib', 'app', 'scripts', 'tests', 'test', '.claude', 'helpers']);
  for (let i = 0; i < dirs.length - 1; i++) {
    if (ROOTS.has(dirs[i].toLowerCase())) return dirs[i + 1];
  }
  // No root marker — the top-level dir is the best module label, unless it is
  // itself a known root with nothing under it, in which case use it directly.
  return dirs[dirs.length - 1];
}

/**
 * Resolve a bare callee name to the symbol that most likely defines it.
 *
 * RESOLUTION STRATEGY (approximate by design):
 *   1. Scope to project.
 *   2. Prefer a definition in the SAME directory/module as the caller.
 *   3. If still ambiguous (>1 candidate), pick the first and flag ambiguous.
 *   4. Unresolved (external/stdlib/no symbol) → null (caller records a leaf).
 *
 * @returns {{file, name, kind, ambiguous}|null}
 */
function _resolveCallee(db, name, callerFile, project) {
  const conn = db.raw();
  const sql = `
    SELECT file, kind, name FROM code_symbols
     WHERE name = ?
       AND kind IN ('function','method','class')
       ${project ? 'AND project = ?' : ''}
     ORDER BY file, line
  `;
  const params = project ? [name, project] : [name];
  const rows = conn.prepare(sql).all(...params);
  if (rows.length === 0) return null;
  if (rows.length === 1) return { file: rows[0].file, name, kind: rows[0].kind, ambiguous: false };

  // Multiple definitions — prefer same directory as the caller.
  const callerDir = String(callerFile || '').replace(/\\/g, '/').split('/').slice(0, -1).join('/');
  const sameDir = rows.filter(r => {
    const d = String(r.file).replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    return d === callerDir;
  });
  if (sameDir.length === 1) {
    return { file: sameDir[0].file, name, kind: sameDir[0].kind, ambiguous: false };
  }
  // Still >1 (collision across files, or several in the same dir): take the
  // first deterministically and flag it so downstream confidence drops.
  const pick = (sameDir.length ? sameDir : rows)[0];
  return { file: pick.file, name, kind: pick.kind, ambiguous: true };
}

/**
 * Bounded transitive walk over the call graph, in either direction.
 *
 * @param {object} db
 * @param {{file, name}} start  Entry symbol (its defining file + name).
 * @param {object} opts
 *   direction 'callees' (default) | 'callers'
 *   depth     max hops from the start (default 4)
 *   maxNodes  hard cap; hitting it sets truncated=true (default 150)
 *   project   project scope (recommended)
 * @returns {{nodes, edges, truncated, cycles}}
 *   node = {id:`${file}::${name}`, label, kind, file, terminal, ambiguous}
 *   edge = {source, target, kind:'calls'}
 */
function walkTransitive(db, start, opts = {}) {
  db.initialize(null, null);
  const direction = opts.direction === 'callers' ? 'callers' : 'callees';
  const depth = Number.isFinite(opts.depth) ? opts.depth : 4;
  const maxNodes = Number.isFinite(opts.maxNodes) ? opts.maxNodes : 150;
  const project = opts.project || null;

  const nodeId = (file, name) => `${file}::${name}`;
  const nodes = new Map();   // id -> node
  const edges = new Map();   // `${src}->${tgt}` -> edge
  const cycles = [];
  let truncated = false;

  function ensureNode(file, name, kind, { terminal = false, ambiguous = false } = {}) {
    const id = nodeId(file, name);
    const existing = nodes.get(id);
    if (existing) {
      // Upgrade flags if a later visit learns more (e.g. ambiguity). Terminal
      // is sticky-true: a node only stays terminal if it was always a leaf.
      if (ambiguous) existing.ambiguous = true;
      return existing;
    }
    if (nodes.size >= maxNodes) { truncated = true; return null; }
    const node = { id, label: name, kind: kind || null, file, terminal, ambiguous };
    nodes.set(id, node);
    return node;
  }

  function addEdge(srcId, tgtId) {
    const key = `${srcId}->${tgtId}`;
    if (!edges.has(key)) edges.set(key, { source: srcId, target: tgtId, kind: 'calls' });
  }

  if (!start || !start.file || !start.name) return { nodes: [], edges: [], truncated: false, cycles: [] };

  const startNode = ensureNode(start.file, start.name, start.kind || null, {});
  if (!startNode) return { nodes: [], edges: [], truncated: true, cycles: [] };

  // BFS so the depth cap and node cap behave predictably. visited tracks the
  // call-stack lineage per id so a re-encounter is a genuine cycle, recorded
  // once, then NOT recursed (prevents infinite loops on full-circle flows).
  const visited = new Set([startNode.id]);
  const queue = [{ file: start.file, name: start.name, d: 0 }];

  while (queue.length) {
    if (nodes.size >= maxNodes) { truncated = true; break; }
    const cur = queue.shift();
    const curId = nodeId(cur.file, cur.name);
    if (cur.d >= depth) {
      // Reached the depth cap. If this node actually has outgoing edges we are
      // not expanding, the graph is incomplete → truncated.
      const hasMore = direction === 'callees'
        ? getCallees(db, cur.file, cur.name).length > 0
        : getCallers(db, cur.name, project).length > 0;
      if (hasMore) truncated = true;
      continue;
    }

    if (direction === 'callees') {
      const callees = getCallees(db, cur.file, cur.name);
      for (const c of callees) {
        // Drop flow-noise callees entirely — SQL keywords matched inside query
        // string literals, control-flow words, bare HTTP verbs. Never recorded,
        // not even as terminal leaves; this is what declutters every flow.
        if (isNoiseCallee(c.callee_name)) continue;
        const resolved = _resolveCallee(db, c.callee_name, cur.file, project);
        if (!resolved) {
          // External / stdlib / unindexed — record as a terminal leaf so the
          // flow shows where it exits the indexed graph, then stop.
          const leaf = ensureNode(cur.file, c.callee_name, 'external', { terminal: true });
          if (!leaf) { truncated = true; break; }
          // Leaf id collides with caller's file but distinct name → fine.
          addEdge(curId, leaf.id);
          continue;
        }
        const child = ensureNode(resolved.file, resolved.name, resolved.kind, { ambiguous: resolved.ambiguous });
        if (!child) { truncated = true; break; }
        addEdge(curId, child.id);
        if (visited.has(child.id)) {
          // Full circle — record the cycle edge (already added) but do not
          // recurse again.
          cycles.push({ from: curId, to: child.id });
          continue;
        }
        visited.add(child.id);
        queue.push({ file: resolved.file, name: resolved.name, d: cur.d + 1 });
      }
    } else {
      const callers = getCallers(db, cur.name, project);
      for (const c of callers) {
        // Caller symbol is identified by its own (file, name).
        const child = ensureNode(c.caller_file, c.caller_name, null, {});
        if (!child) { truncated = true; break; }
        addEdge(child.id, curId);
        if (visited.has(child.id)) {
          cycles.push({ from: child.id, to: curId });
          continue;
        }
        visited.add(child.id);
        queue.push({ file: c.caller_file, name: c.caller_name, d: cur.d + 1 });
      }
    }
  }

  // If anything remains queued when we stopped on the node cap, it's truncated.
  if (queue.length && nodes.size >= maxNodes) truncated = true;

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    truncated,
    cycles,
  };
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

/**
 * Build an import graph for a project: nodes are files with their symbol counts,
 * edges are internal import relationships resolved by basename/suffix heuristic.
 *
 * WHY heuristic resolution: code_imports.target stores the raw import string
 * (e.g. './db', '../helpers/db.cjs', 'db.cjs'). We cannot do a full module
 * resolver here without knowing the bundler config, so we match by normalizing
 * both the import target and each known file's basename/path suffix and pick the
 * first match. External imports (npm packages, stdlib) that fail to match any
 * known file are dropped — they would just add noise to an internal graph.
 *
 * @param {object} db       The db.cjs module (must have .raw() and .initialize()).
 * @param {string} project  Project name to filter on.
 * @returns {{ nodes: Array<{id, label, file, symbols}>, edges: Array<{source, target}> }}
 */
function getImportGraph(db, project) {
  db.initialize(null, null);
  const conn = db.raw();
  const args = [project];

  // Collect all indexed files for this project with their symbol counts.
  const fileRows = conn.prepare(
    `SELECT file, COUNT(*) AS symbols
       FROM code_symbols
      WHERE project = ?
      GROUP BY file`
  ).all(...args);

  // Build a lookup map: normalized-forward-slash path → original file string.
  // We index by full path and by the last component (basename) to cover both
  // relative and absolute import targets.
  const fileMap = new Map(); // normKey → original-file-string
  for (const r of fileRows) {
    const norm = r.file.replace(/\\/g, '/');
    fileMap.set(norm, r.file);
    // Also index by basename without extension so './db' → 'db.cjs' resolves.
    const base = path.basename(norm).replace(/\.[^/.]+$/, '');
    if (!fileMap.has(base)) fileMap.set(base, r.file);
  }

  function resolveTarget(target) {
    if (!target) return null;
    const normTarget = target.replace(/\\/g, '/');

    // 1. Exact forward-slash match against known full paths.
    if (fileMap.has(normTarget)) return fileMap.get(normTarget);

    // 2. Strip ./ and ../ prefixes, try basename-only match.
    const base    = path.basename(normTarget).replace(/\.[^/.]+$/, '');
    const baseExt = path.basename(normTarget);
    if (fileMap.has(base))    return fileMap.get(base);
    if (fileMap.has(baseExt)) return fileMap.get(baseExt);

    // 3. Suffix match — last 2 path components (catches '../helpers/db').
    const parts   = normTarget.split('/').filter(Boolean);
    const suffix2 = parts.slice(-2).join('/');
    if (fileMap.has(suffix2)) return fileMap.get(suffix2);

    return null; // external package — drop
  }

  // Build edges from code_imports, keeping only internal-to-internal.
  const importRows = conn.prepare(
    `SELECT DISTINCT file AS src, target
       FROM code_imports
      WHERE project = ?`
  ).all(...args);

  const edges = [];
  const seenEdges = new Set();
  for (const r of importRows) {
    const resolved = resolveTarget(r.target);
    if (!resolved) continue;
    const srcNorm  = r.src.replace(/\\/g, '/');
    const destNorm = resolved.replace(/\\/g, '/');
    if (srcNorm === destNorm) continue; // self-import noise
    const key = `${srcNorm}|${destNorm}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({
      source: `file:${srcNorm}`,
      target: `file:${destNorm}`,
    });
  }

  const nodes = fileRows.map(r => {
    const norm = r.file.replace(/\\/g, '/');
    return {
      id:      `file:${norm}`,
      label:   path.basename(norm),
      file:    norm,
      symbols: r.symbols,
    };
  });

  return { nodes, edges };
}

/**
 * Build treemap data for a project: one entry per file with LOC, churn, and
 * folder grouping. churnData is pre-fetched by the caller (getChurn) so this
 * function stays synchronous and avoids double-fetching.
 *
 * @param {object}  db         The db.cjs module.
 * @param {string}  project    Project name to filter on.
 * @param {object}  churnData  Result of churn.getChurn() — { churn: [...], maxCommits }.
 * @returns {{ nodes: Array<{path, name, folder, loc, commits, ratio}> }}
 */
function getTreemapData(db, project, churnData) {
  db.initialize(null, null);
  const conn = db.raw();

  // MAX(line) is the fallback when line_count is NULL (rows not yet backfilled).
  // MAX(line_count) always wins when the column is populated since it reflects
  // the actual file length rather than the last-symbol line number.
  const fileRows = conn.prepare(
    `SELECT file,
            COALESCE(MAX(line_count), MAX(line)) AS loc
       FROM code_symbols
      WHERE project = ?
      GROUP BY file`
  ).all(project);

  // Build a churn lookup keyed by the forward-slash-normalized file basename
  // and by full path segment suffix. churn.file is repo-relative (e.g.
  // '.claude/helpers/db.cjs') so matching against absolute DB paths requires
  // a suffix check.
  const churnMap = new Map(); // normalized-path-component → { commits, ratio }
  if (churnData && churnData.churn) {
    for (const c of churnData.churn) {
      const norm = c.file.replace(/\\/g, '/');
      churnMap.set(norm, c);
      // Also index by basename for cheap lookup.
      churnMap.set(path.posix.basename(norm), c);
    }
  }

  function lookupChurn(filePath) {
    const norm = filePath.replace(/\\/g, '/');
    if (churnMap.has(norm)) return churnMap.get(norm);
    // Walk suffix segments: match '.claude/helpers/db.cjs' against a DB path
    // ending with that same suffix.
    const parts = norm.split('/').filter(Boolean);
    for (let len = Math.min(4, parts.length); len >= 1; len--) {
      const suffix = parts.slice(-len).join('/');
      if (churnMap.has(suffix)) return churnMap.get(suffix);
    }
    return null;
  }

  const nodes = fileRows.map(r => {
    const norm   = r.file.replace(/\\/g, '/');
    const churn  = lookupChurn(norm);
    const folder = path.posix.dirname(norm) || 'root';
    return {
      path:    norm,
      name:    path.posix.basename(norm),
      folder:  folder === '.' ? 'root' : folder,
      loc:     r.loc || 0,
      commits: churn ? churn.commits : 0,
      ratio:   churn ? churn.ratio   : 0,
    };
  });

  return { nodes };
}

// Levenshtein distance — used to rank fuzzy matches when exact/substring fails
function _editDist(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    const curr = new Array(bl + 1);
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[bl];
}

function searchSymbols(db, query, limit = 50) {
  db.initialize(null, null);
  const q = String(query).slice(0, 100);
  const qLow = q.toLowerCase();
  const conn = db.raw();

  // Pass 1: exact + substring (LIKE) — fast, indexed
  const like = `%${q}%`;
  let rows = conn.prepare(
    `SELECT file, lang, kind, name, line FROM code_symbols
      WHERE name LIKE ? COLLATE NOCASE
      LIMIT ?`
  ).all(like, Math.max(limit * 3, 100));

  // Score: exact match = 0, prefix = 1, contains = 2, else fuzzy distance + 10
  const scored = rows.map(r => {
    const n = r.name.toLowerCase();
    let score;
    if (n === qLow) score = 0;
    else if (n.startsWith(qLow)) score = 1;
    else if (n.includes(qLow)) score = 2;
    else score = 10 + _editDist(n, qLow);
    return { ...r, score };
  });

  // Pass 2: if substring didn't find enough, do fuzzy across all names
  if (scored.length < limit && q.length >= 3) {
    const allNames = conn.prepare(
      `SELECT DISTINCT name FROM code_symbols WHERE LENGTH(name) BETWEEN ? AND ?`
    ).all(Math.max(2, q.length - 3), q.length + 3);

    const fuzzyMatches = allNames
      .map(r => ({ name: r.name, dist: _editDist(r.name.toLowerCase(), qLow) }))
      .filter(r => r.dist <= Math.ceil(q.length * 0.3) && r.dist <= 3)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, limit);

    for (const fm of fuzzyMatches) {
      const seen = scored.find(s => s.name === fm.name);
      if (seen) continue;
      const detail = conn.prepare(
        `SELECT file, lang, kind, name, line FROM code_symbols WHERE name = ? LIMIT 1`
      ).get(fm.name);
      if (detail) scored.push({ ...detail, score: 10 + fm.dist });
    }
  }

  scored.sort((a, b) => a.score - b.score || a.name.length - b.name.length);
  return scored.slice(0, limit).map(({ score, ...rest }) => rest);
}

module.exports = {
  shouldIndex,
  indexFile,
  clearFile,
  purgeCodeGraph,
  getSymbols,
  getBlastRadius,
  getGraphStats,
  getImportGraph,
  getTreemapData,
  searchSymbols,
  getCallers,
  getCallees,
  getSymbolBody,
  // flow primitives
  getImports,
  walkTransitive,
  inferModule,
  NOISE_CALLEES,
  isNoiseCallee,
};
