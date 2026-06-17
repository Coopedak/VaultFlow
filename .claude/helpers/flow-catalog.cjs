'use strict';

/**
 * flow-catalog.cjs — discover and catalog FLOWS: end-to-end process paths
 * ("full circles") through a project, traced from entry points over the
 * (approximate) call graph.
 *
 * WHY: a project is a set of flows, not a flat list of files. The brain already
 * indexes symbols, imports, and calls; this layer walks that graph from real
 * entry points (HTTP routes, CLI commands) to produce named, persisted flows
 * the dashboard and agent can reason over.
 *
 * APPROXIMATE BY DESIGN — call resolution is bare-name only (code_calls stores
 * the tail identifier), entry-point detection is high-confidence-only and
 * therefore PARTIAL. Every flow carries `truncated` and per-node `ambiguous`
 * flags. Never present these as ground truth; present them as a starting map.
 *
 * Consumers pass an initialized db handle (require('./db.cjs')) so this module
 * stays a pure engine with no singleton state of its own.
 */

const { createHash } = require('node:crypto');
const cg = require('./code-graph.cjs');

// Express/Koa/router-style HTTP verb call-sites. A symbol that calls one of
// these (in TS/JS) is registering a route → treat the SYMBOL as an entry point.
const HTTP_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'use', 'route', 'all', 'options', 'head']);

// Express/Koa/router-style import targets. A file only qualifies for HTTP-route
// entry-point detection if it actually imports one of these — otherwise a bare
// `.get(`/`.post(` call is far more likely a Map/cache/DOM/SQL access than a
// real route registration. Substring match (case-insensitive) against the
// import target, so 'express', '@hapi/router', 'koa-router', 'fastify' all hit.
const ROUTER_IMPORT_HINTS = ['express', 'router', 'fastify', 'koa', 'hapi', 'restify', 'polka'];

function fileImportsRouter(conn, file, project) {
  const rows = conn.prepare(
    `SELECT target FROM code_imports WHERE file = ? ${project ? 'AND project = ?' : ''}`
  ).all(...(project ? [file, project] : [file]));
  for (const r of rows) {
    const t = String(r.target || '').toLowerCase();
    if (ROUTER_IMPORT_HINTS.some(h => t.includes(h))) return true;
  }
  return false;
}

/**
 * Detect high-confidence entry points for a project. Conservative on purpose:
 * better to surface a few real entries than many false ones. Coverage is
 * PARTIAL by design — decorator-based routes, dynamic dispatch, and framework
 * magic are intentionally not chased here.
 *
 * Precision over recall (v1): HTTP-route detection now requires the file to
 * actually import an express/router-style module, and entry points are deduped
 * by (inferModule(file) + name) so double-indexed source paths (different path
 * roots → different fingerprints) don't create twin flows.
 *
 * @param {object} db   initialized db handle
 * @param {string} project
 * @param {Array}  [declared]  explicit user-declared entries [{file,name,kind?,reason?}]
 * @returns {Array<{file,name,kind,reason}>}
 */
function detectEntryPoints(db, project, declared = []) {
  db.initialize(null, null);
  const conn = db.raw();
  // Dedupe by (module + name), NOT raw file path: a file indexed under both
  // C:\GIT\proj\x.ts and proj/x.ts is the same symbol → one entry point.
  const seen = new Set();
  const out = [];

  function push(file, name, kind, reason) {
    if (!file || !name) return;
    const key = `${cg.inferModule(file, project)}::${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file, name, kind: kind || 'function', reason });
  }

  // (c) User-declared entry points win first — they're ground truth.
  for (const d of declared || []) {
    if (d && d.file && d.name) push(d.file, d.name, d.kind, d.reason || 'declared');
  }

  // (a) HTTP routes: a caller symbol that invokes a router verb (app.get(...),
  // router.post(...)). callee_name is the bare verb tail. Scope to TS/JS only,
  // and ONLY for files that import an express/router-style module — a bare
  // `.get(`/`.post(` call site in a non-web file is noise, not a route.
  const verbPlaceholders = [...HTTP_VERBS].map(() => '?').join(',');
  const routeRows = conn.prepare(`
    SELECT DISTINCT caller_file, caller_name, lang
      FROM code_calls
     WHERE callee_name IN (${verbPlaceholders})
       AND project = ?
       AND lang = 'ts'
     ORDER BY caller_file, caller_name
  `).all(...HTTP_VERBS, project);
  const routerFileCache = new Map();
  for (const r of routeRows) {
    if (!routerFileCache.has(r.caller_file)) {
      routerFileCache.set(r.caller_file, fileImportsRouter(conn, r.caller_file, project));
    }
    if (!routerFileCache.get(r.caller_file)) continue; // not a web file — skip
    // Confirm the caller is a real defined symbol (not a stray match).
    const sym = conn.prepare(
      `SELECT kind FROM code_symbols WHERE file = ? AND name = ? AND project = ? LIMIT 1`
    ).get(r.caller_file, r.caller_name, project);
    push(r.caller_file, r.caller_name, sym ? sym.kind : 'function', 'http-route');
  }

  // (b) CLI commands: exported functions/symbols whose file lives under a
  // scripts/ or cli directory. Best-effort — these are the headless entry
  // points (vaultflow's own cli-query lives in scripts/). HIGH-confidence
  // source: precision-friendly because such files are deliberate entry points.
  const cliRows = conn.prepare(`
    SELECT file, name, kind FROM code_symbols
     WHERE project = ?
       AND kind IN ('function','method')
       AND (
         file LIKE '%/scripts/%' OR file LIKE '%\\scripts\\%'
         OR file LIKE '%cli%' OR file LIKE '%cli.mjs' OR file LIKE '%cli.cjs'
       )
     ORDER BY file, line
  `).all(project);
  for (const r of cliRows) push(r.file, r.name, r.kind, 'cli-command');

  return out;
}

/**
 * Stable fingerprint for a traced flow: sha1 over its sorted node ids. Two
 * traces of the same shape (same node set) collapse to one flow → dedupe.
 */
function fingerprintNodes(nodes) {
  const ids = nodes.map(n => n.id).sort();
  return createHash('sha1').update(ids.join('\n')).digest('hex');
}

/** Deterministic flow id derived from the entry point (stable across re-runs). */
function flowIdFor(project, entry) {
  const raw = `${project || ''}::${entry.file}::${entry.name}`;
  return 'flow_' + createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

/**
 * Quality score for a traced flow: the fraction of its nodes that RESOLVE to a
 * real, unambiguous project symbol (non-terminal AND non-ambiguous). Terminal
 * leaves (external/stdlib/unindexed exits) and ambiguous picks (bare-name
 * collisions resolved by guess) both subtract from confidence.
 *
 * A single-node flow (entry only, no real callees) scores 1.0 by definition —
 * but the discover loop already drops those before scoring, so in practice the
 * score reflects how much of a real multi-node flow is grounded in the index.
 *
 * @returns {number} 0..1
 */
function flowQuality(nodes) {
  if (!nodes.length) return 0;
  const resolved = nodes.filter(n => !n.terminal && !n.ambiguous).length;
  return resolved / nodes.length;
}

/**
 * Discover flows for a project: for each entry point, trace callees into a
 * bounded graph, name it, and persist it (preserving any manual curation).
 * Dedupes by fingerprint so two entry points that resolve to the same shape
 * don't create duplicate flows.
 *
 * @param {object} db
 * @param {string} project
 * @param {object} [opts]  { declared=[], depth, maxNodes, minQuality }
 * @returns {{project, entryPoints, flowsCreated, flowsUpdated, flowsSkippedDup, flowsSkippedLowQuality, flowsPruned, truncatedCount, minQuality, approximate, flows}}
 */
function discoverFlows(db, project, opts = {}) {
  db.initialize(null, null);
  // RECALL FLOOR: merge persisted user-declared entries (the dashboard/CLI write
  // them via db.addDeclaredEntry) with any caller-supplied declarations. Loading
  // them from the DB here — not from opts — is what makes them re-traced on every
  // nightly run (nightly calls discoverFlows(db, proj, {}) with no opts). The DB
  // stores {file, symbol}; detectEntryPoints expects {file, name}.
  const persistedDeclared = (db.listDeclaredEntries ? db.listDeclaredEntries(project) : [])
    .map(d => ({ file: d.file, name: d.symbol, reason: 'declared' }));
  const declared = [...persistedDeclared, ...(opts.declared || [])]
    .map(d => ({ ...d, reason: 'declared' }));
  const depth = Number.isFinite(opts.depth) ? opts.depth : 4;
  const maxNodes = Number.isFinite(opts.maxNodes) ? opts.maxNodes : 150;
  // Quality threshold: a flow whose RESOLVED-node fraction is below this is
  // garbage (apiErr-style mega-flows are dominated by terminal SQL/keyword
  // leaves) and never reaches the catalog. 0.35 keeps plausible flows while
  // dropping the noise observed on real repos.
  const minQuality = Number.isFinite(opts.minQuality) ? opts.minQuality : 0.35;

  const entries = detectEntryPoints(db, project, declared);

  let flowsCreated = 0;
  let flowsUpdated = 0;
  let flowsSkippedDup = 0;
  let flowsSkippedLowQuality = 0;
  let truncatedCount = 0;
  const fingerprints = new Set();
  const storedIds = new Set(); // flow ids written this run — survivors of the gate
  const flows = [];

  for (const entry of entries) {
    // A user-declared entry is the RECALL FLOOR — it is ground truth. It bypasses
    // the lone-node skip, the quality gate, and fingerprint dedup so a user's
    // explicit declaration is NEVER silently dropped (it may render as a single
    // low-confidence node if the trace resolves to little — that's surfaced, not
    // hidden). Its flow is stored with source='declared' and is prune-exempt.
    const isDeclared = entry.reason === 'declared';

    const graph = cg.walkTransitive(db, { file: entry.file, name: entry.name }, {
      direction: 'callees',
      depth,
      maxNodes,
      project,
    });

    // A lone entry node with no edges is noise — skip (nothing to trace).
    // EXCEPT a declared entry: surface it anyway (flagged low confidence).
    if (graph.nodes.length <= 1 && graph.edges.length === 0 && !isDeclared) continue;

    // QUALITY GATE — drop garbage AUTO flows before they reach the catalog. Two
    // ways a candidate fails: (1) too few of its nodes resolve to real symbols
    // (mostly terminal/ambiguous noise), or (2) it hit the node cap AND is
    // dominated by unresolved nodes — the apiErr mega-flow signature, where a
    // tiny helper absorbs an entire monolith's worth of SQL/keyword leaves.
    // Declared entries are EXEMPT — the user asked for them explicitly.
    const quality = flowQuality(graph.nodes);
    const cappedAndNoisy = graph.nodes.length >= maxNodes && quality < 0.5;
    if (!isDeclared && (quality < minQuality || cappedAndNoisy)) { flowsSkippedLowQuality++; continue; }

    const fp = fingerprintNodes(graph.nodes);
    // Declared entries bypass dedup so the explicit declaration always
    // materializes as its own catalog row (its id is stable per entry).
    if (!isDeclared) {
      if (fingerprints.has(fp)) { flowsSkippedDup++; continue; }
      fingerprints.add(fp);
    }

    const id = flowIdFor(project, entry);
    const moduleLabel = cg.inferModule(entry.file, project);
    const name = `${moduleLabel ? moduleLabel + ' · ' : ''}${entry.name}`;
    const confidence = Math.round(quality * 100) / 100; // 2-dp 0..1
    const lowConfidence = isDeclared && (quality < minQuality || (graph.nodes.length <= 1 && graph.edges.length === 0));

    const flow = {
      id,
      project,
      name,
      description: isDeclared
        ? `User-declared flow from entry point ${entry.name} (${graph.nodes.length} nodes, confidence ${confidence}, approximate).${lowConfidence ? ' Low confidence — the trace resolved to little; the declaration is preserved as the recall floor.' : ''}`
        : `Auto-traced flow from ${entry.reason} entry point ${entry.name} (${graph.nodes.length} nodes, confidence ${confidence}, approximate).`,
      entry_point: `${entry.file}::${entry.name}`,
      source: isDeclared ? 'declared' : 'auto',
      status: 'active',
      fingerprint: fp,
      truncated: graph.truncated ? 1 : 0,
      confidence,
    };

    const res = db.upsertFlowGraph(flow, graph.nodes, graph.edges);
    storedIds.add(id);
    if (res.created) flowsCreated++; else flowsUpdated++;
    if (graph.truncated) truncatedCount++;
    flows.push({ id, name, entry_point: flow.entry_point, source: flow.source, nodes: graph.nodes.length, confidence, lowConfidence: !!lowConfidence, truncated: graph.truncated, preservedCuration: res.preservedCuration });
  }

  // PRUNE stale auto-flows: any source='auto' flow for this project that was NOT
  // re-discovered this run (e.g. a garbage mega-flow the gate now rejects, or a
  // flow whose entry point disappeared) is removed so the catalog reflects only
  // the current best map. Curated (source='manual') AND user-declared
  // (source='declared') flows are NEVER pruned — declared flows are the recall
  // floor and persist across runs even if their trace is currently low-quality.
  let flowsPruned = 0;
  for (const existing of db.listFlows(project)) {
    if (existing.source === 'manual' || existing.source === 'declared') continue;
    if (storedIds.has(existing.id)) continue;
    if (db.deleteFlow(existing.id)) flowsPruned++;
  }

  return {
    project,
    entryPoints: entries.length,
    flowsCreated,
    flowsUpdated,
    flowsSkippedDup,
    flowsSkippedLowQuality,
    flowsPruned,
    truncatedCount,
    minQuality,
    approximate: true, // bare-name call resolution — confidence is partial
    flows,
  };
}

module.exports = {
  detectEntryPoints,
  discoverFlows,
  fingerprintNodes,
  flowIdFor,
  flowQuality,
  HTTP_VERBS,
};
