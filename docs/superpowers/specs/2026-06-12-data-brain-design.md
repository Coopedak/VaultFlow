# vaultflow Data Brain / Mission Control — Design

- **Date:** 2026-06-12
- **Status:** Draft — pending user review
- **Scope:** Dashboard "Brain" tab (graph + vitals + live pulse), learning-loop circuit closures, snapshot trend infrastructure, unified `vaultflow` core CLI

> **Source study note:** two open-source repos were cloned and studied to inform
> this design. **Architecture and schemas were studied; no code was copied** —
> everything below is reimplemented vaultflow-native against our own stack
> (CJS + `node:sqlite`, not their ESM).
>
> 1. **Wayland desktop app** — github.com/ferroxlabs/wayland (AGPL-3.0 + some
>    Apache-2.0). The Electron command center. Its own memory is a simple
>    file-based markdown archive (linear search, no FTS/embeddings).
> 2. **IJFW engine** — github.com/FerroxLabs/ijfw, **MIT licensed**, published as
>    `@ijfw/install` on npm. This is the real "5-partition memory brain": the
>    desktop app spawns it as a local MCP server at `~/.ijfw/mcp-server`. It was
>    never proprietary — just lives in a different repo than the app. MIT means
>    **no copyleft contamination risk**, but we still reimplement rather than copy.
>
> Reality check on the marketing: the skill-prompt eval harness is **not
> implemented** in either repo. The 5-partition memory **is** real and is worth
> learning from (see backlog item 1, now concrete). vaultflow's existing SQLite +
> FTS5 + embeddings + RRF search already matches IJFW's hot/warm search tiers;
> what IJFW adds that we lack is **semantic-tier promotion, a bi-temporal facts
> table, contradiction-driven staleness, and a user-model profile.**

---

## North Star

vaultflow should function as a local-first command center for all AI CLI agents on this
machine — the role [Wayland](https://getwayland.com/) plays, but grown organically from
vaultflow's hook system instead of a separate desktop app.

Mapping the Wayland concepts onto vaultflow:

| Wayland concept | vaultflow today | This design adds |
|---|---|---|
| Command center over many CLIs | TUI (multi-pane claude PTYs), watcher daemon, `agent-context.json` for Codex/Copilot/Cursor | Mission Control live view (Phase 3) |
| Shared memory across agents | SQLite DB + MCP server (`mcp-server.cjs`) already queryable by any agent | Brain graph makes the shared memory visible (Phase 1) |
| Self-improvement loop | patterns → promotion, routing-miss audit, model demotion (all partially dead-ended) | Circuit closures + measurable vitals (Phase 2) |
| Mission Control live view | none (dashboard is request/response only) | SSE pulse + active-session strip (Phase 3) |
| 5-partition memory (working/episodic/semantic/procedural/user-model) | flat: memory_entries, session_summaries, patterns, dictionary — already SQLite + FTS5 + embeddings, which exceeds Wayland's OSS file-based archive | Backlog — classification view over existing tables |
| Skill eval harness (rewrite, score, promote prompts) | routing-miss audit surfaces gaps, no auto-tuning | Backlog — builds on Phase 2 attribution data (unimplemented in Wayland too) |
| Standalone core engine (wayland-core, closed source) | capabilities scattered across helper CLIs + MCP server | unified `vaultflow` bin (Phase 4) |
| Task scheduler | nightly.mjs, Loop 13 (3AM session review) | Surfaced in Mission Control (Phase 3) |
| Constitution file | CLAUDE.md + `~/.claude/rules/` + gen-context.mjs | Already covered — no work |
| Remote control / messaging channels | dashboard on :7700 (localhost) | Out of scope |

**Non-goals:** spawning/driving other CLIs (ACP orchestration), messaging-channel
integrations, desktop app packaging, voice/image features.

---

## Phase 1 — Brain Graph (structure)

A force-directed graph of every entity vaultflow knows about and how they connect.
No schema changes — all edges already exist in SQLite.

### Node model

Node IDs are `type:key` strings:

| Type | Key | Label | Weight |
|---|---|---|---|
| `project` | project name | name | session count (30d) |
| `session` | sessions.id | started_at + project | edit count |
| `file` | file path | basename | edit + import frequency |
| `symbol` | `file#name` | name | caller count |
| `memory` | `source#title` | title | backlink count |
| `skill` | vault_agents.agent_id | name | use_count |
| `pattern` | patterns.pattern_key | pattern_key | fire_count |
| `prompt` | prompts.id | preview (60 chars) | 1 |
| `commit` | sha | subject (60 chars) | 1 |

### Edge sources (existing tables, UNIONed)

| Edge kind | Table | Direction |
|---|---|---|
| `links` | memory_links | memory → memory |
| `imports` | code_imports | file → file |
| `calls` | code_calls | symbol → symbol |
| `routed` | skill_injection_decisions | prompt → skill |
| `edited` | edit_events | session → file |
| `prompted` | prompts | session → prompt |
| `summarized` | session_summaries (top_files, patterns) | session → file, session → pattern |
| `owns` | patterns.agent | pattern → skill |
| `committed` | git_commits | commit → project |
| `belongs` | project column on most tables | * → project |

### API

`GET /api/brain/graph?center=<nodeId>&depth=1|2&types=a,b,c&limit=N`

- **Overview mode** (no `center`): top nodes per type over last 30 days — 10 projects
  by session count, 15 hub files, 10 skills by use_count, 10 patterns by fire_count,
  10 memory entries by backlink count — plus edges **among the selected set only**.
- **Neighborhood mode** (`center` given): the node, its edges, and neighbors out to
  `depth` (default 1, max 2).
- **Caps:** 150 nodes / 400 edges default, 500/1500 hard max. Never ship the full
  code graph to the browser.
- Response: `{ nodes: [{id, type, label, weight}], edges: [{source, target, kind, weight}] }`
- Implementation: new `getBrainGraph(opts)` in `db.cjs`; endpoint in
  `dashboard/server.mjs` following the existing thin-route pattern.

### UI — new "Brain" tab

- **Cytoscape.js** for rendering — loaded the same way Chart.js already is (static
  asset, no build step). **This is the one new dependency in the entire design**
  (frontend-only). Alternative considered: hand-rolled D3 force layout — rejected,
  more code for a worse result.
- Nodes colored by type, sized by weight; `cose` force layout.
- Click node → refetch with `center=` and merge the neighborhood into the view.
- Search box backed by existing `/api/search` (unified search) → recenter on result.
- Side panel shows node detail via existing endpoints (memory entry, symbol search,
  session timeline) with a deep-link to the relevant existing tab.

---

## Phase 2 — Vitals + closing the learning loops ("is it getting smarter")

The exploration found 8 learning loops; several write data nothing reads back. This
phase closes four circuits and adds the snapshot infrastructure that makes
improvement measurable. **This is the phase where the system gets smarter rather
than just prettier.**

### New table: `brain_snapshots`

```sql
CREATE TABLE IF NOT EXISTS brain_snapshots (
  snapshot_date TEXT NOT NULL,            -- YYYY-MM-DD
  metric        TEXT NOT NULL,            -- dotted metric key
  scope         TEXT NOT NULL DEFAULT '', -- project/agent, '' = global
  value         REAL NOT NULL,
  PRIMARY KEY (snapshot_date, metric, scope)
);
```

Written by a new error-isolated step in `nightly.mjs` (same isolation pattern as
existing steps). Metrics recorded nightly:

| Metric | Source |
|---|---|
| `patterns.count`, `patterns.fires.total` | patterns |
| `routing.injection_rate.7d`, `routing.misses.7d` | skill_injection_decisions + routing-miss audit |
| `prompts.dedup_hits.7d` | prompts where similarity_score ≥ dedup threshold |
| `tools.dupe_rate.7d` | tool_calls dedup stats |
| `mcp.adoption.7d` | existing code-graph/savings query |
| `memory.count`, `memory.stale.count` | memory_entries, memory_stale |
| `model.approval_rate` (scope=agent) | model_performance |
| `embeddings.coverage` | memory_embeddings vs memory_entries |
| `verdicts.approval_rate.7d` | agent_verdicts |

Helpers in `db.cjs`: `recordBrainSnapshot()`, `getBrainSnapshots({metric, scope, days})`.

### Circuit closures

1. **Retrieval feedback — implicit capture.** `intelligence.getContext()` logs an
   impression row in `retrieval_feedback` (`action='injected'`, `useful=NULL`) for
   each doc it injects. A nightly correlation step sets `useful=1` when the same
   session subsequently edited or read the doc's source file, `useful=0` after
   7 days with no correlation. No rating UI required.
2. **Verdict attribution.** Add nullable `decision_id INTEGER` to `agent_verdicts`
   (ALTER TABLE, idempotent guard). `hook-handler.cjs` passes the most recent
   `skill_injection_decisions.id` for the session when recording a verdict. Enables
   per-skill routing-quality measurement for the first time.
3. **Promoted-flag read-back.** `router.cjs` applies a 10% score boost to
   promoted patterns and vault tools when ranking candidates (multiplier on the
   composite score, constant defined in router.cjs), so promotion changes
   behavior instead of being a write-only flag.
4. **Model recommendations panel.** `GET /api/model/recommendations` reads
   `{metrics_root}/model-recommendations.json`; `POST /api/model/recommendations/accept`
   applies one via a new `applyRecommendation()` export in `model-router.cjs`.
   Dashboard Control tab gets a panel with per-recommendation Accept buttons —
   same interaction pattern as the existing pattern-promote button. **Deliberately
   one-click, not auto-apply**; auto-apply can become a config toggle later.
5. **Composite promotion score (Wayland-informed).** Replace the blunt
   fire_count/confidence thresholds with a 0–100 composite score for patterns and
   memory entries, computed nightly and stored as a snapshot metric:
   - +30 high-signal type (pattern/decision types)
   - +10 per cross-project occurrence
   - +5 per reference/fire
   - +20 promoted-tag match (architecture/design/decision tags)
   - +15 recency boost, full under 24h, linear decay to 0 at 30 days
   - Promote at ≥90 (calibrated so today's promotion candidates still qualify).
   The existing nightly promotion step swaps its predicate for this score; the
   formula lives in one exported function in `db.cjs` so the dashboard can show
   per-entry scores.

### Vitals panel (on the Brain tab)

- Sparkline trend cards (Chart.js line charts — already loaded) for each snapshot
  metric, with up/down delta vs 7 days prior.
- Agent-verdicts summary — `/api/verdicts` exists today with **no UI**; render it.
- Routing-miss audit summary from the latest `routing-misses-{date}.json`.

---

## Phase 3 — Pulse / Mission Control ("watch it think")

### Event feed

`GET /api/brain/events` — Server-Sent Events from `dashboard/server.mjs`.

- **DB-as-bus:** the server polls SQLite every ~1.5s using max-rowid watermarks on
  `prompts`, `tool_calls`, `edit_events`, `skill_injection_decisions`,
  `agent_verdicts`, `sessions`, and pushes new rows as SSE events.
- Chosen over hooks POSTing to the server because hooks are short-lived processes
  and the dashboard may not be running; the DB works unconditionally. The watcher
  daemon already writes Codex/Copilot/Cursor edits into the same tables, so
  **non-Claude agents appear in the feed for free.**
- Event shape: `{ kind, ts, session_id, project, label, refs: [nodeIds] }`.
- If the DB is locked, the poller skips a beat silently — SSE degrades to silence,
  never errors.

### UI

- **Live ticker** pane on the Brain tab (toggle on/off).
- **Node pulses:** graph nodes referenced by `refs` flash when an event touches them.
- **Pipeline strip** per active session: prompt → route → inject → edit flowing
  left to right.
- **Mission Control strip — unified ledger (Wayland-informed).** One projection
  over live sessions and scheduled jobs, modeled on Wayland's `LedgerEntry`:

  ```
  { id, source: 'session'|'job', title, status, owner, detail,
    lastHeartbeat, startedAt, updatedAt }
  ```

  Statuses and how vaultflow derives them:

  | Status | Derivation |
  |---|---|
  | `running` | session events within the last 10 min |
  | `zombie` | session has no ended_at and no events for 30+ min |
  | `scheduled` | nightly / Loop 13 with next-run time |
  | `failed` | last nightly step error, watcher daemon down |
  | `done` | sessions ended cleanly today |
  | `idle` | watcher running, nothing active |

  Rendered urgency-first (needs-attention → active → scheduled → done → idle),
  matching Wayland's section ordering. Zombie detection is the piece vaultflow
  has never had — sessions that die without firing SessionEnd currently linger
  as false-active forever; the dashboard `/api/health` stale-session check
  becomes user-visible here.

---

## Phase 4 — `vaultflow` core CLI (the Wayland-Core answer)

Wayland-Core's appeal is a standalone, headless engine any tool can invoke with one
command (`npx @ferroxlabs/wayland-core "..."`). Its source is closed — the OSS
desktop app merely spawns it. vaultflow already has the equivalent capabilities
scattered across helper scripts and the MCP server; this phase unifies them into
one bin with **no new logic**:

```jsonc
// package.json
"bin": { "vaultflow": ".claude/helpers/cli.mjs" }
```

| Subcommand | Delegates to (existing) |
|---|---|
| `vaultflow search <q>` | unified_search (RRF: memory + symbols + commits + dictionary + tools) |
| `vaultflow context [project]` | intelligence getContext / agent-context.json |
| `vaultflow graph [--center id]` | Phase 1 `getBrainGraph()` |
| `vaultflow mission` | Phase 3 ledger snapshot (text rendering) |
| `vaultflow doctor` | doctor.mjs |
| `vaultflow nightly` | nightly.mjs |
| `vaultflow dict <q>` | dict.mjs |
| `vaultflow flush` | flush-parquet.mjs |

`cli.mjs` is a thin argv router (~100 lines) that `await import()`s the right
helper. Output is plain text by default, `--json` for machine consumers. This is
what makes vaultflow's brain available headlessly to Codex, Copilot, cron jobs,
and shell scripts — the same role wayland-core plays for Wayland, built from
parts that already exist.

## Testing

`node --test` suites matching the existing `tests/sessionStore.test.mjs` +
fixtures pattern, against a fixture DB:

- `tests/brain-graph.test.mjs` — node/edge assembly, caps, overview vs neighborhood
- `tests/brain-snapshots.test.mjs` — record/read, idempotent re-run same date
- `tests/verdict-attribution.test.mjs` — decision_id linking, null-safe migration
- `tests/retrieval-feedback.test.mjs` — impression logging + nightly correlation
- `tests/brain-endpoints.test.mjs` — response shapes for `/api/brain/*`,
  `/api/model/recommendations`
- `tests/cli.test.mjs` — `vaultflow` bin smoke test: each subcommand resolves to
  its helper and `--json` output parses

UI verified manually against the live DB (no frontend test harness exists in the
project; not introducing one).

## Error handling

- New nightly steps use the existing isolated-step pattern — one failure never
  kills the run.
- Graph endpoint enforces node/edge caps server-side.
- ALTER TABLE migrations are guarded (check column existence first), consistent
  with `db.initialize()` idempotency.
- SSE poller swallows transient DB-lock errors.

## Risks

- **Graph readability at scale:** overview mode could still be visually dense.
  Mitigation: type filters + caps + neighborhood-first interaction model.
- **Implicit feedback precision:** edit/read correlation is a heuristic; some
  `useful=1` rows will be coincidental. Acceptable — the signal only needs to beat
  zero (current state), and the nightly learning loop consumes it in aggregate.
- **SSE on Windows/long-lived connections:** Express SSE is plain HTTP; keep-alive
  comments every 15s prevent proxy/browser timeouts.

## Backlog (post-v1, Wayland-inspired)

1. **5-partition memory (IJFW-informed, now concrete).** IJFW implements this as a
   single `tier_semantic` column on one `memory_entries` table, not five tables —
   the same shape vaultflow can adopt:
   - **Add `tier_semantic` column** to `memory_entries` (`working` default),
     enum: working / episodic / semantic / procedural / procedural_candidate.
   - **Promotion ladder (nightly):**
     - working → episodic: at session end, concatenate a session's working rows
       into one episodic summary (we already build session_summaries — promote
       those rather than re-deriving).
     - episodic → semantic: Jaccard token-overlap > 0.7 between two episodic
       entries, or an explicit `promote:semantic` tag.
     - working → procedural: a task ≥ 5 min that recurs as 3+ similar
       task→commit chains (Jaccard > 0.7) — vaultflow already has the patterns
       table; this is the same signal expressed as a memory tier.
   - **Bi-temporal facts table** (genuinely new, high value):
     ```sql
     CREATE TABLE facts (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL,
       confidence REAL DEFAULT 1.0, memory_id TEXT, source TEXT,
       valid_from TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
       valid_to TEXT, created_at INTEGER NOT NULL);
     ```
     Storing a contradicting (subject, predicate) closes the prior row's
     `valid_to` instead of accumulating conflicts — "what did we believe about X
     on date Y" becomes queryable. Facts are substring-grounded against their
     source text (hallucination guard).
   - **Contradiction-driven staleness:** vaultflow's `memory_stale` today only
     flags missing source files. IJFW propagates staleness by BFS over the code
     graph from a superseded node (depth ≤ 2, edge weight ≥ 0.5), flagging
     memory rows that mention reached symbols. We already have code_calls /
     code_imports — the graph exists.
   - **User-model partition** (the 5th, which vaultflow has *nothing* like): a
     profile of inferences about the user (expertise, style, preferences) with
     provenance, an audit verb, and right-to-be-forgotten purge. Maps cleanly
     onto our existing MEMORY.md `user`/`feedback` memory types.
2. **Skill-prompt eval harness** — use Phase 2 verdict attribution data to score
   skill descriptions, propose rewrites for high-miss skills, A/B them via the
   router, promote winners. (Wayland *advertises* this but has not implemented
   it — source inspection confirmed. Shipping it would leapfrog the reference.)
3. **Cost/token attribution** — Wayland tracks per-conversation `CostEvent`
   rows (model, tokens, USD) with budgets that warn/pause. vaultflow captures no
   token counts today; investigate whether hook payloads expose usage, then add
   a `cost_events` table + Mission Control budget strip.
4. **Auto-apply model recommendations** — config toggle once one-click accept has
   built trust.
5. **Agent auto-retirement** — flag vault_agents/vault_tools with zero use in 90
   days for review.
6. **Remote access hardening** — Tailscale-style guidance for reaching the
   dashboard off-box.
