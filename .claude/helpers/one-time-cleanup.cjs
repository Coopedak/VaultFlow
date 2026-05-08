'use strict';

/**
 * One-time data cleanup against the live vaultflow.db. Idempotent — safe to
 * re-run. Performs the corrections that the audit fixes apply going forward,
 * but for historical rows.
 *
 * Steps:
 *  1. Normalize sessions.model + model_performance.model via normalizeModelName.
 *  2. Re-derive sessions.project where the current value is in the BLOCKLIST
 *     (e.g. "YOU", "GIT", "system32", ".claude"). Use cwd if available.
 *  3. Re-derive edit_events.project where the current value is in BLOCKLIST.
 *  4. Drop empty prompts (prompt_text IS NULL OR ='').
 */

const path = require('node:path');
const db   = require('./db.cjs');
const { deriveProject } = require('./project-id.cjs');

db.initialize();
const raw = db.raw();
const norm = db.normalizeModelName;

const BLOCKLIST = new Set([
  'system32', 'System32', 'Windows', 'windows',
  'YOU', 'Users', 'users', 'AppData', 'Local', 'Roaming', 'Temp', 'temp', 'tmp',
  'GIT', 'Projects', 'projects',
  '.claude', '.cursor', '.vscode', '.git', '.github',
  'memory', 'rules', 'skills', 'agents',
  'helpers', 'dashboard',
  // observed corruptions from the audit:
  'CGITtacklerack_reporesearch', 'merge-master-worktree', 'agent-a2b4635bfb8152e6b',
]);

let changes = 0;

// ── 1. Normalize sessions.model ─────────────────────────────────────────────
console.log('1. Normalizing sessions.model …');
const sessionsToFix = raw.prepare(`
  SELECT id, model FROM sessions WHERE model IS NOT NULL AND model != ''
`).all();
const upd = raw.prepare('UPDATE sessions SET model = ? WHERE id = ?');
for (const s of sessionsToFix) {
  const n = norm(s.model);
  if (n !== s.model) {
    upd.run(n, s.id);
    changes++;
  }
}
console.log(`   normalized ${changes} session model names`);

// ── 2. Normalize model_performance.model ────────────────────────────────────
console.log('2. Normalizing model_performance.model …');
const mpRows = raw.prepare(`
  SELECT rowid AS rowid, model FROM model_performance WHERE model IS NOT NULL AND model != ''
`).all();
const mpUpd = raw.prepare('UPDATE model_performance SET model = ? WHERE rowid = ?');
let mpChanges = 0;
for (const r of mpRows) {
  const n = norm(r.model);
  if (n !== r.model) { mpUpd.run(n, r.rowid); mpChanges++; }
}
console.log(`   normalized ${mpChanges} model_performance rows`);

// ── 3. Re-derive sessions.project where current value is noise ──────────────
console.log('3. Re-deriving sessions.project for blocklisted/noise values …');
const dirty = raw.prepare(`
  SELECT id, project, cwd FROM sessions
   WHERE project IS NOT NULL AND project != ''
`).all();
const sessUpd = raw.prepare('UPDATE sessions SET project = ? WHERE id = ?');
let sessFixed = 0;
for (const s of dirty) {
  if (BLOCKLIST.has(s.project)) {
    const better = s.cwd ? deriveProject(s.cwd) : null;
    sessUpd.run(better, s.id);
    sessFixed++;
  }
}
console.log(`   replaced ${sessFixed} noisy sessions.project values`);

// ── 4. Re-derive edit_events.project where current value is noise ───────────
console.log('4. Re-deriving edit_events.project for blocklisted values …');
const editDirty = raw.prepare(`
  SELECT id, project, file_path FROM edit_events
   WHERE project IS NOT NULL AND project != ''
`).all();
const editUpd = raw.prepare('UPDATE edit_events SET project = ? WHERE id = ?');
let editFixed = 0;
for (const e of editDirty) {
  if (BLOCKLIST.has(e.project)) {
    const better = e.file_path ? deriveProject(e.file_path) : null;
    editUpd.run(better, e.id);
    editFixed++;
  }
}
console.log(`   replaced ${editFixed} noisy edit_events.project values`);

// ── 5. Drop empty prompts (would fail recordPrompt's new validation) ────────
console.log('5. Dropping empty prompts …');
// Cascade: also drop matching retrieval_docs rows.
const ids = raw.prepare(`
  SELECT id FROM prompts WHERE prompt_text IS NULL OR prompt_text = ''
`).all().map(r => r.id);
let promptsDropped = 0;
if (ids.length) {
  const placeholders = ids.map(() => '?').join(',');
  raw.prepare(
    `DELETE FROM retrieval_docs WHERE source_type='prompt' AND source_id IN (${placeholders.replace(/\?/g, '?')})`
  ).run(...ids.map(String));
  raw.prepare(`DELETE FROM prompts WHERE id IN (${placeholders})`).run(...ids);
  promptsDropped = ids.length;
}
console.log(`   dropped ${promptsDropped} empty prompts`);

console.log('\nDone.');
console.log(`  total changes: model=${changes + mpChanges}, project=${sessFixed + editFixed}, prompts dropped=${promptsDropped}`);
