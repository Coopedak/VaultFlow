# Changelog

All notable changes to vaultflow are documented here.

---

## [1.6.0] — 2026-05-08

### Added
- **Cross-CLI memory injection.** SessionStart hook now returns `additionalContext` with the recent session summaries and top memory hits for the current project, so Claude starts every conversation with prior-session awareness. The same recent-activity block is also baked into `AGENTS.md` and `.github/copilot-instructions.md` via `gen-context.mjs`, so Codex and Copilot see the same context on their next start.
- **Always-on watcher with reboot survival.** New `ensure-watcher.mjs` helper any CLI can call to idempotently start the daemon. New `install-watcher-task.ps1` registers a Windows scheduled task `VaultflowWatcher` at logon so the watcher restarts after reboots without depending on which CLI launched first. The Claude SessionStart bg path now delegates to `ensureWatcher()`.
- **Periodic context refresh from the watcher.** Every 10 min (override via `VAULTFLOW_GEN_CONTEXT_INTERVAL_MS`) the watcher drains a dirty-project set and spawns detached `gen-context` runs for projects with edits since the last tick. Copilot/Codex see fresh `AGENTS.md` / `copilot-instructions.md` even between Claude sessions.
- **`pre-subagent` hook + `active-subagent.json` tracker.** New `PreToolUse:Task` matcher writes the active subagent's identity to a small JSON file; `post-subagent` clears it; `post-edit` reads it. Patterns now attribute correctly to the subagent (developer-backend, researcher, etc.) instead of writing null.
- **Dictionary origin tagging.** `session-auto` entries now carry origin (`user` / `ai`) and tool (`claude` / `copilot` / `codex`). Stop hook reads the Claude transcript_path JSONL to harvest assistant terms tagged `session-auto:ai:claude`. All 443 pre-existing entries relabeled by best-source attribution.
- **`db.recomputeSessionAggregates(id)` + `recomputeAllSessionAggregates()`.** Derives `edits` / `commands` / `duration_ms` from event tables. Wired into `session.end()` and `closeStaleSessions()` so dashboard rows stop showing zeros. 181 historical sessions backfilled.
- **`db.getRecentSessionSummaries(project, N)`.** Returns last N non-empty summaries; powers the SessionStart context block and the gen-context recent-activity injection.

### Fixed
- **SessionStart latency: 53s → ~1s.** Heavy work (`doImport`, `stack-detect`, `gen-context`, watcher start) moved to detached `session-start-bg.mjs`; the foreground hook only registers the session and emits the context block.
- **`vault_agents.trigger_pattern` blank for 105/120 rows.** `backfill.mjs` and `post-edit.cjs` now parse YAML frontmatter `description:` and store it as both description and trigger_pattern. Backfill restored 87 of 120 trigger_patterns; remaining 33 lack frontmatter.
- **Patterns coverage was Claude-only.** `db.recordEdit` now also fires `upsertPattern` so watcher-recorded edits (Copilot, Codex, raw editor) generate pattern rows just like Claude's `post-edit` did.

### Privacy
- Untracked auto-generated context files (`AGENTS.md`, `.github/copilot-instructions.md`, `.cursor/rules/wiki.mdc`) and stale audit docs (`AUDIT-FINDINGS.md`, `AUDIT-FIX-PLAN.md`); added to `.gitignore`. Replaced hardcoded usernames in test fixtures and `e2e-verify.cjs`. Public history rewritten via `git filter-repo` to remove all historical occurrences of the maintainer's username/email.

---

## [1.5.0] — 2026-05-08

### Added (patterns adopted from claude-mem audit — see CLAUDE-MEM-REVIEW.md)
- **`<private>...</private>` tag stripping** at the recordPrompt / recordToolCall edge. Tags remain visible to the model in-conversation but never reach prompts.prompt_text or tool_calls.input_json. Hash dedup runs on the stripped payload so two calls differing only in private content still dedupe. (Note: the strip was bundled into the v1.4.0 commit alongside the hardening pass; calling it out here for traceability.)
- **PreToolUse(Read) → file-context injection** (`.claude/helpers/pre-read.cjs`). When the model is about to Read a file > 1.5KB, vaultflow queries past edits/memory for that path and returns a compact preamble via `hookSpecificOutput.additionalContext`. Wired into `.claude/settings.json` as a `Read`-matched PreToolUse hook.
- **Shell read-intent parser** (`.claude/helpers/shell-intent.cjs`). Hand-rolled tokenizer (no `shell-quote` dep added) that extracts file paths from Bash commands using `cat|head|tail|less|more|bat|view|nl|tac|file|wc` etc. Lets vaultflow capture *intent to read* before the file is touched.

Deferred for a future pass:
- Structured session-summary XML schema (request/investigated/learned/completed/next_steps).
- 3-layer retrieval contract (search → timeline → get_observations) — the actual mechanism behind claude-mem's "10x token efficiency" marketing claim.

### Tests
- 28 new tests across `privateTags.test.mjs`, `shellIntent.test.mjs`, `preRead.test.mjs`. Total suite: 50/50 passing.

## [1.4.0] — 2026-05-08

### Fixed (deep-audit hardening pass)
- **Sessions never close** — Stop/SessionEnd hook misses (IDE crash, kill -9) left 22% of sessions perpetually open. New `db.closeStaleSessions(cutoffHours)` runs on every `session.start()` and closes orphans using the latest `tool_call`/`edit_event`/`prompt` timestamp for that session.
- **Project detection produces garbage** — `deriveProject()` walked up looking for the literal string `GIT` and otherwise fell back to `path.basename(path.dirname(filePath))`, producing labels like `system32`, `.claude`, `memory`, `rules`, `YOU`. Replaced with shared `project-id.cjs` helper that walks up to the nearest `.git` directory and returns null (not the noisy basename) when no project root is found. Applied across `post-edit.cjs`, `watcher.mjs`, `session.cjs`, and `copilot-resume.cjs`.
- **Watcher sessions missing `cli` and `project`** — generic watcher session rows are now created with `cli='watcher'` and a derived project so analytics aren't biased.
- **Claude sessions missing `model`/`model_provider`/`cli_version`** — `session.cjs` now sniffs `CLAUDE_CODE_MODEL` / `ANTHROPIC_MODEL` / `CLAUDE_CODE_VERSION` env vars and infers `model_provider` from the model prefix.
- **Model name fragmentation** — `claude-sonnet-4.6` and `claude-sonnet-4-6` and `claude-sonnet-4-6-20250514` were stored as three separate rows. New `db.normalizeModelName()` is applied on `upsertSession` to canonicalize on write.
- **`vault_tools.path` 100% NULL** — `backfill.mjs` and `post-edit.cjs` now derive each tool's path from `<index-dir>/<tool-id>/` or `<index-dir>/<tool-id>.md` instead of always passing `null`.
- **Empty `prompt_text` rows** — `db.recordPrompt` returns early on empty/whitespace input rather than inserting blank rows from missing hook payloads.
- **Dashboard env-var precedence bug** — `process.env.USERPROFILE || '' + 'vault/...'` evaluated as `USERPROFILE || 'vault/...'`; fixed in both `server.mjs` and `gen.mjs`.
- **Dashboard `byProject` dropped NULL projects** — now buckets them as `(unknown)` so the chart shows the full picture.
- **Dashboard `avg_duration_ms` was silently biased** — now exposes `closed_sessions` and `active_sessions` alongside the average so the basis is honest.
- **EPIPE crash in `auto-memory-hook.mjs`** — stderr writes were synchronous and a closed pipe killed the SessionStart hook. All writes now go through a safe wrapper plus a stderr error listener.
- **Rogue `C:GITvaultflowdocs` folder** — string-concat artifact removed from repo root.
- **`npm test` broken on Node 24** — `node --test tests/` no longer auto-globs; switched to explicit pattern.
- **Dashboard "12 endpoints" doc drift** — actually has 24, comment corrected.

## [1.1.0] — 2026-05-05

### Added
- **Shell tracking** — watcher daemon now captures PowerShell commands via two parallel paths:
  - Path A: polls `ConsoleHost_history.txt` (PSReadLine) every 3 seconds — zero setup required
  - Path B: tails `shell-commands.jsonl` written by `config/vaultflow-shell-tracker.ps1` — adds timestamps + CWD
- **`config/vaultflow-shell-tracker.ps1`** — PowerShell profile snippet; reads `metrics_root` from `vaultflow.yaml` automatically (no hardcoded paths); dot-source from `$PROFILE`
- **Persistent JSONL position** — watcher saves read position to `shell-jsonl.pos` so commands written while the watcher was down are not lost on restart

### Fixed
- **Hook path backslash bug** — all hook commands in `.claude/settings.json` now use forward slashes; backslashes in bare `node` commands were consumed as escape sequences by the shell, producing mangled module paths (`ERR_MODULE_NOT_FOUND`)
- **FTS5 syntax errors** — raw user input passed directly to SQLite `MATCH` operator would crash on queries containing `OR`, `AND`, `NOT`, `"`, `*`, or `-`; all five FTS5 search functions now wrap input with `ftsPhrase()` which escapes as a phrase literal
- **skill-loader.mjs loop abort** — unreadable skill subdirectories caused the entire skill listing to abort; now only the failing directory is skipped
- **post-edit.cjs defensive initialize** — `db.initialize()` added at top of `reindexMemoryFile()` for correctness under unusual call ordering
- **Orphaned native bindings** — `npm prune` removed 198 orphaned packages including `duckdb` (old package with missing `.node` binding) that was triggering `ERR_MODULE_NOT_FOUND` on session start

### Changed
- Shell command records stored in `tool_calls` table as `tool_name = 'ShellHistory'`; never injected into prompts

---

## [1.0.0] — 2026-04-01

### Added
- Initial release: session tracking, edit metrics, FTS5 memory search, skill routing, Parquet cold archive
- Background agent gap closure: watcher daemon auto-start, `agent-context.json` for Codex/Cursor/Copilot
- Zero-config setup: `vaultflow.yaml` gitignored, example template committed
- Live FTS5 re-index on wiki/vault `.md` edits
- Live registry updates when `.claude/agents/` or `vault/tools/index.md` are edited
- Vault tool usage tracking with auto-promotion to `DISCOVERY.md`
- Dashboard: Express SPA + Chart.js (12 API endpoints)
- Dictionary: structured term index with BM25 search
- Codex CLI integration: 15 enabled agents from 134 skill definitions
