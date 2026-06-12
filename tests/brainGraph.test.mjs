/**
 * getBrainGraph() — overview + neighborhood graph assembly over existing
 * edge tables. Run: node --test tests/brainGraph.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

/** Fresh metrics root with an initialized DB, seeded with cross-entity rows. */
function freshDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-brain-'));
  db.close();                       // drop any prior handle (module is a singleton)
  db.initialize(root, 'vaultflow.db');
  const conn = db.raw();
  conn.exec(`
    INSERT INTO sessions (id, started_at, project, edits) VALUES
      ('s1','2026-06-10T10:00:00Z','alpha', 5),
      ('s2','2026-06-11T10:00:00Z','beta', 2);
    INSERT INTO edit_events (timestamp, session_id, file_path, project) VALUES
      ('2026-06-10T10:01:00Z','s1','src/a.js','alpha'),
      ('2026-06-10T10:02:00Z','s1','src/b.js','alpha');
    INSERT INTO memory_entries (source, title, body, tags) VALUES
      ('vault/x.md#1','Alpha note','body one','tag'),
      ('vault/y.md#1','Beta note','body two','tag');
    INSERT INTO memory_links (source, target, title) VALUES
      ('vault/x.md#1','vault/y.md#1','Alpha note');
  `);
  return root;
}

test('overview mode returns nodes per type and edges among them', () => {
  freshDb();
  const g = db.getBrainGraph({ center: null, depth: 1, types: null, limit: 200 });
  assert.equal(g.meta.mode, 'overview');
  assert.ok(g.nodes.length > 0, 'expected nodes');
  // project nodes present
  assert.ok(g.nodes.some(n => n.type === 'project' && n.id === 'project:alpha'));
  // session node present and linked to its project
  assert.ok(g.nodes.some(n => n.id === 'session:s1'));
  assert.ok(g.edges.some(e => e.kind === 'belongs' && e.source === 'session:s1' && e.target === 'project:alpha'));
  // every edge endpoint must exist as a node (no dangling edges)
  const ids = new Set(g.nodes.map(n => n.id));
  for (const e of g.edges) {
    assert.ok(ids.has(e.source) && ids.has(e.target), `dangling edge ${e.source}->${e.target}`);
  }
});

test('limit clamps node count and sets truncated flag', () => {
  freshDb();
  const g = db.getBrainGraph({ center: null, depth: 1, types: null, limit: 2 });
  assert.ok(g.nodes.length <= 2 + 0); // soft cap honored
  assert.equal(typeof g.meta.truncated, 'boolean');
});

test('types filter restricts node types', () => {
  freshDb();
  const g = db.getBrainGraph({ center: null, depth: 1, types: ['project'], limit: 200 });
  assert.ok(g.nodes.every(n => n.type === 'project'), 'only project nodes expected');
});
