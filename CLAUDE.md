# vaultflow — Claude Code Reference

## What This Is

vaultflow is the Claude Code hook system. It intercepts every Claude Code event and
adds intelligence: session tracking, edit metrics, FTS5 memory search, skill auto-injection,
tech stack detection, tool call deduplication, and a Parquet cold archive.

## Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js 18+ (CJS hooks + ESM helpers) |
| Hot store | SQLite via better-sqlite3 (FTS5 + WAL) |
| Cold archive | Apache Parquet via duckdb (Lambda architecture) |
| Dashboard | Express 4 + Chart.js SPA |
| AI agents | Codex CLI via `.agents/config.toml` (15 enabled) |
| Package manager | npm |

## Run Commands

```bash
# Install (first time)
cd C:\GIT\vaultflow && npm install --ignore-scripts

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

# Gen context files (copilot-instructions, AGENTS.md, cursor rules)
npm run gen-context [project-path]

# Install git hooks in a project
npm run install-hooks [project-path]

# Stack detection
node .claude/helpers/stack-detector.mjs [project-path]
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
  db.cjs                  — SQLite + DuckDB/Parquet core (28 exports)
  hook-handler.cjs        — main event dispatcher (all hook events)
  session.cjs             — session lifecycle (start/end/restore)
  post-edit.cjs           — edit event recorder
  router.cjs              — skill/agent routing
  intelligence.cjs        — memory + pattern matching
  auto-memory-hook.mjs    — vault/domain/ import → FTS memory
  flush-parquet.mjs       — SQLite → Parquet export API
  stack-detector.mjs      — 22-rule tech stack detector
  skill-loader.mjs        — skill content loader + injection builder
  dict.mjs                — dictionary import/search/CLI
  watcher.mjs             — chokidar daemon (Copilot/Codex tracking)
  gen-context.mjs         — context file generator
  install-git-hooks.mjs   — git hook installer
  backfill.mjs            — vault index → DB backfill
  dashboard/
    server.mjs            — Express API server (12 endpoints)
    index.html            — SPA shell
    app.js                — Chart.js dashboard

config/
  vaultflow.yaml          — all config (paths, storage, intelligence, dashboard)

.agents/
  config.toml             — Codex CLI config (15 enabled / 119 disabled)
  skills/                 — 134 skill directories
  README.md               — agent docs + trigger table
```

## Knowledge Hierarchy

Before answering domain questions or implementing anything, check in this order:
1. This file (CLAUDE.md) — project-specific rules
2. `C:\Users\YOU\vault\index.md` — cross-project patterns, tools, methodology
3. Source code — actual implementation
