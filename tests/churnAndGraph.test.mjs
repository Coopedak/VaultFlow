/**
 * churnAndGraph.test.mjs — unit tests for churn.cjs pure helpers and
 * code-graph.cjs import-graph / treemap data builders.
 *
 * Tests cover only PURE logic that does not require a live DB, git, or disk.
 * Run: node --test tests/churnAndGraph.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require  = createRequire(import.meta.url);
const churn    = require('../.claude/helpers/churn.cjs');
const cg       = require('../.claude/helpers/code-graph.cjs');
const db       = require('../.claude/helpers/db.cjs');

// ── churn: normalizePath ─────────────────────────────────────────────────────

test('normalizePath converts backslashes to forward slashes', () => {
  assert.equal(churn.normalizePath('C:\\GIT\\vaultflow\\.claude\\helpers\\db.cjs'),
               'C:/GIT/vaultflow/.claude/helpers/db.cjs');
});

test('normalizePath is a no-op for forward-slash paths', () => {
  assert.equal(churn.normalizePath('C:/GIT/vaultflow/src/index.js'),
               'C:/GIT/vaultflow/src/index.js');
});

test('normalizePath handles empty / null gracefully', () => {
  assert.equal(churn.normalizePath(''), '');
  assert.equal(churn.normalizePath(null), '');
  assert.equal(churn.normalizePath(undefined), '');
});

// ── churn: parseGitNameOnly ──────────────────────────────────────────────────

test('parseGitNameOnly counts one file changed in one commit', () => {
  const raw = '\nsrc/index.js\n\n';
  const map = churn.parseGitNameOnly(raw);
  assert.equal(map.get('src/index.js'), 1);
  assert.equal(map.size, 1);
});

test('parseGitNameOnly counts multiple commits for the same file', () => {
  // git log --name-only --format= produces blank lines between commits.
  const raw = [
    '',
    'src/index.js',
    'src/utils.js',
    '',
    'src/index.js',
    '',
  ].join('\n');
  const map = churn.parseGitNameOnly(raw);
  assert.equal(map.get('src/index.js'), 2);
  assert.equal(map.get('src/utils.js'), 1);
});

test('parseGitNameOnly skips 40-char SHA lines (defensive, format= suppresses them)', () => {
  const sha = 'a'.repeat(40);
  const raw = `\n${sha}\nsrc/app.js\n`;
  const map = churn.parseGitNameOnly(raw);
  assert.equal(map.has(sha), false, 'SHA line must be skipped');
  assert.equal(map.get('src/app.js'), 1);
});

test('parseGitNameOnly normalizes backslash paths from Windows git', () => {
  const raw = '\nsrc\\helpers\\db.cjs\n\n';
  const map = churn.parseGitNameOnly(raw);
  assert.equal(map.get('src/helpers/db.cjs'), 1, 'backslash must be normalized');
});

test('parseGitNameOnly returns empty map for empty input', () => {
  assert.equal(churn.parseGitNameOnly('').size, 0);
  assert.equal(churn.parseGitNameOnly(null).size, 0);
});

// ── churn: buildChurnList ────────────────────────────────────────────────────

test('buildChurnList sorts by commits descending', () => {
  const map = new Map([
    ['a.js', 3],
    ['b.js', 10],
    ['c.js', 1],
  ]);
  const list = churn.buildChurnList(map);
  assert.equal(list[0].file, 'b.js');
  assert.equal(list[1].file, 'a.js');
  assert.equal(list[2].file, 'c.js');
});

test('buildChurnList computes ratio correctly: maxCommits = top entry commits', () => {
  const map = new Map([
    ['hot.js',  100],
    ['warm.js',  50],
    ['cold.js',  10],
  ]);
  const list = churn.buildChurnList(map);
  // hot.js has the max, so ratio = 1
  assert.equal(list[0].ratio, 1);
  // warm.js = 50/100 = 0.5
  assert.equal(list[1].ratio, 0.5);
  // cold.js = 10/100 = 0.1
  assert.ok(Math.abs(list[2].ratio - 0.1) < 1e-9, `expected 0.1, got ${list[2].ratio}`);
});

test('buildChurnList returns ratio 0 when maxCommits is 0', () => {
  // A map where every value is 0 should not divide by zero.
  const map = new Map([['file.js', 0]]);
  const list = churn.buildChurnList(map);
  assert.equal(list[0].ratio, 0);
});

test('buildChurnList returns empty array for empty map', () => {
  assert.deepEqual(churn.buildChurnList(new Map()), []);
  assert.deepEqual(churn.buildChurnList(null), []);
});

// ── code-graph: getImportGraph target resolution ─────────────────────────────

function freshDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-chg-'));
  db.close();
  db.initialize(root, 'vaultflow.db');
  return root;
}

function seed(conn, file, project, target) {
  try {
    conn.prepare(
      `INSERT OR IGNORE INTO code_symbols (file,project,lang,kind,name,line,indexed_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run(file, project, 'js', 'function', 'fn_' + path.basename(file).replace(/\W/g, '_'), 1, '2026-01-01');
  } catch (_) {}
  if (target) {
    try {
      conn.prepare(
        `INSERT OR IGNORE INTO code_imports (file,project,lang,target,raw,line,indexed_at)
         VALUES (?,?,?,?,?,?,?)`
      ).run(file, project, 'js', target, `import '${target}'`, 1, '2026-01-01');
    } catch (_) {}
  }
}

test('getImportGraph: internal edge resolved by basename match', () => {
  freshDb();
  const conn = db.raw();
  // Two files: a.js imports b.js by basename './b'
  seed(conn, 'C:/GIT/proj/src/a.js', 'proj', './b');
  seed(conn, 'C:/GIT/proj/src/b.js', 'proj', null);

  const graph = cg.getImportGraph(db, 'proj');

  // Both files become nodes
  assert.equal(graph.nodes.length, 2, 'should have 2 nodes');

  // Edge from a.js → b.js must exist
  const edge = graph.edges.find(
    e => e.source.includes('a.js') && e.target.includes('b.js')
  );
  assert.ok(edge, 'edge a.js → b.js must be present');
});

test('getImportGraph: external npm import is dropped', () => {
  freshDb();
  const conn = db.raw();
  seed(conn, 'C:/GIT/proj/src/index.js', 'proj', 'express');
  seed(conn, 'C:/GIT/proj/src/index.js', 'proj', './utils');
  seed(conn, 'C:/GIT/proj/src/utils.js', 'proj', null);

  const graph = cg.getImportGraph(db, 'proj');
  // 'express' is external — should not create an edge
  const expressEdge = graph.edges.find(e => e.target.includes('express'));
  assert.equal(expressEdge, undefined, 'external npm import must be dropped');

  // But internal edge must exist
  const internalEdge = graph.edges.find(e => e.target.includes('utils.js'));
  assert.ok(internalEdge, 'internal edge to utils.js must be present');
});

test('getImportGraph: node id format is "file:" + forward-slash path', () => {
  freshDb();
  const conn = db.raw();
  seed(conn, 'C:/GIT/proj/src/x.js', 'proj', null);

  const graph = cg.getImportGraph(db, 'proj');
  assert.ok(graph.nodes[0].id.startsWith('file:'), 'node id must start with "file:"');
  assert.ok(!graph.nodes[0].id.includes('\\'), 'node id must use forward slashes');
});

// ── code-graph: getTreemapData LOC fallback ───────────────────────────────────

test('getTreemapData: uses line_count when populated, falls back to MAX(line)', () => {
  freshDb();
  const conn = db.raw();

  // Row WITH line_count populated
  conn.prepare(
    `INSERT INTO code_symbols (file,project,lang,kind,name,line,indexed_at,line_count)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run('C:/GIT/p/a.js', 'p', 'js', 'function', 'fa', 1, '2026-01-01', 250);

  // Row WITHOUT line_count (NULL) — fallback should use MAX(line)
  conn.prepare(
    `INSERT INTO code_symbols (file,project,lang,kind,name,line,indexed_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run('C:/GIT/p/b.js', 'p', 'js', 'function', 'fb', 180, '2026-01-01');

  const result = cg.getTreemapData(db, 'p', { churn: [] });

  const nodeA = result.nodes.find(n => n.name === 'a.js');
  const nodeB = result.nodes.find(n => n.name === 'b.js');

  assert.ok(nodeA, 'a.js node must exist');
  assert.ok(nodeB, 'b.js node must exist');

  // a.js has explicit line_count=250
  assert.equal(nodeA.loc, 250, 'a.js should use line_count=250');
  // b.js has no line_count → COALESCE falls back to MAX(line)=180
  assert.equal(nodeB.loc, 180, 'b.js should fall back to MAX(line)=180');
});

test('getTreemapData: commits and ratio default to 0 when no churn data', () => {
  freshDb();
  const conn = db.raw();
  conn.prepare(
    `INSERT INTO code_symbols (file,project,lang,kind,name,line,indexed_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run('C:/GIT/p/c.js', 'p', 'js', 'function', 'fc', 10, '2026-01-01');

  const result = cg.getTreemapData(db, 'p', { churn: [] });
  const nodeC  = result.nodes.find(n => n.name === 'c.js');
  assert.ok(nodeC, 'c.js node must exist');
  assert.equal(nodeC.commits, 0, 'commits defaults to 0 with no churn data');
  assert.equal(nodeC.ratio,   0, 'ratio defaults to 0 with no churn data');
});

test('getTreemapData: folder is dirname or "root" for top-level files', () => {
  freshDb();
  const conn = db.raw();
  // File with a parent directory
  conn.prepare(
    `INSERT INTO code_symbols (file,project,lang,kind,name,line,indexed_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run('C:/GIT/p/src/helper.js', 'p', 'js', 'function', 'fh', 5, '2026-01-01');

  const result  = cg.getTreemapData(db, 'p', { churn: [] });
  const helper  = result.nodes.find(n => n.name === 'helper.js');
  assert.ok(helper, 'helper.js must be present');
  assert.ok(helper.folder !== 'root', 'nested file should have a real folder, not "root"');
  assert.ok(helper.folder.endsWith('src'), `folder should end with 'src', got '${helper.folder}'`);
});
