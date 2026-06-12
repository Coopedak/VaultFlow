/**
 * vaultflow query CLI — each subcommand resolves and --json parses.
 * Runs the real cli-query.mjs as a child against a seeded fixture DB.
 * Run: node --test tests/cliQuery.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

const QUERY = path.resolve('scripts/cli-query.mjs');

function seedRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-cli-'));
  db.close(); db.initialize(root, 'vaultflow.db');
  db.raw().exec(`
    INSERT INTO sessions (id, started_at, project) VALUES ('s1','2026-06-10T10:00:00Z','alpha');
    INSERT INTO memory_entries (source, title, body, tags) VALUES ('vault/x.md#1','Auth note','use bcrypt for hashing','security');
  `);
  db.close();
  return root;
}

function run(root, args) {
  return spawnSync(process.execPath, [QUERY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, VAULTFLOW_METRICS_ROOT: root },
    timeout: 15000,
  });
}

test('graph --json prints parseable {nodes,edges}', () => {
  const root = seedRoot();
  const r = run(root, ['graph', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const g = JSON.parse(r.stdout);
  assert.ok(Array.isArray(g.nodes) && Array.isArray(g.edges));
});

test('mission --json prints parseable ledger', () => {
  const root = seedRoot();
  const r = run(root, ['mission', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const mc = JSON.parse(r.stdout);
  assert.ok(Array.isArray(mc.entries));
});

test('search prints text results', () => {
  const root = seedRoot();
  const r = run(root, ['search', 'bcrypt']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Auth note|bcrypt/i);
});

test('unknown subcommand exits non-zero with usage', () => {
  const root = seedRoot();
  const r = run(root, ['frobnicate']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /unknown|usage/i);
});
