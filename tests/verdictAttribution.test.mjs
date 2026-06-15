import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

function fresh() { const r = fs.mkdtempSync(path.join(os.tmpdir(),'vf-va-')); db.close(); db.initialize(r,'vaultflow.db'); return r; }

test('agent_verdicts has a decision_id column after migration', () => {
  fresh();
  const cols = db.raw().prepare(`PRAGMA table_info(agent_verdicts)`).all().map(c => c.name);
  assert.ok(cols.includes('decision_id'), 'decision_id column missing');
});

test('recordVerdict persists decision_id', () => {
  fresh();
  db.recordVerdict('s1', 'voice-of-reason', 'APPROVED', 'looks good', null, 77);
  const row = db.raw().prepare(`SELECT decision_id FROM agent_verdicts LIMIT 1`).get();
  assert.equal(row.decision_id, 77);
});
