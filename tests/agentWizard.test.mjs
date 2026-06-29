// tests/agentWizard.test.mjs — agent-authoring.mjs unit tests
//
// Uses node:test + node:assert/strict. Each test injects a fresh mkdtempSync
// dir as claudeDir so the real ~/.claude is never touched.
//
// WHY: agent-authoring.mjs is pure logic with no Express; testing it directly
// gives deterministic FS assertions without spinning up a server.

import test   from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import os     from 'node:os';
import path   from 'node:path';

import {
  validateSlug,
  assertSafe,
  renderSkillMd,
  renderAgentMd,
  mergeAgentIntoConfig,
  registerInSkillsIndex,
  createAgent,
} from '../.claude/helpers/agent-authoring.mjs';

// ── helpers ────────────────────────────────────────────────────────────────

/** Create a fresh temp dir to use as claudeDir. */
function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vf-agent-wizard-'));
}

/**
 * Seed a minimal skills/index.md with the Dev-Team Pipeline Agents table.
 * Required by registerInSkillsIndex.
 */
function seedIndex(claudeDir) {
  const skillsDir = path.join(claudeDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, 'index.md'),
    [
      '# Claude Code Skills Index',
      '',
      '## Dev-Team Pipeline Agents',
      '',
      '| Skill | Description |',
      '|-------|-------------|',
      '| [researcher](researcher/SKILL.md) | Does research |',
      '',
    ].join('\n'),
    'utf8',
  );
}

// ── case 1: happy-path writes both files with correct content ──────────────

test('happy path: writes agents/{slug}.md and skills/{slug}/SKILL.md', async (t) => {
  const claudeDir = freshDir();
  seedIndex(claudeDir);

  const result = await createAgent({
    slug:        'perf-reviewer',
    role:        'Performance Reviewer',
    description: 'Reviews code for performance issues.',
    model:       'sonnet',
    claudeDir,
  });

  assert.ok(Array.isArray(result.files), 'files array returned');
  assert.equal(result.files.length, 2);

  const agentPath = path.join(claudeDir, 'agents', 'perf-reviewer.md');
  const skillPath = path.join(claudeDir, 'skills', 'perf-reviewer', 'SKILL.md');

  assert.ok(fs.existsSync(agentPath), 'agent file written');
  assert.ok(fs.existsSync(skillPath), 'skill file written');

  const agentMd = fs.readFileSync(agentPath, 'utf8');
  const skillMd = fs.readFileSync(skillPath, 'utf8');

  // Agent: frontmatter fields
  assert.match(agentMd, /^name: perf-reviewer/m,   'agent name field');
  assert.match(agentMd, /^model: sonnet/m,           'agent model field');
  assert.match(agentMd, /Performance Reviewer Agent/, 'agent title heading');

  // Skill: frontmatter fields
  assert.match(skillMd, /^name: perf-reviewer/m,    'skill name field');
  assert.match(skillMd, /bundle:\s+"dev-team"/,      'skill bundle field');
  assert.match(skillMd, /version:\s+"1\.3\.3"/,      'skill version field');
  assert.match(skillMd, /author:\s+"vaultflow-wizard"/, 'skill author field');
  assert.match(skillMd, /Reviews code for performance issues/, 'description in frontmatter');
});

// ── case 2: config merge preserves seeded keys + normalises $schema ─────────

test('config merge: adds new key, preserves _comment/config_tier/prior agent_models/$schema', async (t) => {
  const claudeDir = freshDir();
  seedIndex(claudeDir);

  // Seed a devteam-config with existing content that must be preserved.
  const configPath = path.join(claudeDir, 'devteam-config.json');
  const seeded = {
    $schema:        'C:\\Old\\path\\schema.json',
    config_version: '1.3.3',
    config_tier:    'user',
    _comment:       'My precious comment',
    agent_models: {
      'project-manager': 'opus',
      researcher:        'sonnet',
    },
    pipeline: {
      default_mode:              'standard',
      max_review_rounds:         3,
      skip_research_for_trivial: true,
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(seeded, null, 2) + '\n', 'utf8');

  await createAgent({
    slug:        'new-agent',
    role:        'New Agent',
    description: 'Does new things.',
    model:       'haiku',
    claudeDir,
  });

  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // New key added.
  assert.equal(cfg.agent_models['new-agent'], 'haiku', 'new agent_models entry added');

  // Prior agent_models keys preserved.
  assert.equal(cfg.agent_models['project-manager'], 'opus',   'prior project-manager preserved');
  assert.equal(cfg.agent_models['researcher'],       'sonnet', 'prior researcher preserved');

  // Scalar root keys preserved.
  assert.equal(cfg._comment,       seeded._comment,       '_comment preserved');
  assert.equal(cfg.config_tier,    seeded.config_tier,    'config_tier preserved');
  assert.equal(cfg.config_version, seeded.config_version, 'config_version preserved');

  // $schema normalised to canonical path.
  assert.match(cfg.$schema, /devteam-config\.schema\.json$/, '$schema normalised');
});

// ── case 3: traversal slug throws status 400 ──────────────────────────────

test('path traversal slug throws status 400', async (t) => {
  const claudeDir = freshDir();
  seedIndex(claudeDir);

  // validateSlug rejects "../evil" before we even hit assertSafe,
  // but the contract requires status 400 for any traversal-adjacent slug.
  await assert.rejects(
    () => createAgent({ slug: '../evil', description: 'bad', model: 'sonnet', claudeDir }),
    err => {
      assert.equal(err.status, 400, 'status 400 for traversal slug');
      return true;
    },
  );
});

// ── case 4: bad slugs are all rejected before any write ────────────────────

test('bad slugs are rejected before any write', async (t) => {
  const badSlugs = ['foo/bar', 'foo.bar', 'FOO', '-x', 'x-', '', 'ab'];
  for (const slug of badSlugs) {
    await assert.rejects(
      () => createAgent({ slug, description: 'x', model: 'sonnet', claudeDir: freshDir() }),
      err => {
        assert.equal(err.status, 400, `slug "${slug}" should give status 400`);
        return true;
      },
    );
  }
});

// ── case 5: collision without overwrite → status 409 with existing ─────────

test('collision without overwrite: throws status 409 with existing paths', async (t) => {
  const claudeDir = freshDir();
  seedIndex(claudeDir);

  // First create succeeds.
  await createAgent({ slug: 'my-agent', role: 'My Agent', description: 'First.', model: 'sonnet', claudeDir });

  // Second create without overwrite → 409.
  await assert.rejects(
    () => createAgent({ slug: 'my-agent', description: 'Second.', model: 'sonnet', claudeDir }),
    err => {
      assert.equal(err.status, 409, 'status 409 on collision');
      assert.ok(err.existing,               'existing object present');
      assert.ok(err.existing.agent || err.existing.skill, 'at least one existing path');
      return true;
    },
  );
});

// ── case 6: overwrite:true replaces file content ──────────────────────────

test('overwrite:true replaces agent/skill content', async (t) => {
  const claudeDir = freshDir();
  seedIndex(claudeDir);

  await createAgent({ slug: 'my-agent', role: 'Old Role', description: 'Old description.', model: 'haiku', claudeDir });

  // Overwrite with new content.
  await createAgent({ slug: 'my-agent', role: 'New Role', description: 'New description.', model: 'opus', overwrite: true, claudeDir });

  const agentMd = fs.readFileSync(path.join(claudeDir, 'agents', 'my-agent.md'), 'utf8');
  const skillMd = fs.readFileSync(path.join(claudeDir, 'skills', 'my-agent', 'SKILL.md'), 'utf8');

  assert.match(agentMd, /New Role/,        'agent has new role');
  assert.match(agentMd, /^model: opus/m,   'agent has new model');
  assert.match(skillMd, /New description/, 'skill has new description');
  assert.doesNotMatch(agentMd, /Old Role/, 'old role not in agent');
});

// ── case 7: merge preserves unrelated pipeline object (deep-equal) ─────────

test('config merge: unrelated pipeline object deep-equals after merge', async (t) => {
  const claudeDir = freshDir();
  seedIndex(claudeDir);

  const pipeline = {
    default_mode:              'standard',
    review_strictness:         'pragmatic',
    skip_research_for_trivial: true,
    skip_docs_for_trivial:     true,
    max_review_rounds:         3,
  };

  const configPath = path.join(claudeDir, 'devteam-config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ config_version: '1.3.3', config_tier: 'user', agent_models: {}, pipeline }, null, 2) + '\n',
    'utf8',
  );

  await createAgent({ slug: 'z-agent', description: 'Zed agent.', model: 'sonnet', claudeDir });

  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(cfg.pipeline, pipeline, 'pipeline object unchanged');
  assert.equal(cfg.agent_models['z-agent'], 'sonnet', 'new agent still added');
});

// ── case 8: missing config file → created fresh with skeleton + $schema ────

test('missing config file: created fresh with correct skeleton and $schema', async (t) => {
  const claudeDir = freshDir();
  seedIndex(claudeDir);

  // No devteam-config.json exists — createAgent must create it.
  const configPath = path.join(claudeDir, 'devteam-config.json');
  assert.ok(!fs.existsSync(configPath), 'config absent before test');

  await createAgent({ slug: 'fresh-agent', description: 'Fresh.', model: 'haiku', claudeDir });

  assert.ok(fs.existsSync(configPath), 'config created');

  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(cfg.config_version,          '1.3.3', 'config_version in skeleton');
  assert.equal(cfg.config_tier,             'user',  'config_tier in skeleton');
  assert.equal(cfg.agent_models['fresh-agent'], 'haiku', 'agent added');
  assert.match(cfg.$schema, /devteam-config\.schema\.json$/, '$schema set');
});

// ── case 9: YAML frontmatter safety — multi-line description/role collapsed ─

test('renderAgentMd: multi-line description/role produce single-line scalar values in frontmatter', () => {
  // renderAgentMd and renderSkillMd are imported at the top of this file.
  const agentMd = renderAgentMd({
    name:        'test-scalar',
    role:        'A\nB',
    description: 'line1\nline2',
    model:       'sonnet',
  });

  // Extract the frontmatter block (between the two --- delimiters).
  const fmMatch = agentMd.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fmMatch, 'frontmatter block present');
  const fm = fmMatch[1];

  // Split into lines and find the description: and name: lines.
  const fmLines = fm.split('\n');
  const descLine = fmLines.find(l => l.startsWith('description:'));
  const nameLine = fmLines.find(l => l.startsWith('name:'));

  assert.ok(descLine, 'description: line found in frontmatter');
  assert.ok(nameLine,  'name: line found in frontmatter');

  // Neither line should contain a raw newline — by definition each is one line,
  // but we also assert no \n appears in the value (covers the collapse).
  assert.ok(!descLine.includes('\n'), 'description: has no embedded newline');
  assert.ok(!nameLine.includes('\n'),  'name: has no embedded newline');

  // The collapsed description value should be a single space-joined string.
  assert.match(descLine, /^description: line1 line2$/, 'description newline collapsed to space');

  // role is used as the agent title in the body (not a frontmatter key in the
  // dispatch form), but verify it doesn't produce raw newlines in the output.
  assert.ok(!agentMd.includes('A\nB'), 'role newline not present raw in output');

  // Verify renderSkillMd also collapses newlines in the name/model scalar positions.
  const skillMd = renderSkillMd({
    name:        'test-scalar',
    role:        'C\nD',
    description: 'desc here',
    model:       'so\nnet',
  });
  const sfmMatch = skillMd.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(sfmMatch, 'skill frontmatter present');
  const sfm = sfmMatch[1];
  const sNameLine  = sfm.split('\n').find(l => l.startsWith('name:'));
  assert.ok(sNameLine, 'skill name: line present');
  assert.ok(!sNameLine.includes('\n'), 'skill name: has no embedded newline');
  // model appears in body (Default: ...) — verify no raw newline from multi-line model.
  assert.ok(!skillMd.includes('so\nnet'), 'skill model newline not raw in output');
});
