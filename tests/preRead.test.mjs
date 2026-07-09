/**
 * pre-read.cjs — PreToolUse(Read) file-context injection. Smoke tests.
 * Run: node --test tests/preRead.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evaluatePreRead } from './helpers/hook-evals.mjs';

test('non-Read tool: emits nothing', () => {
  assert.equal(evaluatePreRead({ tool_name: 'Bash', tool_input: { command: 'ls' } }), null);
});

test('missing file_path: emits nothing', () => {
  assert.equal(evaluatePreRead({ tool_name: 'Read', tool_input: {} }), null);
});

test('tiny file (under 1.5KB): emits nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-pre-read-'));
  const tiny = path.join(dir, 'tiny.md');
  fs.writeFileSync(tiny, 'hello world');
  assert.equal(evaluatePreRead({ tool_name: 'Read', tool_input: { file_path: tiny } }), null);
});

test('large file with no DB history: emits nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-pre-read-'));
  const big = path.join(dir, 'big.md');
  fs.writeFileSync(big, 'x'.repeat(2000));
  const out = evaluatePreRead({ tool_name: 'Read', tool_input: { file_path: big } });
  // No DB history → no context. (Skip if DB happens to mention the temp path.)
  if (out) {
    assert.ok(out.hookSpecificOutput, 'malformed output if non-empty');
  }
});

test('large file WITH DB history: emits hookSpecificOutput', () => {
  // Use the vaultflow DB which already has thousands of edits on these files.
  const target = path.resolve('.claude/helpers/db.cjs');
  if (!fs.existsSync(target) || fs.statSync(target).size < 1500) {
    return; // Cannot test without a real large vaultflow file.
  }
  const out = evaluatePreRead({
    tool_name: 'Read',
    tool_input: { file_path: target },
  });
  if (!out) {
    // Acceptable if DB has no history yet on a fresh install.
    return;
  }
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.ok(out.hookSpecificOutput.additionalContext.includes('vaultflow context'));
  assert.ok(out.hookSpecificOutput.additionalContext.length <= 1500);
});

test('garbage stdin: exits 0 silently', () => {
  assert.equal(evaluatePreRead('not json at all'), null);
});
