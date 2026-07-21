# vaultflow — Claude Code Reference

## What This Is

vaultflow is the Claude Code hook system. It intercepts every Claude Code event and
adds intelligence: session tracking, edit metrics, FTS5 memory search, skill auto-injection,
tech stack detection, tool call deduplication, and a Parquet cold archive.

## Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js 22+ (CJS hooks + ESM helpers) |
| Hot store | SQLite via node:sqlite built-in (FTS5 + WAL) |
| Cold archive | Apache Parquet via @duckdb/node-api (Lambda architecture) |
| Dashboard | Express 4 + Chart.js SPA (73 endpoints) |
| AI agents | Codex CLI via `.agents/config.toml` (15 enabled) |
| Package manager | npm |

## Run Commands

```bash
# Fresh machine (installs required software too: Node 22+, Git, Claude Code CLI via winget/npm,
# then npm deps, config bootstrap, vault skeleton, hooks, task, watcher, plugin, doctor)
powershell -ExecutionPolicy Bypass -File scripts/install.ps1

# Install (first time, Node already present) — setup auto-installs npm deps if missing
cd C:\GIT\vaultflow && npm install --ignore-scripts

# Setup / install on this machine (idempotent — safe to re-run)
npm run setup                  # prereqs + config + vault skeleton + global hooks + CLI link + user-scope MCP
                               # + curated skills + nightly task + watcher + dev-team plugin, then doctor
npm run setup:dry-run          # show what would change, write nothing
npm run setup:hooks-only       # only (re)install the global hooks
npm run setup:uninstall        # remove everything vaultflow installed (see below)
npm run install-dev-team       # install ONLY the vendored dev-team plugin
vaultflow install              # same as `npm run setup` once the CLI is linked
#
# What "install" makes machine-wide (the point is that NONE of it is repo-local):
#   hooks   → vaultflow's canonical hook set is merged into ~/.claude/settings.json
#             (USER-global) so hooks fire in EVERY project. Hooks belonging to other
#             tools are PRESERVED — install merges, it does not replace the hooks
#             object. The project's own .claude/settings.json deliberately declares
#             no lifecycle hooks; duplicating them there makes each one fire twice.
#             Canonical set lives in scripts/install.mjs (CANONICAL_HOOKS).
#   MCP     → registered in ~/.claude.json under mcpServers (user scope). The repo's
#             .mcp.json is PROJECT scope only, so without this the vaultflow MCP tools
#             (find_symbol, blast_radius, search_memory …) exist only inside this repo.
#   skills  → the skills marked `enabled = true` in .agents/config.toml are copied to
#             ~/.claude/skills so the CLI can use them from any project. Copies carry a
#             .vaultflow-managed marker; a hand-authored skill of the same name is never
#             overwritten, and uninstall removes only marked copies.
# Prior user settings are backed up to ~/.claude/backups/; other keys (model/theme/…)
# are preserved. Skip steps with --no-mcp / --no-skills / --no-dev-team / --no-nightly.
# Also registers plugins/dev-team as a local marketplace. See "Dev Team plugin" below.

# Fresh machine, start to finish (installs Node/Git/Claude CLI first, then the above)
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 --dry-run   # flags forward to install.mjs

# Dashboard
npm run dashboard              # http://localhost:7700

# TUI — multi-pane blessed UI, each session is its own claude PTY in the same window
npm run tui                    # left: sessions list; right: live PTY for the focused session
                               # N = new claude session, K = kill, P = popout to external term
                               # also reachable as `opentui` from any PowerShell window

# csm browser — single-pane historical session list (from ~/.claude/history.jsonl)
npm run tui:browse             # syncs vaultflow names → ~/.claude/sessions.json, then launches csm
npm run tui:sync               # sync names only, no UI

# Watcher (Copilot/Codex file tracking)
npm run watcher
npm run watcher:stop

# Backfill DB from vault indexes
npm run backfill
npm run backfill -- --skills-only
npm run backfill -- --tools-only
npm run backfill -- --dry-run

# Flush SQLite → Parquet
node .claude/helpers/flush-parquet.mjs

# Dictionary
npm run dict                   # stats
npm run dict:import            # import from vault/domain/
node .claude/helpers/dict.mjs --search "thermal spray"
node .claude/helpers/dict.mjs --add "term" "category" "definition"

# Import Claude Desktop / claude.ai chats
npm run import-chats                      # import from paths.claude_export_dir
npm run import-chats [path]               # import from explicit dir or conversations.json file
npm run import-chats [path] --dry-run     # parse + count, write nothing
npm run import-chats [path] --json        # print summary as JSON

# Gen context files (copilot-instructions, AGENTS.md, cursor rules)
npm run gen-context [project-path]

# Install git hooks in a project
npm run install-hooks [project-path]

# Stack detection
node .claude/helpers/stack-detector.mjs [project-path]

# Headless brain access — query vaultflow's brain from any tool (Codex/Copilot/cron/scripts)
vaultflow search <query> [--json]        # search memory/symbols/commits
vaultflow find-skill "<task>" [--json] [--limit N]  # find existing skills before authoring new ones
vaultflow context [project] [--json]     # context vaultflow would inject
vaultflow graph [--center id] [--json]   # brain graph (nodes/edges/meta)
vaultflow mission [--json]               # Mission Control ledger
vaultflow flows discover [--project]     # discover flows (entry-point detect + transitive trace); prune-exempt user-declared entries preserved
vaultflow flows list [--json]            # list cataloged flows for a project
vaultflow flows declare <file> <symbol>  # declare a manual entry point (persisted; prune-exempt)
vaultflow flows declared [--json]        # list user-declared entry points
vaultflow impact <file-or-symbol> [--json]  # downstream/upstream impact + affected flows (verified/handoff/not-affected) + root-cause direction
vaultflow doctor                         # health audit
```

## Critical Architecture Rules

1. **CJS/ESM boundary** — hook-handler.cjs (CJS) MUST use `await import()` for ESM modules. Never `require()` an `.mjs` file.
2. **DB initialize guard** — `db.initialize()` is idempotent. Call it before every DB operation. Once open, stays open.
3. **FTS5 content tables** — `dictionary_fts`, `prompts_fts`, `vault_tools_fts` are content-backed. Write via `upsertDictionaryEntry()` etc., never INSERT directly.
4. **Parquet flush** — `edit_events` + `sessions` via `flushToParquet()`; `tool_calls` + `prompts` via `flushTelemetryToParquet()`. Both called in `flush-parquet.mjs main()`.
5. **BM25 rank direction** — `bm25()` returns negative values. `ORDER BY rank ASC` = most relevant first.
6. **native modules** — `better-sqlite3` requires `npm install --ignore-scripts` to avoid node-gyp failures on Windows. The `.node` binding is pre-built.
7. **Claude Desktop chats** — imported chats reuse the `sessions` table (not a separate table); distinguished by `cli='claude-desktop'`. The `imported_chats` idempotency table dedupes on conversation uuid + updated_at. See ADR-001 for rationale.
8. **Skill reuse finder** — skills get reuse-before-build enforcement via `search_skills` MCP tool, `vaultflow find-skill` CLI, and a non-blocking PreToolUse(Write) authoring gate. Search is over `vault_agents` name/description (body/semantic deferred). Verdict (REUSE/MODIFY/BUILD-NEW-OK) is advisory; gate fires only on NEW skill writes via Write tool. See ADR-002 for design.
9. **Flow catalog is APPROXIMATE** — discovered from call-graph (bare-name identifier resolution) and router-import hinting; partial by design (decorators, dynamic dispatch, DB/event/queue couplings not auto-detected). Every flow carries `confidence` (auto|manual|declared) and `source` markers; per-node `ambiguous` flags signal bare-name collisions. User-declared entry points (`vaultflow flows declare <file> <symbol>`) form the recall floor (prune-exempt, re-traced nightly). Human annotation (name/description/user_notes) marks a flow manual and reads authoritatively as the ground truth for the agent. Flows are stored in `flows`/`flow_nodes`/`flow_edges` tables with a 150-node transitive limit per flow + cycle detection. Dashboard "Flows" tab surfaces each flow as a Cytoscape flowchart; declare/annotate forms are available for human curation. See ADR-003 for design.
10. **Agent creation is deterministic, not LLM-powered** — the Agents wizard in Synapse v2 (dashboard/js/agents.js + agent-authoring.mjs) fills SKILL.md + agents/*.md templates via schema validation and file merging, with zero model calls. Stack auto-detection reuses existing stack-detector.mjs; reuse search reuses existing skill-reuse.cjs. New agents write to ~/.claude (Claude Code's config), not the project. Newly created agents are dispatchable after Claude Code restart and appear in reuse-search after `npm run backfill --skills-only`. v1 creates single agents only; teams are deferred to v2. See ADR-004 for design.
11. **CodeFlow code-intelligence features** — churn, health-score, and visualization layers (code-graph, treemap) use hybrid git/edit-events churn measurement and a deterministic 5-term health formula with data-unavailable guards. No new dependencies: squarified treemap is pure JS (~60 lines), Cytoscape is vendored. All critical logic (parseGitNameOnly, countCycles, scoreFromStats, squarify) is pure and separately unit-testable; WHY comments explain intent, not mechanics. See ADR-005 for architecture, formula rationale, and data-integrity guards (path containment, SQL binding, honest unavailability signals).
12. **`edit_events` is an append-only log; the analytics view is filtered, not the table** — `edit_events` feeds hot-files, churn, the treemap, and the health score, so anything recorded there is ranked as if a human authored it. Three invariants keep it honest, all defined once in `path-filter.cjs` and applied at BOTH write time (`watcher.mjs`) and read time (`db.queryEditFrequency`): (a) *noise rejection* — pattern-based (`.metrics/`, `node_modules`, `.duckdb`/`.sqlite`, `.git-*/`, build output) PLUS per-repo `git check-ignore`, because no global list can decide `public/` (authored in React, generated by Quartz); the git check is directory-level and cached by ancestor, so an ignored tree costs one subprocess. (b) *path canonicalization* — Windows reports the same file as `C:\Git\…` (Claude hook, session cwd) and `C:\GIT\…` (watcher, watch root); `realpathSync.native` converges new rows, `mergePathCasing` folds historical ones at read time. (c) *no double counting* — `flushToParquet` COPIES rows without deleting, so Parquet is a strict SUBSET of SQLite; the union in `queryEditFrequency` must dedupe on `edit_events.id`, never `UNION ALL`. Rows are never purged: the log stays auditable and tightening a rule retroactively fixes every consumer.

## File Map

```
.claude/helpers/
  db.cjs                     — SQLite + DuckDB/Parquet core (28 exports)
  code-graph.cjs             — lightweight per-file symbol + import indexer
  brain-notes.cjs            — Atlas note core: memory_entries + [[wikilinks]] → notes / backlinks / local graph
  embeddings.mjs             — local semantic embeddings for memory_entries
  commit-indexer.cjs         — index git commit messages into FTS5 across projects
  hook-handler.cjs           — main event dispatcher (all hook events)
  session.cjs                — session lifecycle (start/end/restore)
  session-start-bg.mjs       — background indexing for SessionStart
  post-edit.cjs              — edit event recorder + live FTS5 re-index for wiki/vault files
  router.cjs                 — skill/agent routing
  model-router.cjs           — automatic model tier demotion for sub-agents
  intelligence.cjs           — memory + pattern matching
  pre-edit.cjs               — PreToolUse(Edit|Write|MultiEdit) blast-radius warning
  pre-read.cjs               — PreToolUse(Read) file-context injection
  pre-search.cjs             — PreToolUse(Grep|Glob) MCP-tool suggestion
  pre-bash.cjs               — PreToolUse(Bash) MCP-equivalent suggestion
  shell-intent.cjs           — extract read-intent file paths from a Bash command string
  git-context.cjs            — surface current git state at session start
  focus.cjs                  — load and write the per-project "current focus" file
  project-id.cjs             — resolve canonical project name from a file path
  path-filter.cjs            — single definition of "is this a real, authored edit?" (pattern + gitignore
                               noise rejection, Windows path-casing canonicalization). Shared by
                               watcher.mjs at WRITE time and db.cjs at READ time so they cannot drift.
  copilot-resume.cjs         — prints a brief session resume block to stderr
  auto-memory-hook.mjs       — vault/domain/ import → FTS memory
  dict.mjs                   — dictionary import/search/CLI
  import-claude-chats.mjs    — Anthropic official export (conversations.json) → sessions/prompts/memory
  backfill.mjs               — vault index → DB backfill
  watcher.mjs                — chokidar daemon (Copilot/Codex/background agent tracking)
  ensure-watcher.mjs         — idempotent watcher daemon launcher
  flush-parquet.mjs          — SQLite → Parquet export API
  cli-telemetry-backfill.mjs — one-shot Copilot/Codex session metadata backfill
  nightly.mjs                — nightly maintenance (DB hygiene, code graph, embeddings, Parquet)
  doctor.mjs                 — one-command health audit
  audit.mjs                  — vaultflow health audit
  lint.mjs                   — vaultflow data-hygiene linter
  cleanup.mjs                — repo-hygiene: mangled-path junk, gitignored logs, empty dirs, untracked-doc review
  doc-drift-check.mjs        — verify CLAUDE.md claims against repo reality
  stack-detector.mjs         — 22-rule tech stack detector
  skill-loader.mjs           — skill content loader + injection builder
  skill-reuse.cjs            — shared skill-relevance scorer (overlap coefficient for find-skill / search_skills / authoring gate)
  flow-catalog.cjs           — flow discovery (entry-point detect + transitive trace + cycle detection + 150-node cap + noise stop-list + quality gate)
  flow-impact.cjs            — upstream/downstream impact + per-flow verdict (affected/affected-handoff/verify/not-affected) + root-cause direction (shallow 2-depth walk + text-match commit correlation)
  flow-excalidraw.cjs        — pure, deterministic flow → Excalidraw document converter
  flows-draw.mjs             — batch flow → Excalidraw drawing generator (nightly)
  export-quartz.mjs          — static Quartz-style HTML export of the Atlas brain view
  gen-context.mjs            — context file generator
  install-git-hooks.mjs      — git hook installer
  sync-csm-names.mjs         — derives friendly session names from prompts → ~/.claude/sessions.json (read by csm TUI; never overwrites user-set names)
  plan-init.mjs              — project-lift plan scaffolder
  project-audit.mjs          — inventory C:\GIT projects + correlate vaultflow history
  agent-authoring.mjs        — pure ESM: slug validation, SKILL.md + agents/*.md renderers, safe devteam-config.json merge, reuse + stack lookup, createAgent orchestrator
  churn.cjs                  — file-level churn (commit frequency) from git log or edit_events fallback; primary path for code-graph/treemap coloring
  health-score.cjs           — deterministic A–F health score via Tarjan SCC + dead-code/god-object/coupling formula; guards against incomplete indexing
  backfill-line-count.mjs    — idempotent backfill for code_symbols.line_count (migration v7); enables accurate treemap leaf sizing
  mcp-server.cjs             — vaultflow MCP (Model Context Protocol) server
  dashboard/
    server.mjs               — Express API server + serves the live SPA (incl. /api/notes for Atlas, /api/health, /api/code-graph/import-graph)
    index.html               — legacy v1 SPA shell (Brain tab + operational tabs, served at /v1)
    app.js                   — v1 Chart.js + Cytoscape dashboard logic
    index-v2.html            — Synapse v2 shell (modular js/ views; the default UI at / and /v2)
    js/
      core.js                — v2 SPA core: hash router, view registry, api() fetch, mount
      command-center.js      — v2 Command Center home view + health-score dial (A–F grade)
      charts.js              — v2 Chart.js theme defaults + sparkline/line factories
      format.js              — v2 formatting helpers
      atlas.js               — Atlas view: Quartz-style brain notes (markdown + backlinks + local graph + search)
      activity-sessions.js   — Sessions list view
      activity-edits.js      — Hot files (most edited) view
      activity-prompts.js    — Recent prompts + skill routing view
      activity-tools.js      — Tool Calls view
      brain-memory.js        — FTS memory search view
      brain-graph.js         — Brain Graph view
      brain-dictionary.js    — Dictionary browser view
      brain-discoveries.js   — Code pattern discoveries view
      code-flows.js          — Flows view (Cytoscape flowcharts + declare/annotate forms)
      code-stacks.js         — Tech stack detection card grid
      learning-agents.js     — Agent usage list view
      learning-patterns.js   — Learning patterns view
      system-control.js      — Control panel view
      system-health.js       — System health table + unified search
      agents.js              — Agents view: 7-step deterministic wizard (no-LLM) for single-agent creation w/ stack detect + reuse search
      project-store.js       — shared project selector (localStorage 'vf_project', seeded from /api/projects mostActive)
      code-graph.js          — import-dependency Cytoscape view (Folder | Churn coloring, legend, cose layout)
      treemap.js             — squarified treemap view (leaf area ∝ LOC, Folder | Churn coloring, cell tooltips)
      viz-util.js            — pure color + layout helpers: churnColor, folderColor, scoreToGrade, gradeColor, squarify (Bruls et al.)
    vendor/
      chart.umd.min.js       — vendored Chart.js (UMD)
      cytoscape.min.js       — vendored Cytoscape
      markdown-it.min.js     — vendored markdown renderer (MIT), used by the Atlas view

config/
  resolve.cjs             — config resolution (local → yaml → example)
  vaultflow.local.yaml    — your real paths (gitignored — create from example)
  vaultflow.yaml          — alternate name (gitignored)
  vaultflow.example.yaml  — committed template with YOU placeholder paths

.agents/
  config.toml             — Codex CLI config (15 enabled / 119 disabled)
  skills/                 — 134 skill directories
  README.md               — agent docs + trigger table

plugins/
  dev-team/               — vendored Claude Code plugin (multi-agent dev team, self-contained marketplace)
```

## Dev Team plugin

`plugins/dev-team/` vendors the **Dev Team** Claude Code plugin (v1.5.1) directly into the
repo — it is both a plugin and its own marketplace, so it installs from disk with no GitHub
access. `npm run setup` (or `npm run install-dev-team`) registers `plugins/dev-team` as a
local marketplace and runs `claude plugin install dev-team@dev-team --scope user`.

It adds a multi-agent team to Claude Code: a **Project Manager** orchestrates a **Researcher**,
**Code Developer**, **Code Reviewer**, **Documenter**, **Integrator**, and a **Voice of Reason**
advisor through a Plan → Research → Develop → Review → Document → Integrate pipeline. The
integrator never pushes/merges without explicit human approval. Ships a shared coding-standards
interface (override per-repo with `.dev-team/standards.md`) and analytics.

- **Use it:** in any project, "use the dev team to add a customer search feature" — the session
  becomes the Project Manager and dispatches specialist agents.
- **Activation:** plugins load at Claude Code session start — restart Claude Code after install.
- **Report:** `/dev-team-report` shows team activity (needs Node for analytics).
- **Remove:** `npm run setup:uninstall`, or `/plugin uninstall dev-team@dev-team`.
- Distinct from vaultflow's own hooks/agents: the plugin runs in Claude Code's plugin namespace
  with its own `${CLAUDE_PLUGIN_ROOT}` analytics hooks; it does not touch the vaultflow DB.

## Background Agent Integration

When vaultflow spawns a sub-agent (SubagentStop hook fires), it writes
`{metrics_root}/agent-context.json` with:

```json
{
  "db_path": "/abs/path/to/vaultflow.db",
  "session_id": 42,
  "project": "PRGJSMES",
  "helpers_dir": "/abs/path/to/.claude/helpers",
  "top_memory": [{ "title": "...", "source": "..." }],
  "updated_at": "2026-01-01T00:00:00Z"
}
```

Background agents (Codex, Cursor, Copilot) can read this file to:
- Connect to the shared DB and log their own tool calls / prompts
- Search FTS5 memory: `node {helpers_dir}/db.cjs --search "query"`
- Know the current session ID for cross-session attribution

The watcher daemon (auto-started on SessionStart) catches filesystem edits from
any tool that doesn't fire Claude Code hooks, so all file activity is recorded
regardless of which agent made the edit.

## Import Your Claude Desktop Chats

vaultflow can import conversations from Claude Desktop or claude.ai into your Brain. Chats become searchable sessions linked to projects and appear in the dashboard.

**Setup (one time):**
1. Go to claude.ai → Settings → Privacy → Export data → Download your conversations as `conversations.json`
2. Create a folder at the path specified in `paths.claude_export_dir` (default: `~/Downloads/claude-exports`)
3. Drop the `conversations.json` file (or an unzipped export folder) into that folder

**Import:**
- Manual: `npm run import-chats` (imports from the watched folder)
- Manual with a specific file: `npm run import-chats C:/path/to/conversations.json`
- Automatic: the nightly job (3AM Windows task) auto-detects new/changed exports and imports them

**What happens:**
- Each conversation becomes a searchable session node in the Brain graph (distinguished by `cli='claude-desktop'`)
- Each human message becomes a full-text searchable prompt row
- The full transcript becomes a searchable memory entry (FTS + embeddings)
- Conversations are linked to their project if projects.json is present in the export

Run `npm run import-chats --dry-run` to see what would be imported without writing to the database.

## Finding an Existing Skill Before Building a New One

Before authoring a new skill, check if one already exists that you can reuse or adapt. vaultflow surfaces existing skills via three checkpoints:

**CLI (headless access for scripts/cron):**
```bash
vaultflow find-skill "webhook retry logic"        # returns ranked skills with verdict
vaultflow find-skill "error handler" --json       # JSON output for tooling
```

**MCP tool (in Claude Code sessions):**
- `search_skills` — query tool with mandate to call before creating. Returns top matches, each with a verdict:
  - **REUSE**: ≥30% overlap — high likelihood this skill already does what you need
  - **MODIFY**: 15–30% overlap — adapt an existing skill instead of building new
  - **BUILD-NEW-OK**: <15% overlap — no strong match, OK to build new

**Authoring gate (automatic reminder):**
- When you write a new skill file (with name+description frontmatter) via the Write tool, vaultflow logs a non-blocking reminder with the closest matches. You can ignore it and build new — the gate is advisory, not enforced. Authoring via Edit/MultiEdit won't trigger the gate; use the `search_skills` tool or CLI in those cases.

All three surfaces search the same index (backfilled nightly from `.agents/skills/`, `.claude/skills/`, and user skill directories).

## Knowledge Hierarchy

Before answering domain questions or implementing anything, check in this order:
1. This file (CLAUDE.md) — project-specific rules
2. `config/vaultflow.local.yaml → paths.vault_root` + `/index.md` — cross-project patterns, tools, methodology
3. Source code — actual implementation
