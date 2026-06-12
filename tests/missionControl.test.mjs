import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

function fresh() { const r = fs.mkdtempSync(path.join(os.tmpdir(),'vf-mc-')); db.close(); db.initialize(r,'vaultflow.db'); return r; }
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

test('a session with no ended_at and a recent edit is running', () => {
  fresh();
  db.raw().exec(`INSERT INTO sessions (id, started_at, project) VALUES ('s1','${iso(60000)}','alpha')`);
  db.raw().exec(`INSERT INTO edit_events (timestamp, session_id, file_path, project) VALUES ('${iso(30000)}','s1','a.js','alpha')`);
  const mc = db.getMissionControl();
  const e = mc.entries.find(x => x.id === 'session:s1');
  assert.ok(e, 'session entry present');
  assert.equal(e.status, 'running');
  assert.equal(mc.counts.running, 1);
});

test('a session with no ended_at and stale activity is a zombie', () => {
  fresh();
  db.raw().exec(`INSERT INTO sessions (id, started_at, project) VALUES ('s2','${iso(60*60000)}','beta')`);
  db.raw().exec(`INSERT INTO edit_events (timestamp, session_id, file_path, project) VALUES ('${iso(45*60000)}','s2','b.js','beta')`);
  const mc = db.getMissionControl();
  const e = mc.entries.find(x => x.id === 'session:s2');
  assert.equal(e.status, 'zombie');
});

test('an ended session today is done', () => {
  fresh();
  db.raw().exec(`INSERT INTO sessions (id, started_at, ended_at, project) VALUES ('s3','${iso(120*60000)}','${iso(100*60000)}','gamma')`);
  const mc = db.getMissionControl();
  const e = mc.entries.find(x => x.id === 'session:s3');
  assert.equal(e.status, 'done');
});
