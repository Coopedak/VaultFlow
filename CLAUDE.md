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
| Dashboard | Express 4 + Chart.js SPA (50 endpoints) |
| AI agents | Codex CLI via `.agents/config.toml` (15 enabled) |
| Package manager | npm |

## Run Commands

```bash
# Install (first time)
cd C:\GIT\vaultflow && npm install --ignore-scripts

# In PowerShell, use `npm.cmd` instead of `npm` if script execution is blocked.

# Setup / install on this machine (idempotent — safe to re-run)
npm run setup                  # global hooks + `npm link` CLI + nightly task + watcher, then doctor
npm run setup:dry-run          # show what would change, write nothing
npm run setup:hooks-only       # only (re)install the global hooks
npm run setup:uninstall        # remove global hooks + nightly task
vaultflow install              # same as `npm run setup` (once the CLI is linked)
# Installs vaultflow's hook block into ~/.claude/settings.json (USER-global) so hooks
# fire in EVERY Claude Code project, not just the vaultflow repo. Backs up prior
# settings to ~/.claude/backups/ and preserves existing keys (model/theme/etc).

# Dashboard
npm run dashboard              # http://localhost:7700

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

## File Map

```
.claude/helpers/
  db.cjs                  — SQLite + DuckDB/Parquet core (28 exports)
  hook-handler.cjs        — main event dispatcher (all hook events)
  session.cjs             — session lifecycle (start/end/restore)
  post-edit.cjs           — edit event recorder + live FTS5 re-index for wiki/vault files
  router.cjs              — skill/agent routing
  intelligence.cjs        — memory + pattern matching
  auto-memory-hook.mjs    — vault/domain/ import → FTS memory
  flush-parquet.mjs       — SQLite → Parquet export API
  stack-detector.mjs      — 22-rule tech stack detector
  skill-loader.mjs        — skill content loader + injection builder
  skill-reuse.cjs         — shared skill-relevance scorer (overlap coefficient for find-skill / search_skills / authoring gate)
  flow-catalog.cjs        — flow discovery (entry-point detect + transitive trace + cycle detection + 150-node cap + noise stop-list + quality gate)
  flow-impact.cjs         — upstream/downstream impact + per-flow verdict (affected/affected-handoff/verify/not-affected) + root-cause direction (shallow 2-depth walk + text-match commit correlation)
  dict.mjs                — dictionary import/search/CLI
  import-claude-chats.mjs — Anthropic official export (conversations.json) → sessions/prompts/memory
  watcher.mjs             — chokidar daemon (Copilot/Codex/background agent tracking)
  gen-context.mjs         — context file generator
  install-git-hooks.mjs   — git hook installer
  backfill.mjs            — vault index → DB backfill
  dashboard/
    server.mjs            — Express API server (12 endpoints)
    index.html            — SPA shell
    app.js                — Chart.js dashboard

config/
  resolve.cjs             — config resolution (local → yaml → example)
  vaultflow.local.yaml    — your real paths (gitignored — create from example)
  vaultflow.yaml          — alternate name (gitignored)
  vaultflow.example.yaml  — committed template with YOU placeholder paths

.agents/
  config.toml             — Codex CLI config (15 enabled / 119 disabled)
  skills/                 — 134 skill directories
  README.md               — agent docs + trigger table
```

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
