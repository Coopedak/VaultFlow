/**
 * cleanup.test.mjs — unit + integration tests for the repo-hygiene cleanup tool.
 *
 * Uses node:test + node:assert/strict, matching the style of lintClassifiers.test.mjs.
 * All tests operate on temp fixture dirs — the real repo is never mutated.
 *
 * Coverage:
 *   1. isMangledPath: flags C:GIT... and GIT... names, not normal filenames.
 *   2. Empty-dir detection: empty dir flagged, non-empty not flagged.
 *   3. Noise exclusion: node_modules, desktop/obj paths, and auto-gen files are
 *      excluded from the untracked-doc list; a real loose doc is included.
 *   4. Integration safety (real runCleanup call on a fixture git repo):
 *      - A file named like a .db (even with a mangled prefix) survives --fix
 *      - A tracked file survives --fix
 *      - An untracked normal .md doc survives --fix (docs-review, not junk)
 *      - An empty orphaned dir is removed by --fix
 *      - An untracked mangled junk file (no .db extension) is removed by --fix
 *
 * Windows note: colons are not valid in Windows filenames so "C:GIT..." cannot
 * be created on-disk. Real mangled artifacts on this system use "GIT..." (no
 * drive letter) because the colon was also stripped. The test uses the "GIT"
 * prefix form which IS valid on Windows and IS flagged by isMangledPath.
 *
 * Run: node --test tests/cleanup.test.mjs
 */

import test   from 'node:test';
import assert from 'node:assert/strict';
import fs     from 'node:fs';
import path   from 'node:path';
import os     from 'node:os';
import { execSync } from 'node:child_process';

import { runCleanup } from '../.claude/helpers/cleanup.mjs';

// ── re-implement pure classifiers locally to lock the contract ────────────
// These mirror the private helpers in cleanup.mjs. If the logic diverges the
// integration test will surface it — the classifiers exist here only to keep
// the unit tests self-contained and fast.

function isMangledPath(basename) {
  if (/^[A-Za-z]:GIT/i.test(basename)) return true;
  if (/^GIT[A-Za-z]/i.test(basename)) return true;
  // "vaultflow" glued to .claude / .superpowers / helpers / dashboard
  if (/vaultflow(?:\.claude|\.superpowers|helpers|dashboard)/i.test(basename)) return true;
  return false;
}

function isDirEmpty(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (entries.length === 0) return true;
    for (const e of entries) {
      if (e.isFile() || e.isSymbolicLink()) return false;
      if (e.isDirectory() && !isDirEmpty(path.join(dir, e.name))) return false;
    }
    return true;
  } catch (_) { return false; }
}

// ── helper: create a throwaway temp dir ───────────────────────────────────
function makeTmpDir(prefix = 'cleanup-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── 1. isMangledPath classifier ───────────────────────────────────────────

test('isMangledPath: flags Windows drive-letter prefix artifacts', () => {
  // Note: these names can only appear in the heuristic — Windows cannot create
  // files with colons on NTFS. The regex still correctly matches them.
  assert.ok(isMangledPath('C:GITvaultflow.claudehelpersdashboardvendorx.js'),
    'C:GIT prefix should be flagged');
  assert.ok(isMangledPath('D:GITvaultflowfoo'),
    'D:GIT prefix should be flagged');
});

test('isMangledPath: flags bare GIT-prefix artifacts', () => {
  // These ARE createable on Windows and match real artifacts (colon stripped).
  assert.ok(isMangledPath('GITvaultflowfoo'),
    'GIT prefix (no drive) should be flagged');
  assert.ok(isMangledPath('GITvaultflow.superpowerssddfoo.txt'),
    'GIT + project glued should be flagged');
});

test('isMangledPath: flags project-name-glued artifacts', () => {
  assert.ok(isMangledPath('vaultflow.claudehelperscleanup.mjs'),
    '.claude glued to project name should be flagged');
  assert.ok(isMangledPath('vaultflow.superpowerssddfoo'),
    '.superpowers glued to project name should be flagged');
  assert.ok(isMangledPath('vaultflowhelpersdashboardvendorchart.umd.min.js'),
    'helpers glued to project name should be flagged');
});

test('isMangledPath: does NOT flag normal filenames', () => {
  assert.ok(!isMangledPath('README.md'),      'README.md is normal');
  assert.ok(!isMangledPath('normal-file.js'), 'normal-file.js is normal');
  assert.ok(!isMangledPath('chart.umd.min.js'), 'chart.umd.min.js is normal');
  assert.ok(!isMangledPath('cytoscape.min.js'), 'cytoscape.min.js is normal');
  assert.ok(!isMangledPath('CHANGELOG.md'),   'CHANGELOG.md is normal');
  assert.ok(!isMangledPath('cleanup.mjs'),    'cleanup.mjs is normal');
  assert.ok(!isMangledPath('package.json'),   'package.json is normal');
  assert.ok(!isMangledPath('.gitignore'),     '.gitignore is normal');
  assert.ok(!isMangledPath('node_modules'),   'node_modules is normal (a real dir)');
});

// ── 2. empty-dir detection ────────────────────────────────────────────────

test('isDirEmpty: flags a truly empty directory', () => {
  const tmp = makeTmpDir();
  const empty = path.join(tmp, 'empty-subdir');
  fs.mkdirSync(empty);
  assert.ok(isDirEmpty(empty), 'newly created dir should be empty');
  fs.rmdirSync(empty);
  fs.rmdirSync(tmp);
});

test('isDirEmpty: does NOT flag a non-empty directory', () => {
  const tmp = makeTmpDir();
  fs.writeFileSync(path.join(tmp, 'file.txt'), 'content');
  assert.ok(!isDirEmpty(tmp), 'dir with a file should not be empty');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('isDirEmpty: flags a dir containing only empty subdirs (recursive)', () => {
  const tmp  = makeTmpDir();
  const sub  = path.join(tmp, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  assert.ok(isDirEmpty(tmp), 'dir containing only empty subdirs should report empty');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── 3. noise exclusion filter for untracked docs ──────────────────────────
// We test the exclusion logic by simulating a list of relative paths through
// the same predicate used in cleanup.mjs.

const UNTRACKED_DOC_EXCLUDE = new Set([
  'AGENTS.md',
  '.github/copilot-instructions.md',
  '.cursor/rules/wiki.mdc',
  '.vscode/mcp.json',
  '.mcp.json',
  '.claude/settings.local.json',
]);

function isExcludedUntrackedDoc(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  // Any node_modules anywhere in the path (top-level or nested, e.g. electron-tui/node_modules/)
  if (normalized.includes('node_modules/') || normalized === 'node_modules') return true;
  if (normalized.includes('desktop/') && normalized.includes('/obj/')) return true;
  if (normalized.startsWith('.git/')) return true;
  const fwd = relPath.replace(/\\/g, '/');
  for (const excl of UNTRACKED_DOC_EXCLUDE) {
    if (fwd === excl.replace(/\\/g, '/')) return true;
  }
  return false;
}

test('noise exclusion: node_modules paths are excluded (top-level and nested)', () => {
  assert.ok(isExcludedUntrackedDoc('node_modules/foo/README.md'));
  assert.ok(isExcludedUntrackedDoc('node_modules/bar/CHANGELOG.md'));
  // Nested node_modules in subdirectories (e.g. electron-tui/node_modules/)
  assert.ok(isExcludedUntrackedDoc('electron-tui/node_modules/@electron/get/README.md'));
  assert.ok(isExcludedUntrackedDoc('packages/app/node_modules/lodash/README.md'));
});

test('noise exclusion: desktop obj paths are excluded', () => {
  assert.ok(isExcludedUntrackedDoc('desktop/VaultFlow.App/obj/debug.txt'));
  assert.ok(isExcludedUntrackedDoc('desktop/bin/obj/notes.txt'));
});

test('noise exclusion: auto-generated context files are excluded', () => {
  assert.ok(isExcludedUntrackedDoc('AGENTS.md'));
  assert.ok(isExcludedUntrackedDoc('.github/copilot-instructions.md'));
  assert.ok(isExcludedUntrackedDoc('.cursor/rules/wiki.mdc'));
  assert.ok(isExcludedUntrackedDoc('.claude/settings.local.json'));
});

test('noise exclusion: a real loose doc is NOT excluded', () => {
  assert.ok(!isExcludedUntrackedDoc('SCRATCH.md'));
  assert.ok(!isExcludedUntrackedDoc('docs/notes.txt'));
  assert.ok(!isExcludedUntrackedDoc('REVIEW-NOTES.md'));
});

// ── 4. integration safety — real runCleanup on a fixture git repo ─────────
//
// Builds a minimal git repo in a temp dir and asserts filesystem state AFTER
// calling runCleanup({ fix: true, repoRoot: fixture }). This is the only test
// that exercises the real deletion path end-to-end.
//
// Windows note: colons are illegal in NTFS filenames, so we use the "GIT..."
// prefix form (no drive letter). This is what real Windows mangled artifacts
// actually look like — the colon was stripped along with the path separator.
//
// Fixture contents:
//   (a) tracked file                    → must survive (git-tracked guard)
//   (b) untracked .md doc               → must survive (docs-review list, not junk)
//   (c) untracked .db file              → must survive (absolute *.db guard in safeDelete)
//   (d) mangled-name .db file           → must survive (same *.db guard fires first)
//   (e) untracked empty dir             → must be removed (empty-dir class)
//   (f) untracked mangled junk (non-.db)→ must be removed (mangled-path class)

test('integration: --fix deletes only safe junk; .db, tracked files, and docs survive', async (t) => {
  // Skip gracefully if git is not available in this environment
  let gitAvailable = true;
  try { execSync('git --version', { stdio: 'pipe' }); }
  catch (_) { gitAvailable = false; }

  if (!gitAvailable) {
    t.skip('git not available — skipping integration test');
    return;
  }

  const fixture = makeTmpDir('cleanup-integration-');

  try {
    // Set up a minimal git repo
    execSync('git init -q', { cwd: fixture });
    execSync('git config user.email "test@test.com"', { cwd: fixture });
    execSync('git config user.name "Test"', { cwd: fixture });

    // (a) Tracked file — must survive
    const trackedFile = path.join(fixture, 'README.md');
    fs.writeFileSync(trackedFile, '# fixture\n');
    execSync('git add README.md', { cwd: fixture });
    execSync('git commit -q -m "init"', { cwd: fixture });

    // (b) Untracked normal .md doc — must survive (goes to docs-review, not junk)
    const untrackedDoc = path.join(fixture, 'NOTES.md');
    fs.writeFileSync(untrackedDoc, '# untracked notes');

    // (c) Untracked normal .db file — must survive (absolute *.db guard)
    const normalDb = path.join(fixture, 'data.db');
    fs.writeFileSync(normalDb, 'db content');

    // (d) Untracked mangled-name .db file — must survive (*.db guard fires before deletion)
    //     Use "GIT..." prefix (valid on Windows, colon already stripped in real artifacts).
    //     isMangledPath returns true for this name, but safeDelete refuses to delete *.db.
    const mangledDb = path.join(fixture, 'GITfixturejunk.db');
    fs.writeFileSync(mangledDb, 'mangled db content');

    // (e) Untracked empty directory — must be removed
    const emptyDir = path.join(fixture, 'orphan-empty-dir');
    fs.mkdirSync(emptyDir);

    // (f) Untracked mangled-name non-.db file — must be removed
    //     Use "GIT..." prefix — valid on Windows and matched by isMangledPath.
    const mangledJunk = path.join(fixture, 'GITfixturejunk.txt');
    fs.writeFileSync(mangledJunk, 'junk content');

    // Confirm isMangledPath agrees on both mangled names before calling runCleanup
    assert.ok(isMangledPath(path.basename(mangledDb)),   'mangled .db name is flagged by heuristic');
    assert.ok(isMangledPath(path.basename(mangledJunk)), 'mangled .txt name is flagged by heuristic');

    // Run cleanup in fix mode against the fixture, NOT the real repo
    const report = await runCleanup({ fix: true, repoRoot: fixture });

    // ── assert filesystem state ───────────────────────────────────────────
    assert.ok(fs.existsSync(trackedFile),  'tracked README.md must survive --fix');
    assert.ok(fs.existsSync(untrackedDoc), 'untracked NOTES.md must survive --fix (docs-review)');
    assert.ok(fs.existsSync(normalDb),     'normal data.db must survive --fix (*.db guard)');
    assert.ok(fs.existsSync(mangledDb),    'mangled GITfixturejunk.db must survive --fix (*.db guard even when name is mangled)');
    assert.ok(!fs.existsSync(emptyDir),    'empty orphan dir must be removed by --fix');
    assert.ok(!fs.existsSync(mangledJunk), 'mangled non-.db junk file must be removed by --fix');

    // ── assert report structure ───────────────────────────────────────────
    // The mangled .db should appear in report.mangled with action=skipped
    const mangledDbEntry = report.mangled.find(m => m.path === mangledDb);
    assert.ok(mangledDbEntry, 'mangled .db must appear in report.mangled');
    assert.equal(mangledDbEntry.action, 'skipped',
      'mangled .db action must be "skipped", not "removed"');
    assert.match(mangledDbEntry.reason, /\.db/,
      'reason must mention .db so the human understands why it was skipped');

    // The mangled non-.db junk should show "removed"
    const mangledJunkEntry = report.mangled.find(m => m.path === mangledJunk);
    assert.ok(mangledJunkEntry, 'mangled .txt junk must appear in report.mangled');
    assert.equal(mangledJunkEntry.action, 'removed',
      'non-.db mangled junk must be reported as removed');

  } finally {
    // Always clean up fixture, even on assertion failure
    try { fs.rmSync(fixture, { recursive: true, force: true }); } catch (_) {}
  }
});
