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
    `DELETE FROM retrieval_docs WHERE source_type='prompt' AND source_id IN (${placeholders})`
  ).run(...ids.map(String));
  raw.prepare(`DELETE FROM prompts WHERE id IN (${placeholders})`).run(...ids);
  promptsDropped = ids.length;
}
console.log(`   dropped ${promptsDropped} empty prompts`);

// ── 6. Purge D:/vaultflow rows from code_symbols + code_imports ─────────────
// These leaked in because code-graph.cjs had no exclude_index_prefixes guard.
// The guard is now in place; this step removes the historical contamination.
// NOTE: the leading 'D:%vaultflow%' clause already covers all D:\vaultflow rows
// (LIKE uses % as wildcard and the pattern is case-insensitive in SQLite).
// The former OR branch used a JS string literal 'D:\vaultflow%' where \v is a
// vertical-tab character — it matched nothing and has been removed.
console.log('6. Purging D:/vaultflow rows from code_symbols and code_imports …');
const symDel = raw.prepare(`DELETE FROM code_symbols WHERE file LIKE 'D:%vaultflow%'`).run();
const impDel = raw.prepare(`DELETE FROM code_imports WHERE file LIKE 'D:%vaultflow%'`).run();
console.log(`   deleted ${symDel.changes} code_symbols rows, ${impDel.changes} code_imports rows`);

// ── 7. Purge D:/vaultflow rows from edit_events ──────────────────────────────
// edit_events doesn't go through purgeCodeGraph(), so needs its own DELETE.
console.log('7. Purging D:/vaultflow rows from edit_events …');
const evtDel = raw.prepare(`DELETE FROM edit_events WHERE LOWER(file_path) LIKE 'd:%vaultflow%'`).run();
console.log(`   deleted ${evtDel.changes} edit_events rows`);

// ── 8. Purge .wal / .duckdb.wal rows from edit_events ───────────────────────
// 40,039 WAL-journal rows polluted edit_events and the Brain graph hub-files
// list. The watcher and post-edit guards are now in place; remove historical rows.
console.log('8. Purging .wal / .duckdb.wal rows from edit_events …');
const walDel = raw.prepare(`DELETE FROM edit_events WHERE file_path LIKE '%.duckdb.wal' OR file_path LIKE '%.wal'`).run();
console.log(`   deleted ${walDel.changes} edit_events rows (.wal / .duckdb.wal)`);

// ── 9. Delete orphan vault_agents row agent_id='SKILL' ──────────────────────
// When the user-skill directory was renamed from 'SKILL' to 'process-manager',
// upsertVaultAgent (INSERT … ON CONFLICT(agent_id) DO UPDATE) correctly updated
// the 'process-manager' row but left behind the stale 'SKILL' row with
// source='user-skill'. The orphan causes find-skill / search_skills to surface
// "SKILL" instead of "process-manager" for relevant queries. Idempotent:
// re-running deletes 0 rows once the orphan is gone.
console.log('9. Deleting orphan vault_agents row (agent_id=\'SKILL\') …');
const orphanDel = raw.prepare(`DELETE FROM vault_agents WHERE agent_id='SKILL' AND source='user-skill'`).run();
console.log(`   deleted ${orphanDel.changes} orphan vault_agents row(s)`);

console.log('\nDone.');
console.log(`  total changes: model=${changes + mpChanges}, project=${sessFixed + editFixed}, prompts dropped=${promptsDropped}`);
console.log(`  code_symbols purged=${symDel.changes}, code_imports purged=${impDel.changes}, edit_events D: purged=${evtDel.changes}, edit_events .wal purged=${walDel.changes}`);
console.log(`  vault_agents orphans deleted=${orphanDel.changes}`);
