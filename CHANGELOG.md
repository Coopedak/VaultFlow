# Changelog

All notable changes to vaultflow are documented here.

---

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
