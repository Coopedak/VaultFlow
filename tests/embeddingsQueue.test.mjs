/**
 * embed_queue + embedding-hygiene regression tests.
 *
 * Locks in the kind-filtered popEmbedQueue fix. The memory/prompt drainer
 * (session-start + watcher) and the nightly symbol drainer share ONE
 * delete-on-pop queue, so an unfiltered pop let the frequent drainer
 * claim-and-discard symbol rows before the symbol drainer ever saw them —
 * which froze symbol-embedding coverage at ~4%. Also covers the orphan-purge
 * DELETE (nightly step 8e3) and the unembedded-symbol selection that drives the
 * symbol-embedding backfill loop. All assertions are model-free (no transformers).
 *
 * Run: node --test tests/embeddingsQueue.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

function freshDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-embq-'));
  db.close();                        // drop any prior handle (module is a singleton)
  db.initialize(root, 'vaultflow.db');
  return root;
}

function enqueue(conn, kind, targetId, queuedAt = '2026-01-01T00:00:00Z') {
  conn.prepare(`INSERT INTO embed_queue (kind, target_id, queued_at) VALUES (?, ?, ?)`).run(kind, targetId, queuedAt);
}

// ── popEmbedQueue: kind-filtered lanes (regression for the shipped bug) ───────

test('popEmbedQueue(["memory","prompt"]) claims only its lane and leaves symbol rows', () => {
  freshDb();
  const conn = db.raw();
  enqueue(conn, 'memory', 1);
  enqueue(conn, 'symbol', 2);
  enqueue(conn, 'prompt', 3);
  enqueue(conn, 'symbol', 4);

  const got = db.popEmbedQueue(100, ['memory', 'prompt']);
  assert.deepEqual(got.map(r => r.kind).sort(), ['memory', 'prompt']);
  // symbol rows MUST survive for the nightly symbol drainer (this is the bug).
  // node:sqlite rows are null-prototype, so normalize before deep-compare.
  const left = conn.prepare(`SELECT kind, COUNT(*) n FROM embed_queue GROUP BY kind`).all()
    .map(r => ({ kind: r.kind, n: Number(r.n) }));
  assert.deepEqual(left, [{ kind: 'symbol', n: 2 }]);
});

test('popEmbedQueue(["symbol"]) claims only symbol rows', () => {
  freshDb();
  const conn = db.raw();
  enqueue(conn, 'memory', 1);
  enqueue(conn, 'symbol', 2);
  const got = db.popEmbedQueue(100, ['symbol']);
  assert.deepEqual(got.map(r => Number(r.target_id)), [2]);
  assert.equal(conn.prepare(`SELECT COUNT(*) n FROM embed_queue`).get().n, 1, 'memory row untouched');
});

test('popEmbedQueue() with no kind filter pops all kinds (legacy behavior preserved)', () => {
  freshDb();
  const conn = db.raw();
  enqueue(conn, 'memory', 1);
  enqueue(conn, 'symbol', 2);
  enqueue(conn, 'prompt', 3);
  const got = db.popEmbedQueue(100);
  assert.equal(got.length, 3);
  assert.equal(conn.prepare(`SELECT COUNT(*) n FROM embed_queue`).get().n, 0);
});

test('popEmbedQueue deletes on pop and respects the limit (oldest id first)', () => {
  freshDb();
  const conn = db.raw();
  for (let i = 1; i <= 5; i++) enqueue(conn, 'symbol', i);
  const got = db.popEmbedQueue(2, ['symbol']);
  assert.deepEqual(got.map(r => Number(r.target_id)), [1, 2]);
  assert.equal(conn.prepare(`SELECT COUNT(*) n FROM embed_queue`).get().n, 3, 'only 2 popped, 3 remain');
});

// ── orphan-embedding purge (nightly step 8e3) ────────────────────────────────

test('orphan purge deletes embeddings whose source row is gone, keeps live ones', () => {
  freshDb();
  const conn = db.raw();
  const id = Number(conn.prepare(`INSERT INTO memory_entries (source, title, body) VALUES ('s','t','b')`).run().lastInsertRowid);
  const vec = JSON.stringify([0.1, 0.2]);
  conn.prepare(`INSERT INTO memory_embeddings (memory_id, vector, dim, model, indexed_at) VALUES (?,?,?,?,?)`).run(id, vec, 2, 'm', 't');
  conn.prepare(`INSERT INTO memory_embeddings (memory_id, vector, dim, model, indexed_at) VALUES (?,?,?,?,?)`).run(999999, vec, 2, 'm', 't'); // orphan

  const deleted = conn.prepare(`DELETE FROM memory_embeddings WHERE memory_id NOT IN (SELECT id FROM memory_entries)`).run().changes;
  assert.equal(deleted, 1, 'only the orphan deleted');
  assert.deepEqual(conn.prepare(`SELECT memory_id FROM memory_embeddings`).all().map(r => Number(r.memory_id)), [id]);
});

// ── unembedded-symbol selection (drives backfillUnembeddedSymbols) ────────────

test('unembedded-symbol selection: hashed-but-unembedded only; skips covered + null-hash', (t) => {
  freshDb();
  const conn = db.raw();
  // Portable across the portable-brain snapshot copies: older copies (e.g. D:)
  // predate the symbol-embedding subsystem. Skip rather than fail where the
  // symbol_embeddings table / code_symbols.content_hash column is absent.
  const hasTable = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='symbol_embeddings'").get();
  const hasHash = conn.prepare('PRAGMA table_info(code_symbols)').all().some(c => c.name === 'content_hash');
  if (!hasTable || !hasHash) { t.skip('symbol-embedding subsystem not present in this copy'); return; }
  const insSym = conn.prepare(`INSERT INTO code_symbols (file,project,lang,kind,name,line,indexed_at,content_hash) VALUES (?,?,?,?,?,?,?,?)`);
  insSym.run('/a.js', 'p', 'js', 'function', 'covered', 1, 't', 'h1');  // already embedded
  insSym.run('/a.js', 'p', 'js', 'function', 'missing', 2, 't', 'h2');  // hashed, unembedded -> selected
  insSym.run('/a.js', 'p', 'js', 'function', 'nohash',  3, 't', null);  // no hash -> skipped

  conn.prepare(`INSERT INTO symbol_embeddings (file,symbol_name,symbol_kind,vector,dim,model,content_hash,indexed_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run('/a.js', 'covered', 'function', '[0]', 1, 'm', 'h1', 't');

  const rows = conn.prepare(`
    SELECT cs.name FROM code_symbols cs
    LEFT JOIN symbol_embeddings se
      ON se.file = cs.file AND se.symbol_name = cs.name AND se.symbol_kind = cs.kind
    WHERE se.file IS NULL AND cs.content_hash IS NOT NULL
  `).all().map(r => r.name);
  assert.deepEqual(rows, ['missing']);
});
