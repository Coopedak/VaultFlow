# Vaultflow Deep Audit — Findings

Multi-round audit collated from data audit + 4 parallel code audit agents +
meta-audit. Severity: **C**ritical / **H**igh / **M**edium / **L**ow.

## Round 1A — Data completeness audit (DB stats)

| # | Finding | Numbers | Sev |
|---|---------|---------|-----|
| D1 | Sessions never close (`ended_at`/`duration_ms` NULL) | 39/172 (22.7%); 20/23 claude sessions; 19 today | **C** |
| D2 | Sessions missing `model` | 101/172 (58.7%) | **H** |
| D3 | Sessions missing `model_provider` | 159/172 (92.4%) | **H** |
| D4 | Sessions missing `cli_version` | 100/172 | M |
| D5 | Sessions missing `cli` | 63/172 (36.6%) | **H** |
| D6 | Sessions missing `project` | 22/172 | M |
| D7 | Prompts missing `source` | 186/666 (28%) | **H** |
| D8 | Prompts with empty `prompt_text` | 19/666 | M |
| D9 | `vault_tools.path` NULL for every row | 81/81 | **H** |
| D10 | `vault_agents.description` NULL | 41/120 (34%) | M |
| D11 | Project detection produces noise (`system32`, `YOU`, `GIT`, `merge-master-worktree`, `CGITtacklerack_reporesearch`, `.claude`, `memory`, `rules`, `skills`) | many | **H** |
| D12 | `C:GITvaultflowdocs` rogue folder in repo root (path-concat bug) | exists | **H** |
| D13 | Model name inconsistencies in DB (`GPT-5` vs `gpt-5.4`, `claude-sonnet-4.5` vs `claude-sonnet-4-6`) | mixed | **H** |
| D14 | Patterns: `agent` NULL for all 70; all `promoted=1` | 70/70 | M |
| D15 | `retrieval_feedback` only 4 rows vs 24,050 retrieval_docs | barely wired | **H** |
| D16 | `npm test` broken on Node 24 (`--test tests/` ≠ glob) | hard fail | **H** |
| D17 | `.debug-hook.log` shows recent EPIPE in auto-memory-hook.mjs:248 | recent | M |

## Round 1B — Code-level audit findings (pending / arriving from agents)

### Router / intelligence / retrieval (Agent #4 — DONE)

| # | File:Line | Finding | Sev |
|---|-----------|---------|-----|
| R1 | `model-router.cjs:25-29` + `db.cjs:99-100` | No model-name normalizer; dashes vs dots mismatch silently breaks demotion logic | **H** |
| R2 | `db.cjs:1805-1849` | 273 NULL `skill_routed` is expected (no skill matched) — not a bug | L |
| R3 | `intelligence.cjs:115-117` | `pending-insights.jsonl` lacks agent field; all patterns get `agent='auto'` | M |
| R4 | `intelligence.cjs:136-187` | Promotion only checks `fire_count >= threshold`, no quality heuristics | M |
| R5 | `db.cjs:278-295` | `retrieval_feedback` schema exists but no caller populates it; no feedback loop | **H** |
| R6 | `audit.mjs`, `project-audit.mjs` | Both work; not exposed prominently | L |
| R7 | `mcp-server.cjs:312` | Functional; skill list is filesystem not DB-indexed | L |

### Hook lifecycle (Agent #1 — DONE)

| # | File:Line | Finding | Sev | Note |
|---|-----------|---------|-----|------|
| H1 | `session.cjs:160`, `db.cjs:1238` | `dbUpsert()` runs on session-start with NULL `ended_at`/`duration_ms`; `COALESCE(excluded.ended_at, sessions.ended_at)` keeps NULL if SessionEnd never fires | **C** | needs verify: which hook closes? |
| H2 | `watcher.mjs:81, 95` | Generic watcher sessions create rows without `cli` field; only Copilot/Codex paths set it | **H** | confirmed |
| H3 | `session.cjs:84-108`, `db.cjs:1226-1230` | claude sessions never sniff `model`/`model_provider`/`cli_version` from env or capture them from runtime | **H** | confirmed |
| H4 | `post-edit.cjs:40-51`, `watcher.mjs:147-156` | `deriveProject()` falls back to `path.basename(path.dirname(filePath))` → produces `system32`, `.claude`, `memory`, `rules` | **H** | confirmed |
| H5 | unknown | `C:GITvaultflowdocs` folder = string concat without separator | L | confirmed exists |
| H6 | (claimed) `db.cjs:250, 1829` | Agent claimed `prompts.source` column missing — **FALSE POSITIVE**: column exists via ALTER TABLE on `db.cjs:1056` (verified). 186 NULL-source rows are all from 2026-05-06 with `session.cli=NULL` (pre-migration historical) | — | reject as bug |
| H7 | `hook-handler.cjs:212, 228, 658` | `sanitizeString(... \|\| '', 8000)` returns empty string for missing payloads; `recordPrompt` inserts empty `prompt_text` without validation | M | confirmed |

### Cross-agent meta-finding

Two agents independently reported "prompts.source column missing" (false positive — column added via `ALTER TABLE` migration on `db.cjs:1056`). Lesson: schema is split between `CREATE TABLE` and migration ALTERs; future audits must read both.

### Documentation drift

- `package.json` says **1.2.0**, CHANGELOG.md tops out at **1.1.0**, recent commit reads `feat(v1.3.0)`.
- `CLAUDE.md`: "12 API endpoints" — actual count is **24**.
- `AGENTS.md` contains literal `C:\Users\YOU\` placeholder paths instead of substituted `C:\Users\YOU\`.
- `AGENTS.md` agents table has many `---` and `name: ...` artefacts — markdown frontmatter parser leaks the raw `name:` field into description.
- `npm test` broken on Node 24 (`--test tests/` no longer auto-globs; works when run per file).

### Discovery from claude-mem comparison

- `pending_messages` durable queue pattern (UNIQUE on tool_use_id) — borrow to survive hook crashes.
- `observation_feedback` table — wire it. Vaultflow already has `retrieval_feedback` schema but barely populates it (4 rows for 24,050 docs).
- `<private>...</private>` tag stripping at hook edge — 50 lines, useful.
- Structured session_summary fields (request/investigated/learned/completed/next_steps).

### Dashboard / TUI / endpoints (Agent #2 — DONE)

| # | File:Line | Finding | Sev | Note |
|---|-----------|---------|-----|------|
| DB1 | `server.mjs:4` | Comment + CLAUDE.md claim "12 endpoints" — there are 24 | M | doc drift |
| DB2 | `server.mjs:37` | `USERPROFILE \|\| '' + 'vault/methodology/.metrics'` — operator-precedence bug; falls back to `'vault/...'` (no leading slash) when env var missing | **H** | |
| DB3 | `server.mjs:566` | FTS5 `INSERT INTO ftstable(ftstable) VALUES('integrity-check')` — agent flagged; **false positive** (this is correct FTS5 command syntax) | — | reject |
| DB4 | `server.mjs:98` | Table name interpolation in COUNT — agent flagged "SQL injection critical"; **false positive** (hardcoded allowlist, not user input) | — | reject |
| DB5 | `server.mjs:1829` | Agent says `prompts.source` column doesn't exist — **false positive** (added via ALTER TABLE migration; tests pass) | — | reject |
| DB6 | `server.mjs:149` | `AVG(duration_ms)` silently excludes NULL durations — biases avg downward, doesn't surface "active sessions excluded" | M | |
| DB7 | `server.mjs:162` | byProject query has `AND project IS NOT NULL` — drops 22 sessions instead of bucketing as "unknown" | M | |
| DB8 | `server.mjs:200` | `/api/patterns/:id/promote` opens fresh DB connection, breaks `withRawDb` pattern, leak risk on throw | M | |
| DB9 | `app.js:41` | `fmtDate` shows local time silently with no UTC indicator | M | |
| DB10 | `app.js:325` | dupe_rate NULL renders as "0% green" instead of "no data" | M | |
| DB11 | `index.html:554` | UI hardcodes literal `C:/GIT` path text | M | |
| DB12 | `tui/db-reader.mjs:94-105` | `getModelRouting()` divides by `verdicts_total` with `? 0` fallback only; can yield null/NaN | M | |
| DB13 | `tui/telemetry.mjs:32` | `iso(value \|\| Date.now())` masks 0/falsy timestamps as "now" | L | |

### Parquet / watcher / backfill (Agent #3 — DONE)

| # | File:Line | Finding | Sev |
|---|-----------|---------|-----|
| P1 | `backfill.mjs:526` | `backfillTools()` calls `upsertVaultTool(toolId, name, desc, null, '')` — `path` always null | **H** |
| P2 | `backfill.mjs:358-383, 429` | Codex agents pass empty desc; user-skill parser returns `''` for minimal files | M |
| P3 | `watcher.mjs:155`, `post-edit.cjs:50` | `deriveProject()` falls back to `path.basename(path.dirname(filePath))`, captures `memory`, `rules`, `.claude`, `Temp` as project | M |
| P4 | `watcher.mjs:92-97` | `ensureSession()` never derives or sets `project` — watcher sessions are NULL | M |
| P5 | `flush-parquet.mjs`, `db.cjs:1430-1495` | Parquet flush is COPY (not MOVE); design correct, undocumented | L |
| P6 | `backfill.mjs:103-131` | Suspect glob+path.join double-resolve created `C:GITvaultflowdocs` folder | L |
| P7 | `backfill.mjs:627`, `db.cjs:1307-1325` | Backfill doesn't write timestamps to memory_entries/vault_*; by design | L |
| P8 | `copilot-resume.cjs:51` | `project = path.basename(process.cwd())` — produces "YOU" or "GIT" if invoked outside a project | M |

