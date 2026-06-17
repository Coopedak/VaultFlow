/**
 * Reuse-before-build for SKILLS — search_skills / find-skill / pre-authoring
 * gate / backfill stub-fallback.
 *
 * Covers:
 *   - skill-reuse scorer: BM25 ranking + advisory verdict thresholds
 *   - find-skill CLI: spawns cli-query.mjs against a seeded temp root, --json
 *   - pre-edit gate: synthetic PreToolUse(Write) hook JSON over stdin
 *   - backfill stub-fallback: stub frontmatter → body-text description
 *
 * Run: node --test tests/skillReuse.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db         = require('../.claude/helpers/db.cjs');
const skillReuse = require('../.claude/helpers/skill-reuse.cjs');

const QUERY = path.resolve('scripts/cli-query.mjs');
const HOOK  = path.resolve('.claude/helpers/pre-edit.cjs');

// Seed a fresh temp metrics root with a known set of skills in vault_agents.
function seedRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-skill-'));
  db.close();
  db.initialize(root, 'vaultflow.db');
  db.upsertVaultAgent('developer-backend', 'developer-backend', 'claude',
    'Back-End Developer agent specializing in server-side logic, services, repositories, APIs, and business logic', null);
  db.upsertVaultAgent('documenter', 'documenter', 'claude',
    'Writes documentation, README files, changelogs, and inline code docs', null);
  db.upsertVaultAgent('reviewer-code', 'reviewer-code', 'claude',
    'Reviews code for quality, correctness, and bugs before merging', null);
  db.close();
  return root;
}

function runCli(root, args) {
  return spawnSync(process.execPath, [QUERY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, VAULTFLOW_METRICS_ROOT: root },
    timeout: 15000,
  });
}

function runHook(root, payload) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, VAULTFLOW_METRICS_ROOT: root },
    timeout: 10000,
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

// ── scorer + ranking ────────────────────────────────────────────────────────

test('searchVaultAgents ranks the relevant skill first', () => {
  const root = seedRoot();
  db.initialize(root, 'vaultflow.db');
  const rows = db.searchVaultAgents('build a backend service with server-side APIs', 10);
  db.close();
  assert.ok(rows.length > 0, 'expected matches');
  assert.equal(rows[0].name, 'developer-backend', `top hit was ${rows[0].name}`);
});

test('verdict tagging behaves at the thresholds', () => {
  assert.equal(skillReuse.verdictFor(skillReuse.REUSE_THRESHOLD), 'REUSE');
  assert.equal(skillReuse.verdictFor(skillReuse.REUSE_THRESHOLD - 0.01), 'MODIFY');
  assert.equal(skillReuse.verdictFor(skillReuse.MODIFY_THRESHOLD), 'MODIFY');
  assert.equal(skillReuse.verdictFor(skillReuse.MODIFY_THRESHOLD - 0.01), 'BUILD-NEW-OK');
  assert.equal(skillReuse.verdictFor(0), 'BUILD-NEW-OK');
});

test('high overlap query earns a REUSE verdict on the backend skill', () => {
  const desc = 'Back-End Developer agent specializing in server-side logic services repositories APIs business logic';
  const conf = skillReuse.overlapScore('back-end developer server-side services repositories APIs business logic', desc);
  assert.ok(conf >= skillReuse.REUSE_THRESHOLD, `confidence ${conf} should be >= ${skillReuse.REUSE_THRESHOLD}`);
  assert.equal(skillReuse.verdictFor(conf), 'REUSE');
});

// Regression guard for the SCORER SKEW bug: a SHORT free-text query that
// partially-but-strongly matches a long skill description must NOT be dismissed
// as BUILD-NEW-OK. Under the old max()-denominator metric, "build a backend
// service" (3 tokens) vs the backend skill (~11 tokens) scored ~0.07 → wrongly
// BUILD-NEW-OK. The overlap-coefficient (min()) scores it ~0.33 → REUSE.
test('short multi-word query matching a seeded skill yields REUSE/MODIFY (not BUILD-NEW-OK)', () => {
  const root = seedRoot();
  db.initialize(root, 'vaultflow.db');
  const rows = db.searchVaultAgents('build a backend service', 10);
  const scored = skillReuse.scoreSkillRows('build a backend service', rows);
  db.close();
  const top = scored.find(r => r.name === 'developer-backend');
  assert.ok(top, 'developer-backend should be among the matches');
  assert.notEqual(top.verdict, 'BUILD-NEW-OK',
    `short query "build a backend service" must not be BUILD-NEW-OK (got ${top.verdict} @ ${top.confidence})`);
  assert.ok(['REUSE', 'MODIFY'].includes(top.verdict),
    `expected REUSE or MODIFY, got ${top.verdict}`);
});

test('unrelated query yields no strong match (BUILD-NEW-OK)', () => {
  const root = seedRoot();
  db.initialize(root, 'vaultflow.db');
  const rows = db.searchVaultAgents('underwater basket weaving', 10);
  const scored = skillReuse.scoreSkillRows('underwater basket weaving', rows);
  db.close();
  assert.ok(scored.every(r => r.verdict === 'BUILD-NEW-OK'),
    'no seeded skill should clear the MODIFY bar for an unrelated query');
});

// ── CLI: find-skill ──────────────────────────────────────────────────────────

test('find-skill --json returns the backend skill as top hit', () => {
  const root = seedRoot();
  const r = runCli(root, ['find-skill', 'build a backend service', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.ok(Array.isArray(rows) && rows.length > 0, 'expected JSON array of rows');
  assert.equal(rows[0].name, 'developer-backend');
  assert.ok('verdict' in rows[0] && 'confidence' in rows[0], 'rows carry verdict + confidence');
});

test('find-skill text mode notes "OK to build new" for an unrelated task', () => {
  const root = seedRoot();
  const r = runCli(root, ['find-skill', 'underwater basket weaving']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK to build new/i);
});

// ── pre-edit gate ─────────────────────────────────────────────────────────────

test('gate warns + lists existing skill when authoring a NEW skill under a skills dir', () => {
  const root = seedRoot();
  const skillDir = path.join(root, '.agents', 'skills', 'my-backend-helper');
  fs.mkdirSync(skillDir, { recursive: true });
  const file = path.join(skillDir, 'SKILL.md');
  const content = [
    '---',
    'name: my-backend-helper',
    'description: A helper for building server-side services, repositories, and backend APIs',
    '---',
    '',
    '# My Backend Helper',
    'Does backend things.',
  ].join('\n');

  const { stdout, status, stderr } = runHook(root, {
    tool_name: 'Write',
    tool_input: { file_path: file, content },
  });
  assert.equal(status, 0, stderr);
  assert.ok(stdout.trim(), 'expected hook output');
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /New skill "my-backend-helper" — reuse before building/);
  assert.match(ctx, /developer-backend/);
});

test('gate stays silent for a NEW non-skill file', () => {
  const root = seedRoot();
  const file = path.join(root, 'src', 'foo.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { stdout, status } = runHook(root, {
    tool_name: 'Write',
    tool_input: { file_path: file, content: 'export const foo = () => 1;\n' },
  });
  assert.equal(status, 0);
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext || '', /reuse before building|OK to build new/);
  }
});

test('gate does not fire for an EXISTING skill file (not new authoring)', () => {
  const root = seedRoot();
  const skillDir = path.join(root, '.agents', 'skills', 'already-here');
  fs.mkdirSync(skillDir, { recursive: true });
  const file = path.join(skillDir, 'SKILL.md');
  const content = [
    '---',
    'name: already-here',
    'description: A helper for building server-side services and backend APIs',
    '---',
    '',
    '# Already Here',
  ].join('\n');
  fs.writeFileSync(file, content); // file exists BEFORE the Write hook fires

  const { stdout, status } = runHook(root, {
    tool_name: 'Write',
    tool_input: { file_path: file, content },
  });
  assert.equal(status, 0);
  if (stdout.trim()) {
    const out = JSON.parse(stdout);
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext || '', /New skill .* reuse before building/);
  }
});

// ── backfill stub-fallback ─────────────────────────────────────────────────────

test('backfill falls back to body text when frontmatter description is a stub', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-bf-'));
  const userSkillsDir = path.join(root, 'skills');
  const stubSkillDir  = path.join(userSkillsDir, 'stubby');
  fs.mkdirSync(stubSkillDir, { recursive: true });
  const bodyText = 'This skill orchestrates thermal-spray coating quality inspection workflows end to end.';
  fs.writeFileSync(path.join(stubSkillDir, 'SKILL.md'), [
    '---',
    'name: stubby',
    'description: Agent skill for stubby - invoke with $',  // stub pattern
    '---',
    '',
    bodyText,
  ].join('\n'));

  const cfg = {
    paths:   { metrics_root: root, user_skills_dir: userSkillsDir },
    storage: { db_file: 'vaultflow.db' },
  };

  const { runBackfill } = await import('../.claude/helpers/backfill.mjs');
  await runBackfill({ skillsOnly: true, config: cfg });

  db.close();
  db.initialize(root, 'vaultflow.db');
  const row = db.raw().prepare(`SELECT description FROM vault_agents WHERE agent_id = 'stubby'`).get();
  db.close();
  assert.ok(row, 'stubby skill was registered');
  assert.equal(row.description, bodyText, 'description came from body, not the stub frontmatter');
});
