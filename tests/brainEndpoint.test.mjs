/**
 * /api/brain/graph response shape. Boots the Express app against a fixture DB.
 * Run: node --test tests/brainEndpoint.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

function seed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-ep-'));
  db.close();
  db.initialize(root, 'vaultflow.db');
  db.raw().exec(`INSERT INTO sessions (id, started_at, project, edits) VALUES ('s1','2026-06-10T10:00:00Z','alpha',3);`);
  db.close();
  return root;
}

test('GET /api/brain/graph returns {nodes,edges,meta}', async () => {
  const root = seed();
  process.env.VAULTFLOW_METRICS_ROOT = root; // server reads config; override below if needed
  // The server module reads config at import; call the route handler via a light fetch.
  const { startServer } = await import('../.claude/helpers/dashboard/server.mjs');
  const srv = startServer({ metricsRoot: root, port: 0 });
  const addr = srv.address();
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/brain/graph?limit=50`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.nodes), 'nodes array');
  assert.ok(Array.isArray(body.edges), 'edges array');
  assert.equal(typeof body.meta.mode, 'string');
  srv.close();
});
