# claude-mem — Deep Audit & Adoption Recommendation

**Repo:** github.com/thedotmack/claude-mem (v12.7.5, AGPL-3.0¹, ~250 days old, 73,415 ★, 6,307 forks, 98 open issues)
**Method:** 4 parallel deep-audit agents (architecture+storage, retrieval+skills, hooks+adapters, maturity+red-flags) + spot-verifications via Firecrawl/WebFetch.

¹ GitHub API reports `license_name: "Other"` despite AGPL-3.0 LICENSE file — verify SPDX header before any code copy. License is **viral on network use** anyway.

---

## TL;DR

claude-mem is a **single-author, marketing-driven, architecturally-different** project. The architecture (out-of-process worker, AI compression, vector store, multi-IDE plugins) solves a different problem than vaultflow (multi-CLI activity log + FTS5 + Parquet cold archive). **There are 6 specific patterns worth borrowing** and **6 things to deliberately skip**. The 73k-star figure is hype (~9k stars/month for an 8-month solo repo, contributor graph dominated by the author at 92.7%, no organic forum discussion).

---

## Architecture diff (one paragraph)

| Layer | claude-mem | vaultflow |
|---|---|---|
| Hooks | Bash shim → Bun/Node → HTTP daemon (worker is Bun on port 37777, HTTP+SSE) | CJS in-process, sync, no daemon |
| Storage hot | SQLite WAL + Chroma sidecar (vector) | SQLite WAL + FTS5 |
| Storage cold | None — SQLite forever | Parquet via DuckDB (Lambda) |
| Compression | AI worker calls Claude/Gemini/OpenRouter, writes structured `<observation>` / `<summary>` XML | None — raw text indexed |
| Multi-tool | 5 plugin variants: Claude/Codex/Cursor/Windsurf/Gemini-CLI/OpenCode/etc. via marketplace | chokidar watcher daemon for filesystem-level coverage of any tool |
| Retrieval | Vector-first (Chroma) → FTS5 fallback, 90-day window, per-type metadata-then-rank | FTS5 BM25 only |
| Surface | Express server, 30+ HTTP routes, no auth (closed Issue #1251 confirms) | 24 read-only routes, localhost, dashboard SPA |

---

## What's worth borrowing (ranked by value/cost)

### 1. **PreToolUse-on-Read file-context injection** — HIGHEST VALUE / LOW COST

**What it does (claude-mem):** When Claude is about to `Read` a file (>1500 bytes), the hook queries past observations referencing that file, scores by specificity (in `files_modified` = +2, ≤3 files touched = +2), dedupes by session, and returns up to 15 results grouped by day in `hookSpecificOutput.additionalContext` with `permissionDecision: 'allow'`. Source: `src/cli/handlers/file-context.ts`.

**Why steal it:** Claude reads the file *plus* a tight summary of past edits/observations on it. Cuts duplicate exploration and grounds decisions.

**Vaultflow port:**
- Add `PreToolUse` matcher for `Read` to `.claude/settings.json` calling a new `pre-read.cjs` handler
- Query `edit_events` where `file_path = ?` and `timestamp >= datetime('now','-90 days')`, group by session, return last N edits + memory entries that reference the file path
- Effort: ~80 LOC, half a day

### 2. **Structured session-summary XML schema** — HIGH VALUE / MEDIUM COST

**What it does (claude-mem):** `buildSummaryPrompt` requires the model wrap output in `<summary>` with children `<request>`, `<investigated>`, `<learned>`, `<completed>`, `<next_steps>`, `<notes>`. Non-conforming output is discarded. Source: `src/sdk/prompts.ts:76-101`.

**Why steal it:** vaultflow's `session_summaries` is freeform — can't be queried per-field, can't be filtered by `obs_type`. Structured fields enable per-field FTS, per-type ranking, and richer dashboard surfacing.

**Vaultflow port:**
- Migrate `session_summaries` to add `request`, `investigated`, `learned`, `completed`, `next_steps` columns (or a single JSON column with these keys)
- Update `session.cjs:writeSessionSummary` to accept structured input
- A future "compaction" step (optional) can synthesize structured fields from raw activity — but not required to adopt the schema
- Effort: schema + writer = ~120 LOC

### 3. **`<private>...</private>` tag stripping at hook edge** — MEDIUM VALUE / VERY LOW COST

**What it does (claude-mem):** `UserPromptSubmit` strips `<private>...</private>` from prompts before insert; `PostToolUse` strips from `tool_input` / `tool_response` JSON before observation creation. Tags remain visible in the live conversation. Source: `docs/public/usage/private-tags.mdx` (verified via WebFetch).

**Why steal it:** A free user-facing privacy primitive. Protects API keys, customer data, scratch credentials from being captured into permanent indexes.

**Vaultflow port:**
- ~30-line regex helper in `db.cjs.recordPrompt` and `db.cjs.recordToolCall`
- No schema change
- Effort: 1 hour

### 4. **3-layer retrieval contract for the LLM** (search → timeline → get_observations) — MEDIUM VALUE / MEDIUM COST

**What it does (claude-mem):** `mem-search` skill enforces filter-before-fetch. The LLM calls `search` (returns IDs + 1-line previews), then `timeline` (chronologically scopes), then `get_observations(ids[])` (fetches bodies). Forces token-economical retrieval. Source: `plugin/skills/mem-search/SKILL.md`.

**Why steal it:** vaultflow's MCP `search_memory` and `get_context` already exist but lack this disciplined call pattern. Adding a `timeline` endpoint + writing a skill prompt that enforces the 3-step pattern would dramatically reduce tokens spent surfacing prior context.

**Vaultflow port:**
- Add `mcp__vaultflow__timeline(project, days)` returning headline events
- Add `mcp__vaultflow__get_memory_by_ids(ids[])` for bulk fetch
- Write a `mem-search`-style skill prompt enforcing the call order
- Effort: ~2-3 hours

### 5. **Codex/Cursor adapter normalization layer** — LOW VALUE NOW / MEDIUM COST

**What it does (claude-mem):** Each tool's events get translated into a single `NormalizedHookInput` shape (`hook_event_name`, `tool_name`, `session_id`, `source`) so handlers don't care which tool fired. The Codex adapter notably uses `shell-quote` to parse Bash commands and extract read-intent file paths from `cat|head|tail|less|view|nl|tac`.

**Why steal it (selectively):** vaultflow's chokidar already covers filesystem-level activity. The shell-command parser is the genuinely useful piece — it captures *intent to read* before the file is touched, which complements vaultflow's after-the-fact edit tracking. Source: `src/cli/adapters/codex-file-context.ts`.

**Vaultflow port (just the parser):**
- Add a `shell-intent.cjs` helper using `shell-quote` (already a transitive dep) to extract paths from `tool_calls.input_json` where `tool_name='Bash'` for read commands
- Effort: ~50 LOC

### 6. **Marketplace plugin registration** — LATER / DISTRIBUTION-ONLY

**What it does:** `~/.claude/plugins/known_marketplaces.json` + `installed_plugins.json` + `enabledPlugins` triple-write registers vaultflow as a plugin Claude Code can manage. Source: `src/npx-cli/commands/install.ts:73-145`.

**Why consider:** Public distribution lever. Not a feature win — a packaging win.

**Defer until** vaultflow is ready to be distributed beyond your machine.

---

## What to deliberately skip

| Anti-pattern | Why skip |
|---|---|
| **HTTP worker daemon on a fixed port (no auth)** | Issue #1251 documented critical security findings (path traversal, no auth on 30+ endpoints, plaintext API keys) — closed by repo owner with 3 comments, no linked PRs, no confirmed remediation. vaultflow's in-process model is strictly safer. |
| **Bun + uv runtime auto-installer** | Two extra runtimes installed on first run for an architecture you'd be skipping anyway. |
| **AI compression of every tool event** | Sends user code/prompts to Anthropic/Gemini/OpenRouter for every observation. Conflicts with vaultflow's local-only stance. The default also burns tokens at session-rate. |
| **Chroma vector sidecar** | Python sidecar via `uv` for embeddings on top of SQLite. FTS5 + structured fields gets ~80% of the value at 0% the operational cost. |
| **Static-port multi-tenancy** | Only needed because of the daemon. No daemon, no port, no problem. |
| **AGPL-licensed code copy** | License is viral on network use. Borrow patterns and prompts; do not copy code. |

---

## Maturity / red-flag findings (verified)

- **Single-author project with marketing tailwind.** thedotmack: 1,596 commits (92.7%); next human: 27 commits. Repo created 2025-08-31. ~9k stars/month for 8 months is implausible organically — Trendshift surge + Augment-published "73K stars" milestone posts + DEV.to "DIY alternative" posts.
- **CI has zero test gates on `npm publish`.** `.github/workflows/npm-publish.yml`: tag push → checkout → install → build → publish. No tests, no lint, no typecheck. 266 releases shipped this way.
- **3 days, 10 patch releases (May 5–7).** Patch-shotgun pattern. CHANGELOG entries are real but the velocity is "ship → break → patch."
- **Security Issue #1251 (closed)** — auditor flagged HIGH risk: path traversal, no auth on 30+ HTTP endpoints, cleartext API keys, optional `0.0.0.0` binding. Closed by owner with 3 comments, no linked PRs, no confirmed remediation.
- **Migration data-loss reports (#1749, #1307)** — Migration 7 reportedly recreates tables; cross-machine sync corrupts.
- **Progressive slowdown (#2213)** — Reported 3-4 hour parallel-session degradation, closed as duplicate of an unresolved older issue.
- **No retrieval-quality evals.** `evals/swebench/` is a SWE-Bench wrapper (does Claude+claude-mem solve bugs?), not a recall@k or compression-fidelity test. Marketing claims "10x token efficiency" — unbenchmarked in-repo.
- **`<private>` tag location** — agents disagreed; verified via docs: stripped at the **hook edge** (UserPromptSubmit + PostToolUse handlers), not the storage edge. Tags remain visible to the model in-conversation; only persistence is filtered.
- **`observation_feedback` is a roadmap stub.** Schema exists, hooks write to it, but `SearchManager.ts` does NOT consult it for reranking. Vaultflow's `retrieval_feedback` table is in the same state — both projects collect the signal but neither closes the loop.

---

## Where vaultflow is genuinely ahead

1. **Multi-tool filesystem watcher** — chokidar daemon catches Copilot/Cursor/Codex/etc. edits even when their hooks don't fire. claude-mem only sees what its hooks report.
2. **Parquet cold archive** — DuckDB-queryable, lossless, indefinite. claude-mem keeps everything in SQLite forever.
3. **Local-only by default** — no compression API calls, no data exfiltration. claude-mem requires sending user code/prompts to a cloud model to function.
4. **Smaller auditable surface** — no HTTP daemon, no Chroma sidecar, no Bun/uv runtimes. Hook-to-DB call latency is microseconds vs. claude-mem's HTTP roundtrip.
5. **CI test gates exist and pass** (22 tests).
6. **Honest schema migrations via `IF NOT EXISTS` + idempotent ALTERs.** No #1749-class data-loss reports.

---

## Concrete adoption plan (for vaultflow, in order)

| # | Item | Effort | Source file in claude-mem | Vaultflow target |
|---|------|--------|---------------------------|------------------|
| 1 | `<private>` tag stripping | 1h | `docs/public/usage/private-tags.mdx` | `db.cjs.recordPrompt`, `db.cjs.recordToolCall` |
| 2 | PreToolUse(Read) → file-context injection | 4h | `src/cli/handlers/file-context.ts` | new `.claude/helpers/pre-read.cjs` + settings hook |
| 3 | Structured session-summary fields | 4h | `src/sdk/prompts.ts:76-101` | `db.cjs.writeSessionSummary` + schema migration |
| 4 | 3-layer retrieval contract (`mem-search`-style) | 3h | `plugin/skills/mem-search/SKILL.md` + `DataRoutes.ts` | new MCP tools + skill prompt |
| 5 | Shell-command read-intent parser | 2h | `src/cli/adapters/codex-file-context.ts` | new `.claude/helpers/shell-intent.cjs` |
| 6 | (Future) Marketplace plugin registration | 8h | `src/npx-cli/commands/install.ts:73-145` | new `scripts/install-plugin.mjs` |

Total for items 1–5: ~14 hours. Item 6 is distribution-only, defer.

---

## Bottom line

**Borrow the 6 patterns above; reject the architecture wholesale.** claude-mem solves "AI-compressed memory across IDEs via a daemon" — vaultflow solves "lossless multi-CLI activity log with FTS5 retrieval." The 73k stars are marketing capital, not engineering signal. The ideas worth stealing are smaller and lower-risk than copying the whole stack would be.
