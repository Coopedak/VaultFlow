/**
 * embeddings.mjs — local semantic embeddings for memory_entries.
 *
 * WHY: BM25 misses concept matches. "How does the watcher recover" doesn't
 * find a memory titled "daemon restart logic" because no shared keywords.
 * Local embedding model fixes that — no API keys, no network after first
 * load. Uses Xenova/transformers.js with all-MiniLM-L6-v2 (384 dims, ~80MB
 * on first run, fully cached after).
 *
 * Usage:
 *   import { backfillEmbeddings, semanticSearch } from './embeddings.mjs';
 *   await backfillEmbeddings();        // index missing entries
 *   const hits = await semanticSearch('how does the watcher recover', 5);
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const MODEL_DIM = 384;
const BATCH = 16;

let _pipeline = null;

async function getPipeline() {
  if (_pipeline) return _pipeline;
  // Lazy-load transformers to keep the module light for non-embedding code paths.
  const tf = await import('@xenova/transformers');
  // Quiet console noise — the lib spams cache warnings on first load.
  tf.env.allowLocalModels = true;
  _pipeline = await tf.pipeline('feature-extraction', MODEL_ID, { quantized: true });
  return _pipeline;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embed(text) {
  const pipe = await getPipeline();
  const out = await pipe(String(text || '').slice(0, 4000), { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

export async function backfillEmbeddings({ batch = BATCH, force = false } = {}) {
  const db = require('./db.cjs');
  db.initialize(null, null);
  const conn = db.raw();

  const rows = force
    ? conn.prepare('SELECT id, title, body FROM memory_entries').all()
    : conn.prepare(`
        SELECT m.id, m.title, m.body FROM memory_entries m
         LEFT JOIN memory_embeddings me ON me.memory_id = m.id
         WHERE me.memory_id IS NULL
      `).all();

  if (!rows.length) return { indexed: 0, skipped: 'all-up-to-date' };

  const upsert = conn.prepare(`
    INSERT INTO memory_embeddings (memory_id, vector, dim, model, indexed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(memory_id) DO UPDATE SET
      vector = excluded.vector,
      dim    = excluded.dim,
      model  = excluded.model,
      indexed_at = excluded.indexed_at
  `);
  const now = new Date().toISOString();

  let indexed = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    for (const r of chunk) {
      const text = (r.title || '') + '\n\n' + (r.body || '');
      try {
        const vec = await embed(text);
        upsert.run(r.id, JSON.stringify(vec), MODEL_DIM, MODEL_ID, now);
        indexed++;
      } catch (err) {
        process.stderr.write(`[embeddings] id=${r.id} err: ${err.message}\n`);
      }
    }
  }
  return { indexed, total: rows.length };
}

export async function semanticSearch(query, limit = 5) {
  const db = require('./db.cjs');
  db.initialize(null, null);
  const conn = db.raw();

  const qVec = await embed(query);

  // For 7-10k entries cosine in JS is fine (~100ms). For >100k consider sqlite-vss.
  const rows = conn.prepare(`
    SELECT me.memory_id, me.vector, m.title, m.source, substr(m.body, 1, 400) AS body
      FROM memory_embeddings me
      JOIN memory_entries m ON m.id = me.memory_id
  `).all();

  const scored = rows.map(r => {
    let v;
    try { v = JSON.parse(r.vector); } catch (_) { return null; }
    return {
      memory_id: r.memory_id,
      title:    r.title,
      source:   r.source,
      body:     r.body,
      score:    cosine(qVec, v),
    };
  }).filter(Boolean);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Process the embed_queue: drains rows for memory + prompt kinds and embeds
 * each, writing to memory_embeddings / prompt_embeddings. Idempotent — safe
 * to run from session-start-bg and from the watcher in parallel.
 */
export async function processEmbedQueue({ batchSize = 200 } = {}) {
  const db = require('./db.cjs');
  db.initialize(null, null);
  const conn = db.raw();

  // Claim ONLY memory + prompt rows — symbol rows belong to the nightly
  // processSymbolEmbedQueue drainer. popEmbedQueue deletes on pop, so popping
  // symbol rows here would discard them unembedded (the `else continue` below).
  const rows = db.popEmbedQueue(batchSize, ['memory', 'prompt']);
  if (!rows.length) return { processed: 0 };

  const upsertMem = conn.prepare(`
    INSERT INTO memory_embeddings (memory_id, vector, dim, model, indexed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(memory_id) DO UPDATE SET
      vector = excluded.vector, dim = excluded.dim,
      model  = excluded.model,  indexed_at = excluded.indexed_at
  `);
  const upsertPrompt = conn.prepare(`
    INSERT INTO prompt_embeddings (prompt_id, vector, dim, model, indexed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(prompt_id) DO UPDATE SET
      vector = excluded.vector, dim = excluded.dim,
      model  = excluded.model,  indexed_at = excluded.indexed_at
  `);

  const now = new Date().toISOString();
  let processed = 0;
  for (const r of rows) {
    try {
      let text = '';
      if (r.kind === 'memory') {
        const m = conn.prepare('SELECT title, body FROM memory_entries WHERE id = ?').get(r.target_id);
        if (!m) continue;
        text = (m.title || '') + '\n\n' + (m.body || '');
      } else if (r.kind === 'prompt') {
        const p = conn.prepare('SELECT prompt_text FROM prompts WHERE id = ?').get(r.target_id);
        if (!p) continue;
        text = p.prompt_text || '';
      } else { continue; }
      if (!text.trim()) continue;

      const vec = await embed(text);
      if (r.kind === 'memory')      upsertMem.run(r.target_id, JSON.stringify(vec), MODEL_DIM, MODEL_ID, now);
      else if (r.kind === 'prompt') upsertPrompt.run(r.target_id, JSON.stringify(vec), MODEL_DIM, MODEL_ID, now);
      processed++;
    } catch (err) {
      process.stderr.write(`[embeddings] queue ${r.kind}/${r.target_id} err: ${err.message}\n`);
    }
  }
  return { processed, batch: rows.length };
}

/**
 * Drain the embed_queue for kind='symbol'. Reads body via slice (same boundary
 * logic indexFile uses), embeds, writes to symbol_embeddings keyed by
 * (file, name, kind) plus the content_hash that produced the vector.
 * Hash mismatches on later passes are how stale embeddings get refreshed.
 */
export async function processSymbolEmbedQueue({ batchSize = 100 } = {}) {
  const db = require('./db.cjs');
  const fs = await import('node:fs');
  db.initialize(null, null);
  const conn = db.raw();

  // Pull ONLY symbol-kind queue entries; popEmbedQueue handles delete-on-pop.
  // Passing the kind filter (rather than popping all + .filter) means we never
  // claim-and-discard memory/prompt rows that processEmbedQueue owns.
  const rows = db.popEmbedQueue(batchSize, ['symbol']);
  if (!rows.length) return { processed: 0 };

  // For each queue row (target_id = code_symbols.rowid), read symbol body
  // and embed. Slice boundaries match indexFile()'s bodySlice.
  let processed = 0, failed = 0;
  for (const r of rows) {
    try {
      const sym = conn.prepare(
        `SELECT file, name, kind, line, content_hash FROM code_symbols WHERE rowid = ?`
      ).get(r.target_id);
      if (!sym || !sym.content_hash) continue;

      const content = fs.readFileSync(sym.file, 'utf8');
      const lines = content.split(/\r?\n/);
      const peers = conn.prepare(
        `SELECT line FROM code_symbols WHERE file = ? AND line > ? ORDER BY line ASC LIMIT 1`
      ).get(sym.file, sym.line);
      const startIdx = Math.max(0, sym.line - 1);
      const endIdx = peers ? Math.max(startIdx, peers.line - 1) : Math.min(lines.length, startIdx + 200);
      const body = lines.slice(startIdx, endIdx).join('\n');
      if (body.length < 10) continue;

      const vec = await embed(body);
      db.upsertSymbolEmbedding({
        file: sym.file, name: sym.name, kind: sym.kind,
        vector: vec, model: MODEL_ID, contentHash: sym.content_hash,
      });
      processed++;
    } catch (err) {
      failed++;
      process.stderr.write(`[embeddings] symbol queue rowid=${r.target_id} err: ${err.message}\n`);
    }
  }
  return { processed, failed, batch: rows.length };
}

/**
 * Backfill loop: embed code symbols that already have a content_hash but no
 * symbol_embeddings row yet. WHY: code-graph only enqueues symbols whose hash
 * CHANGED, so symbols indexed before they were ever edited never got enqueued —
 * which left semanticSymbolSearch stuck at ~4% coverage. This climbs coverage a
 * bounded batch per night without re-indexing files. Enqueue + drain happen in
 * one pass so the code_symbols.rowid we enqueue stays valid (rowids change when
 * a file is re-indexed). Relies on popEmbedQueue being kind-filtered so the
 * memory/prompt drainer can't claim-and-discard these symbol rows mid-pass.
 *
 * @param {object} opts
 * @param {number} opts.maxSymbols  Cap enqueued per call (default 3000 — ~100s nightly)
 * @param {number} opts.embedBatch  Symbols embedded per drain iteration (default 500)
 */
export async function backfillUnembeddedSymbols({ maxSymbols = 3000, embedBatch = 500 } = {}) {
  const db = require('./db.cjs');
  db.initialize(null, null);
  const conn = db.raw();

  const missing = conn.prepare(`
    SELECT cs.rowid AS rid
      FROM code_symbols cs
      LEFT JOIN symbol_embeddings se
        ON se.file = cs.file AND se.symbol_name = cs.name AND se.symbol_kind = cs.kind
     WHERE se.file IS NULL
       AND cs.content_hash IS NOT NULL
     LIMIT ?
  `).all(maxSymbols);
  if (!missing.length) return { enqueued: 0, processed: 0, failed: 0, skipped: 'fully-covered' };

  const enq = conn.prepare(`INSERT OR IGNORE INTO embed_queue (kind, target_id, queued_at) VALUES ('symbol', ?, ?)`);
  const now = new Date().toISOString();
  let enqueued = 0;
  for (const m of missing) { try { enq.run(m.rid, now); enqueued++; } catch (_) {} }

  let processed = 0, failed = 0;
  while (true) {
    const r = await processSymbolEmbedQueue({ batchSize: embedBatch });
    processed += r.processed || 0;
    failed += r.failed || 0;
    if (!r.processed && !r.failed) break;
    if ((r.batch || 0) < embedBatch) break;
  }
  return { enqueued, processed, failed };
}

/**
 * Cosine similarity over symbol_embeddings. Used by unified_search as the
 * "code semantic" source — finds symbols whose body is conceptually related
 * to the query, even when no keyword overlap exists.
 *
 * @param {string} query
 * @param {number} limit  default 5
 * @param {number} threshold  default 0.25 — low because code prose differs
 *                            from natural-language queries; tune later.
 */
export async function semanticSymbolSearch(query, { limit = 5, threshold = 0.25 } = {}) {
  const db = require('./db.cjs');
  db.initialize(null, null);
  const conn = db.raw();

  const qVec = await embed(query);

  const rows = conn.prepare(`
    SELECT file, symbol_name AS name, symbol_kind AS kind, vector
    FROM symbol_embeddings
  `).all();
  if (!rows.length) return [];

  const scored = [];
  for (const r of rows) {
    let v; try { v = JSON.parse(r.vector); } catch (_) { continue; }
    const s = cosine(qVec, v);
    if (s >= threshold) scored.push({ file: r.file, name: r.name, kind: r.kind, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * One-time backfill: re-index every file that has symbols but no hashes yet,
 * then drain the resulting embed_queue. Heavier than the nightly path but
 * useful for an initial population pass.
 *
 * @param {object} opts
 * @param {string|null} opts.projectFilter  Only re-index files for this project (faster, e.g. 'vaultflow')
 * @param {number} opts.maxFiles  Cap to this many files (default 100)
 * @param {number} opts.embedBatch  How many symbols to embed per batch (default 200)
 */
export async function backfillSymbolEmbeddings({ projectFilter = null, maxFiles = 100, embedBatch = 200 } = {}) {
  const db = require('./db.cjs');
  const fs = await import('node:fs');
  const cg = await import('./code-graph.cjs').then(m => m.default || m).catch(() => require('./code-graph.cjs'));
  db.initialize(null, null);
  const conn = db.raw();

  // Files with at least one symbol lacking content_hash.
  const files = conn.prepare(`
    SELECT DISTINCT file, project
    FROM code_symbols
    WHERE content_hash IS NULL
      ${projectFilter ? "AND project = ?" : ""}
    ORDER BY file
    LIMIT ?
  `).all(...(projectFilter ? [projectFilter, maxFiles] : [maxFiles]));

  let indexedFiles = 0, enqueued = 0;
  for (const f of files) {
    if (!fs.existsSync(f.file)) continue;
    try {
      const before = conn.prepare(`SELECT COUNT(*) AS n FROM embed_queue WHERE kind='symbol'`).get().n;
      cg.indexFile(db, f.file, f.project);
      const after = conn.prepare(`SELECT COUNT(*) AS n FROM embed_queue WHERE kind='symbol'`).get().n;
      enqueued += Math.max(0, after - before);
      indexedFiles++;
    } catch (_) {}
  }

  // Now drain whatever's queued.
  let totalProcessed = 0, totalFailed = 0;
  while (true) {
    const r = await processSymbolEmbedQueue({ batchSize: embedBatch });
    if (!r.processed && !r.failed) break;
    totalProcessed += r.processed || 0;
    totalFailed += r.failed || 0;
    if ((r.batch || 0) < embedBatch) break;
  }

  return { indexedFiles, enqueued, processed: totalProcessed, failed: totalFailed };
}

/**
 * Find past prompts semantically similar to the input. Returns matches above
 * `threshold` (default 0.85 — quite strict). Used by the UserPromptSubmit
 * hook to surface "you asked this before."
 */
export async function findSimilarPrompts(text, { limit = 3, threshold = 0.85, days = 60 } = {}) {
  const db = require('./db.cjs');
  db.initialize(null, null);
  const conn = db.raw();

  const qVec = await embed(text);
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();

  const rows = conn.prepare(`
    SELECT pe.prompt_id, pe.vector, p.prompt_text, p.timestamp, p.session_id, p.skill_routed
      FROM prompt_embeddings pe
      JOIN prompts p ON p.id = pe.prompt_id
     WHERE p.timestamp > ?
       AND length(p.prompt_text) > 8
  `).all(cutoff);

  const scored = [];
  for (const r of rows) {
    let v; try { v = JSON.parse(r.vector); } catch (_) { continue; }
    const s = cosine(qVec, v);
    if (s >= threshold) scored.push({ ...r, score: s, vector: undefined });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export async function stats() {
  const db = require('./db.cjs');
  db.initialize(null, null);
  const conn = db.raw();
  const total = conn.prepare('SELECT COUNT(*) AS n FROM memory_entries').get().n;
  const embedded = conn.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get().n;
  return { total, embedded, coverage_pct: total > 0 ? Math.round(100 * embedded / total) : 0 };
}
