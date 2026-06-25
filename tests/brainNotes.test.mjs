// tests/brainNotes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');
const notes = require('../.claude/helpers/brain-notes.cjs');

function freshDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-notes-'));
  try { db.close(); } catch {}
  db.initialize(root, 'vaultflow.db');
  db.raw().exec(`
    INSERT INTO memory_entries (source, title, body, tags) VALUES
      ('a.md', 'Alpha', 'Alpha links to [[Beta]] here.', 'x'),
      ('a.md', 'Beta',  'Beta is a plain note.',          'y'),
      ('a.md', 'Gamma', 'Gamma sees [[Beta]] and [[Ghost]].', 'z');
  `);
  return root;
}
function idOf(title) {
  return db.raw().prepare('SELECT id FROM memory_entries WHERE title = ?').get(title).id;
}

// ── Task 1: listNotes + getNote ───────────────────────────────────────────

test('listNotes returns all note headers, newest first', () => {
  freshDb();
  const rows = notes.listNotes({ limit: 10 });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.title).sort(), ['Alpha', 'Beta', 'Gamma']);
  assert.ok('source' in rows[0] && 'tags' in rows[0] && !('body' in rows[0]));
});

test('getNote returns the full note including body', () => {
  freshDb();
  const n = notes.getNote(idOf('Beta'));
  assert.equal(n.title, 'Beta');
  assert.match(n.body, /plain note/);
});

test('getNote returns null for a missing id', () => {
  freshDb();
  assert.equal(notes.getNote(999999), null);
});
