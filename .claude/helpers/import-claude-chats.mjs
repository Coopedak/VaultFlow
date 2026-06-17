/**
 * import-claude-chats.mjs — import Claude Desktop / claude.ai chat exports.
 *
 * Anthropic's official account data export ships a `conversations.json` (a JSON
 * array of conversations) and, optionally, a `projects.json` mapping. This
 * helper ingests that export into vaultflow's brain:
 *
 *   conversation  → a `sessions` row (cli='claude-desktop', platform='imported')
 *   each human turn → a `prompts` row (source='claude-desktop')
 *   full transcript → a `memory_entries` row (source='claude-desktop:conv:<uuid>')
 *
 * Because the `sessions` row carries a `project`, getBrainGraph() already turns
 * each conversation into a graph node with a `belongs` edge to its project —
 * no graph-engine change needed.
 *
 * Idempotency: the `imported_chats` table records each conversation's uuid +
 * updated_at. A re-run skips conversations whose updated_at is unchanged, so
 * nightly auto-pickup never duplicates prompts or transcripts. When a chat
 * changed (new turns), its old prompts (and their retrieval_docs) are deleted
 * and rewritten so counts stay exact.
 *
 * CLI usage:
 *   node import-claude-chats.mjs [path]            Import (path = dir or conversations.json)
 *   node import-claude-chats.mjs [path] --dry-run  Parse + count, write nothing
 *   node import-claude-chats.mjs [path] --json     Print the summary as JSON
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path              from 'node:path';
import fs                from 'node:fs';
import os                from 'node:os';

const require = createRequire(import.meta.url);

// ── config ────────────────────────────────────────────────────────────────

// Memoized so resolveSourceFiles() and getDb() share one YAML parse per run.
let _cachedConfig = null;
function loadConfig() {
  if (_cachedConfig !== null) return _cachedConfig;
  try {
    const yaml       = require('js-yaml');
    const configPath = require('../../config/resolve.cjs');
    if (fs.existsSync(configPath)) {
      _cachedConfig = yaml.load(fs.readFileSync(configPath, 'utf8'));
      return _cachedConfig;
    }
  } catch (_) {}
  _cachedConfig = {};
  return _cachedConfig;
}

function getDb() {
  const db  = require('./db.cjs');
  const cfg = loadConfig();
  // VAULTFLOW_METRICS_ROOT lets tests / explicit callers target a fresh DB
  // without a config file (mirrors scripts/cli-query.mjs). initialize() is
  // idempotent — once open it stays open.
  const root = process.env.VAULTFLOW_METRICS_ROOT
    || (cfg.paths && cfg.paths.metrics_root)
    || null;
  const file = (cfg.storage && cfg.storage.db_file) || null;
  db.initialize(root, file);
  return db;
}

// ── source resolution ───────────────────────────────────────────────────────

const DEFAULT_PROJECT = 'claude-desktop';

/**
 * Resolve the conversations.json file(s) to import.
 *
 * Precedence for the source location:
 *   1. explicit CLI path argument
 *   2. cfg.paths.claude_export_dir
 *   3. ~/Downloads/claude-exports
 *
 * The source may be a direct path to a conversations.json file, or a directory.
 * For a directory we look for conversations.json directly inside it AND inside
 * each immediate subdirectory — this handles an unzipped export folder (e.g.
 * data-2026-06-17/conversations.json) dropped into the watched directory.
 *
 * @param {string} [explicitPath]
 * @returns {string[]} absolute paths to conversations.json files (may be empty)
 */
function resolveSourceFiles(explicitPath) {
  const cfg = loadConfig();
  const source = explicitPath
    || (cfg.paths && cfg.paths.claude_export_dir)
    || path.join(os.homedir(), 'Downloads', 'claude-exports');

  if (!fs.existsSync(source)) return [];

  const stat = fs.statSync(source);
  if (stat.isFile()) return [path.resolve(source)];

  // Directory: scan it and its immediate subdirectories for conversations.json.
  const found = [];
  const direct = path.join(source, 'conversations.json');
  if (fs.existsSync(direct)) found.push(path.resolve(direct));

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(source, entry.name, 'conversations.json');
    if (fs.existsSync(nested)) found.push(path.resolve(nested));
  }
  return found;
}

/**
 * Load projects.json (if present) from the same directory as conversations.json,
 * returning a uuid→name map. Tolerant of absence and shape drift.
 *
 * @param {string} conversationsFile  absolute path to a conversations.json
 * @returns {Record<string,string>}
 */
function loadProjectsById(conversationsFile) {
  const byId = {};
  const projectsFile = path.join(path.dirname(conversationsFile), 'projects.json');
  if (!fs.existsSync(projectsFile)) return byId;
  try {
    const arr = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
    if (Array.isArray(arr)) {
      for (const p of arr) {
        const id   = p && (p.uuid || p.id);
        const name = p && (p.name || p.title);
        if (id && name) byId[id] = name;
      }
    }
  } catch (_) { /* malformed projects.json → no mapping, conversations still import */ }
  return byId;
}

// ── parsing (centralized field-name fallbacks live here) ──────────────────────

/**
 * Extract the plain text of a single message. Anthropic exports put the body in
 * a `content` array of typed blocks; older/flatter exports use a bare `text`.
 * We concatenate every text block, falling back to `text`, tolerating absence.
 */
function extractMessageText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const fromBlocks = blocks
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim();
  if (fromBlocks) return fromBlocks;
  return typeof msg.text === 'string' ? msg.text.trim() : '';
}

/**
 * Resolve a sender into our normalized role. sender may be "human"/"user" for
 * the person and "assistant" for Claude.
 */
function normalizeRole(sender) {
  const s = String(sender || '').toLowerCase();
  if (s === 'human' || s === 'user') return 'human';
  return 'assistant';
}

/**
 * Normalize the raw export JSON into a stable internal shape. ALL field-name
 * fallbacks (uuid/id, name/title, chat_messages/messages, sender variants)
 * are centralized here so the real-file verification only ever touches this fn.
 *
 * @param {any} json                       parsed conversations.json (array)
 * @param {Record<string,string>} projectsById  uuid→name map
 * @returns {Array<{uuid, name, createdAt, updatedAt, project, messages:
 *           Array<{role:'human'|'assistant', text:string, ts:string|null}>}>}
 */
export function parseConversations(json, projectsById) {
  const projects = projectsById || {};
  const list = Array.isArray(json) ? json : [];
  const out  = [];

  for (const convo of list) {
    if (!convo || typeof convo !== 'object') continue;

    const uuid = convo.uuid || convo.id;
    if (!uuid) continue; // no stable key → can't dedupe; skip rather than dupe

    const rawMessages = Array.isArray(convo.chat_messages)
      ? convo.chat_messages
      : (Array.isArray(convo.messages) ? convo.messages : []);

    const messages = [];
    for (const m of rawMessages) {
      const text = extractMessageText(m);
      messages.push({
        role: normalizeRole(m && m.sender),
        text,
        ts:   (m && m.created_at) || null,
      });
    }

    // Project: explicit uuid reference → mapped name; otherwise the default bucket.
    const projectUuid = convo.project_uuid || (convo.project && convo.project.uuid) || null;
    const project = (projectUuid && projects[projectUuid]) || DEFAULT_PROJECT;

    out.push({
      uuid,
      name:      convo.name || convo.title || null,
      createdAt: convo.created_at || null,
      updatedAt: convo.updated_at || null,
      project,
      messages,
    });
  }

  return out;
}

/**
 * Render a conversation as a chronological markdown transcript, used as the
 * body of the memory_entries row so the full chat is FTS-searchable and
 * readable in the Brain view.
 */
export function renderTranscript(convo) {
  const parts = [];
  for (const m of convo.messages) {
    if (!m.text) continue;
    const speaker = m.role === 'human' ? 'Human' : 'Assistant';
    parts.push(`**${speaker}:**\n${m.text}`);
  }
  return parts.join('\n\n');
}

// ── write path ────────────────────────────────────────────────────────────

/**
 * Delete a conversation's existing prompts AND the retrieval_docs they spawned.
 *
 * recordPrompt() writes a retrieval_docs row keyed by (source_type='prompt',
 * source_id=<prompt rowid>). Prompt ids are AUTOINCREMENT and never reused, so
 * deleting prompts alone would orphan those retrieval_docs rows (and their FTS
 * shadow) forever. We therefore look up the prompt ids first and delete the
 * matching retrieval_docs rows in the same pass. The retrieval_docs_ad trigger
 * keeps retrieval_docs_fts in sync on delete.
 */
function deleteConversationPrompts(db, uuid) {
  const conn = db.raw();
  const ids = conn.prepare('SELECT id FROM prompts WHERE session_id = ?').all(uuid).map(r => r.id);
  if (ids.length === 0) return;
  // retrieval_docs.source_id is stored as TEXT (see upsertRetrievalDoc), so bind
  // the prompt ids as strings — an integer IN-list would miss the TEXT values.
  const placeholders = ids.map(() => '?').join(', ');
  conn.prepare(
    `DELETE FROM retrieval_docs WHERE source_type = 'prompt' AND source_id IN (${placeholders})`
  ).run(...ids.map(String));
  conn.prepare('DELETE FROM prompts WHERE session_id = ?').run(uuid);
}

function parseTs(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/**
 * Write a single conversation. Returns one of: 'skipped' | 'imported' | 'changed'.
 * 'imported' = first time seen; 'changed' = seen before but updated_at moved.
 */
function writeConversation(db, convo, sourceFile) {
  const conn = db.raw();
  const prior = conn
    .prepare('SELECT updated_at FROM imported_chats WHERE conversation_uuid = ?')
    .get(convo.uuid);

  const isNew     = !prior;
  // Intentional raw-string equality: ISO 8601 dates compare correctly as
  // strings. Worst case a format difference triggers a harmless re-import.
  const unchanged = prior && prior.updated_at === convo.updatedAt;
  if (unchanged) return { status: 'skipped', prompts: 0 };

  const createdMs = parseTs(convo.createdAt);
  const updatedMs = parseTs(convo.updatedAt);

  // Atomicity note: we cannot wrap this sequence in a single BEGIN/COMMIT
  // because db.upsertMemoryEntry() calls _refreshMemoryLinks() which issues
  // its own BEGIN/COMMIT on the same node:sqlite DatabaseSync connection —
  // nested transactions are not supported and would throw. The sequence is
  // therefore non-atomic, but crash-recoverable by design: imported_chats is
  // written last so a torn write leaves no bookmark, and the next run simply
  // re-imports the conversation from scratch without duplicating data (the
  // 'changed' path deletes prior prompts before re-inserting).
  db.upsertSession({
    id:             convo.uuid,
    started_at:     convo.createdAt || convo.updatedAt || new Date().toISOString(),
    ended_at:       convo.updatedAt || null,
    duration_ms:    (createdMs != null && updatedMs != null) ? Math.max(0, updatedMs - createdMs) : null,
    platform:       'imported',
    cli:            'claude-desktop',
    model_provider: 'anthropic',
    model:          null,
    project:        convo.project,
  });

  // Changed case: drop the prior prompts (+ retrieval_docs) before re-inserting
  // so turn counts reflect the new transcript without duplicates.
  if (!isNew) deleteConversationPrompts(db, convo.uuid);

  let promptCount = 0;
  for (const m of convo.messages) {
    if (m.role !== 'human' || !m.text) continue;
    db.recordPrompt(convo.uuid, m.text, { source: 'claude-desktop' });
    promptCount++;
  }

  db.upsertMemoryEntry(
    `claude-desktop:conv:${convo.uuid}`,
    convo.name || 'Untitled chat',
    renderTranscript(convo),
    `claude-desktop chat ${convo.project}`
  );

  conn.prepare(`
    INSERT INTO imported_chats (conversation_uuid, updated_at, source_file, message_count, imported_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(conversation_uuid) DO UPDATE SET
      updated_at    = excluded.updated_at,
      source_file   = excluded.source_file,
      message_count = excluded.message_count,
      imported_at   = excluded.imported_at
  `).run(
    convo.uuid,
    convo.updatedAt || null,
    sourceFile,
    convo.messages.length,
    new Date().toISOString()
  );

  return { status: isNew ? 'imported' : 'changed', prompts: promptCount };
}

// ── public API ────────────────────────────────────────────────────────────

/**
 * Import Claude Desktop chat exports.
 *
 * @param {{ path?: string, dryRun?: boolean }} [opts]
 * @returns {{files, conversations, imported, skipped, changed, prompts, errors}}
 */
export function importChats(opts) {
  const o       = opts || {};
  const dryRun  = !!o.dryRun;
  const files   = resolveSourceFiles(o.path);

  const summary = { files: files.length, conversations: 0, imported: 0, skipped: 0, changed: 0, prompts: 0, errors: 0 };
  if (files.length === 0) return summary;

  // In dry-run we parse + count but never open/write the DB.
  const db = dryRun ? null : getDb();

  for (const file of files) {
    let conversations;
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      conversations = parseConversations(json, loadProjectsById(file));
    } catch (err) {
      summary.errors++;
      process.stderr.write(`[import-chats] failed to parse ${file}: ${err.message}\n`);
      continue;
    }

    for (const convo of conversations) {
      summary.conversations++;
      try {
        if (dryRun) {
          // Count what a real run would do without consulting the DB: treat
          // every conversation as importable and tally its human turns.
          summary.imported++;
          summary.prompts += convo.messages.filter(m => m.role === 'human' && m.text).length;
          continue;
        }
        const r = writeConversation(db, convo, file);
        if (r.status === 'skipped')  summary.skipped++;
        if (r.status === 'imported') summary.imported++;
        if (r.status === 'changed')  summary.changed++;
        summary.prompts += r.prompts;
      } catch (err) {
        // One bad conversation must not abort the whole run.
        summary.errors++;
        process.stderr.write(`[import-chats] error on conversation ${convo.uuid}: ${err.message}\n`);
      }
    }
  }

  return summary;
}

/**
 * Nightly entry point — resolves the configured export directory and imports.
 */
export function importChatsNightly() {
  return importChats({ dryRun: false });
}

// ── CLI ───────────────────────────────────────────────────────────────────

const thisPath = fileURLToPath(import.meta.url);

if (process.argv[1] === thisPath) {
  const args      = process.argv.slice(2);
  const dryRun    = args.includes('--dry-run');
  const printJson = args.includes('--json'); // CLI-only print flag; not passed into importChats()
  const target    = args.find(a => !a.startsWith('--')); // first non-flag = path

  try {
    const db      = require('./db.cjs');
    const summary = importChats({ path: target, dryRun });

    if (printJson) {
      console.log(JSON.stringify(summary));
    } else if (summary.files === 0) {
      console.log('No conversations.json found. Set paths.claude_export_dir or pass a path.');
    } else {
      console.log(
        `Imported ${summary.imported}, changed ${summary.changed}, skipped ${summary.skipped} ` +
        `(${summary.conversations} conversations across ${summary.files} file(s)); ` +
        `${summary.prompts} prompt(s), ${summary.errors} error(s).` +
        (dryRun ? ' [dry-run — nothing written]' : '')
      );
    }

    try { db.close(); } catch (_) {}
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}
