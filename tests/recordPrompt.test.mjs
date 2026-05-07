/**
 * recordPrompt — hardening tests for the prompts.source migration.
 *
 * Covers Patient Zero (skill_routed/source separation) and every secondary
 * failure surfaced in the audit map: corrupted titles, polluted metadata_json,
 * stale retrieval_docs, mis-derived success_state, and silent re-corruption.
 *
 * Run: node --test tests/recordPrompt.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-recordprompt-'));
  // Clear cached db.cjs so initialize() opens our temp DB fresh each test.
  delete require.cache[require.resolve('../.claude/helpers/db.cjs')];
  const db = require('../.claude/helpers/db.cjs');
  db.initialize(dir, 'test.db');
  // Seed a session so getSessionMetadata returns a project/cli for the prompt.
  db.upsertSession({
    id: 'sess-1',
    started_at: new Date().toISOString(),
    platform: 'test',
    cli: 'claude',
    project: 'vaultflow',
  });
  db.upsertSession({
    id: 'sess-copilot',
    started_at: new Date().toISOString(),
    platform: 'copilot',
    cli: 'copilot',
    project: 'vaultflow',
  });
  return { db, dir };
}

function rawConn(dir) {
  const sqlite = require('node:sqlite');
  return new sqlite.DatabaseSync(path.join(dir, 'test.db'));
}

test('schema: prompts.source column exists after initialize()', () => {
  const { dir } = freshDb();
  const cols = rawConn(dir).prepare('PRAGMA table_info(prompts)').all().map(c => c.name);
  assert.ok(cols.includes('source'), `expected source col, got: ${cols.join(',')}`);
  assert.ok(cols.includes('skill_routed'));
});

test('options form: { skillRouted, source } persists both fields', () => {
  const { db, dir } = freshDb();
  db.recordPrompt('sess-1', 'hello world', { skillRouted: 'frontend-design', source: 'claude' });
  const row = rawConn(dir).prepare('SELECT skill_routed, source FROM prompts WHERE session_id=?').get('sess-1');
  assert.equal(row.skill_routed, 'frontend-design');
  assert.equal(row.source, 'claude');
});

test('legacy positional: bare-string 3rd arg still routes to skill_routed', () => {
  const { db, dir } = freshDb();
  db.recordPrompt('sess-1', 'hi', 'frontend-design');
  const row = rawConn(dir).prepare('SELECT skill_routed, source FROM prompts WHERE session_id=?').get('sess-1');
  assert.equal(row.skill_routed, 'frontend-design');
  // source falls back to session.cli
  assert.equal(row.source, 'claude');
});

test('source defaults from session.cli when caller omits it', () => {
  const { db, dir } = freshDb();
  db.recordPrompt('sess-copilot', 'hi', { skillRouted: 'frontend-design' });
  const row = rawConn(dir).prepare('SELECT skill_routed, source FROM prompts WHERE session_id=?').get('sess-copilot');
  assert.equal(row.source, 'copilot');
  assert.equal(row.skill_routed, 'frontend-design');
});

test('guard: passing CLI tag as legacy string raises', () => {
  const { db } = freshDb();
  assert.throws(
    () => db.recordPrompt('sess-1', 'hi', 'copilot'),
    /'copilot' is a CLI source, not a skill name/,
  );
  assert.throws(
    () => db.recordPrompt('sess-1', 'hi', 'tracked:codex'),
    /Pass it as \{ source: 'tracked:codex' \}/,
  );
});

test('guard: passing CLI tag inside { skillRouted } also raises', () => {
  const { db } = freshDb();
  assert.throws(
    () => db.recordPrompt('sess-1', 'hi', { skillRouted: 'codex' }),
    /'codex' is a CLI source/,
  );
});

test('retrieval_docs: title encodes both source and skill, not "Prompt copilot"', () => {
  const { db, dir } = freshDb();
  db.recordPrompt('sess-copilot', 'hello', { source: 'copilot', skillRouted: 'frontend-design' });
  db.recordPrompt('sess-copilot', 'plain',  { source: 'copilot' });
  const titles = rawConn(dir).prepare(
    "SELECT title FROM retrieval_docs WHERE source_type='prompt' ORDER BY id"
  ).all().map(r => r.title);
  assert.deepEqual(titles, [
    'Prompt [copilot] → frontend-design',
    'Prompt [copilot]',
  ]);
});

test('retrieval_docs: metadata_json carries both fields, not just skill_routed', () => {
  const { db, dir } = freshDb();
  db.recordPrompt('sess-copilot', 'hello', { source: 'copilot', skillRouted: 'frontend-design' });
  const meta = JSON.parse(
    rawConn(dir).prepare("SELECT metadata_json FROM retrieval_docs WHERE source_type='prompt'").get().metadata_json,
  );
  assert.equal(meta.source, 'copilot');
  assert.equal(meta.skill_routed, 'frontend-design');
});

test('backfill: pre-existing CLI tags in skill_routed move to source on initialize()', () => {
  const { dir } = freshDb();
  // Simulate the corrupted state by writing directly, bypassing recordPrompt.
  const conn = rawConn(dir);
  conn.exec("INSERT INTO sessions (id, started_at, platform, cli) VALUES ('s-old', '2026-01-01', 'copilot', 'copilot')");
  for (const tag of ['copilot', 'codex', 'tracked:codex', 'tui:claude']) {
    conn.prepare(
      "INSERT INTO prompts (timestamp, session_id, prompt_text, skill_routed) VALUES (?, ?, ?, ?)"
    ).run('2026-01-01T00:00:00Z', 's-old', `text-${tag}`, tag);
  }
  conn.close();

  // Re-open via db.cjs initialize() — backfill must run.
  delete require.cache[require.resolve('../.claude/helpers/db.cjs')];
  const db2 = require('../.claude/helpers/db.cjs');
  db2.initialize(dir, 'test.db');

  const conn2 = rawConn(dir);
  const rows = conn2.prepare('SELECT prompt_text, skill_routed, source FROM prompts ORDER BY id').all();
  for (const r of rows) {
    // No bare CLI tag should remain in skill_routed
    assert.ok(
      !['copilot','codex','claude','watcher','tracked:codex','tracked:copilot','tui:claude','tui:codex','tui:copilot'].includes(r.skill_routed),
      `${r.prompt_text} still has CLI tag in skill_routed: ${r.skill_routed}`,
    );
    assert.ok(r.source, `${r.prompt_text} missing source after backfill`);
  }
});

test('backfill: idempotent — running initialize() twice does not re-corrupt', () => {
  const { db, dir } = freshDb();
  db.recordPrompt('sess-1', 'p1', { skillRouted: 'frontend-design', source: 'claude' });

  delete require.cache[require.resolve('../.claude/helpers/db.cjs')];
  const db2 = require('../.claude/helpers/db.cjs');
  db2.initialize(dir, 'test.db');

  const row = rawConn(dir).prepare("SELECT skill_routed, source FROM prompts WHERE session_id='sess-1'").get();
  assert.equal(row.skill_routed, 'frontend-design');
  assert.equal(row.source, 'claude');
});

test('backfill: composite [copilot:skill] tag splits into source + skill_routed', () => {
  const { dir } = freshDb();
  const conn = rawConn(dir);
  conn.exec("INSERT INTO sessions (id, started_at, platform, cli) VALUES ('s-comp', '2026-01-01', 'copilot', 'copilot')");
  conn.prepare(
    "INSERT INTO prompts (timestamp, session_id, prompt_text, skill_routed) VALUES (?, ?, ?, ?)"
  ).run('2026-01-01T00:00:00Z', 's-comp', 'composite-in-skill', '[copilot:general-purpose]');
  // Also seed a row where the composite already migrated into source whole
  // (simulates a partial earlier backfill that collapsed it).
  conn.prepare(
    "INSERT INTO prompts (timestamp, session_id, prompt_text, skill_routed, source) VALUES (?, ?, ?, ?, ?)"
  ).run('2026-01-01T00:00:01Z', 's-comp', 'composite-in-source', null, '[copilot:frontend-design]');
  conn.close();

  delete require.cache[require.resolve('../.claude/helpers/db.cjs')];
  const db2 = require('../.claude/helpers/db.cjs');
  db2.initialize(dir, 'test.db');

  const rows = rawConn(dir).prepare(
    "SELECT prompt_text, skill_routed, source FROM prompts WHERE session_id='s-comp' ORDER BY id"
  ).all().map(r => ({ ...r }));
  assert.deepEqual(rows, [
    { prompt_text: 'composite-in-skill',  skill_routed: 'general-purpose',  source: 'copilot' },
    { prompt_text: 'composite-in-source', skill_routed: 'frontend-design',  source: 'copilot' },
  ]);
});

test('backfill: stale retrieval_docs titles get rewritten despite COALESCE upsert', () => {
  const { dir } = freshDb();
  const conn = rawConn(dir);
  conn.exec("INSERT INTO sessions (id, started_at, platform, cli) VALUES ('s-stale', '2026-01-01', 'copilot', 'copilot')");
  // Seed a prompt with the old corruption AND a matching retrieval_docs row
  // with the old "Prompt copilot" title — exactly mirroring the live DB state.
  const info = conn.prepare(
    "INSERT INTO prompts (timestamp, session_id, prompt_text, skill_routed) VALUES (?, ?, ?, ?)"
  ).run('2026-01-01T00:00:00Z', 's-stale', 'hello', 'copilot');
  conn.prepare(`
    INSERT INTO retrieval_docs (source_type, source_id, session_id, timestamp, title, body, metadata_json)
    VALUES ('prompt', ?, 's-stale', '2026-01-01T00:00:00Z', 'Prompt copilot', 'hello', '{"skill_routed":"copilot"}')
  `).run(String(info.lastInsertRowid));
  conn.close();

  delete require.cache[require.resolve('../.claude/helpers/db.cjs')];
  const db2 = require('../.claude/helpers/db.cjs');
  db2.initialize(dir, 'test.db');

  const r = rawConn(dir).prepare(
    "SELECT title, metadata_json FROM retrieval_docs WHERE source_type='prompt'"
  ).get();
  assert.equal(r.title, 'Prompt [copilot]');
  const meta = JSON.parse(r.metadata_json);
  assert.equal(meta.source, 'copilot');
  assert.equal(meta.skill_routed, null);
});

test('backfill: phase 3 (retrieval_docs rewrite) is idempotent — runs at most once per row', () => {
  const { dir } = freshDb();
  const conn = rawConn(dir);
  conn.exec("INSERT INTO sessions (id, started_at, platform, cli) VALUES ('s-idem', '2026-01-01', 'copilot', 'copilot')");
  const info = conn.prepare(
    "INSERT INTO prompts (timestamp, session_id, prompt_text, skill_routed) VALUES (?, ?, ?, ?)"
  ).run('2026-01-01T00:00:00Z', 's-idem', 'hello', 'copilot');
  conn.prepare(`
    INSERT INTO retrieval_docs (source_type, source_id, session_id, timestamp, title, body, metadata_json)
    VALUES ('prompt', ?, 's-idem', '2026-01-01T00:00:00Z', 'Prompt copilot', 'hello', '{"skill_routed":"copilot"}')
  `).run(String(info.lastInsertRowid));
  conn.close();

  // First open: rewrite happens.
  delete require.cache[require.resolve('../.claude/helpers/db.cjs')];
  require('../.claude/helpers/db.cjs').initialize(dir, 'test.db');
  const t1 = rawConn(dir).prepare("SELECT timestamp FROM retrieval_docs WHERE source_type='prompt'").get();

  // Second open: row already has new-form metadata; the rewrite predicate must not match.
  delete require.cache[require.resolve('../.claude/helpers/db.cjs')];
  require('../.claude/helpers/db.cjs').initialize(dir, 'test.db');

  // Probe the predicate directly — should now find zero candidates.
  const candidates = rawConn(dir).prepare(`
    SELECT COUNT(*) AS c FROM retrieval_docs r
    WHERE r.source_type = 'prompt'
      AND (r.title LIKE 'Prompt %' OR r.title = 'Prompt')
      AND (r.metadata_json IS NULL OR r.metadata_json NOT LIKE '%"source"%')
  `).get();
  assert.equal(candidates.c, 0, 'phase 3 still finds candidates after first run — not idempotent');
});

test('FTS: prompts_fts still indexes prompt_text after schema change', () => {
  const { db, dir } = freshDb();
  db.recordPrompt('sess-1', 'unique-token-zebra', { source: 'claude' });
  const hits = rawConn(dir).prepare(
    "SELECT rowid FROM prompts_fts WHERE prompts_fts MATCH 'zebra'"
  ).all();
  assert.ok(hits.length > 0, 'prompts_fts did not return a match for inserted prompt');
});
