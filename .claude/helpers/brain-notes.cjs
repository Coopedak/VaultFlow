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

// ── listNotes + getNote ───────────────────────────────────────────────────

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
 * Fetch a single note with body.
 * (links/backlinks added in Task 2)
 * @param {number} id
 * @returns {{id, source, title, body, tags} | null}
 */
function getNote(id) {
  ensure();
  const note = db.raw().prepare(
    `SELECT id, source, title, body, tags FROM memory_entries WHERE id = ?`
  ).get(Number(id));
  return note || null;
}

module.exports = { listNotes, getNote };
