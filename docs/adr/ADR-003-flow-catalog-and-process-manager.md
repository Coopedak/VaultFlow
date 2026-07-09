# ADR-003: Flow Catalog and Process Manager Agent

**Status:** Accepted (2026-06-17)

**Date:** 2026-06-17

## Context

vaultflow indexes code symbols, imports, and call graphs per project. The brain already knows what each function does and which files depend on which. What was missing: a named, persistent representation of **flows** — end-to-end process paths through the project (often cyclic) that humans reason over and agents need to analyze before multi-file changes.

For example: a web project has a "user signup" flow (route handler → validation → DB insert → email service → response), a "report generation" flow (CLI entry → query → transform → cache → export), and a "webhook retry" flow (listener → deserialize → process → queue → backoff). Each is a named, human-meaningful path through the code.

The system needed to decide:
1. Whether to build a new flow-discovery engine or reuse existing infrastructure
2. How to handle the inherent incompleteness (call-graph + bare-name, not full program analysis)
3. What should be the source of truth when automation and humans disagree
4. When should flows be re-discovered vs. preserved

## Decision

**Adopted: Reuse the existing code-graph and bare-name call resolution; implement flows as a discoverable, persistent, curator-friendly catalog with a 3-tier confidence model (auto | manual | declared).**

### The Three Tiers

1. **Auto** (`source='auto'`) — discovered nightly by walking the transitive call graph from high-confidence entry points (HTTP routes, CLI commands). Re-discovered each nightly run. If a human adds `user_notes`, the flow upgrades to `source='manual'`.

2. **Manual** (`source='manual'`) — a human has opened the flow's annotation panel and added a name, description, or user_notes. Preserved across nightly re-runs (the annotation row survives). Re-traced with the latest code graph nightly.

3. **Declared** (`source='declared'`) — user explicitly registered via `vaultflow flows declare <file> <symbol>`. Entry point is prune-exempt (survives across all future nightly runs). Stored in `declared_entries` table; re-traced nightly like manual flows.

### Storage

Flows live in three tables:
- **`flows`** — (id, project, entry_file, entry_symbol, name, description, user_notes, source, confidence, truncated, created_at, updated_at)
- **`flow_nodes`** — (flow_id, node_id, file, symbol, ambiguous, depth, order)
- **`flow_edges`** — (flow_id, edge_id, caller_file, caller, callee_file, callee, ambiguous)

Each node and edge carries an `ambiguous` flag (bare-name collision detected) so the dashboard can visualize uncertainty. `flow.truncated` flag indicates the walk hit the 150-node cap.

### The Process Manager Agent

A new skill **`process-manager`** (at `C:\Users\DCC\.claude\skills\process-manager\SKILL.md`) acts as the PM's flow analyst:
- **Invoked in the PLAN phase** before multi-file changes that cross flow boundaries (to assess impact scope)
- **Invoked at BUG intake** to identify which flows are affected and root-cause direction
- Queries via `vaultflow impact <file>` or the `impact` MCP tool
- Uses declared + manual flows as ground truth; auto flows as "starting map"
- Reports upstream/downstream impact, affected-flow classifications (affected / affected-handoff / verify / not-affected), and commit correlation leads

## Consequences

### Positive
- **Reuse existing infrastructure** — flow discovery rides the proven code-graph and bare-name call tracer. Zero new analysis engines.
- **Honest about limitations** — every flow is labeled with its source (auto/manual/declared) and confidence level. Ambiguous nodes and truncation flags signal when to trust the annotation over the trace.
- **Human-in-the-loop by design** — user-declared and manual flows survive nightly re-runs. The `user_notes` field is authoritative (can describe DB/event/queue couplings the call graph cannot see).
- **Recall floor** — declared entry points are prune-exempt and re-traced nightly. Users define the minimum set of flows they care about; discovery is additive.
- **Cyclic flows supported** — the code-graph walker detects cycles and terminates; each flow is visualized as a Cytoscape flowchart on the dashboard (Cytoscape handles cycles naturally).
- **Dashboard integration** — the "Flows" tab shows each flow as a flowchart; declare and annotate forms let humans update flows in real time.
- **Agent-ready impact analysis** — `vaultflow impact <file>` returns upstream/downstream impact + affected-flow verdicts + root-cause direction (shallow 2-depth upstream walk + text-match commit correlation labeled "lead not proof").

### Tradeoffs Accepted
- **Partial entry-point detection** — HTTP routes require a router-import check (precision over recall). Decorators, dynamic dispatch, and framework magic are intentionally not chased. Users can declare missing entries.
- **Bare-name resolution only** — `code_calls` stores the tail identifier (callee_name). A call to `validate()` could resolve to any `validate` in the project; the `ambiguous` flag signals this. Full qualified-name resolution would require semantic analysis (rejected as too expensive).
- **DB/event/queue couplings invisible** — flows cannot auto-detect producer-consumer handoffs, database constraints, or message-queue subscribers. This is the **primary reason for human curation** — `user_notes` on a flow can annotate these hidden couplings.
- **Nightly, not real-time** — flows are re-discovered nightly. A flow-changing commit + a multi-file change in the same day could make the flow stale. Users can manually re-run `vaultflow flows discover <project>` in urgent cases.
- **Impact analysis uncached** — `GET /api/flows/:id/impact` re-runs the engine per call (no caching). Candidate for caching keyed by flow + code-graph fingerprint if catalogs grow large.
- **Root-cause direction is heuristic** — commit correlation uses filename fuzzy-match against the change target's base stem; labeled "lead not proof." Intended to narrow the search space for human investigation, not as ground truth.

### What Was Rejected
- **Full program analysis** — semantic call resolution (building a qualified-name map). Rejected for cost (incremental compilation-like analysis) and diminishing returns (80% of flows are traceable with bare names; the remaining 20% need human annotation).
- **Blocking gate on multi-file changes** — originally considered: "refuse to make multi-file changes if impact spans >3 flows." Rejected because the gate would be frustrating (too many false positives) and the real solution is human judgment (invoke the process-manager agent at PLAN time).
- **New search/impact engine** — considered building a dedicated "flow impact" query language. Rejected; reuse the code-graph + impact tracing (existing infrastructure).
- **Real-time sync** — flows auto-discovered and updated as edits happen. Rejected; nightly + manual re-run is sufficient for the agent's use case (PLAN phase is not sub-minute).

## Implementation Notes

- **Entry-point detection** — HTTP routes: `code_calls` where `callee_name IN ('get', 'post', ...)` + file imports a router module. CLI entry points: file imports `yargs` or `commander` (not yet implemented). User-declared entries: sourced from `declared_entries` table + passed to `detectEntryPoints()`.
- **Transitive walk** — `walkTransitive(db, {file, symbol}, project)` does breadth-first traversal of the code-graph up to 150 nodes, detects cycles, returns `{nodes, edges, truncated, ambiguous_count}`.
- **Noise stop-list** — excludes common non-semantic symbols (`test`, `it`, `describe`, `expect`, `console.log`, etc.) from flow discovery to keep flows readable.
- **Quality gate** — filters flows by minimum size (≥3 nodes) and blocks flows with >80% ambiguous nodes (signal-to-noise too low).
- **Nightly refresh** — called from `nightly.mjs`: `discoverFlows(db, project, null)` walks entry points, skips auto-flows without annotation, preserves manual/declared. If the walk produces a different edge list, `updated_at` is refreshed.
- **Impact engine** — `analyzeImpact(db, {file, symbol, project})` returns `{downstream, upstream, flows_affected, root_cause_direction}` where:
  - `downstream` = files/symbols that call the target
  - `upstream` = files/symbols called by the target (shallow walk, ≤40 nodes)
  - `flows_affected` = [{flow_id, verdict: 'affected'|'affected-handoff'|'verify'|'not-affected', reason}]
  - `root_cause_direction` = {likely_files, commits, caveats: "lead not proof"}
- **Shared-node heuristic** — a flow is `'affected'` if it shares ≥1 node with downstream. `'affected-handoff'` if impact touches an edge of the flow but not any node inside (the flow calls a changed function, but the flow itself might not behave differently). `'verify'` if the change is in upstream but the flow imports/uses the module transitively. `'not-affected'` otherwise.
- **Declared entries persistence** — stored in `declared_entries` table, never pruned, always re-included in `detectEntryPoints()`.
- **Dashboard Flows tab** — Cytoscape visualization of each flow's node + edge set, colored by `ambiguous` status. Declare/Annotate forms let users update `name`, `description`, `user_notes` in real time; saves to `flows` row.
- **MCP tool** — `impact` tool wraps `analyzeImpact()` and formats output for agent consumption (list of affected flows with verdicts + upstream/downstream counts).

## Verification

The feature has been tested with:
- HTTP-route entry detection with router-import gating (Express / Fastify projects)
- Transitive walk with cycle detection (flows with and without loops)
- Bare-name ambiguity flagging (multiple `validate()` symbols in the project)
- Nightly re-run preservation of manual annotations and declared entries
- User declaration of entry points via CLI
- Impact analysis downstream (callers of a changed function)
- Impact analysis upstream (root-cause search in dependencies)
- Per-flow verdict assignment (affected / affected-handoff / verify / not-affected)
- Commit correlation fuzzy-match (file base-stem matching recent commits)

## Known Follow-Up

**Caching** — `GET /api/flows/:id/impact` re-runs the impact engine on every call (no caching). If flow catalogs grow to hundreds of flows in a large project, this could become slow. Recommend implementing cache keyed by `(flow_id, code_graph_fingerprint)` where fingerprint is a hash of the transitive closure of code_symbols + code_calls. Invalidate nightly when the code graph changes.
