import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

function fresh() { const r = fs.mkdtempSync(path.join(os.tmpdir(),'vf-ev-')); db.close(); db.initialize(r,'vaultflow.db'); return r; }

test('first call with empty watermarks returns current max rowids and no spurious events', () => {
  fresh();
  db.raw().exec(`INSERT INTO edit_events (timestamp, session_id, file_path, project) VALUES ('2026-06-10T10:00:00Z','s1','a.js','alpha')`);
  const r1 = db.getEventsSince({});
  assert.ok(r1.watermarks.edit_events >= 1, 'watermark should advance to current max');
  // a second call with the returned watermark yields nothing new
  const r2 = db.getEventsSince(r1.watermarks);
  assert.equal(r2.events.length, 0, 'no new events after catching up');
});

test('new rows after a watermark are returned as events with refs', () => {
  fresh();
  const r1 = db.getEventsSince({});
  db.raw().exec(`INSERT INTO edit_events (timestamp, session_id, file_path, project) VALUES ('2026-06-10T10:05:00Z','s1','src/x.js','alpha')`);
  const r2 = db.getEventsSince(r1.watermarks);
  assert.equal(r2.events.length, 1);
  const e = r2.events[0];
  assert.equal(e.kind, 'edit');
  assert.ok(e.refs.includes('file:src/x.js'));
  assert.ok(e.refs.includes('session:s1'));
});
