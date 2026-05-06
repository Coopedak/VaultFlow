/**
 * session-manager.mjs — session state store (EventEmitter)
 *
 * WHY: Central registry for all active sessions. Emits events so
 * widgets can react to changes without polling.
 *
 * Events emitted:
 *   'added'    (session)        — new session registered
 *   'removed'  (session)        — session removed from list
 *   'updated'  (session)        — session metadata changed (tokens, edits, status)
 *   'output'   (session, line)  — new line of PTY output appended
 *   'selected' (session)        — active session in right panel changed
 */

import { EventEmitter } from 'node:events';
import { randomUUID }   from 'node:crypto';

const MAX_LINES = 5000;

class SessionManager extends EventEmitter {
  constructor() {
    super();
    this._sessions = new Map();   // id → session object
    this._selectedId = null;       // currently shown in right panel
  }

  /**
   * Create and register a new session.
   * @param {{ tool: string, project: string, cwd: string }} opts
   * @returns {object} session
   */
  create({ tool = 'claude', project = 'unknown', cwd = process.cwd() } = {}) {
    const id = randomUUID();
    const session = {
      id,
      sessionId: null,    // set by db-reader when a matching DB row is found
      project,
      cwd,
      tool,               // 'claude' | 'copilot' | 'codex'
      status: 'running',  // 'running' | 'idle' | 'notification' | 'crashed'
      tokens: 0,
      maxTokens: 200000,
      edits: 0,
      commands: 0,
      tasks: 0,
      errors: 0,
      startedAt: new Date(),
      lines: [],          // buffered PTY output lines (plain strings, ANSI intact)
      ptyProc: null,      // node-pty instance (set by pty-manager)
      pendingReview: null,
      scrollPos: -1,      // -1 = live tail; ≥0 = pinned scroll position
      externalLaunches: 0,
      lastPoppedOutAt: null,
      launchName: null,
    };
    this._sessions.set(id, session);
    this.emit('added', session);

    // Auto-select if first session
    if (this._sessions.size === 1) {
      this.select(id);
    }

    return session;
  }

  /** Get session by id. Returns undefined if not found. */
  get(id) {
    return this._sessions.get(id);
  }

  /** Get all sessions as an array, in insertion order. */
  getAll() {
    return Array.from(this._sessions.values());
  }

  /** Get sessions grouped by tool type. */
  getGrouped() {
    const groups = { claude: [], copilot: [], codex: [] };
    for (const s of this._sessions.values()) {
      const key = s.tool in groups ? s.tool : 'claude';
      groups[key].push(s);
    }
    return groups;
  }

  /**
   * Append a line of PTY output to a session.
   * Trims the buffer to MAX_LINES.
   */
  appendLine(id, line) {
    const s = this._sessions.get(id);
    if (!s) return;
    s.lines.push(line);
    if (s.lines.length > MAX_LINES) {
      s.lines.splice(0, s.lines.length - MAX_LINES);
    }
    this.emit('output', s, line);
  }

  /**
   * Update session fields and emit 'updated'.
   * @param {string} id
   * @param {Partial<session>} patch
   */
  update(id, patch) {
    const s = this._sessions.get(id);
    if (!s) return;
    Object.assign(s, patch);
    this.emit('updated', s);
  }

  /** Select a session to display in right panel. */
  select(id) {
    const s = this._sessions.get(id);
    if (!s) return;
    this._selectedId = id;
    this.emit('selected', s);
  }

  /** Get the currently selected session (or null). */
  getSelected() {
    if (!this._selectedId) return null;
    return this._sessions.get(this._selectedId) || null;
  }

  /**
   * Remove a session from the list.
   * If removed session was selected, select the next one.
   */
  remove(id) {
    const s = this._sessions.get(id);
    if (!s) return;

    const keys = Array.from(this._sessions.keys());
    const idx  = keys.indexOf(id);
    this._sessions.delete(id);
    this.emit('removed', s);

    if (this._selectedId === id) {
      // Pick the next session, or the previous if this was last
      const remaining = Array.from(this._sessions.keys());
      if (remaining.length > 0) {
        const nextIdx = Math.min(idx, remaining.length - 1);
        this.select(remaining[nextIdx]);
      } else {
        this._selectedId = null;
        this.emit('selected', null);
      }
    }
  }

  /** How many sessions are registered. */
  get size() {
    return this._sessions.size;
  }

  /**
   * Get a flat list of sessions in display order (for 1–9 shortcuts).
   * Order: claude sessions, then copilot, then codex.
   */
  getFlat() {
    const g = this.getGrouped();
    return [...g.claude, ...g.copilot, ...g.codex];
  }
}

export const sessionManager = new SessionManager();
