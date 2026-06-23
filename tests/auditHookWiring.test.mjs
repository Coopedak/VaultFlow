/**
 * auditHookWiring.test.mjs — regression guard for audit.mjs hook-wiring detection.
 *
 * The bug this locks down: checkHookWiring() used to read ONLY the project
 * .claude/settings.json. But vaultflow's lifecycle hooks (SessionStart,
 * SessionEnd, PostToolUse, UserPromptSubmit, Stop) are wired in the USER's
 * global ~/.claude/settings.json — Claude Code merges hooks from project
 * shared + project local + user global + enterprise managed. The old check
 * therefore reported live, firing hooks as "missing" (a false negative).
 *
 * wiredHookEvents() computes the UNION of hook event names across every
 * settings scope. A hook is "wired" if present in ANY scope.
 */

import test   from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import os     from 'node:os';
import path   from 'node:path';

import { wiredHookEvents, readSettingsFile } from '../.claude/helpers/audit.mjs';

test('a hook wired only in global settings counts as wired (the false-negative fix)', () => {
  const project = { hooks: { PreToolUse: [] } };
  const global  = { hooks: { SessionStart: [], SessionEnd: [], Stop: [] } };
  const wired = wiredHookEvents(project, global);

  assert.ok(wired.has('SessionStart'), 'SessionStart from global should be wired');
  assert.ok(wired.has('Stop'),         'Stop from global should be wired');
  assert.ok(wired.has('PreToolUse'),   'PreToolUse from project should be wired');
});

test('an event present in no scope is absent from the union', () => {
  const wired = wiredHookEvents({ hooks: { PreToolUse: [] } }, { hooks: { SessionStart: [] } });
  assert.equal(wired.has('SessionEnd'), false);
  assert.equal(wired.has('PostToolUse'), false);
});

test('tolerates null / empty / hook-less / malformed settings objects', () => {
  const wired = wiredHookEvents(null, undefined, {}, { hooks: null }, { permissions: {} });
  assert.equal(wired.size, 0);
});

test('deduplicates an event wired in more than one scope', () => {
  const a = { hooks: { SessionStart: [], Stop: [] } };
  const b = { hooks: { SessionStart: [], PostToolUse: [] } };
  const wired = wiredHookEvents(a, b);
  assert.deepEqual([...wired].sort(), ['PostToolUse', 'SessionStart', 'Stop']);
});

test('readSettingsFile: valid JSON → object, missing → null, malformed → null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-audit-'));
  try {
    const good = path.join(dir, 'settings.json');
    fs.writeFileSync(good, JSON.stringify({ hooks: { Stop: [] } }), 'utf8');
    assert.deepEqual(readSettingsFile(good), { hooks: { Stop: [] } });

    const bad = path.join(dir, 'broken.json');
    fs.writeFileSync(bad, '{ not valid json', 'utf8');
    assert.equal(readSettingsFile(bad), null);

    assert.equal(readSettingsFile(path.join(dir, 'nope.json')), null);
    assert.equal(readSettingsFile(null), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
