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

export async function stats() {
  const db = require('./db.cjs');
  db.initialize(null, null);
  const conn = db.raw();
  const total = conn.prepare('SELECT COUNT(*) AS n FROM memory_entries').get().n;
  const embedded = conn.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get().n;
  return { total, embedded, coverage_pct: total > 0 ? Math.round(100 * embedded / total) : 0 };
}
