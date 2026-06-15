import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

function fresh() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-snap-'));
  db.close(); db.initialize(root, 'vaultflow.db'); return root;
}

test('recordBrainSnapshot then getBrainSnapshots round-trips', () => {
  fresh();
  db.recordBrainSnapshot('2026-06-10', 'patterns.count', '', 42);
  db.recordBrainSnapshot('2026-06-11', 'patterns.count', '', 47);
  const rows = db.getBrainSnapshots({ metric: 'patterns.count', scope: '', days: 30 });
  assert.equal(rows.length, 2);
  assert.equal(rows[rows.length - 1].value, 47);
});

test('recordBrainSnapshot is idempotent per (date,metric,scope)', () => {
  fresh();
  db.recordBrainSnapshot('2026-06-10', 'memory.count', '', 100);
  db.recordBrainSnapshot('2026-06-10', 'memory.count', '', 105); // same key → overwrite
  const rows = db.getBrainSnapshots({ metric: 'memory.count', scope: '', days: 30 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 105);
});
