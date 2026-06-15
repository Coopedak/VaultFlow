import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

function fresh() { const r = fs.mkdtempSync(path.join(os.tmpdir(),'vf-rf-')); db.close(); db.initialize(r,'vaultflow.db'); return r; }

test('recordRetrievalImpression writes a useful=null row', () => {
  fresh();
  db.recordRetrievalImpression({ sessionId: 's1', query: 'auth', sourceType: 'memory', sourceId: 'vault/x.md#1' });
  const rows = db.raw().prepare(`SELECT * FROM retrieval_feedback`).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'injected');
  assert.equal(rows[0].useful, null);
});

test('correlateRetrievalFeedback marks useful=1 when source file later edited in same session', () => {
  fresh();
  db.recordRetrievalImpression({ sessionId: 's1', query: 'auth', sourceType: 'memory', sourceId: 'src/auth.js#1' });
  db.raw().exec(`INSERT INTO edit_events (timestamp, session_id, file_path, project) VALUES ('2026-06-10T11:00:00Z','s1','src/auth.js','alpha')`);
  const res = db.correlateRetrievalFeedback();
  assert.ok(res.marked >= 1);
  const row = db.raw().prepare(`SELECT useful FROM retrieval_feedback LIMIT 1`).get();
  assert.equal(row.useful, 1);
});
