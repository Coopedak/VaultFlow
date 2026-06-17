/**
 * Flow impact engine (flow-impact.cjs) + the db layer the flows API wraps.
 * Run: node --test tests/flowImpact.test.mjs
 *
 * Seeds a synthetic multi-module call graph + a couple of stored flows + a
 * recent commit, then asserts analyzeImpact's APPROXIMATE classification:
 *   - a change to a node directly IN a flow            → 'affected'
 *   - a change whose downstream consumer is in a flow  → 'affected (handoff)'
 *   - an unrelated change                              → those flows not listed,
 *                                                        notAffected count correct
 *   - curated user_notes are surfaced on affected flows
 *   - root-cause section lists upstream + correlates a seeded recent commit
 *
 * Plus the db round-trip the thin API routes call: listFlows / getFlow /
 * updateFlowAnnotation (sets source='manual', preserves the auto graph).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');
const fi = require('../.claude/helpers/flow-impact.cjs');

const PROJECT = 'synth-impact';
const NOW = '2026-06-17T00:00:00Z';

/**
 * Synthetic graph (TS lang), one project. Call edges:
 *   routes.ts::registerRoutes --> handleRequest --> loadData --> (writeFile ext)
 *   routes.ts::registerRoutes --> renderView  (renderView is a separate consumer)
 *   cycle/a.ts::A --> B --> C    (unrelated module — must not be reached)
 *
 * Imports: routes.ts imports ./data + express.
 *
 * Two stored flows:
 *   FLOW_MAIN  contains registerRoutes + handleRequest + loadData  (the full path)
 *   FLOW_VIEW  contains registerRoutes + renderView ONLY (NOT loadData) — used to
 *              prove HANDOFF: changing loadData reaches FLOW_VIEW only if a
 *              consumer of loadData is in it. handleRequest (a loadData consumer)
 *              is in FLOW_MAIN, not FLOW_VIEW → FLOW_VIEW is NOT reached by a
 *              loadData change, FLOW_MAIN is reached via handoff.
 */
function freshDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-impact-'));
  db.close();
  db.initialize(root, 'vaultflow.db');
  const conn = db.raw();

  const sym = (file, name, line) =>
    `('${file}','${PROJECT}','ts','function','${name}',${line},'${NOW}',NULL)`;
  const call = (cf, cn, callee, line) =>
    `('${cf}','${cn}','${callee}','${PROJECT}','ts',${line},'${NOW}')`;
  const esc = (s) => String(s).replace(/'/g, "''");
  const imp = (file, target, raw, line) =>
    `('${file}','${PROJECT}','ts','${esc(target)}','${esc(raw)}',${line},'${NOW}')`;

  conn.exec(`
    INSERT INTO code_symbols (file,project,lang,kind,name,line,indexed_at,content_hash) VALUES
      ${sym('src/api/routes.ts','registerRoutes',10)},
      ${sym('src/api/routes.ts','handleRequest',30)},
      ${sym('src/api/routes.ts','renderView',50)},
      ${sym('src/api/data.ts','loadData',5)},
      ${sym('src/cycle/a.ts','A',1)},
      ${sym('src/cycle/a.ts','B',10)},
      ${sym('src/cycle/a.ts','C',20)};

    INSERT INTO code_calls (caller_file,caller_name,callee_name,project,lang,line,indexed_at) VALUES
      ${call('src/api/routes.ts','registerRoutes','handleRequest',12)},
      ${call('src/api/routes.ts','registerRoutes','renderView',13)},
      ${call('src/api/routes.ts','handleRequest','loadData',31)},
      ${call('src/api/data.ts','loadData','writeFile',6)},
      ${call('src/cycle/a.ts','A','B',2)},
      ${call('src/cycle/a.ts','B','C',11)};

    INSERT INTO code_imports (file,project,lang,target,raw,line,indexed_at) VALUES
      ${imp('src/api/routes.ts','./data',"import { loadData } from './data'",1)},
      ${imp('src/api/routes.ts','express',"import express from 'express'",2)};
  `);

  // Two stored flows (pre-traced; engine reads stored node sets, never re-walks).
  db.upsertFlowGraph(
    { id: 'flow_main', project: PROJECT, name: 'api · registerRoutes', source: 'auto',
      entry_point: 'src/api/routes.ts::registerRoutes', fingerprint: 'fp_main', confidence: 0.8 },
    [
      { id: 'src/api/routes.ts::registerRoutes', label: 'registerRoutes', file: 'src/api/routes.ts' },
      { id: 'src/api/routes.ts::handleRequest',  label: 'handleRequest',  file: 'src/api/routes.ts' },
      { id: 'src/api/data.ts::loadData',         label: 'loadData',       file: 'src/api/data.ts' },
    ],
    [
      { source: 'src/api/routes.ts::registerRoutes', target: 'src/api/routes.ts::handleRequest' },
      { source: 'src/api/routes.ts::handleRequest',  target: 'src/api/data.ts::loadData' },
    ]
  );
  db.upsertFlowGraph(
    { id: 'flow_view', project: PROJECT, name: 'api · renderView', source: 'auto',
      entry_point: 'src/api/routes.ts::registerRoutes', fingerprint: 'fp_view', confidence: 0.6 },
    [
      { id: 'src/api/routes.ts::registerRoutes', label: 'registerRoutes', file: 'src/api/routes.ts' },
      { id: 'src/api/routes.ts::renderView',     label: 'renderView',     file: 'src/api/routes.ts' },
    ],
    [{ source: 'src/api/routes.ts::registerRoutes', target: 'src/api/routes.ts::renderView' }]
  );

  // A recent commit mentioning the upstream "data" file stem — for root-cause
  // correlation when the symptom is at handleRequest (callee: loadData in data.ts).
  conn.prepare(`
    INSERT INTO git_commits (sha, project, author, committed_at, subject, body, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('abc1234deadbeef', PROJECT, 'dev', '2026-06-16T12:00:00Z',
    'fix(data): loadData returned stale rows', 'reworked the data loader cache', NOW);
  conn.prepare(`
    INSERT INTO git_commits (sha, project, author, committed_at, subject, body, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('def5678cafef00d', PROJECT, 'dev', '2026-06-15T12:00:00Z',
    'chore: bump deps', 'unrelated maintenance', NOW);

  return root;
}

test('analyzeImpact resolves a symbol target and scopes the project', () => {
  freshDb();
  const rep = fi.analyzeImpact(db, { symbol: 'handleRequest', project: PROJECT });
  assert.equal(rep.ok, true);
  assert.equal(rep.approximate, true);
  assert.equal(rep.target.symbol, 'handleRequest');
  assert.equal(rep.target.file, 'src/api/routes.ts');
  assert.equal(rep.target.project, PROJECT);
  assert.match(rep.disclaimer, /APPROXIMATE/);
});

test('a change to a node directly IN a flow → affected', () => {
  freshDb();
  // handleRequest is a direct node of flow_main.
  const rep = fi.analyzeImpact(db, { symbol: 'handleRequest', project: PROJECT });
  const main = rep.flowImpact.affected.find(f => f.id === 'flow_main');
  assert.ok(main, 'flow_main listed');
  assert.equal(main.classification, 'affected', 'directly-in-flow → affected');
});

test('a change whose downstream consumer is in a flow → affected (handoff)', () => {
  freshDb();
  // Change loadData. Its caller is handleRequest (consumer). handleRequest is a
  // node of flow_main but loadData itself is ALSO a node of flow_main → flow_main
  // is 'affected' (direct). flow_view contains neither loadData nor any loadData
  // consumer → not reached. To isolate handoff cleanly, drop loadData from the
  // flow_main node set so only its consumer (handleRequest) remains.
  const conn = db.raw();
  conn.prepare('DELETE FROM flow_nodes WHERE flow_id = ? AND node_id = ?')
    .run('flow_main', 'src/api/data.ts::loadData');

  const rep = fi.analyzeImpact(db, { symbol: 'loadData', project: PROJECT });
  const main = rep.flowImpact.affected.find(f => f.id === 'flow_main');
  assert.ok(main, 'flow_main reached via its consumer handleRequest');
  assert.equal(main.classification, 'affected (handoff)',
    'consumer-in-flow (not the changed node) → handoff');

  // flow_view has no loadData node and no loadData consumer, but it shares the
  // file src/api/routes.ts with the consumer handleRequest → 'verify' (can't
  // prove safe). This is the correct middle classification, not "not reached".
  const view = rep.flowImpact.affected.find(f => f.id === 'flow_view');
  assert.ok(view, 'flow_view shares a file with the consumer');
  assert.equal(view.classification, 'verify', 'shared-file-only link → verify');
});

test('an unrelated change lists no flows and counts notAffected correctly', () => {
  freshDb();
  // 'B' lives in src/cycle/a.ts — no flow references it or its file.
  const rep = fi.analyzeImpact(db, { symbol: 'B', project: PROJECT });
  assert.equal(rep.flowImpact.affectedCount, 0, 'no flow reached');
  assert.equal(rep.flowImpact.totalFlows, 2, 'two flows cataloged');
  assert.equal(rep.flowImpact.notAffected, 2, 'both flows counted as not-affected');
});

test('curated user_notes are surfaced on an affected flow', () => {
  freshDb();
  db.updateFlowAnnotation('flow_main', {
    user_notes: 'loadData ALSO writes an audit row consumed by the billing job (DB handoff).',
  });
  const rep = fi.analyzeImpact(db, { symbol: 'handleRequest', project: PROJECT });
  const main = rep.flowImpact.affected.find(f => f.id === 'flow_main');
  assert.ok(main, 'flow_main listed');
  assert.match(main.user_notes, /billing job/, 'authoritative user_notes surfaced');
});

test('root-cause section lists upstream deps and correlates a recent commit', () => {
  freshDb();
  // Symptom at handleRequest → upstream callee is loadData in src/api/data.ts.
  const rep = fi.analyzeImpact(db, { symbol: 'handleRequest', project: PROJECT, mode: 'debug' });
  assert.equal(rep.mode, 'debug');

  const upFiles = rep.rootCause.upstreamFiles.map(u => u.file);
  assert.ok(upFiles.includes('src/api/data.ts'), 'upstream data.ts listed as a cause origin');

  // The 'data' stem matches the seeded commit subject "fix(data): loadData ...".
  const correlated = rep.rootCause.correlatedCommits;
  assert.ok(correlated.length >= 1, 'at least one upstream-correlated commit');
  assert.ok(correlated.some(c => c.sha === 'abc1234deadbeef'), 'the data commit is correlated');
  // The unrelated maintenance commit must NOT correlate.
  assert.ok(!correlated.some(c => c.sha === 'def5678cafef00d'), 'unrelated commit not correlated');
});

test('downstream lists importers (file) and callsites (symbol)', () => {
  freshDb();
  // loadData: imported via ./data by routes.ts (blast radius) AND called by
  // handleRequest (callsite).
  const rep = fi.analyzeImpact(db, { file: 'src/api/data.ts', symbol: 'loadData', project: PROJECT });
  assert.ok(rep.downstream.callsiteCount >= 1, 'loadData has a callsite');
  assert.ok(rep.downstream.callsites.some(c => c.symbol === 'handleRequest'), 'handleRequest callsite found');
  assert.ok(rep.downstream.importers.some(d => /routes\.ts$/.test(d.file)), 'routes.ts imports data.ts');
});

test('unresolvable target returns ok:false with guidance', () => {
  freshDb();
  const rep = fi.analyzeImpact(db, { symbol: 'doesNotExistAnywhere', project: PROJECT });
  assert.equal(rep.ok, false);
  assert.match(rep.error, /Could not resolve/);
});

test('renderImpact produces a readable, disclaimered report', () => {
  freshDb();
  const rep = fi.analyzeImpact(db, { symbol: 'handleRequest', project: PROJECT });
  const text = fi.renderImpact(rep);
  assert.match(text, /Impact report for/);
  assert.match(text, /APPROXIMATE/);
  assert.match(text, /FLOW IMPACT/);
  assert.match(text, /ROOT-CAUSE DIRECTION/);
});

// ── db layer the thin flows API routes call ───────────────────────────────

test('listFlows / getFlow round-trip the stored graph', () => {
  freshDb();
  const all = db.listFlows(PROJECT);
  assert.equal(all.length, 2, 'two flows listed');
  const main = all.find(f => f.id === 'flow_main');
  assert.equal(main.node_count, 3, 'node_count reflects stored nodes');

  const full = db.getFlow('flow_main');
  assert.ok(full && full.flow && Array.isArray(full.nodes) && Array.isArray(full.edges));
  assert.equal(full.flow.project, PROJECT);
  assert.equal(full.nodes.length, 3);
  assert.equal(full.edges.length, 2);

  assert.equal(db.getFlow('nope'), null, 'missing flow → null (route returns 404)');
});

test('updateFlowAnnotation sets source=manual and preserves the auto graph', () => {
  freshDb();
  const before = db.getFlow('flow_main');
  assert.equal(before.flow.source, 'auto');

  const ok = db.updateFlowAnnotation('flow_main', {
    name: 'Curated Main Flow',
    description: 'hand-written',
    user_notes: 'see DB handoff',
  });
  assert.equal(ok, true);

  const after = db.getFlow('flow_main');
  assert.equal(after.flow.name, 'Curated Main Flow', 'name updated');
  assert.equal(after.flow.description, 'hand-written', 'description updated');
  assert.equal(after.flow.user_notes, 'see DB handoff', 'notes updated');
  assert.equal(after.flow.source, 'manual', 'source flipped to manual');
  // The auto-traced graph is untouched by an annotation write.
  assert.equal(after.nodes.length, 3, 'nodes preserved');
  assert.equal(after.edges.length, 2, 'edges preserved');

  assert.equal(db.updateFlowAnnotation('nope', { name: 'x' }), false, 'missing flow → false');
});
