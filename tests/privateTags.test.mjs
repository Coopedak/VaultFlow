/**
 * private-tag stripping — borrowed from claude-mem's privacy primitive.
 *
 * `<private>...</private>` blocks must never reach prompts.prompt_text or
 * tool_calls.input_json. They remain visible to the model in-conversation;
 * only persistence is filtered. Strip happens at the recordPrompt /
 * recordToolCall edge in db.cjs.
 *
 * Run: node --test tests/privateTags.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-private-'));
  delete require.cache[require.resolve('../.claude/helpers/db.cjs')];
  const db = require('../.claude/helpers/db.cjs');
  db.initialize(dir, 'test.db');
  db.upsertSession({
    id: 'sess-1',
    started_at: new Date().toISOString(),
    platform: 'test',
    cli: 'claude',
    project: 'vaultflow',
  });
  return { db, dir };
}

function rawConn(dir) {
  const sqlite = require('node:sqlite');
  return new sqlite.DatabaseSync(path.join(dir, 'test.db'));
}

test('recordPrompt: strips <private>...</private> before insert', () => {
  const { db, dir } = freshDb();
  db.recordPrompt('sess-1', 'before <private>API_KEY=sk-12345</private> after', { source: 'claude' });
  const row = rawConn(dir).prepare(
    'SELECT prompt_text FROM prompts WHERE session_id=?'
  ).get('sess-1');
  assert.equal(row.prompt_text, 'before  after');
  assert.ok(!row.prompt_text.includes('sk-12345'), 'secret leaked into DB');
});

test('recordPrompt: strips multiline <private> blocks', () => {
  const { db, dir } = freshDb();
  db.recordPrompt('sess-1', 'A\n<private>line1\nline2\nsecret</private>\nB', { source: 'claude' });
  const row = rawConn(dir).prepare(
    "SELECT prompt_text FROM prompts WHERE session_id='sess-1'"
  ).get();
  assert.ok(!row.prompt_text.includes('secret'));
  assert.ok(row.prompt_text.startsWith('A'));
  assert.ok(row.prompt_text.endsWith('B'));
});

test('recordPrompt: drops prompt that is *only* private content', () => {
  const { db, dir } = freshDb();
  db.recordPrompt('sess-1', '<private>everything-secret</private>', { source: 'claude' });
  const count = rawConn(dir).prepare(
    "SELECT COUNT(*) AS c FROM prompts WHERE session_id='sess-1'"
  ).get().c;
  assert.equal(count, 0, 'empty-after-strip prompt should be dropped, not stored as empty');
});

test('recordPrompt: case-insensitive on tag (<PRIVATE> works)', () => {
  const { db, dir } = freshDb();
  db.recordPrompt('sess-1', 'x <PRIVATE>SECRET</PRIVATE> y', { source: 'claude' });
  const row = rawConn(dir).prepare(
    "SELECT prompt_text FROM prompts WHERE session_id='sess-1'"
  ).get();
  assert.ok(!row.prompt_text.includes('SECRET'));
});

test('recordToolCall: strips <private> from input JSON', () => {
  const { db, dir } = freshDb();
  const json = JSON.stringify({
    file_path: '/tmp/foo',
    content: 'public <private>token=abc123</private> content',
  });
  db.recordToolCall('sess-1', 'Write', json);
  const row = rawConn(dir).prepare(
    "SELECT input_json FROM tool_calls WHERE session_id='sess-1'"
  ).get();
  assert.ok(!row.input_json.includes('abc123'), 'secret leaked into tool_calls.input_json');
  assert.ok(row.input_json.includes('public'));
  assert.ok(row.input_json.includes('content'));
});

test('recordToolCall: hash dedupe still works after strip', () => {
  const { db, dir } = freshDb();
  // Two calls that differ only in private content should dedupe to one row.
  db.recordToolCall('sess-1', 'Bash', JSON.stringify({ cmd: 'ls', note: '<private>x</private>' }));
  db.recordToolCall('sess-1', 'Bash', JSON.stringify({ cmd: 'ls', note: '<private>y</private>' }));
  const c = rawConn(dir).prepare(
    "SELECT COUNT(*) AS c FROM tool_calls WHERE session_id='sess-1' AND tool_name='Bash'"
  ).get().c;
  assert.equal(c, 1, 'expected hash-dedup after <private> strip');
});

test('no <private> tag: pass-through unchanged', () => {
  const { db, dir } = freshDb();
  db.recordPrompt('sess-1', 'plain prompt', { source: 'claude' });
  const row = rawConn(dir).prepare(
    "SELECT prompt_text FROM prompts WHERE session_id='sess-1'"
  ).get();
  assert.equal(row.prompt_text, 'plain prompt');
});
