/**
 * GET /api/overview — Command Center aggregator shape check.
 * Seeds a temp fixture DB and asserts every documented key is present.
 * Run: node --test tests/dashboardOverview.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function seedRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-overview-'));
  const db = require('../.claude/helpers/db.cjs');
  db.close?.();
  db.initialize(dir, 'vaultflow.db');
  const c = db.raw();
  c.exec("INSERT INTO sessions (started_at, ended_at, project) VALUES (datetime('now'), datetime('now'), 'vaultflow')");
  c.exec("INSERT INTO memory_entries (title, body, source) VALUES ('t','b','x')");
  return dir;
}

test('GET /api/overview returns the documented shape', async () => {
  const metricsRoot = seedRoot();
  const { startServer } = await import('../.claude/helpers/dashboard/server.mjs');
  const srv = startServer({ port: 0, metricsRoot });
  await new Promise(r => srv.on('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await fetch(base + '/api/overview');
    assert.equal(r.status, 200);
    const o = await r.json();
    for (const k of ['health','memory','codeGraph','sessions','retrieval7d','nightly','embedQueue','db','discoveriesUnreviewed','staleMemory','watcher','recentSessions']) {
      assert.ok(k in o, `missing key: ${k}`);
    }
    assert.equal(typeof o.health.ok,   'number');
    assert.equal(typeof o.health.warn, 'number');
    assert.equal(typeof o.health.fail, 'number');
    assert.equal(typeof o.memory.total,    'number');
    assert.equal(typeof o.memory.embedded, 'number');
    assert.equal(typeof o.memory.pct,      'number');
    assert.equal(typeof o.codeGraph.files,   'number');
    assert.equal(typeof o.codeGraph.symbols, 'number');
    assert.equal(typeof o.codeGraph.edges,   'number');
    assert.equal(typeof o.sessions.total,         'number');
    assert.equal(typeof o.sessions.summarizedPct, 'number');
    assert.equal(typeof o.retrieval7d, 'number');
    assert.ok(o.nightly.ageHours === null || typeof o.nightly.ageHours === 'number');
    assert.equal(typeof o.embedQueue.depth, 'number');
    assert.equal(typeof o.db.sizeMb,     'number');
    assert.equal(typeof o.db.integrity,  'string');
    assert.equal(typeof o.discoveriesUnreviewed, 'number');
    assert.equal(typeof o.staleMemory,           'number');
    assert.equal(typeof o.watcher.running, 'boolean');
    assert.ok(Array.isArray(o.recentSessions));
    // I1: Verify seeded rows flow through queries
    assert.ok(o.sessions.total >= 1, 'seeded session must appear in total');
    assert.ok(o.memory.total   >= 1, 'seeded memory_entry must appear in total');
    assert.ok(Array.isArray(o.recentSessions) && o.recentSessions.length >= 1, 'seeded session must appear in recentSessions');
  } finally { srv.close(); }
});
