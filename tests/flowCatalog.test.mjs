/**
 * Flow catalog — foundation primitives (code-graph), schema/accessors (db),
 * and the discovery engine (flow-catalog). Run:
 *   node --test tests/flowCatalog.test.mjs
 *
 * Seeds a synthetic multi-module call graph and asserts the APPROXIMATE flow
 * tracing behaves: cycle-safe, cap-aware, same-dir bare-name resolution with
 * ambiguity flagging, terminal leaves for unresolved callees, and curation
 * preservation on re-discovery.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');
const cg = require('../.claude/helpers/code-graph.cjs');
const fc = require('../.claude/helpers/flow-catalog.cjs');

const PROJECT = 'synth';
const NOW = '2026-06-17T00:00:00Z';

/**
 * Synthetic graph (project 'synth'), TS lang:
 *
 *  Linear flow:   src/api/routes.ts::registerRoutes  --get-->  (router verb, entry-point marker)
 *                 src/api/routes.ts::registerRoutes  --> handleRequest --> loadData --> writeFile(external)
 *
 *  Cyclic flow:   src/cycle/a.ts::A --> B --> C --> A   (full circle)
 *
 *  Name collision: 'handle' defined in BOTH src/mod1/x.ts and src/mod2/y.ts.
 *                  caller src/mod1/x.ts::caller1 calls handle → should resolve
 *                  to the SAME-DIR src/mod1/x.ts::handle (not ambiguous).
 *                  caller src/other/z.ts::caller2 calls handle → no same-dir
 *                  match → ambiguous=true.
 */
function freshDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-flow-'));
  db.close();
  db.initialize(root, 'vaultflow.db');
  const conn = db.raw();

  const sym = (file, kind, name, line) =>
    `('${file}','${PROJECT}','ts','${kind}','${name}',${line},'${NOW}',NULL)`;
  const call = (cf, cn, callee, line) =>
    `('${cf}','${cn}','${callee}','${PROJECT}','ts',${line},'${NOW}')`;
  // raw may contain single quotes (import statements) → escape for SQL literal.
  const esc = (s) => String(s).replace(/'/g, "''");
  const imp = (file, target, raw, line) =>
    `('${file}','${PROJECT}','ts','${esc(target)}','${esc(raw)}',${line},'${NOW}')`;

  conn.exec(`
    INSERT INTO code_symbols (file,project,lang,kind,name,line,indexed_at,content_hash) VALUES
      ${sym('src/api/routes.ts','function','registerRoutes',10)},
      ${sym('src/api/routes.ts','function','handleRequest',30)},
      ${sym('src/api/data.ts','function','loadData',5)},
      ${sym('src/cycle/a.ts','function','A',1)},
      ${sym('src/cycle/a.ts','function','B',10)},
      ${sym('src/cycle/a.ts','function','C',20)},
      ${sym('src/mod1/x.ts','function','caller1',1)},
      ${sym('src/mod1/x.ts','function','handle',10)},
      ${sym('src/mod2/y.ts','function','handle',5)},
      ${sym('src/other/z.ts','function','caller2',1)},
      ${sym('scripts/garbage.mjs','function','garbageEntry',1)};

    INSERT INTO code_calls (caller_file,caller_name,callee_name,project,lang,line,indexed_at) VALUES
      ${call('src/api/routes.ts','registerRoutes','get',11)},
      ${call('src/api/routes.ts','registerRoutes','handleRequest',12)},
      ${call('src/api/routes.ts','handleRequest','loadData',31)},
      ${call('src/api/data.ts','loadData','writeFile',6)},
      ${call('src/cycle/a.ts','A','B',2)},
      ${call('src/cycle/a.ts','B','C',11)},
      ${call('src/cycle/a.ts','C','A',21)},
      ${call('src/mod1/x.ts','caller1','handle',2)},
      ${call('src/other/z.ts','caller2','handle',2)},
      ${call('scripts/garbage.mjs','garbageEntry','COUNT',2)},
      ${call('scripts/garbage.mjs','garbageEntry','FROM',3)},
      ${call('scripts/garbage.mjs','garbageEntry','bm25',4)},
      ${call('scripts/garbage.mjs','garbageEntry','SELECT',5)},
      ${call('scripts/garbage.mjs','garbageEntry','get',6)},
      ${call('scripts/garbage.mjs','garbageEntry','someExternalLib',7)},
      ${call('scripts/garbage.mjs','garbageEntry','anotherUnindexed',8)};

    INSERT INTO code_imports (file,project,lang,target,raw,line,indexed_at) VALUES
      ${imp('src/api/routes.ts','./data',"import { loadData } from './data'",1)},
      ${imp('src/api/routes.ts','express',"import express from 'express'",2)};
  `);
  return root;
}

test('getImports returns a file imports (project-scoped)', () => {
  freshDb();
  const imps = cg.getImports(db, 'src/api/routes.ts', PROJECT);
  assert.equal(imps.length, 2);
  const targets = imps.map(i => i.target).sort();
  assert.deepEqual(targets, ['./data', 'express']);
  assert.equal(imps[0].lang, 'ts');
});

test('inferModule returns the module under the source root', () => {
  assert.equal(cg.inferModule('src/billing/charge.ts'), 'billing');
  assert.equal(cg.inferModule('src/api/routes.ts'), 'api');
  assert.equal(cg.inferModule('.claude/helpers/db.cjs'), 'helpers');
  assert.equal(cg.inferModule('scripts/cli.mjs'), 'scripts');
  assert.equal(cg.inferModule('foo.ts'), '');
});

test('walkTransitive traces a linear flow and records terminal leaves', () => {
  freshDb();
  const g = cg.walkTransitive(db, { file: 'src/api/routes.ts', name: 'registerRoutes' }, {
    direction: 'callees', depth: 6, maxNodes: 100, project: PROJECT,
  });
  const ids = new Set(g.nodes.map(n => n.id));
  assert.ok(ids.has('src/api/routes.ts::registerRoutes'), 'start node present');
  assert.ok(ids.has('src/api/routes.ts::handleRequest'), 'resolved callee present');
  assert.ok(ids.has('src/api/data.ts::loadData'), 'transitive callee present');
  // writeFile is unresolved (no symbol) → terminal leaf node.
  const leaf = g.nodes.find(n => n.label === 'writeFile');
  assert.ok(leaf, 'unresolved callee recorded');
  assert.equal(leaf.terminal, true, 'unresolved callee is terminal');
  // every edge endpoint exists as a node
  for (const e of g.edges) {
    assert.ok(ids.has(e.source) && ids.has(e.target), `dangling edge ${e.source}->${e.target}`);
  }
});

test('walkTransitive detects a cycle without infinite looping', () => {
  freshDb();
  const g = cg.walkTransitive(db, { file: 'src/cycle/a.ts', name: 'A' }, {
    direction: 'callees', depth: 10, maxNodes: 100, project: PROJECT,
  });
  const ids = new Set(g.nodes.map(n => n.id));
  assert.ok(ids.has('src/cycle/a.ts::A'));
  assert.ok(ids.has('src/cycle/a.ts::B'));
  assert.ok(ids.has('src/cycle/a.ts::C'));
  // The back-edge C->A must be present (the "full circle").
  assert.ok(
    g.edges.some(e => e.source === 'src/cycle/a.ts::C' && e.target === 'src/cycle/a.ts::A'),
    'cycle back-edge C->A recorded'
  );
  assert.ok(g.cycles.length >= 1, 'cycle detected and reported');
  // Only 3 real nodes — no runaway from the loop.
  assert.equal(g.nodes.length, 3);
});

test('walkTransitive honors maxNodes cap and sets truncated', () => {
  freshDb();
  const g = cg.walkTransitive(db, { file: 'src/api/routes.ts', name: 'registerRoutes' }, {
    direction: 'callees', depth: 6, maxNodes: 2, project: PROJECT,
  });
  assert.ok(g.nodes.length <= 2, 'node cap honored');
  assert.equal(g.truncated, true, 'truncated flag set when capped');
});

test('bare-name resolution prefers same-dir and flags ambiguous on collision', () => {
  freshDb();
  // caller1 (src/mod1) → handle: same-dir definition exists → unambiguous.
  const g1 = cg.walkTransitive(db, { file: 'src/mod1/x.ts', name: 'caller1' }, {
    direction: 'callees', depth: 3, maxNodes: 50, project: PROJECT,
  });
  const h1 = g1.nodes.find(n => n.label === 'handle');
  assert.ok(h1, 'handle resolved for caller1');
  assert.equal(h1.file, 'src/mod1/x.ts', 'same-dir definition preferred');
  assert.equal(h1.ambiguous, false, 'same-dir match is unambiguous');

  // caller2 (src/other) → handle: no same-dir def → ambiguous pick.
  const g2 = cg.walkTransitive(db, { file: 'src/other/z.ts', name: 'caller2' }, {
    direction: 'callees', depth: 3, maxNodes: 50, project: PROJECT,
  });
  const h2 = g2.nodes.find(n => n.label === 'handle');
  assert.ok(h2, 'handle resolved for caller2');
  assert.equal(h2.ambiguous, true, 'cross-dir collision flagged ambiguous');
});

test('detectEntryPoints finds the http route registration', () => {
  freshDb();
  const entries = fc.detectEntryPoints(db, PROJECT);
  const route = entries.find(e => e.file === 'src/api/routes.ts' && e.name === 'registerRoutes');
  assert.ok(route, 'route registration detected as entry point');
  assert.equal(route.reason, 'http-route');
});

test('discoverFlows creates flows, dedupes by fingerprint, and round-trips', () => {
  freshDb();
  const summary = fc.discoverFlows(db, PROJECT, {});
  assert.equal(summary.project, PROJECT);
  assert.equal(summary.approximate, true);
  assert.ok(summary.flowsCreated > 0, 'at least one flow created');

  const flows = db.listFlows(PROJECT);
  assert.ok(flows.length > 0, 'flows listed');
  // round-trip: full graph for the first flow
  const full = db.getFlow(flows[0].id);
  assert.ok(full && full.flow && Array.isArray(full.nodes) && Array.isArray(full.edges));
  assert.equal(full.flow.project, PROJECT);

  // Re-run is idempotent: no NEW flows the second time (all dedup/update).
  const before = db.listFlows(PROJECT).length;
  const summary2 = fc.discoverFlows(db, PROJECT, {});
  const after = db.listFlows(PROJECT).length;
  assert.equal(after, before, 're-discovery does not duplicate flows');
  assert.equal(summary2.flowsCreated, 0, 'second run creates nothing new');
});

test('walkTransitive drops noise callees (SQL keywords, HTTP verbs) entirely', () => {
  freshDb();
  // garbageEntry calls COUNT/FROM/bm25/SELECT/get (all noise) + two unresolved
  // externals. The noise callees must NOT appear as nodes — not even terminal.
  const g = cg.walkTransitive(db, { file: 'scripts/garbage.mjs', name: 'garbageEntry' }, {
    direction: 'callees', depth: 4, maxNodes: 100, project: PROJECT,
  });
  const labels = new Set(g.nodes.map(n => n.label));
  for (const noise of ['COUNT', 'FROM', 'bm25', 'SELECT', 'get']) {
    assert.equal(labels.has(noise), false, `noise callee ${noise} must be dropped`);
  }
  // The two genuine (if unresolved) externals survive as terminal leaves.
  assert.ok(labels.has('someExternalLib'), 'real external callee kept');
  assert.ok(labels.has('anotherUnindexed'), 'real external callee kept');
});

test('isNoiseCallee matches case-insensitively', () => {
  assert.equal(cg.isNoiseCallee('COUNT'), true);
  assert.equal(cg.isNoiseCallee('count'), true);
  assert.equal(cg.isNoiseCallee('Json'), true);
  assert.equal(cg.isNoiseCallee('handleRequest'), false);
});

test('flowQuality is the resolved-node fraction', () => {
  const nodes = [
    { terminal: false, ambiguous: false }, // resolved
    { terminal: false, ambiguous: false }, // resolved
    { terminal: true,  ambiguous: false }, // leaf — not resolved
    { terminal: false, ambiguous: true  }, // ambiguous — not resolved
  ];
  assert.equal(fc.flowQuality(nodes), 0.5);
  assert.equal(fc.flowQuality([]), 0);
});

test('quality gate skips a garbage AUTO flow but keeps a clean one', () => {
  freshDb();
  const conn = db.raw();
  // Seed a SECOND http-route entry (so it is AUTO-detected, like registerRoutes)
  // whose trace is dominated by unresolved/external leaves → low quality. This
  // exercises the gate on a real auto-detected entry. It lives in a router-
  // importing file and registers a route, but its only callees are externals.
  const NOW2 = '2026-06-17T00:00:00Z';
  conn.prepare(`INSERT INTO code_symbols (file,project,lang,kind,name,line,indexed_at,content_hash) VALUES (?,?,?,?,?,?,?,?)`)
    .run('src/api/junk.ts', PROJECT, 'ts', 'function', 'junkRoute', 1, NOW2, null);
  conn.prepare(`INSERT INTO code_imports (file,project,lang,target,raw,line,indexed_at) VALUES (?,?,?,?,?,?,?)`)
    .run('src/api/junk.ts', PROJECT, 'ts', 'express', "import express from 'express'", 1, NOW2);
  // route registration (get → dropped noise) + TWO unresolved external callees.
  // Trace = junkRoute (resolved) + 2 terminal leaves → quality 1/3 ≈ 0.33 < 0.35.
  conn.prepare(`INSERT INTO code_calls (caller_file,caller_name,callee_name,project,lang,line,indexed_at) VALUES (?,?,?,?,?,?,?)`)
    .run('src/api/junk.ts', 'junkRoute', 'get', PROJECT, 'ts', 2, NOW2);
  conn.prepare(`INSERT INTO code_calls (caller_file,caller_name,callee_name,project,lang,line,indexed_at) VALUES (?,?,?,?,?,?,?)`)
    .run('src/api/junk.ts', 'junkRoute', 'someUnindexedExternal', PROJECT, 'ts', 3, NOW2);
  conn.prepare(`INSERT INTO code_calls (caller_file,caller_name,callee_name,project,lang,line,indexed_at) VALUES (?,?,?,?,?,?,?)`)
    .run('src/api/junk.ts', 'junkRoute', 'anotherUnindexedExternal', PROJECT, 'ts', 4, NOW2);

  // Plain discovery (no declarations) exercises the gate via real detection.
  const summary = fc.discoverFlows(db, PROJECT, {});
  assert.ok(summary.flowsSkippedLowQuality >= 1, 'at least one low-quality auto flow skipped');

  const names = db.listFlows(PROJECT).map(f => f.name);
  // The garbage auto entry (dominated by an unresolved leaf) is gone.
  assert.ok(!names.some(n => /junkRoute/.test(n)), 'garbage auto flow not cataloged');
  // The clean linear flow survives.
  assert.ok(names.some(n => /registerRoutes/.test(n)), 'clean flow cataloged');
});

test('a DECLARED entry is EXEMPT from the quality gate (recall floor)', () => {
  freshDb();
  // garbageEntry would be dropped by the gate as an auto entry — but a user's
  // explicit declaration is the recall floor and must NOT be silently dropped.
  const summary = fc.discoverFlows(db, PROJECT, {
    declared: [{ file: 'scripts/garbage.mjs', name: 'garbageEntry' }],
  });
  const flows = db.listFlows(PROJECT);
  const declaredFlow = flows.find(f => /garbageEntry/.test(f.name));
  assert.ok(declaredFlow, 'declared low-quality flow IS cataloged');
  assert.equal(declaredFlow.source, 'declared', 'stored with source=declared');
  // The discovery summary surfaces it as low confidence rather than dropping it.
  const traced = summary.flows.find(f => /garbageEntry/.test(f.name));
  assert.ok(traced, 'declared flow present in summary');
  assert.equal(traced.source, 'declared');
});

test('discoverFlows persists a confidence score on each stored flow', () => {
  freshDb();
  fc.discoverFlows(db, PROJECT, {});
  const flows = db.listFlows(PROJECT);
  assert.ok(flows.length > 0, 'flows stored');
  for (const f of flows) {
    assert.equal(typeof f.confidence, 'number', `confidence persisted for ${f.name}`);
    assert.ok(f.confidence >= 0 && f.confidence <= 1, 'confidence in 0..1');
    // Everything stored cleared the gate.
    assert.ok(f.confidence >= 0.35, `stored flow ${f.name} is above the quality threshold`);
  }
});

test('discovery prunes a stale auto-flow but spares a curated one', () => {
  freshDb();
  // Seed a stale auto-flow + a curated (manual) flow that the next discovery
  // run will NOT re-discover (their ids don't match any entry point).
  db.upsertFlowGraph(
    { id: 'flow_stale_auto', project: PROJECT, name: 'stale auto', source: 'auto', fingerprint: 'x' },
    [{ id: 'n1', label: 'n1' }], []
  );
  db.upsertFlowGraph(
    { id: 'flow_curated', project: PROJECT, name: 'curated', source: 'manual', fingerprint: 'y' },
    [{ id: 'm1', label: 'm1' }], []
  );

  const summary = fc.discoverFlows(db, PROJECT, {});
  assert.ok(summary.flowsPruned >= 1, 'at least one stale auto-flow pruned');

  const ids = new Set(db.listFlows(PROJECT).map(f => f.id));
  assert.equal(ids.has('flow_stale_auto'), false, 'stale auto-flow removed');
  assert.equal(ids.has('flow_curated'), true, 'curated flow preserved');
});

test('detectEntryPoints dedupes by module+name across double-indexed paths', () => {
  freshDb();
  const conn = db.raw();
  // Same logical symbol (api · registerRoutes) indexed under a SECOND path root
  // — the double-indexing the prompt calls out: different file roots produce
  // different fingerprints, so dedupe must key on inferModule(file)+name.
  const NOW2 = '2026-06-17T00:00:00Z';
  const dupFile = 'C:/dup/src/api/routes.ts';
  conn.prepare(
    `INSERT INTO code_symbols (file,project,lang,kind,name,line,indexed_at,content_hash) VALUES (?,?,?,?,?,?,?,?)`
  ).run(dupFile, PROJECT, 'ts', 'function', 'registerRoutes', 10, NOW2, null);
  conn.prepare(
    `INSERT INTO code_calls (caller_file,caller_name,callee_name,project,lang,line,indexed_at) VALUES (?,?,?,?,?,?,?)`
  ).run(dupFile, 'registerRoutes', 'get', PROJECT, 'ts', 11, NOW2);
  conn.prepare(
    `INSERT INTO code_imports (file,project,lang,target,raw,line,indexed_at) VALUES (?,?,?,?,?,?,?)`
  ).run(dupFile, PROJECT, 'ts', 'express', "import express from 'express'", 2, NOW2);

  const entries = fc.detectEntryPoints(db, PROJECT);
  const routes = entries.filter(e => e.name === 'registerRoutes' && e.reason === 'http-route');
  assert.equal(routes.length, 1, 'double-indexed route registration collapses to one entry');
});

test('detectEntryPoints only emits routes for files importing a router module', () => {
  freshDb();
  const conn = db.raw();
  const NOW2 = '2026-06-17T00:00:00Z';
  // A symbol that calls `.get(` but in a NON-web file (no express/router import)
  // — e.g. a Map/cache access. Must NOT be detected as an http-route entry.
  conn.prepare(
    `INSERT INTO code_symbols (file,project,lang,kind,name,line,indexed_at,content_hash) VALUES (?,?,?,?,?,?,?,?)`
  ).run('src/cache/store.ts', PROJECT, 'ts', 'function', 'readCache', 1, NOW2, null);
  conn.prepare(
    `INSERT INTO code_calls (caller_file,caller_name,callee_name,project,lang,line,indexed_at) VALUES (?,?,?,?,?,?,?)`
  ).run('src/cache/store.ts', 'readCache', 'get', PROJECT, 'ts', 2, NOW2);

  const entries = fc.detectEntryPoints(db, PROJECT);
  const bogus = entries.find(e => e.name === 'readCache' && e.reason === 'http-route');
  assert.equal(bogus, undefined, 'non-web .get() caller is not a route entry point');
});

test('discoverFlows preserves manual curation on re-discovery', () => {
  freshDb();
  fc.discoverFlows(db, PROJECT, {});
  const flows = db.listFlows(PROJECT);
  const target = flows[0];

  // Hand-annotate → source becomes 'manual'.
  const ok = db.updateFlowAnnotation(target.id, {
    name: 'Curated Flow Name',
    user_notes: 'human-written notes',
  });
  assert.equal(ok, true);

  // Re-run discovery — must NOT clobber the curated name/notes.
  fc.discoverFlows(db, PROJECT, {});
  const after = db.getFlow(target.id);
  assert.equal(after.flow.name, 'Curated Flow Name', 'curated name preserved');
  assert.equal(after.flow.user_notes, 'human-written notes', 'curated notes preserved');
  assert.equal(after.flow.source, 'manual', 'source stays manual');
  // But the auto graph is still refreshed (nodes present).
  assert.ok(after.nodes.length > 0, 'graph still populated after refresh');
});

// ── declared entry points (the RECALL FLOOR) ───────────────────────────────

test('addDeclaredEntry + listDeclaredEntries round-trips', () => {
  freshDb();
  const reg = db.addDeclaredEntry({ project: PROJECT, file: 'src/api/routes.ts', symbol: 'registerRoutes', name: 'API entry' });
  assert.equal(reg.created, true, 'first declaration is a create');
  assert.ok(reg.id, 'declared entry id returned');

  const rows = db.listDeclaredEntries(PROJECT);
  assert.equal(rows.length, 1, 'one declared entry listed');
  assert.equal(rows[0].file, 'src/api/routes.ts');
  assert.equal(rows[0].symbol, 'registerRoutes');
  assert.equal(rows[0].name, 'API entry');
  assert.equal(rows[0].project, PROJECT);
});

test('re-declaring the same file+symbol is idempotent (no duplicate row)', () => {
  freshDb();
  const r1 = db.addDeclaredEntry({ project: PROJECT, file: 'src/api/routes.ts', symbol: 'registerRoutes' });
  const r2 = db.addDeclaredEntry({ project: PROJECT, file: 'src/api/routes.ts', symbol: 'registerRoutes', name: 'renamed' });
  assert.equal(r1.created, true,  'first is a create');
  assert.equal(r2.created, false, 're-declare is an update, not an insert');
  assert.equal(r1.id, r2.id, 'same stable id for same project+file+symbol');

  const rows = db.listDeclaredEntries(PROJECT);
  assert.equal(rows.length, 1, 'still exactly one row after re-declaring');
  assert.equal(rows[0].name, 'renamed', 're-declare refreshes the optional name');
});

test('deleteDeclaredEntry removes a declared entry', () => {
  freshDb();
  const reg = db.addDeclaredEntry({ project: PROJECT, file: 'src/api/routes.ts', symbol: 'registerRoutes' });
  assert.equal(db.deleteDeclaredEntry(reg.id), true, 'delete reports success');
  assert.equal(db.listDeclaredEntries(PROJECT).length, 0, 'entry removed');
  assert.equal(db.deleteDeclaredEntry(reg.id), false, 'deleting a missing entry returns false');
});

test('discoverFlows auto-loads persisted declared entries and stores them as source=declared', () => {
  freshDb();
  // Persist a declaration, then run discovery with NO opts (exactly how nightly
  // calls it). The declared entry must be loaded from the DB and traced.
  db.addDeclaredEntry({ project: PROJECT, file: 'src/api/routes.ts', symbol: 'registerRoutes' });
  fc.discoverFlows(db, PROJECT, {});

  const flowId = fc.flowIdFor(PROJECT, { file: 'src/api/routes.ts', name: 'registerRoutes' });
  const full = db.getFlow(flowId);
  assert.ok(full, 'declared entry produced a flow');
  assert.equal(full.flow.source, 'declared', 'persisted declaration stored as source=declared');
  assert.ok(full.nodes.length > 0, 'declared flow traced a graph');
});

test('a declared flow is EXEMPT from the stale-auto prune (persistent recall floor)', () => {
  freshDb();
  // Seed a declared flow that the NEXT discovery run will not re-trace (its
  // entry point doesn't match any persisted declaration or auto entry). The
  // prune must spare it — declared flows are the recall floor.
  db.upsertFlowGraph(
    { id: 'flow_declared_orphan', project: PROJECT, name: 'declared orphan', source: 'declared', fingerprint: 'z' },
    [{ id: 'd1', label: 'd1' }], []
  );
  db.upsertFlowGraph(
    { id: 'flow_stale_auto2', project: PROJECT, name: 'stale auto 2', source: 'auto', fingerprint: 'w' },
    [{ id: 'a1', label: 'a1' }], []
  );

  fc.discoverFlows(db, PROJECT, {});
  const ids = new Set(db.listFlows(PROJECT).map(f => f.id));
  assert.equal(ids.has('flow_declared_orphan'), true,  'declared flow survives the prune');
  assert.equal(ids.has('flow_stale_auto2'),     false, 'stale auto flow still pruned');
});
