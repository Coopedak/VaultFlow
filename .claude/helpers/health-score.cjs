'use strict';

/**
 * health-score.cjs — deterministic per-project code-health score (A–F).
 *
 * WHY this module exists: CodeFlow's dashboard health dial needs a stable,
 * reproducible score it can display without running any external scanner.
 * All inputs come from tables that code-graph.cjs already populates
 * (code_symbols, code_imports, code_calls), so no new indexing is required.
 *
 * Formula: start at 100, subtract five penalty terms, clamp 0..100, round.
 * Grades: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, else F.
 *
 * The module exports three things kept intentionally separate so each is
 * unit-testable without a DB:
 *   countCycles(edges)     — Tarjan SCC on import edges → integer
 *   scoreFromStats(stats)  — formula only, no I/O
 *   computeHealthScore(db, project) — gathers stats from DB, returns result
 */

const { getImportGraph } = require('./code-graph.cjs');

// ── Tarjan SCC ────────────────────────────────────────────────────────────────

/**
 * Count the number of strongly-connected components (SCCs) of size > 1 in a
 * directed graph described by `edges`. Each SCC of size > 1 is a circular
 * dependency cycle.
 *
 * WHY Tarjan: it runs in O(V+E) — one DFS pass — and produces exact SCC counts
 * rather than just a boolean. We count SCCs ≥ 2 nodes, not individual back-edges,
 * which matches the intuition "how many independent circular clusters exist?"
 *
 * @param {Array<{source: string, target: string}>} edges
 * @returns {number}
 */
function countCycles(edges) {
  // Build adjacency list from edges (nodes may appear only as source or target).
  const adj = new Map(); // node → Set of neighbors
  for (const { source, target } of edges) {
    if (source === target) continue; // self-loops are not meaningful circular deps
    if (!adj.has(source)) adj.set(source, new Set());
    if (!adj.has(target)) adj.set(target, new Set());
    adj.get(source).add(target);
  }

  const nodes = [...adj.keys()];
  const index   = new Map(); // node → discovery index
  const lowLink = new Map(); // node → low-link value
  const onStack = new Map(); // node → boolean
  const stack   = [];
  let   counter = 0;
  let   sccCount = 0;

  // Iterative Tarjan — avoids stack-overflow on large graphs.
  // Each frame carries { node, iterState, neighborIter } so we can resume
  // after a recursive step without actual recursion.
  function strongConnect(startNode) {
    const callStack = [{ node: startNode, phase: 'enter', neighbors: null, ni: 0 }];

    while (callStack.length) {
      const frame = callStack[callStack.length - 1];
      const { node } = frame;

      if (frame.phase === 'enter') {
        index.set(node, counter);
        lowLink.set(node, counter);
        counter++;
        stack.push(node);
        onStack.set(node, true);
        frame.neighbors = [...(adj.get(node) || [])];
        frame.phase = 'visit';
        frame.ni = 0;
      }

      if (frame.phase === 'visit') {
        // Process neighbors one at a time; each time we resume this frame ni
        // has been incremented by the completed child.
        let pushed = false;
        while (frame.ni < frame.neighbors.length) {
          const w = frame.neighbors[frame.ni];
          frame.ni++;
          if (!index.has(w)) {
            // Tree edge — recurse.
            callStack.push({ node: w, phase: 'enter', neighbors: null, ni: 0, parent: node });
            pushed = true;
            break;
          } else if (onStack.get(w)) {
            // Back edge — w is on the stack, update low-link.
            lowLink.set(node, Math.min(lowLink.get(node), index.get(w)));
          }
        }
        if (pushed) continue; // process child before finishing this frame
        frame.phase = 'finish';
      }

      if (frame.phase === 'finish') {
        // Propagate low-link to parent.
        const { parent } = frame;
        if (parent !== undefined) {
          lowLink.set(parent, Math.min(lowLink.get(parent), lowLink.get(node)));
        }

        // If node is an SCC root, pop the SCC.
        if (lowLink.get(node) === index.get(node)) {
          let sccSize = 0;
          while (true) {
            const w = stack.pop();
            onStack.set(w, false);
            sccSize++;
            if (w === node) break;
          }
          // Only count SCCs that represent a real cycle (≥ 2 files).
          if (sccSize > 1) sccCount++;
        }
        callStack.pop();
      }
    }
  }

  for (const node of nodes) {
    if (!index.has(node)) strongConnect(node);
  }

  return sccCount;
}

// ── score formula ─────────────────────────────────────────────────────────────

/**
 * Compute a code-health score from pre-gathered statistics.
 *
 * Kept pure (no I/O) so it is trivially unit-testable and the endpoint can
 * call computeHealthScore() which handles DB access separately.
 *
 * @param {{
 *   functions: number,
 *   dead: number,
 *   deadUnavailable: boolean,
 *   circular: number,
 *   godObjects: number,
 *   connections: number,
 *   files: number
 * }} stats
 *
 * @returns {{
 *   score: number,
 *   grade: string,
 *   breakdown: object
 * }}
 */
function scoreFromStats(stats) {
  const {
    functions,
    dead,
    deadUnavailable,
    circular,
    godObjects,
    connections,
    files,
  } = stats;

  // Dead-code penalty: skip entirely when code_calls is empty — without a
  // call graph we cannot distinguish "no callers" from "not yet indexed", so
  // reporting 100% dead code would be a false positive.
  const deadPenalty = deadUnavailable
    ? 0
    : Math.min(20, functions > 0 ? (dead / functions) * 100 : 0);

  // Circular-deps penalty: 5 points per cycle, capped at 20.
  const circularPenalty = Math.min(20, 5 * circular);

  // God-object penalty: 3 points per oversized file (>500 LOC), capped at 15.
  const godObjectPenalty = Math.min(15, 3 * godObjects);

  // Coupling penalty: average import connections per file; anything above 3
  // starts costing 2 points per extra connection, capped at 15.
  const avgCoup = files > 0 ? connections / files : 0;
  const couplingPenalty = Math.min(15, Math.max(0, avgCoup - 3) * 2);

  // Security: no scanner integrated yet — always 0 penalty.
  // WHY not unavailable: the FE renders "not scanned" specifically when the
  // security term has no `unavailable` field. deadCode uses unavailable:true
  // (→ "n/a (no data)"). Keeping these semantically distinct lets the FE
  // surface them differently without a special-case flag per term.
  const securityPenalty = 0;

  // Round each penalty term to an integer FIRST, then derive score from the
  // sum of those rounded integers. This ensures breakdown.{*}.penalty values
  // always sum exactly to (100 − score) — rounding score and penalties
  // independently would let the displayed breakdown disagree with the score
  // by ±1 point (e.g. coupling 0.6 shown as "1" while score used 0.6).
  const rDeadPenalty     = Math.round(deadPenalty);
  const rCircularPenalty = Math.round(circularPenalty);
  const rGodPenalty      = Math.round(godObjectPenalty);
  const rCouplingPenalty = Math.round(couplingPenalty);

  const total = rDeadPenalty + rCircularPenalty + rGodPenalty + rCouplingPenalty + securityPenalty;
  const score = Math.max(0, 100 - total);

  let grade;
  if (score >= 90) grade = 'A';
  else if (score >= 80) grade = 'B';
  else if (score >= 70) grade = 'C';
  else if (score >= 60) grade = 'D';
  else grade = 'F';

  const breakdown = {
    deadCode: deadUnavailable
      ? { value: null, penalty: 0, unavailable: true }
      : { value: dead, penalty: rDeadPenalty },
    circularDeps: { value: circular, penalty: rCircularPenalty },
    godObjects:   { value: godObjects, penalty: rGodPenalty },
    coupling:     { value: Number(avgCoup.toFixed(2)), penalty: rCouplingPenalty },
    // No `unavailable` field here — FE renders "not scanned" for security when
    // the note key is present and unavailable is absent.
    security:     { penalty: 0, note: 'not scanned' },
  };

  return { score, grade, breakdown };
}

// ── DB stat gathering ─────────────────────────────────────────────────────────

/**
 * Gather code-health stats from the DB for `project` and return a full score
 * result.
 *
 * @param {object} db      The db.cjs module (must expose .initialize() + .raw()).
 * @param {string} project Project name (must match code_symbols.project).
 * @returns {{ project: string, score: number, grade: string, breakdown: object }}
 */
function computeHealthScore(db, project) {
  // Rule 2 from CLAUDE.md: call initialize() before every DB operation.
  db.initialize(null, null);
  const conn = db.raw();

  // Count functions/methods — the denominator for dead-code %.
  const functions = conn.prepare(
    `SELECT COUNT(*) AS n FROM code_symbols
      WHERE project = ?
        AND kind IN ('function', 'method')`
  ).get(project).n;

  // Dead-code detection requires a call graph. If code_calls has no rows for
  // this project, we cannot determine which functions are called — every
  // function would appear dead, yielding a misleading 100% dead-code rate.
  // Guard: when callsCount === 0, set deadUnavailable=true so the formula
  // skips the penalty and the FE renders "n/a (no data)" instead of "100%".
  const callsCount = conn.prepare(
    'SELECT COUNT(*) AS n FROM code_calls WHERE project = ?'
  ).get(project).n;

  let dead = 0;
  const deadUnavailable = callsCount === 0;
  if (!deadUnavailable) {
    // A function is considered dead when its name never appears as a callee
    // in the project's call graph. This is intentionally conservative: a
    // function called only from outside the indexed files (e.g. from tests
    // or config) may be mis-classified. The penalty is capped at 20 points
    // so the impact of false positives is bounded.
    dead = conn.prepare(
      `SELECT COUNT(*) AS n FROM code_symbols
        WHERE project = ?
          AND kind IN ('function', 'method')
          AND name NOT IN (
            SELECT DISTINCT callee_name FROM code_calls WHERE project = ?
          )`
    ).get(project, project).n;
  }

  // Connection count for coupling: total import edges for this project.
  const connections = conn.prepare(
    'SELECT COUNT(*) AS n FROM code_imports WHERE project = ?'
  ).get(project).n;

  // File count: distinct files with any indexed symbol.
  const files = conn.prepare(
    'SELECT COUNT(DISTINCT file) AS n FROM code_symbols WHERE project = ?'
  ).get(project).n;

  // God-object detection: files whose maximum line index exceeds 500.
  // Uses COALESCE(MAX(line_count), MAX(line)) to match the treemap idiom
  // (line_count is the physical file length; line is the last-symbol line,
  // used as a fallback when line_count was not yet backfilled).
  const godObjects = conn.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT file, COALESCE(MAX(line_count), MAX(line)) AS loc
         FROM code_symbols
        WHERE project = ?
        GROUP BY file
     ) WHERE loc > 500`
  ).get(project).n;

  // Circular dependency count: run Tarjan SCC on the import graph edges.
  // getImportGraph calls db.initialize internally, resolves bare import
  // targets to known files, and dedupes edges — so countCycles sees a clean
  // adjacency list rather than raw import strings.
  const { edges } = getImportGraph(db, project);
  const circular = countCycles(edges);

  const stats = { functions, dead, deadUnavailable, circular, godObjects, connections, files };
  const { score, grade, breakdown } = scoreFromStats(stats);

  return { project, score, grade, breakdown };
}

module.exports = { countCycles, scoreFromStats, computeHealthScore };
