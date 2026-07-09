'use strict';

/**
 * flow-impact.cjs — IMPACT ENGINE: "if I change X, what could break, and where
 * could a symptom's root cause originate?"
 *
 * WHY: the brain already knows symbols, imports, calls, and (via flow-catalog)
 * the named end-to-end flows of a project. This layer fuses them into one
 * change-impact report: the DOWNSTREAM consumers a change could break, the
 * UPSTREAM dependencies a root cause could come from, and — the payoff — which
 * cataloged FLOWS the change reaches, classified by HOW it reaches them.
 *
 * APPROXIMATE BY DESIGN. Everything here rides the same bare-name call graph as
 * flow-catalog: code_calls stores the tail identifier of a call, blast-radius is
 * import-string based, and flow membership is whatever the (partial) trace
 * captured. Auto-derived links are a starting map, never ground truth. The
 * HUMAN-curated couplings (flows.user_notes) are the authoritative signal —
 * they can describe DB/event/queue handoffs the call graph physically cannot
 * see — so we surface them prominently and trust them over the auto graph.
 *
 * Pure engine: callers pass an initialized db handle (require('./db.cjs')).
 */

const cg = require('./code-graph.cjs');

const DISCLAIMER =
  'APPROXIMATE — derived from a bare-name call graph + import strings. ' +
  'Curated flows and user_notes are more trustworthy than auto-traced links.';

// How far to walk the upstream dependency chain for root-cause direction.
// Shallow on purpose: the immediate dependencies are where a root cause most
// often lives, and a deep walk dilutes the signal with the whole tree.
const UPSTREAM_DEPTH = 2;
const UPSTREAM_MAX_NODES = 40;
const RECENT_COMMIT_LIMIT = 15;

/** basename without extension, lower-cased — for fuzzy commit correlation. */
function baseStem(file) {
  const norm = String(file || '').replace(/\\/g, '/');
  const base = norm.split('/').pop() || '';
  return base.replace(/\.[^.]+$/, '').toLowerCase();
}

/**
 * Resolve a change target to a {file, symbol, project}. The caller may pass a
 * file path, a symbol name, or both. When only a symbol is given we look it up
 * in code_symbols to recover its file; when only a file is given we leave the
 * symbol null (file-level impact). project is auto-scoped from the symbol/file
 * row when the caller didn't supply it.
 *
 * @returns {{file:?string, symbol:?string, project:?string, kind:?string, resolved:boolean, candidates:Array}}
 */
function resolveTarget(db, { file, symbol, project } = {}) {
  const conn = db.raw();
  let outFile = file || null;
  let outSymbol = symbol || null;
  let outProject = project || null;
  let kind = null;
  const candidates = [];

  // Symbol given (with or without a file): find its definition(s).
  if (outSymbol) {
    const where = [];
    const params = [outSymbol];
    where.push('name = ?');
    if (outFile) {
      const wsep = outFile.replace(/\//g, '\\');
      const fsep = outFile.replace(/\\/g, '/');
      where.push('(file = ? OR file = ?)');
      params.push(wsep, fsep);
    }
    if (outProject) { where.push('project = ?'); params.push(outProject); }
    const rows = conn.prepare(
      `SELECT file, project, kind, line FROM code_symbols WHERE ${where.join(' AND ')} ORDER BY file, line`
    ).all(...params);
    for (const r of rows) candidates.push(r);
    if (rows.length) {
      // Prefer the first deterministic match; record file/project/kind from it.
      outFile = outFile || rows[0].file;
      outProject = outProject || rows[0].project || null;
      kind = rows[0].kind;
    }
  }

  // Only a file given: scope the project from any symbol in that file.
  if (!outSymbol && outFile && !outProject) {
    const wsep = outFile.replace(/\//g, '\\');
    const fsep = outFile.replace(/\\/g, '/');
    const row = conn.prepare(
      'SELECT project FROM code_symbols WHERE (file = ? OR file = ?) AND project IS NOT NULL LIMIT 1'
    ).get(wsep, fsep);
    if (row && row.project) outProject = row.project;
  }

  const resolved = !!(outFile || (outSymbol && candidates.length));
  return { file: outFile, symbol: outSymbol, project: outProject, kind, resolved, candidates };
}

/**
 * DOWNSTREAM consumers: what a change to the target could break.
 *   - file importers (getBlastRadius) — files that import the changed file
 *   - symbol callsites (getCallers)    — functions that call the changed symbol
 * Returns both lists plus a flat set of "consumer node ids" used for flow
 * classification (each callsite is a (caller_file::caller_name) flow node id).
 */
function computeDownstream(db, target) {
  const importers = target.file ? cg.getBlastRadius(db, target.file, target.project) : [];
  const callsites = target.symbol ? cg.getCallers(db, target.symbol, target.project) : [];

  // A callsite is a flow node identified by its own (file, name). The changed
  // symbol's own node id is also a "directly in the flow" marker.
  const consumerNodeIds = new Set();
  if (target.file && target.symbol) consumerNodeIds.add(`${target.file}::${target.symbol}`);
  for (const c of callsites) consumerNodeIds.add(`${c.caller_file}::${c.caller_name}`);

  return { importers, callsites, consumerNodeIds };
}

/**
 * UPSTREAM dependencies: where a root cause could originate.
 *   - imports declared by the changed file (getImports)
 *   - transitive callees of the changed symbol (walkTransitive, shallow)
 * Returns import targets, the callee graph, and a set of upstream file stems
 * (basenames) used to correlate recent commits.
 */
function computeUpstream(db, target) {
  const imports = target.file ? cg.getImports(db, target.file, target.project) : [];

  let calleeGraph = { nodes: [], edges: [], truncated: false };
  if (target.file && target.symbol) {
    calleeGraph = cg.walkTransitive(db, { file: target.file, name: target.symbol }, {
      direction: 'callees',
      depth: UPSTREAM_DEPTH,
      maxNodes: UPSTREAM_MAX_NODES,
      project: target.project,
    });
  }

  // File stems an upstream change could live in — the changed file's own deps
  // (resolved callee nodes' files) + the import targets. Used to fuzzy-match
  // recent commit subjects/bodies (we have no per-file commit data).
  const upstreamStems = new Set();
  for (const n of calleeGraph.nodes) {
    if (n.file && !n.terminal) upstreamStems.add(baseStem(n.file));
  }
  for (const i of imports) {
    const stem = baseStem(i.target);
    if (stem && stem.length >= 3) upstreamStems.add(stem);
  }
  // Always include the changed file's own stem — a recent edit to the file
  // itself is the most obvious root-cause candidate.
  if (target.file) upstreamStems.add(baseStem(target.file));

  return { imports, calleeGraph, upstreamStems };
}

/**
 * FLOW IMPACT: for every cataloged flow in the project, classify how the change
 * reaches it.
 *   'affected'           — the changed node is directly a node in the flow.
 *   'affected (handoff)' — a downstream consumer of the change is in the flow
 *                          (the change propagates into the flow via a callsite).
 *   'verify'             — the flow shares a file with the change but has no
 *                          direct node/consumer link → can't prove it's safe.
 * Flows with no link at all are not listed; we return notAffected as a count.
 *
 * Each affected flow carries confidence + user_notes (curated couplings) so the
 * caller can surface the AUTHORITATIVE human context prominently.
 *
 * @returns {{affected:Array, notAffected:number, total:number}}
 */
function classifyFlows(db, target, consumerNodeIds) {
  const conn = db.raw();
  const flows = db.listFlows(target.project || null);

  // Files the change touches — the changed file + every consumer's file. A flow
  // node sharing one of these files (but not a direct node/consumer) is 'verify'.
  const touchedFiles = new Set();
  if (target.file) {
    touchedFiles.add(target.file.replace(/\\/g, '/'));
  }
  for (const id of consumerNodeIds) {
    const f = id.split('::')[0];
    if (f) touchedFiles.add(f.replace(/\\/g, '/'));
  }

  const changedNodeId = (target.file && target.symbol) ? `${target.file}::${target.symbol}` : null;

  const affected = [];
  let notAffected = 0;

  for (const flow of flows) {
    const nodes = conn.prepare(
      'SELECT node_id, label, file FROM flow_nodes WHERE flow_id = ?'
    ).all(flow.id);

    let direct = false;   // changed node IS a flow node
    let handoff = false;  // a downstream consumer is a flow node
    let verify = false;   // shares a file but no direct/consumer link
    const links = [];

    for (const n of nodes) {
      if (changedNodeId && n.node_id === changedNodeId) {
        direct = true;
        links.push({ node: n.label, via: 'changed-node', node_id: n.node_id });
        continue;
      }
      if (consumerNodeIds.has(n.node_id)) {
        handoff = true;
        links.push({ node: n.label, via: 'downstream-consumer', node_id: n.node_id });
        continue;
      }
      const nf = String(n.file || '').replace(/\\/g, '/');
      if (nf && touchedFiles.has(nf)) {
        verify = true;
        links.push({ node: n.label, via: 'shared-file', node_id: n.node_id });
      }
    }

    let classification = null;
    if (direct) classification = 'affected';
    else if (handoff) classification = 'affected (handoff)';
    else if (verify) classification = 'verify';

    if (!classification) { notAffected++; continue; }

    affected.push({
      id: flow.id,
      name: flow.name,
      entry_point: flow.entry_point,
      source: flow.source,
      status: flow.status,
      confidence: flow.confidence,
      truncated: !!flow.truncated,
      // user_notes are the AUTHORITATIVE human-provided couplings — surface them.
      user_notes: flow.user_notes || null,
      classification,
      links: links.slice(0, 12),
    });
  }

  // Order: affected first, then handoff, then verify; curated flows bubble up
  // within a class (manual before auto) since their user_notes matter most.
  const rank = { 'affected': 0, 'affected (handoff)': 1, 'verify': 2 };
  affected.sort((a, b) =>
    (rank[a.classification] - rank[b.classification]) ||
    ((a.source === 'manual' ? 0 : 1) - (b.source === 'manual' ? 0 : 1)) ||
    String(a.name).localeCompare(String(b.name))
  );

  return { affected, notAffected, total: flows.length };
}

/**
 * ROOT-CAUSE DIRECTION: given the change/symptom location, list the UPSTREAM
 * dependencies (likely cause origins) and correlate them with RECENT COMMITS.
 *
 * We have no per-file commit data (git_commits stores subject/body only), so
 * correlation is text-based: a recent commit whose subject/body mentions an
 * upstream file stem is flagged as a candidate ("the cause may be upstream in
 * X, recently changed in commit abc"). All recent commits are also returned so
 * the caller can show the recent-change window even without a stem hit.
 *
 * @returns {{upstreamFiles:Array, recentCommits:Array, correlated:Array}}
 */
function rootCauseDirection(db, target, upstream) {
  const conn = db.raw();

  // Distinct upstream files (resolved callee files), most-relevant first.
  const upstreamFiles = [];
  const seenFiles = new Set();
  for (const n of upstream.calleeGraph.nodes) {
    if (n.terminal || !n.file) continue;
    const key = n.file.replace(/\\/g, '/');
    if (seenFiles.has(key)) continue;
    seenFiles.add(key);
    upstreamFiles.push({ file: n.file, symbol: n.label, ambiguous: !!n.ambiguous });
  }

  // Recent commits for this project (grounded query: git_commits by project).
  let recentCommits = [];
  if (target.project) {
    recentCommits = conn.prepare(`
      SELECT sha, project, author, committed_at, subject, substr(body, 1, 300) AS body_preview
        FROM git_commits
       WHERE project = ?
       ORDER BY committed_at DESC
       LIMIT ?
    `).all(target.project, RECENT_COMMIT_LIMIT);
  }

  // Correlate: a commit whose subject/body mentions an upstream stem is a
  // root-cause candidate. Match against the upstream stems set.
  const stems = [...upstream.upstreamStems].filter(s => s && s.length >= 3);
  const correlated = [];
  for (const c of recentCommits) {
    const hay = `${c.subject || ''} ${c.body_preview || ''}`.toLowerCase();
    const hits = stems.filter(s => hay.includes(s));
    if (hits.length) {
      correlated.push({
        sha: c.sha,
        committed_at: c.committed_at,
        subject: c.subject,
        matched: hits.slice(0, 6),
      });
    }
  }

  return { upstreamFiles, recentCommits, correlated };
}

/**
 * Analyze the impact of changing a file and/or symbol.
 *
 * @param {object} db   initialized db handle (require('./db.cjs'))
 * @param {object} opts { file?, symbol?, project?, mode? }
 *   mode==='debug' emphasizes the root-cause section; it's always included.
 * @returns {object} structured, APPROXIMATE impact report.
 */
function analyzeImpact(db, opts = {}) {
  db.initialize(null, null);

  const target = resolveTarget(db, opts);
  if (!target.resolved) {
    return {
      ok: false,
      approximate: true,
      disclaimer: DISCLAIMER,
      error: `Could not resolve "${opts.symbol || opts.file || '(nothing)'}" to an indexed file or symbol. ` +
             'Index it (edit it once or run the nightly code-graph step) and retry.',
      target: { file: opts.file || null, symbol: opts.symbol || null, project: opts.project || null },
    };
  }

  const downstream = computeDownstream(db, target);
  const upstream = computeUpstream(db, target);
  const flowImpact = classifyFlows(db, target, downstream.consumerNodeIds);
  const rootCause = rootCauseDirection(db, target, upstream);

  return {
    ok: true,
    approximate: true,
    disclaimer: DISCLAIMER,
    mode: opts.mode === 'debug' ? 'debug' : 'impact',
    target: {
      file: target.file,
      symbol: target.symbol,
      project: target.project,
      kind: target.kind,
      ambiguousTarget: target.candidates.length > 1,
      candidates: target.candidates.map(c => ({ file: c.file, kind: c.kind })),
    },
    downstream: {
      note: 'Consumers a change to the target could break (importers + callsites). ' + DISCLAIMER,
      importers: downstream.importers.map(d => ({ file: d.file, line: d.line, target: d.target })),
      callsites: downstream.callsites.map(c => ({ file: c.caller_file, symbol: c.caller_name, line: c.line })),
      importerCount: downstream.importers.length,
      callsiteCount: downstream.callsites.length,
    },
    upstream: {
      note: 'Dependencies the target relies on — where a root cause could originate. ' + DISCLAIMER,
      imports: upstream.imports.map(i => ({ target: i.target, line: i.line })),
      callees: upstream.calleeGraph.nodes
        .filter(n => n.id !== `${target.file}::${target.symbol}`)
        .map(n => ({ symbol: n.label, file: n.file, terminal: !!n.terminal, ambiguous: !!n.ambiguous })),
      truncated: !!upstream.calleeGraph.truncated,
    },
    flowImpact: {
      note: 'Cataloged flows the change reaches. user_notes are HUMAN-CURATED and AUTHORITATIVE — ' +
            'they may reveal DB/event/queue handoffs the call graph cannot see. ' + DISCLAIMER,
      affected: flowImpact.affected,
      affectedCount: flowImpact.affected.length,
      notAffected: flowImpact.notAffected,
      totalFlows: flowImpact.total,
    },
    rootCause: {
      note: 'Root-cause DIRECTION for a symptom at the target: look UPSTREAM. ' +
            'Commit correlation is text-based (no per-file commit data) — treat as a lead, not proof. ' + DISCLAIMER,
      upstreamFiles: rootCause.upstreamFiles,
      correlatedCommits: rootCause.correlated,
      recentCommits: rootCause.recentCommits.map(c => ({
        sha: c.sha, committed_at: c.committed_at, subject: c.subject,
      })),
    },
  };
}

/**
 * Render an analyzeImpact() result as a readable text report (CLI / MCP).
 * @param {object} rep  the analyzeImpact return value
 * @returns {string}
 */
function renderImpact(rep) {
  if (!rep || rep.ok === false) {
    return rep && rep.error ? `Impact: ${rep.error}` : 'Impact: nothing to report.';
  }
  const t = rep.target;
  const conf = (c) => (c == null ? '?' : `${Math.round(c * 100)}%`);
  const lines = [];

  lines.push(`Impact report for ${t.symbol ? `${t.symbol} ` : ''}${t.file || ''}${t.project ? `  [${t.project}]` : ''}`);
  lines.push(`(${rep.disclaimer})`);
  if (t.ambiguousTarget) {
    lines.push(`! target name is ambiguous — ${t.candidates.length} definitions; using ${t.file}`);
  }

  // DOWNSTREAM
  lines.push('');
  lines.push(`DOWNSTREAM — could break (${rep.downstream.importerCount} importers, ${rep.downstream.callsiteCount} callsites):`);
  for (const d of rep.downstream.importers.slice(0, 15)) lines.push(`  import  ${d.file}:${d.line} → "${d.target}"`);
  for (const c of rep.downstream.callsites.slice(0, 15)) lines.push(`  call    ${c.file}:${c.line} — in ${c.symbol}`);
  if (rep.downstream.importerCount + rep.downstream.callsiteCount === 0) lines.push('  (none found / unindexed)');

  // FLOW IMPACT
  lines.push('');
  lines.push(`FLOW IMPACT — ${rep.flowImpact.affectedCount} of ${rep.flowImpact.totalFlows} flows reached (${rep.flowImpact.notAffected} not affected):`);
  for (const f of rep.flowImpact.affected) {
    lines.push(`  [${f.classification}] ${f.name}  (${f.source}, conf ${conf(f.confidence)}${f.truncated ? ', truncated' : ''})`);
    if (f.user_notes) lines.push(`      ↳ user_notes (AUTHORITATIVE): ${String(f.user_notes).slice(0, 240)}`);
  }
  if (rep.flowImpact.affectedCount === 0) lines.push('  (no cataloged flow reached — run `vaultflow flows discover` if the catalog is empty)');

  // UPSTREAM / ROOT CAUSE
  lines.push('');
  lines.push(`ROOT-CAUSE DIRECTION — look upstream${rep.upstream.truncated ? ' (trace truncated)' : ''}:`);
  for (const u of rep.rootCause.upstreamFiles.slice(0, 12)) {
    lines.push(`  upstream  ${u.symbol} — ${u.file}${u.ambiguous ? '  (ambiguous)' : ''}`);
  }
  if (!rep.rootCause.upstreamFiles.length) lines.push('  (no resolved upstream dependencies)');
  if (rep.rootCause.correlatedCommits.length) {
    lines.push('  recent commits touching upstream (text-correlated — a lead, not proof):');
    for (const c of rep.rootCause.correlatedCommits.slice(0, 8)) {
      lines.push(`    ${String(c.sha).slice(0, 7)}  ${c.committed_at ? c.committed_at.slice(0, 10) + '  ' : ''}${c.subject}  {match: ${c.matched.join(', ')}}`);
    }
  } else if (rep.rootCause.recentCommits.length) {
    lines.push('  no upstream-correlated commit; most recent project commits:');
    for (const c of rep.rootCause.recentCommits.slice(0, 5)) {
      lines.push(`    ${String(c.sha).slice(0, 7)}  ${c.committed_at ? c.committed_at.slice(0, 10) + '  ' : ''}${c.subject}`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  analyzeImpact,
  renderImpact,
  resolveTarget,
  classifyFlows,
  DISCLAIMER,
};
