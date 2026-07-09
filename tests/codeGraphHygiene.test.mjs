/**
 * code-graph hygiene — exclude rules (shouldIndex) + retroactive purge
 * (purgeCodeGraph). These keep vendored, generated, and transient-worktree
 * code out of the symbol graph, and reclaim rows that already leaked in.
 * Run: node --test tests/codeGraphHygiene.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cg = require('../.claude/helpers/code-graph.cjs');
const db = require('../.claude/helpers/db.cjs');

// ── shouldIndex: exclude rules ──────────────────────────────────────────────

test('shouldIndex accepts real project source', () => {
  assert.equal(cg.shouldIndex('C:\\GIT\\PRGJSMES\\prgjsmes-web\\src\\services\\api.ts'), true);
  // D:/vaultflow is the home repo; C:/GIT/vaultflow is a sibling excluded by config.
  // Use a non-excluded vaultflow path for this fixture.
  assert.equal(cg.shouldIndex('D:/vaultflow/.claude/helpers/db.cjs'), true);
  assert.equal(cg.shouldIndex('C:\\GIT\\PSI.All\\Foo\\OrderService.cs'), true);
  assert.equal(cg.shouldIndex('C:/GIT/BUZZ/app/main.py'), true);
});

test('shouldIndex rejects Python venv / site-packages (vendored deps)', () => {
  assert.equal(cg.shouldIndex('C:\\GIT\\BUZZ\\.venv\\Lib\\site-packages\\pyarrow\\tests\\test_dataset.py'), false);
  assert.equal(cg.shouldIndex('C:/GIT/BUZZ/venv/lib/python3.11/site-packages/foo.py'), false);
  assert.equal(cg.shouldIndex('C:/proj/.venv/x.py'), false);
});

test('shouldIndex rejects transient agent worktrees (.claude/worktrees)', () => {
  assert.equal(
    cg.shouldIndex('C:\\GIT\\PRGJSMES\\.claude\\worktrees\\agent-a006f1545c8f3d8e9\\prgjsmes-web\\src\\services\\api.ts'),
    false
  );
});

test('shouldIndex rejects -wt git worktree sibling dirs', () => {
  assert.equal(cg.shouldIndex('C:\\GIT\\PRGJSMES-wt\\prgjsmes-web\\src\\services\\api.ts'), false);
  // a file that merely ends in -wt is NOT a worktree dir and must still index
  assert.equal(cg.shouldIndex('C:\\GIT\\proj\\src\\widget-wt.ts'), true);
});

test('shouldIndex rejects generated C# Service References', () => {
  assert.equal(
    cg.shouldIndex('C:\\GIT\\PSI.All\\PSI.Monitor.Service\\Service References\\WorkOrderService\\Reference.cs'),
    false
  );
});

test('shouldIndex still rejects node_modules (regression guard)', () => {
  assert.equal(cg.shouldIndex('C:/proj/node_modules/foo/index.js'), false);
});

// ── purgeCodeGraph: retroactive cleanup ─────────────────────────────────────

function freshDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-cg-'));
  db.close();                       // drop any prior handle (module is a singleton)
  db.initialize(root, 'vaultflow.db');
  return root;
}

function seedFile(conn, file) {
  conn.prepare('INSERT INTO code_symbols (file,project,lang,kind,name,line,indexed_at) VALUES (?,?,?,?,?,?,?)')
    .run(file, 'p', 'ts', 'function', 'foo', 1, '2026-01-01');
  conn.prepare('INSERT INTO code_imports (file,project,lang,target,raw,line,indexed_at) VALUES (?,?,?,?,?,?,?)')
    .run(file, 'p', 'ts', './bar', 'import bar', 1, '2026-01-01');
  conn.prepare('INSERT INTO code_calls (caller_file,caller_name,callee_name,project,lang,line,indexed_at) VALUES (?,?,?,?,?,?,?)')
    .run(file, 'foo', 'bar', 'p', 'ts', 2, '2026-01-01');
}

test('purgeCodeGraph removes junk-path rows and keeps real source untouched', () => {
  freshDb();
  const conn = db.raw();
  const real = 'C:\\GIT\\PRGJSMES\\prgjsmes-web\\src\\services\\api.ts';
  const junk = [
    'C:\\GIT\\BUZZ\\.venv\\Lib\\site-packages\\pyarrow\\test_x.py',
    'C:\\GIT\\PRGJSMES\\.claude\\worktrees\\agent-x\\api.ts',
    'C:\\GIT\\PRGJSMES-wt\\prgjsmes-web\\src\\services\\api.ts',
  ];
  seedFile(conn, real);
  for (const j of junk) seedFile(conn, j);
  assert.equal(conn.prepare('SELECT COUNT(*) c FROM code_symbols').get().c, 4);

  const res = cg.purgeCodeGraph(db, { checkExistence: false });
  assert.equal(res.junkFiles, 3, 'all three junk files purged');

  assert.deepEqual(conn.prepare('SELECT file FROM code_symbols').all().map(r => r.file), [real]);
  assert.equal(conn.prepare('SELECT COUNT(*) c FROM code_imports').get().c, 1, 'junk imports cleared, real kept');
  assert.equal(conn.prepare('SELECT COUNT(*) c FROM code_calls').get().c, 1, 'junk calls cleared, real kept');
});

test('purgeCodeGraph removes rows for files that no longer exist on disk', () => {
  const root = freshDb();
  const conn = db.raw();
  const exists  = path.join(root, 'real', 'kept.ts');
  const missing = path.join(root, 'gone', 'deleted.ts');       // never created
  fs.mkdirSync(path.dirname(exists), { recursive: true });
  fs.writeFileSync(exists, 'export const kept = 1;\n');
  seedFile(conn, exists);
  seedFile(conn, missing);

  const res = cg.purgeCodeGraph(db, { checkExistence: true });
  assert.equal(res.missingFiles, 1, 'missing file purged');
  assert.equal(res.junkFiles, 0, 'neither path is junk');
  assert.deepEqual(conn.prepare('SELECT file FROM code_symbols').all().map(r => r.file), [exists]);
});

test('purgeCodeGraph with no junk and existence off is a no-op', () => {
  freshDb();
  const conn = db.raw();
  // Use D:/vaultflow (home repo) not C:/GIT/vaultflow (excluded sibling) as real path.
  const real = 'D:/vaultflow/.claude/helpers/db.cjs';
  seedFile(conn, real);
  const res = cg.purgeCodeGraph(db, { checkExistence: false });
  assert.equal(res.filesPurged, 0);
  assert.equal(conn.prepare('SELECT COUNT(*) c FROM code_symbols').get().c, 1);
});
