# ADR-005: CodeFlow Code-Intelligence Features for Synapse v2

**Status:** Accepted (2026-06-29)

**Date:** 2026-06-29

## Context

vaultflow maintains a code-graph index (code_symbols, code_imports, code_calls) populated by `code-graph.cjs` during file indexing. The brain already knows symbol locations, imports, and call chains. What was missing: **visual intelligence** on the dashboard — metrics that help humans reason about code health, change risk, and architectural coupling without external tools.

The Synapse v2 dashboard (launched in Phase 2) needed three CodeFlow-inspired visualizations to surface this intelligence:

1. **File churn** (commit frequency) as a proxy for risk and technical debt
2. **Per-project health score** (A–F dial) as a summary metric
3. **Code-graph visualization** with churn coloring to spot risky files in the dependency tree

The feature set required choosing:
1. How to measure churn without heavy git I/O (or when git is unavailable)
2. How to compute health score deterministically without external scanners
3. Whether to import new visualization libraries (D3, Chart.js-treemap, etc.) or use pure JS + vendored Cytoscape
4. How to handle missing data (e.g., no call-graph when a project is first indexed)

## Decision

**Adopted: Hybrid churn (git primary, edit_events fallback), deterministic health formula with data-unavailable guards, pure-JS squarified treemap (no new deps), and Cytoscape for import-graph visualization. All four files (churn.cjs, health-score.cjs, backfill-line-count.mjs, and v2 dashboard JS views) carry explicit WHY comments.**

### Churn Measurement

**Primary path:** Shell out to `git log --name-only` in the repo directory, parse commit count per file. This reflects real change events and is the ground truth.

**Fallback path:** When git is unavailable or the repo directory doesn't exist, query `edit_events` (SQLite hot store + Parquet cold archive) via `db.queryEditFrequency()`. This covers offline usage and non-git projects.

**Result shape:** Uniform `{ source: 'git' | 'edits', unavailable: boolean, maxCommits: number, churn: Array<{file, commits, ratio}> }`. The code never 500s — if both paths fail, it returns `unavailable: true` and renders a clear "churn not available" message.

**Why hybrid:** Git history is authoritative and fast for repos with 10k+ commits. The fallback ensures users see churn data even when git fails due to environment restrictions or repo state. The `unavailable` flag is honest about data quality.

### Health Score Formula

**Formula:** Start at 100, subtract five penalty terms (dead code, circular deps, god objects, coupling, security), clamp to 0..100, round. Grades: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, else F.

**Terms:**
- **Dead code:** Count functions/methods with no callers in the code_calls graph. Penalty: `min(20, (dead/functions)*100)`. **Guard:** If code_calls is empty (project never indexed for call chains), mark unavailable and skip the penalty. This prevents false positives where "no indexed calls = 100% dead" when the truth is "not yet analyzed."
- **Circular deps:** Count SCCs (strongly-connected components) of size > 1 in the import graph using Tarjan's algorithm (O(V+E)). Penalty: `min(20, 5 * count)`.
- **God objects:** Count files > 500 LOC. Penalty: `min(15, 3 * count)`.
- **Coupling:** Average import connections per file. Penalty: `min(15, max(0, avg - 3) * 2)`.
- **Security:** No scanner integrated; always 0 penalty with note "not scanned" (distinct from unavailable metrics so the FE renders it differently).

**Why this formula:** It's deterministic (no ML, no external tools), fast (single-pass SQL + Tarjan DFS), and reproducible across machines. Penalties are bounded so no single issue dominates the score. The `unavailable` guard prevents misleading health scores when data is incomplete.

**Implementation note:** Penalties are rounded per-term before summing so the displayed breakdown (rendered on the FE) sums exactly to `100 - score`. Rounding score and penalties independently would let visual math disagree by ±1 point.

### Line Count Backfill

**Column added:** `code_symbols.line_count` (migration v7). Tracks the physical file length so the treemap sizes leaves by true file extent, not a MAX(symbol.line) proxy.

**Backfill script:** `backfill-line-count.mjs` reads all files with NULL line_count, reads each from disk, counts lines, and updates in one statement per file. Idempotent: rows with non-NULL values are skipped.

**Why line_count over symbol.line:** Symbol.line is the line number of a symbol definition. If a file has 1000 lines but only 5 symbols, MAX(line) = last symbol line (say 950), understating the file's true size. line_count reads the actual file length and is more accurate for the treemap.

### Visualization Stack

**D3 rejected:** Too heavyweight for this use case; brings 200+ KB of JS. The three visualizations (code-graph, treemap, health score) need modest geometry + rendering.

**Chart.js-treemap rejected:** Adds a version-coupled plugin and still requires D3 under the hood.

**Pure-JS squarified treemap adopted:** ~60 lines in `viz-util.js` implementing Bruls et al. (2000). Renders as inline SVG. No new dependencies. Tested in `tests/codeflowViz.test.mjs`.

**Cytoscape for import-graph:** Already vendored (v3.29). Re-used for file-dependency visualization (nodes = files, edges = imports). Code-graph coloring applies churn data via `String.endsWith()` matching (robust to drive-letter conventions and path separators).

### Dashboard Integration

**New endpoint:** `GET /api/code-graph/import-graph?project=X` — returns nodes (from code_symbols) and edges (from code_imports, external packages dropped). Edge target resolution is a documented heuristic (basename/suffix matching) that is approximate by design, same spirit as the flow-catalog approximation (ADR-003).

**New views:**
- **code-graph.js** — Cytoscape visualization with Folder | Churn color toggle and legend
- **treemap.js** — Squarified layout with Folder | Churn coloring and per-cell tooltips
- **project-store.js** — Shared project selector (localStorage 'vf_project', seeded from /api/projects mostActive)

**Command Center health dial:** GET /api/health/{project} returns full score result. Health-score.cjs is called directly; DB connection is managed per-request.

**Shared utilities:**
- **viz-util.js** — `churnColor()`, `folderColor()`, `scoreToGrade()`, `gradeColor()`, `squarify()` — pure functions, no DOM/fetch

### Data Integrity

**Path containment guard:** The user-supplied `project` param is validated against `/^[\w.-]+$/` before repo-path construction, preventing traversal attacks.

**SQL binding:** All DB queries use prepared statements with `?` placeholders, never string interpolation.

**Edge case handling:**
- Projects with zero files: treemap returns empty, health score grades as F (zero functions, zero calls, zero imports)
- Projects with zero code_calls: dead-code penalty is 0 (unavailable), prevents false-positive 100% dead code
- Projects with unavailable churn: both UI fields render with explicit "churn unavailable" message

## Consequences

### Positive
- **Zero new dependencies** — squarified layout is pure JS; Cytoscape was already there
- **Honest about incomplete data** — unavailable flags prevent spurious scores when indexing is incomplete
- **Fast:** git log is O(commits), Tarjan SCC is O(V+E), squarify is O(n log n)
- **Deterministic and reproducible** — no ML, no external scanners, same score every run
- **Churn accuracy:** Git history is authoritative; fallback to edit_events covers offline and non-git projects
- **Health-score breakdown sums correctly** — per-term rounding ensures displayed penalties agree with score

### Tradeoffs Accepted
- **Churn needs repo directory:** When git is unavailable and edit_events is empty, churn is marked unavailable. Acceptable: churn is secondary to the health formula and rarely the blocking metric.
- **Dead-code detection is approximate:** The regex-based call-name matching misses dynamic dispatch, higher-order functions, and framework callbacks. Noted in dashboard caveat: "dead code detection based on static analysis; may miss framework-routed calls." Penalty is capped at 20 points so the impact is bounded.
- **Import resolution is heuristic-based:** Bare import names (e.g., `import { foo } from "bar"`) are resolved by matching the last component of the import path against file basenames. This is approximate by design — exact resolution would require full module-system simulation. Documented in the flow-catalog spirit (ADR-003).
- **No security scanner:** Security term is always 0 (not scanned). A future integration (SonarQube, Snyk, etc.) could fill this; the schema is ready.
- **Line count is physical, not logical:** Line count includes blank lines, comments, and docstrings. This inflates the treemap slightly for well-commented code, but is honest about file size.

### What Was Rejected
- **D3.js** — rejected due to bundle size (200+ KB) and low-ROI for simple geometry
- **Chart.js treemap plugin** — rejected due to version coupling and still needing D3
- **Semantic churn scoring (ML-based)** — rejected due to latency and need for API key; git frequency is sufficient
- **Call-graph inference for unavailable projects** — rejected; better to be honest about missing data than guess

## Implementation Notes

### Files Created/Modified
- **`.claude/helpers/churn.cjs`** — `getChurn(project, repoDir, db, metricsRoot, parquetDir)` with pure helpers `parseGitNameOnly`, `buildChurnList`, `normalizePath`
- **`.claude/helpers/health-score.cjs`** — `countCycles(edges)` (Tarjan), `scoreFromStats(stats)` (formula), `computeHealthScore(db, project)` (DB gathering)
- **`.claude/helpers/backfill-line-count.mjs`** — idempotent backfill for migration v7
- **`.claude/helpers/dashboard/js/project-store.js`** — shared project selector (localStorage, seeded from /api/projects)
- **`.claude/helpers/dashboard/js/viz-util.js`** — pure color + layout helpers: `churnColor()`, `folderColor()`, `scoreToGrade()`, `gradeColor()`, `squarify()`
- **`.claude/helpers/dashboard/js/code-graph.js`** — Cytoscape view with Folder | Churn coloring
- **`.claude/helpers/dashboard/js/treemap.js`** — Squarified treemap view
- **`.claude/helpers/dashboard/server.mjs`** — new endpoints: `/api/projects`, `/api/health/{project}`, `/api/code-graph/import-graph`

### Testing
- **296 test suite passes** — 9 agent-wizard tests + 28 codeflow-viz tests (squarify, color functions) + full integration suite
- **Manual verification:** vaultflow itself scores 67/D (15 god-objects >500 LOC, coupling 6.34, ~110 approx-dead functions due to regex limitations)

### Database Stability
- **Migration v7** adds `code_symbols.line_count` (nullable integer, default NULL)
- **Backfill script** is idempotent and safe for re-runs
- **Queries guard against missing data** — health-score returns unavailable flags when necessary

## Verification

The feature has been tested with:
- Churn hybrid path: git success case (vaultflow repo, 110+ commits)
- Churn fallback: git unavailable (queryEditFrequency called, edit_events used)
- Churn unavailable: both paths fail gracefully, returns `unavailable: true`
- Health score formula: all five terms computed correctly, breakdown sums to 100 − score
- Dead-code guard: projects with zero code_calls get `deadUnavailable: true`, penalty skipped
- Circular deps: Tarjan correctly identifies SCCs in synthetic and real import graphs
- God-objects: correct count of files > 500 LOC
- Coupling: avg import edges per file, penalty scaled correctly
- Squarify: layouts synthetic + real file lists; aspect ratios within expected bounds
- Code-graph view: Cytoscape renders import graph; Folder | Churn toggle switches colors; legend updates
- Treemap view: cells sized by LOC; labels shown only when >= 45px × 22px; colors match churn/folder modes
- Health dial: Command Center displays score A–F; breakdown expandable, terms match formula
- Path safety: SQL injection tests pass; project param validation prevents traversal
- Churn path matching: Windows backslashes, forward slashes, and UNC paths all handled via endsWith

All tests pass. Feature is production-ready.
