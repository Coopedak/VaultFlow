'use strict';

/**
 * Test fixture for sessionStore.test.mjs — runs session.start() in an
 * isolated child process and reports the resulting session as JSON.
 *
 * DB side-effects are stubbed out BEFORE session.cjs is loaded so the test
 * never touches the live vaultflow.db. session.cjs resolves the sessions
 * directory from VAULTFLOW_SESSIONS_DIR (set by the test) and the project
 * from process.cwd() (set via spawnSync cwd).
 */

const db = require('../../.claude/helpers/db.cjs');
db.initialize         = () => {};
db.upsertSession      = () => {};
db.closeStaleSessions = () => ({ closed: 0 });

const session = require('../../.claude/helpers/session.cjs');
const s = session.start();
process.stdout.write(JSON.stringify({ id: s.id, project: s.project, cwd: s.cwd }));
