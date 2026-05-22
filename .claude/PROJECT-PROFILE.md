# Project Profile: vaultflow

_Maintained by session-reviewer. Last updated: 2026-05-21_

---

## Identity

| Field | Value |
|-------|-------|
| Name | vaultflow |
| Path | C:\GIT\vaultflow |
| Type | Node.js hook system + Express dashboard SPA |
| Wiki | None (CLAUDE.md is canonical) |

---

## Publishing

| Remote | URL | Purpose |
|--------|-----|---------|
| origin | https://github.com/Coopedak/VaultFlow.git | Publish — personal GitHub (public) |
| private-backup | https://github.com/Coopedak/vaultflow-private-backup.git | Dev — private mirror |

**Status:** published on personal GitHub
**Remotes correctly ordered?** Yes — personal project, origin is personal GH as expected.

---

## Tech Stack (confirmed by sessions)

### Backend
- Language: Node.js 22+ (CJS hooks + ESM helpers — boundary enforced)
- Framework: Express 4 (dashboard API)
- Data: node:sqlite (FTS5 + WAL) hot store; @duckdb/node-api Parquet cold archive
- Key libraries: chokidar (watcher daemon), blessed (TUI), Chart.js (dashboard)

### Frontend
- Dashboard SPA: vanilla JS + Chart.js, served from `.claude/helpers/dashboard/`
- TUI: blessed-based multi-pane terminal UI

### Database
- Engine: SQLite (hot, WAL mode) + Parquet (cold, via DuckDB)
- Active DB: `C:\Users\DCC\vault\methodology\.metrics\vaultflow.db` (NOT `C:\GIT\vaultflow\vaultflow.db` which is a stale stub)
- FTS5 content-backed tables: `dictionary_fts`, `prompts_fts`, `vault_tools_fts`

### Infrastructure
- Hosting: localhost only (npm run dashboard → :7700)
- CI/CD: none required — hook system runs in-process with Claude Code
- Scheduled tasks (Windows Task Scheduler):
  - `RalphLoop` — daily 02:00 → `vault/maintenance/ralph.ps1 -AutoGenerate`
  - `VaultflowNightly` — daily 03:00 → `.claude/helpers/nightly.mjs`
  - `VaultflowWatcher` — long-running file watcher daemon

---

## Active Skills

| Skill | Tier | Why |
|-------|------|-----|
| session-reviewer | Mid | Captures session learnings into this file + ai-intelligence-log.md |
| vault-librarian | Mid | Reconciles dictionary / vault_tools / vault_agents with FTS index |
| pattern-analyst | Mid | Promotes high-fire patterns to skills, prevents duplication |
| developer-backend | Mid | Node CJS/ESM helpers, SQLite/Parquet, Express endpoints |
| developer-frontend | Low | Only for dashboard SPA tweaks |
| researcher | Top | Hook-architecture decisions, DuckDB/Parquet patterns |

---

## Active Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| Claude Code hooks | Session/tool event interception | hook-handler.cjs is the dispatcher |
| Windows Task Scheduler | Nightly maintenance | 3 tasks registered (see Infrastructure) |
| vaultflow MCP | In-session lookups | find_symbol, blast_radius, search_memory, etc. |
| Codex CLI | Background agent | `.agents/config.toml`, 15 enabled / 119 disabled |

---

## Confirmed Patterns

### Architecture
- CJS/ESM boundary — `.cjs` files must use `await import()` for `.mjs`, never `require()`
- `db.initialize()` is idempotent — call before every DB op; stays open after first call
- FTS5 content tables written via wrapper functions (`upsertDictionaryEntry()`), never raw INSERT
- BM25 rank is negative — `ORDER BY rank ASC` returns most relevant first

### Hook Injection
- PreToolUse hook reads target file → injects related memory + recent edits inline
- SessionStart hook injects: rules from `~/.claude/rules/`, recent activity, MCP tool hints, code-graph top files, git status
- The rules files under `~/.claude/rules/*.md` are loaded by Claude Code itself (not vaultflow) — non-CC tools (Cursor, Codex) don't auto-see them

### Lambda Architecture
- SQLite = hot store, Parquet = cold archive
- `flushToParquet()` for edit_events + sessions; `flushTelemetryToParquet()` for tool_calls + prompts
- Both invoked from `flush-parquet.mjs main()` and from nightly step 9

### Naming
- `.cjs` extension for CommonJS (hot path, fast load)
- `.mjs` extension for ESM (helpers, CLI tools)
- Path style: forward slashes in code, backslashes only at OS-API boundary

---

## Known Gotchas

- **DB location confusion**: `C:\GIT\vaultflow\vaultflow.db` exists but is a stub (0 MB, May 7 mtime). The real DB is at `C:\Users\DCC\vault\methodology\.metrics\vaultflow.db` (currently 636 MB). Always check `config/vaultflow.local.yaml → paths.metrics_root` first.
- **better-sqlite3 install**: requires `npm install --ignore-scripts` on Windows to avoid node-gyp failures. The `.node` binding is pre-built.
- **session-reviewer auto-trigger ban**: behavior-rules.md says never invoke `/session-reviewer` mid-session. Only run via Loop 30 (3AM) or explicit user request. (This session: user explicit.)
- **Rules-vs-vaultflow injection**: User confusion when AI "doesn't know rules" — likely cause is non-Claude-Code terminal (Codex/Cursor/Copilot) which don't load `~/.claude/rules/`. Fix: rely on vaultflow's `agent-context.json` writeout for those agents.
- **Skills not in nightly.mjs**: session-reviewer, vault-librarian, pattern-analyst are skills (require Claude CLI), not Node scripts. Adding them to nightly requires shelling out to `claude` CLI, not raw `require()`.

---

## Business Rules (enforced in code)

- Skills load via the Skill tool — never via Read tool on skill files
- vaultflow MCP tools should be preferred over Grep/Read for symbol/file lookups (98% fewer tokens for `get_symbol_body`)
- All FTS5 writes go through wrappers — never bypass with raw INSERT (content table consistency)
- Parquet flush is exit-0 even on partial failure — errors go to stderr, summary to stdout

---

## Session History

| Date | What was built | Key discovery | Agents used |
|------|----------------|---------------|-------------|
| 2026-05-21 | Diagnostic + nightly schedule audit | RalphLoop + VaultflowNightly running clean. session-reviewer/vault-librarian/pattern-analyst are NOT in nightly.mjs — must shell out to claude CLI to integrate. | session-reviewer (manual), vault-librarian (manual), pattern-analyst (manual) |

---

## Flags for Next Session

- [ ] [NIGHTLY-INTEGRATION] Add session-reviewer / vault-librarian / pattern-analyst to nightly orchestration (either as Ralph tasks via IMPLEMENTATION_PLAN.md, or via `claude --no-interactive` shellout from nightly.mjs)
- [ ] [DB-STUB-CLEANUP] Delete or symlink the misleading `C:\GIT\vaultflow\vaultflow.db` stub to avoid future "DB is empty" diagnostic dead-ends
- [ ] [BG-AGENT-RULES] Non-CC terminals (Codex, Cursor, Copilot) don't load `~/.claude/rules/`. Confirm `agent-context.json` includes a `rules_snapshot` field or pointer so background agents have parity.

---

## Model Tier Signals

- 2026-05-21 session-reviewer: Mid → appropriate. Diagnostic + profile creation completed under 5 tool calls.
