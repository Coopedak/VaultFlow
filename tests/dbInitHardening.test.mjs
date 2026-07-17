/**
 * dbInitHardening.test.mjs — regression locks for the 2026-07 initialize()
 * performance repair. Three behaviors, each of which silently regressing
 * would re-tax every hook invocation (initialize runs at the start of EVERY
 * Read/Edit/prompt hook):
 *
 *  1. The one-shot FTS repair is recorded in vf_meta so rebuilds don't run
 *     per-open (they cost ~1.7s on a 400MB DB).
 *  2. The separator-normalized expression index on edit_events exists and
 *     actually serves the pre-read history lookup (was a full-table scan).
 *  3. The db.cjs CLI entry (background-agent interface documented in
 *     CLAUDE.md) prints usage instead of silently no-oping.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

const DB_CJS = path.resolve('.claude/helpers/db.cjs');

function fresh() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-init-'));
  db.close(); db.initialize(root, 'vaultflow.db'); return root;
}

test('initialize() records the one-shot FTS repair flag in vf_meta', () => {
  fresh();
  const row = db.raw().prepare(`SELECT value FROM vf_meta WHERE key = 'fts_repair_v1'`).get();
  assert.ok(row, 'fts_repair_v1 flag missing — FTS rebuilds are running on every open again');
  assert.ok(!Number.isNaN(Date.parse(row.value)), 'flag value should be an ISO timestamp');
});

test('re-initialize preserves the vf_meta flag (repair does not re-run)', () => {
  const root = fresh();
  const first = db.raw().prepare(`SELECT value FROM vf_meta WHERE key = 'fts_repair_v1'`).get().value;
  db.close(); db.initialize(root, 'vaultflow.db');
  const second = db.raw().prepare(`SELECT value FROM vf_meta WHERE key = 'fts_repair_v1'`).get().value;
  assert.equal(second, first, 'flag was rewritten — repair block re-ran on re-open');
});

test('edit_events has the normalized-path expression index and the pre-read query uses it', () => {
  fresh();
  const raw = db.raw();
  const idx = raw.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_edit_events_path_norm'`
  ).get();
  assert.ok(idx, 'idx_edit_events_path_norm missing from schema');

  // Same expression as pre-read.cjs — the index only helps if they match.
  const plan = raw.prepare(`
    EXPLAIN QUERY PLAN
    SELECT file_path FROM edit_events
    WHERE REPLACE(file_path,'\\','/') = ? AND timestamp >= ?
    ORDER BY timestamp DESC LIMIT 10
  `).all('C:/x/y.js', '2026-01-01');
  const details = plan.map(r => r.detail).join(' | ');
  assert.ok(
    details.includes('idx_edit_events_path_norm'),
    `pre-read lookup not served by the expression index (plan: ${details})`
  );
});

test('db.cjs CLI: no args prints usage and exits 2 (documented agent interface)', () => {
  const res = spawnSync(process.execPath, [DB_CJS], { encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 2);
  assert.ok((res.stderr || '').includes('--search'), 'usage text should mention --search');
});
