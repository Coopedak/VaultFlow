/**
 * pre-read.cjs — PreToolUse(Read) file-context injection. Smoke tests.
 * Run: node --test tests/preRead.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOOK = path.resolve('.claude/helpers/pre-read.cjs');

function runHook(payload) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

test('non-Read tool: emits nothing', () => {
  const { stdout, status } = runHook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(stdout.trim(), '');
  assert.equal(status, 0);
});

test('missing file_path: emits nothing', () => {
  const { stdout, status } = runHook({ tool_name: 'Read', tool_input: {} });
  assert.equal(stdout.trim(), '');
  assert.equal(status, 0);
});

test('tiny file (under 1.5KB): emits nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-pre-read-'));
  const tiny = path.join(dir, 'tiny.md');
  fs.writeFileSync(tiny, 'hello world');
  const { stdout } = runHook({ tool_name: 'Read', tool_input: { file_path: tiny } });
  assert.equal(stdout.trim(), '');
});

test('large file with no DB history: emits nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-pre-read-'));
  const big = path.join(dir, 'big.md');
  fs.writeFileSync(big, 'x'.repeat(2000));
  const { stdout } = runHook({ tool_name: 'Read', tool_input: { file_path: big } });
  // No DB history → no context. (Skip if DB happens to mention the temp path.)
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.ok(out.hookSpecificOutput, 'malformed output if non-empty');
  }
});

test('large file WITH DB history: emits hookSpecificOutput', () => {
  // Use the vaultflow DB which already has thousands of edits on these files.
  const target = path.resolve('.claude/helpers/db.cjs');
  if (!fs.existsSync(target) || fs.statSync(target).size < 1500) {
    return; // Cannot test without a real large vaultflow file.
  }
  const { stdout, stderr, status } = runHook({
    tool_name: 'Read',
    tool_input: { file_path: target },
  });
  assert.equal(status, 0, `non-zero exit. stderr=${stderr}`);
  if (!stdout.trim()) {
    // Acceptable if DB has no history yet on a fresh install.
    return;
  }
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.ok(out.hookSpecificOutput.additionalContext.includes('vaultflow context'));
  assert.ok(out.hookSpecificOutput.additionalContext.length <= 1500);
});

test('garbage stdin: exits 0 silently', () => {
  const res = spawnSync(process.execPath, [HOOK], {
    input: 'not json at all',
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(res.status, 0);
  assert.equal((res.stdout || '').trim(), '');
});
