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
| Dashboard | Express 4 + Chart.js SPA (44 read-only API endpoints) |
| AI agents | Codex CLI via `.agents/config.toml` (15 enabled) |
| Package manager | npm |

## Run Commands

```bash
# Install (first time)
cd C:\GIT\vaultflow && npm install --ignore-scripts

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

# Gen context files (copilot-instructions, AGENTS.md, cursor rules)
npm run gen-context [project-path]

# Install git hooks in a project
npm run install-hooks [project-path]

# Stack detection
node .claude/helpers/stack-detector.mjs [project-path]

# Headless brain access — query vaultflow's brain from any tool (Codex/Copilot/cron/scripts)
vaultflow search <query> [--json]        # search memory/symbols/commits
vaultflow context [project] [--json]     # context vaultflow would inject
vaultflow graph [--center id] [--json]   # brain graph (nodes/edges/meta)
vaultflow mission [--json]               # Mission Control ledger
vaultflow doctor                         # health audit
```

## Critical Architecture Rules

1. **CJS/ESM boundary** — hook-handler.cjs (CJS) MUST use `await import()` for ESM modules. Never `require()` an `.mjs` file.
2. **DB initialize guard** — `db.initialize()` is idempotent. Call it before every DB operation. Once open, stays open.
3. **FTS5 content tables** — `dictionary_fts`, `prompts_fts`, `vault_tools_fts` are content-backed. Write via `upsertDictionaryEntry()` etc., never INSERT directly.
4. **Parquet flush** — `edit_events` + `sessions` via `flushToParquet()`; `tool_calls` + `prompts` via `flushTelemetryToParquet()`. Both called in `flush-parquet.mjs main()`.
5. **BM25 rank direction** — `bm25()` returns negative values. `ORDER BY rank ASC` = most relevant first.
6. **native modules** — `better-sqlite3` requires `npm install --ignore-scripts` to avoid node-gyp failures on Windows. The `.node` binding is pre-built.

## File Map

```
.claude/helpers/
  db.cjs                     — SQLite + DuckDB/Parquet core (28 exports)
  code-graph.cjs             — lightweight per-file symbol + import indexer
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
  copilot-resume.cjs         — prints a brief session resume block to stderr
  auto-memory-hook.mjs       — vault/domain/ import → FTS memory
  dict.mjs                   — dictionary import/search/CLI
  backfill.mjs               — vault index → DB backfill
  watcher.mjs                — chokidar daemon (Copilot/Codex/background agent tracking)
  ensure-watcher.mjs         — idempotent watcher daemon launcher
  flush-parquet.mjs          — SQLite → Parquet export API
  cli-telemetry-backfill.mjs — one-shot Copilot/Codex session metadata backfill
  nightly.mjs                — nightly maintenance (DB hygiene, code graph, embeddings, Parquet)
  doctor.mjs                 — one-command health audit
  audit.mjs                  — vaultflow health audit
  lint.mjs                   — vaultflow data-hygiene linter
  doc-drift-check.mjs        — verify CLAUDE.md claims against repo reality
  one-time-cleanup.cjs       — one-time idempotent data cleanup against the live DB
  stack-detector.mjs         — 22-rule tech stack detector
  skill-loader.mjs           — skill content loader + injection builder
  gen-context.mjs            — context file generator
  install-git-hooks.mjs      — git hook installer
  sync-csm-names.mjs         — derives friendly session names from prompts → ~/.claude/sessions.json (read by csm TUI; never overwrites user-set names)
  plan-init.mjs              — project-lift plan scaffolder
  project-audit.mjs          — inventory C:\GIT projects + correlate vaultflow history
  mcp-server.cjs             — vaultflow MCP (Model Context Protocol) server
  dashboard/
    server.mjs               — Express API server (44 endpoints)
    gen.mjs                  — generate a self-contained HTML dashboard
    index.html               — SPA shell
    app.js                   — Chart.js dashboard

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

## Knowledge Hierarchy

Before answering domain questions or implementing anything, check in this order:
1. This file (CLAUDE.md) — project-specific rules
2. `config/vaultflow.local.yaml → paths.vault_root` + `/index.md` — cross-project patterns, tools, methodology
3. Source code — actual implementation
