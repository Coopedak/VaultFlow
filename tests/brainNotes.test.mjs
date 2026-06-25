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
  // Verify ORDER BY id DESC — each successive id must be strictly smaller.
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].id > rows[i].id, `row[${i-1}].id (${rows[i-1].id}) should be > row[${i}].id (${rows[i].id})`);
  }
});

test('listNotes source filter returns only matching rows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-notes-src-'));
  try { db.close(); } catch {}
  db.initialize(root, 'vaultflow.db');
  db.raw().exec(`
    INSERT INTO memory_entries (source, title, body, tags) VALUES
      ('a.md', 'NoteA', 'body a', ''),
      ('b.md', 'NoteB', 'body b', ''),
      ('a.md', 'NoteC', 'body c', '');
  `);
  const all = notes.listNotes({ limit: 10 });
  assert.equal(all.length, 3);
  const aOnly = notes.listNotes({ source: 'a.md' });
  assert.equal(aOnly.length, 2);
  assert.ok(aOnly.every(r => r.source === 'a.md'));
  const bOnly = notes.listNotes({ source: 'b.md' });
  assert.equal(bOnly.length, 1);
  assert.equal(bOnly[0].title, 'NoteB');
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

// ── Task 2: wikilink extraction, resolveLinks, getBacklinks ───────────────

test('extractWikilinkTitles pulls names out of [[ ]]', () => {
  assert.deepEqual(notes.extractWikilinkTitles('see [[Beta]] and [[Ghost]] ok'), ['Beta', 'Ghost']);
  assert.deepEqual(notes.extractWikilinkTitles('none here'), []);
});

test('resolveLinks marks resolved vs dangling, case-insensitively', () => {
  freshDb();
  const links = notes.resolveLinks('Gamma sees [[beta]] and [[Ghost]].');
  const beta = links.find(l => l.name.toLowerCase() === 'beta');
  const ghost = links.find(l => l.name === 'Ghost');
  assert.equal(beta.dangling, false);
  assert.equal(beta.id, idOf('Beta'));
  assert.equal(ghost.dangling, true);
  assert.equal(ghost.id, null);
});

test('getBacklinks finds notes linking to this note', () => {
  freshDb();
  const refs = notes.getBacklinks(idOf('Beta'));
  assert.deepEqual(refs.map(r => r.title).sort(), ['Alpha', 'Gamma']);
});

test('getNote includes links and backlinks', () => {
  freshDb();
  const gamma = notes.getNote(idOf('Gamma'));
  assert.equal(gamma.links.length, 2);
  const beta = notes.getNote(idOf('Beta'));
  assert.deepEqual(beta.backlinks.map(r => r.title).sort(), ['Alpha', 'Gamma']);
});

// ── Task 3: getLocalGraph ─────────────────────────────────────────────────

test('getLocalGraph returns the note plus linked + backlinking neighbors', () => {
  freshDb();
  const g = notes.getLocalGraph(idOf('Beta'));
  const ids = g.nodes.map(n => n.label).sort();
  assert.deepEqual(ids, ['Alpha', 'Beta', 'Gamma']);     // Beta + its two backlinkers
  const center = g.nodes.find(n => n.center);
  assert.equal(center.label, 'Beta');
  assert.ok(g.edges.length >= 2);
  for (const e of g.edges) { assert.equal(typeof e.source, 'string'); assert.equal(typeof e.target, 'string'); }
});

test('getLocalGraph on a missing id returns empty graph', () => {
  freshDb();
  assert.deepEqual(notes.getLocalGraph(999999), { nodes: [], edges: [] });
});

test('getLocalGraph outgoing neighbor label uses canonical DB title, not raw wikilink text', () => {
  // Seed a note that links via lowercase [[beta]] to a note titled "Beta".
  // The graph node for Beta must be labeled "Beta", not "beta".
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-notes-lbl-'));
  try { db.close(); } catch {}
  db.initialize(root, 'vaultflow.db');
  db.raw().exec(`
    INSERT INTO memory_entries (source, title, body, tags) VALUES
      ('x.md', 'Source', 'Links to [[beta]] here.', ''),
      ('x.md', 'Beta',   'Beta body.',              '');
  `);
  const srcId = db.raw().prepare('SELECT id FROM memory_entries WHERE title = ?').get('Source').id;
  const g = notes.getLocalGraph(srcId);
  const betaNode = g.nodes.find(n => !n.center);
  assert.ok(betaNode, 'neighbor node should exist');
  assert.equal(betaNode.label, 'Beta', `expected canonical "Beta", got "${betaNode.label}"`);
});
