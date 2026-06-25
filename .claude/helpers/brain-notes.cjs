'use strict';

/**
 * brain-notes.cjs — Atlas data core
 *
 * WHY: Maps memory_entries rows + their [[wikilink]] references into note
 * objects with resolved links, backlinks, and a local Cytoscape-ready graph.
 * Consumed by /api/notes endpoints (server.mjs) and the Atlas SPA view.
 *
 * All DB access goes through db.cjs (the shared connection manager).
 * No new npm dependencies — pure Node.js 22+ CJS.
 */

const db = require('./db.cjs');

// Ensure the DB is open before any query. db.initialize() is idempotent.
function ensure() { db.initialize(); }

// ── Task 1: listNotes + getNote ───────────────────────────────────────────

/**
 * List note headers (no body) from memory_entries.
 * @param {object} [opts]
 * @param {number} [opts.limit=100]   max rows, clamped to 500
 * @param {number} [opts.offset=0]
 * @param {string|null} [opts.source] filter by source file path
 * @returns {Array<{id:number, source:string, title:string, tags:string}>}
 */
function listNotes({ limit = 100, offset = 0, source = null } = {}) {
  ensure();
  const lim = Math.min(Number(limit) || 100, 500);
  const off = Number(offset) || 0;
  const where = source ? 'WHERE source = ?' : '';
  const args = source ? [source, lim, off] : [lim, off];
  return db.raw().prepare(
    `SELECT id, source, title, tags FROM memory_entries ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...args);
}

/**
 * Fetch a single note with body, resolved wikilinks, and backlinks.
 * @param {number} id
 * @returns {{id, source, title, body, tags, links:Link[], backlinks:Ref[]} | null}
 */
function getNote(id) {
  ensure();
  const note = db.raw().prepare(
    `SELECT id, source, title, body, tags FROM memory_entries WHERE id = ?`
  ).get(Number(id));
  if (!note) return null;
  note.links = resolveLinks(note.body);
  note.backlinks = getBacklinks(note.id);
  return note;
}

// ── Task 2: wikilink extraction, resolveLinks, getBacklinks ───────────────

/**
 * Extract the raw names inside all [[wikilink]] markers in a body string.
 * @param {string} body
 * @returns {string[]}
 */
function extractWikilinkTitles(body) {
  return [...String(body || '').matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1].trim());
}

/**
 * Build a lowercase title → id index over all memory_entries.
 * @returns {Map<string, number>}
 */
function titleIndex() {
  ensure();
  const rows = db.raw().prepare(`SELECT id, title FROM memory_entries`).all();
  const map = new Map();
  for (const r of rows) map.set(r.title.toLowerCase(), r.id);
  return map;
}

/**
 * Resolve all [[wikilinks]] in a body string against the title index.
 * Case-insensitive: [[beta]] resolves to a note titled "Beta".
 * @param {string} body
 * @returns {Array<{name:string, id:number|null, dangling:boolean}>}
 */
function resolveLinks(body) {
  const idx = titleIndex();
  return extractWikilinkTitles(body).map(name => {
    const id = idx.get(name.toLowerCase());
    return { name, id: id == null ? null : id, dangling: id == null };
  });
}

/**
 * Find all notes whose body contains a [[wikilink]] pointing to the given note's title.
 * @param {number} id  target note id
 * @returns {Array<{id:number, source:string, title:string}>}
 */
function getBacklinks(id) {
  ensure();
  const target = db.raw().prepare(`SELECT title FROM memory_entries WHERE id = ?`).get(Number(id));
  if (!target) return [];
  const t = target.title.toLowerCase();
  const rows = db.raw().prepare(
    `SELECT id, source, title, body FROM memory_entries WHERE id != ?`
  ).all(Number(id));
  return rows
    .filter(r => extractWikilinkTitles(r.body).some(n => n.toLowerCase() === t))
    .map(r => ({ id: r.id, source: r.source, title: r.title }));
}

module.exports = { listNotes, getNote, extractWikilinkTitles, resolveLinks, getBacklinks };
