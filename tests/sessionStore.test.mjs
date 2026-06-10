/**
 * session.cjs — per-project continuity store. Regression tests for the
 * cross-project session bleed: a single global current.json let start()
 * restore a recent session from ANY project (even one that had already
 * ended), mislabeling the new conversation's project and telemetry.
 * Run: node --test tests/sessionStore.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FIXTURE = path.resolve('tests/fixtures/session-start-fixture.cjs');

/** Make a fake project dir with its own .git so deriveProject() resolves to
 *  the dir's basename regardless of where the OS temp dir lives. */
function makeProjectDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vf-${name}-`));
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

function runStart(projectCwd, sessionsDir) {
  const res = spawnSync(process.execPath, [FIXTURE], {
    cwd: projectCwd,
    env: { ...process.env, VAULTFLOW_SESSIONS_DIR: sessionsDir },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(res.status, 0, `fixture failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function currentFileFor(sessionsDir, projectDir) {
  return path.join(sessionsDir, `current-${path.basename(projectDir)}.json`);
}

function seedSession(file, fields) {
  const now = new Date().toISOString();
  const base = {
    id: 'seeded-0000-1111',
    startedAt: now,
    endedAt: null,
    restoredAt: now,
    durationMs: null,
    platform: os.platform(),
    cwd: '',
    context: 'claude-code',
    metrics: { edits: 0, commands: 0, tasks: 0, errors: 0 },
    project: 'seeded',
    injectedSources: [],
  };
  fs.writeFileSync(file, JSON.stringify({ ...base, ...fields }, null, 2));
}

test('fresh start creates a per-project continuity file', () => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-sess-'));
  const projA = makeProjectDir('alpha');

  const s = runStart(projA, sessionsDir);
  assert.equal(s.project, path.basename(projA));
  assert.equal(path.resolve(s.cwd), path.resolve(projA));
  assert.ok(fs.existsSync(currentFileFor(sessionsDir, projA)), 'per-project current file missing');
});

test('recent live session in the same cwd is restored (same id)', () => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-sess-'));
  const projA = makeProjectDir('alpha');
  seedSession(currentFileFor(sessionsDir, projA), {
    cwd: projA,
    project: path.basename(projA),
  });

  const s = runStart(projA, sessionsDir);
  assert.equal(s.id, 'seeded-0000-1111', 'live same-project session should be restored');
});

test('ended session is never resurrected, even if recent', () => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-sess-'));
  const projA = makeProjectDir('alpha');
  seedSession(currentFileFor(sessionsDir, projA), {
    cwd: projA,
    project: path.basename(projA),
    endedAt: new Date().toISOString(),
  });

  const s = runStart(projA, sessionsDir);
  assert.notEqual(s.id, 'seeded-0000-1111', 'ended session must not be restored');
  assert.equal(s.project, path.basename(projA));
});

test('session with a foreign cwd is never restored', () => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-sess-'));
  const projA = makeProjectDir('alpha');
  const projB = makeProjectDir('bravo');
  // Same-name collision scenario: the file is in projA's slot but holds a
  // session whose cwd is another directory.
  seedSession(currentFileFor(sessionsDir, projA), {
    cwd: projB,
    project: path.basename(projB),
  });

  const s = runStart(projA, sessionsDir);
  assert.notEqual(s.id, 'seeded-0000-1111', 'foreign-cwd session must not be restored');
  assert.equal(s.project, path.basename(projA), 'new session must belong to the launching project');
  assert.equal(path.resolve(s.cwd), path.resolve(projA));
});

test('two projects keep independent continuity files', () => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-sess-'));
  const projA = makeProjectDir('alpha');
  const projB = makeProjectDir('bravo');

  const a = runStart(projA, sessionsDir);
  const b = runStart(projB, sessionsDir);
  assert.notEqual(a.id, b.id);

  // Starting B must not disturb A's continuity: A restores its own session.
  const a2 = runStart(projA, sessionsDir);
  assert.equal(a2.id, a.id, 'project A session lost after project B started');
});

test('legacy global current.json is removed on start', () => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-sess-'));
  const projA = makeProjectDir('alpha');
  const legacy = path.join(sessionsDir, 'current.json');
  seedSession(legacy, { cwd: projA, project: path.basename(projA) });

  runStart(projA, sessionsDir);
  assert.ok(!fs.existsSync(legacy), 'legacy current.json should be deleted');
});
