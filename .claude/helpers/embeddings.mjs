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

  const rows = db.popEmbedQueue(batchSize);
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
