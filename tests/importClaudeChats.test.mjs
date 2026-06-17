/**
 * import-claude-chats.mjs — Anthropic chat export ingestion.
 * Verifies parsing, idempotency, change-detection, and dry-run (no writes).
 * Run: node --test tests/importClaudeChats.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CONVOS   = path.join(__dirname, 'fixtures', 'conversations.sample.json');
const FIXTURE_PROJECTS = path.join(__dirname, 'fixtures', 'projects.sample.json');
const IMPORTER = path.resolve(__dirname, '..', '.claude', 'helpers', 'import-claude-chats.mjs');

// Total human turns across the fixture: conv-001 (2) + conv-002 (1) + conv-003 (1)
// + conv-004 (1 non-empty; the empty-text turn is dropped) = 5.
const EXPECTED_HUMAN_PROMPTS = 5;
const EXPECTED_CONVERSATIONS = 4;

/** Build a fresh export dir containing canonically-named export files. */
function freshExportDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-chats-'));
  fs.copyFileSync(FIXTURE_CONVOS,   path.join(dir, 'conversations.json'));
  fs.copyFileSync(FIXTURE_PROJECTS, path.join(dir, 'projects.json'));
  return dir;
}

/** Fresh metrics root + initialized DB (db is a module singleton). */
function freshDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-chats-db-'));
  db.close();
  db.initialize(root, 'vaultflow.db');
  return root;
}

/** Import the module against the already-open singleton DB. */
async function loadImporter() {
  return import('../.claude/helpers/import-claude-chats.mjs');
}

test('initial import: sessions, prompts, memory, graph all populated', async () => {
  freshDb();
  const exportDir = freshExportDir();
  const importer  = await loadImporter();

  const summary = importer.importChats({ path: exportDir, dryRun: false });

  assert.equal(summary.conversations, EXPECTED_CONVERSATIONS);
  assert.equal(summary.imported, EXPECTED_CONVERSATIONS);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.prompts, EXPECTED_HUMAN_PROMPTS);
  assert.equal(summary.errors, 0);

  const conn = db.raw();

  // A session row exists with cli='claude-desktop' for each conversation.
  const sess = conn.prepare(
    `SELECT id, cli, project FROM sessions WHERE cli = 'claude-desktop' ORDER BY id`
  ).all();
  assert.equal(sess.length, EXPECTED_CONVERSATIONS);

  // conv-003's project resolves from projects.sample.json (proj-uuid-001).
  const proj3 = conn.prepare(`SELECT project FROM sessions WHERE id = ?`).get('conv-uuid-003');
  assert.equal(proj3.project, 'Synthetic Project Alpha');

  // Prompt count equals the number of human turns across the fixture.
  const promptCount = conn.prepare(`SELECT COUNT(*) n FROM prompts`).get().n;
  assert.equal(promptCount, EXPECTED_HUMAN_PROMPTS);

  // A memory_entries transcript exists for each conversation.
  const memCount = conn.prepare(
    `SELECT COUNT(*) n FROM memory_entries WHERE source LIKE 'claude-desktop:conv:%'`
  ).get().n;
  assert.equal(memCount, EXPECTED_CONVERSATIONS);

  // The unnamed conversation falls back to 'Untitled chat'.
  const untitled = conn.prepare(
    `SELECT title FROM memory_entries WHERE source = 'claude-desktop:conv:conv-uuid-004'`
  ).get();
  assert.equal(untitled.title, 'Untitled chat');

  // FTS search finds the unique token planted in an assistant message.
  const hits = db.searchMemory('ZEBRAFIXTURE', 5);
  assert.ok(hits.some(h => h.source === 'claude-desktop:conv:conv-uuid-001'),
    'expected ZEBRAFIXTURE transcript in memory search results');

  // Brain graph includes the conversation session node + belongs edge to project.
  const g = db.getBrainGraph({ center: null, depth: 1, types: null, limit: 500 });
  assert.ok(g.nodes.some(n => n.id === 'session:conv-uuid-003'), 'conversation session node missing');
  assert.ok(g.nodes.some(n => n.id === 'project:Synthetic Project Alpha'), 'project node missing');
  assert.ok(
    g.edges.some(e => e.kind === 'belongs'
      && e.source === 'session:conv-uuid-003'
      && e.target === 'project:Synthetic Project Alpha'),
    'belongs edge from conversation to project missing'
  );

  // getBrainNote enriches the claude-desktop session with title + transcript outlink.
  const note = db.getBrainNote('session:conv-uuid-001');
  assert.equal(note.title, 'Conversation with content blocks');
  assert.ok(note.outlinks.some(l => l.id === 'memory:claude-desktop:conv:conv-uuid-001' && l.title === 'Transcript'),
    'expected transcript outlink on claude-desktop session note');
});

test('idempotency: re-import skips all, prompts unchanged', async () => {
  freshDb();
  const exportDir = freshExportDir();
  const importer  = await loadImporter();

  importer.importChats({ path: exportDir, dryRun: false });
  const before = db.raw().prepare(`SELECT COUNT(*) n FROM prompts`).get().n;

  const second = importer.importChats({ path: exportDir, dryRun: false });
  const after  = db.raw().prepare(`SELECT COUNT(*) n FROM prompts`).get().n;

  assert.equal(second.imported, 0);
  assert.equal(second.changed, 0);
  assert.equal(second.skipped, EXPECTED_CONVERSATIONS);
  assert.equal(after, before, 'prompt count must not change on idempotent re-import');
});

test('change-detection: bumped updated_at + new turn re-imports only that chat', async () => {
  freshDb();
  const exportDir = freshExportDir();
  const importer  = await loadImporter();

  importer.importChats({ path: exportDir, dryRun: false });
  const baseTotal = db.raw().prepare(`SELECT COUNT(*) n FROM prompts`).get().n;
  const baseConv2 = db.raw()
    .prepare(`SELECT COUNT(*) n FROM prompts WHERE session_id = 'conv-uuid-002'`).get().n;
  assert.equal(baseConv2, 1);

  // Mutate conv-002: bump updated_at and append one extra human turn.
  const raw = JSON.parse(fs.readFileSync(path.join(exportDir, 'conversations.json'), 'utf8'));
  const conv2 = raw.find(c => c.uuid === 'conv-uuid-002');
  conv2.updated_at = '2026-06-11T10:00:00Z';
  conv2.chat_messages.push({
    uuid: 'msg-002c',
    sender: 'human',
    content: [{ type: 'text', text: 'A brand new human turn added after the first import.' }],
    created_at: '2026-06-11T09:30:00Z',
  });
  fs.writeFileSync(path.join(exportDir, 'conversations.json'), JSON.stringify(raw), 'utf8');

  const summary = importer.importChats({ path: exportDir, dryRun: false });
  assert.equal(summary.changed, 1, 'exactly one conversation should be re-imported');
  assert.equal(summary.skipped, EXPECTED_CONVERSATIONS - 1);

  // conv-002 now has 2 human prompts (no dupes), others unchanged → +1 net.
  const newConv2 = db.raw()
    .prepare(`SELECT COUNT(*) n FROM prompts WHERE session_id = 'conv-uuid-002'`).get().n;
  assert.equal(newConv2, 2);
  const newTotal = db.raw().prepare(`SELECT COUNT(*) n FROM prompts`).get().n;
  assert.equal(newTotal, baseTotal + 1, 'only the new turn should be added');

  // No orphaned retrieval_docs: every prompt-type retrieval doc maps to a live prompt.
  const orphans = db.raw().prepare(`
    SELECT COUNT(*) n FROM retrieval_docs rd
    WHERE rd.source_type = 'prompt'
      AND NOT EXISTS (SELECT 1 FROM prompts p WHERE p.id = rd.source_id)
  `).get().n;
  assert.equal(orphans, 0, 'change-detection must not orphan retrieval_docs');
});

test('dry-run CLI: status 0, parseable JSON counts, zero DB writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-chats-dry-'));
  const r = spawnSync(process.execPath, [IMPORTER, FIXTURE_CONVOS, '--dry-run', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, VAULTFLOW_METRICS_ROOT: root },
    timeout: 15000,
  });

  assert.equal(r.status, 0, r.stderr);
  const summary = JSON.parse(r.stdout);
  assert.equal(summary.conversations, EXPECTED_CONVERSATIONS);
  assert.equal(summary.prompts, EXPECTED_HUMAN_PROMPTS);

  // Dry run must not have created/written the DB: open it and confirm zero rows.
  db.close();
  db.initialize(root, 'vaultflow.db');
  const conn = db.raw();
  const sessions = conn.prepare(`SELECT COUNT(*) n FROM sessions`).get().n;
  assert.equal(sessions, 0, 'dry-run must write nothing to the DB');
  const importedChats = conn.prepare(`SELECT COUNT(*) n FROM imported_chats`).get().n;
  assert.equal(importedChats, 0, 'dry-run must not write to imported_chats');
  const prompts = conn.prepare(`SELECT COUNT(*) n FROM prompts`).get().n;
  assert.equal(prompts, 0, 'dry-run must not write to prompts');
});
