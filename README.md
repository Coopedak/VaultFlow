# vaultflow

Claude Code intelligence layer — automatic session tracking, edit metrics, FTS5 memory search, skill routing, and a Parquet cold archive. Fires silently during every Claude Code session via configured hooks. Zero friction, no agent changes required.

---

## What It Does

Every Claude Code session automatically:

- **Tracks edits** — every `Write`, `Edit`, and `MultiEdit` tool call is recorded with file path, project, and timestamp
- **Sessions** — start/end times, duration, edit counts, command counts, and errors per session
- **Routes prompts** — matches each prompt to the best skill + model tier using BM25 keyword overlap against your skills index
- **Injects memory** — top-5 relevant chunks from your vault and project wikis are surfaced at `UserPromptSubmit` via FTS5 BM25 ranking
- **Live re-index** — editing any wiki or vault `.md` file updates the FTS5 index immediately; no manual backfill required
- **Live registry** — editing `.claude/agents/` or `vault/tools/index.md` auto-upserts vault_agents / vault_tools instantly
- **Tool usage tracking** — vault tools matched in prompts have their `use_count` incremented; tools reaching threshold are auto-promoted to DISCOVERY.md
- **Discovers patterns** — file-type/directory patterns that fire repeatedly are promoted to `DISCOVERY.md` stubs for conversion to vault skills
- **Archives to Parquet** — SQLite hot store drains to Parquet nightly; DuckDB UNIONs both for analytical queries that span weeks

---

## Requirements

- **Node.js 22+** (uses built-in `node:sqlite` — no native compilation)
- **npm** (for dependency install)
- **Claude Code** CLI or desktop app

---

## Installation

### 1. Install dependencies

```bash
cd C:\GIT\vaultflow
npm install
```

### 2. Configure paths

`config/vaultflow.yaml` ships with placeholder paths (`YOU`). Copy it to `config/vaultflow.local.yaml` and fill in your real paths — the local file is gitignored so your paths stay private:

```bash
copy config\vaultflow.yaml config\vaultflow.local.yaml
```

At minimum set `paths.metrics_root` — everything else uses that as a base:

```yaml
paths:
  vault_root:       "C:/Users/YOU/vault"
  metrics_root:     "C:/Users/YOU/vault/methodology/.metrics"
  projects_memory:  "C:/Users/YOU/.claude/projects"
  skills_index:     "C:/Users/YOU/.claude/skills/index.md"
  wiki_glob:        "C:/GIT/*/wiki/**/*.md"
  claude_glob:      "C:/GIT/*/CLAUDE.md"

storage:
  db_file:       "vaultflow.db"     # relative to metrics_root
  parquet_dir:   "parquet"          # relative to metrics_root
  discoveries_dir: "discoveries"    # relative to metrics_root

intelligence:
  pattern_fire_threshold: 3         # subagent completions before DISCOVERY.md is written
  skill_inject_high_threshold: 0.6  # confidence >= this → inject full skill instructions
  skill_inject_low_thickness:  0.3  # confidence >= this → inject skill description only
```

`metrics_root` is the only directory vaultflow writes to. It is created automatically on first run.

### 3. Wire Claude Code hooks

**Option A — fresh install (no existing settings.json):**

```cmd
copy .claude\settings.json %USERPROFILE%\.claude\settings.json
```

**Option B — merge into existing settings.json:**

Open `.claude/settings.json` and copy the `hooks` block into your existing `%USERPROFILE%\.claude\settings.json`. Each hook maps a Claude Code lifecycle event to a handler command.

**Option C — project-scoped only:**

Copy `.claude/settings.json` to the root `.claude/settings.json` of any specific project to activate vaultflow only for that project.

### 4. Run initial backfill

Crawls your vault, project wikis, and CLAUDE.md files into the FTS5 index. Required once before skill routing and memory injection work.

```bash
node .claude/helpers/backfill.mjs
# or
npm run backfill
```

### 5. Verify

```bash
node .claude/helpers/flush-parquet.mjs
# or
npm run flush
```

Both commands print counts on success and exit non-zero on failure.

---

## Architecture

```
Claude Code session
      │
      ├── SessionStart     → session.start() → doImport() → FTS5 index loaded
      │                      stack-detector runs → project_stacks updated
      │
      ├── UserPromptSubmit → router.routeTask() → skill + tier selected
      │                      intelligence.getContext() → top-5 BM25 chunks injected
      │
      ├── PreToolUse(Bash) → hook-handler: blocks dangerous command patterns
      │
      ├── PostToolUse      → post-edit.cjs → SQLite edit_events + session.metric()
      │   (Write|Edit|     → pattern key recorded (ext::parent-dir)
      │    MultiEdit)      → wiki/vault .md edits → FTS5 re-indexed immediately
      │                    → .claude/agents/ edits → vault_agents upserted
      │                    → vault/tools/index.md → vault_tools refreshed
      │
      ├── SubagentStop     → intelligence.feedback() → consolidate insights
      │                      patterns crossing fire threshold → DISCOVERY.md stub
      │
      ├── Stop             → post-task → doSync() → MEMORY.md reordered by PageRank
      │
      └── SessionEnd       → session.end() → duration calculated + stored

SQLite (hot write, synchronous)
      │
      └── flush-parquet.mjs → Parquet (cold archive, DuckDB)
                                │
                                └── DuckDB UNION queries → analytical reports
```

### Storage layers

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Hot store | `node:sqlite` DatabaseSync | Fast synchronous writes during hooks — zero latency |
| Cold archive | DuckDB + Parquet | Analytical queries spanning weeks/months |
| FTS5 index | SQLite FTS5 | BM25 ranked search over vault + wiki content |
| Session state | JSON file | Per-session state persisted across compactions |

### SQLite schema

| Table | What's stored |
|-------|-------------|
| `sessions` | Session start/end, duration, edits, commands, tasks, errors, project, platform |
| `edit_events` | Timestamp, file path, project, change type (create/edit/delete), session |
| `patterns` | File-type patterns (e.g. `ts::src`), fire count, agent, confidence, promoted flag |
| `memory_entries` | FTS5-indexed vault + wiki content — title, body, source path |
| `tool_calls` | Tool name, input hash, timestamp — for deduplication telemetry |
| `prompts` | Prompt text, timestamp, skill routed, session |
| `dictionary` | Term, category, definition, source — imported from vault/domain/ |
| `vault_agents` | Agent registry — name, source, trigger pattern, use count |
| `vault_tools` | Tool registry — backfilled from vault/tools/ |
| `project_stacks` | Detected stack per project — key, confidence, detected at |

---

## Hook Reference

| Event | Command | What it does |
|-------|---------|-------------|
| `SessionStart` | `session-start` | Opens/restores session, runs FTS5 import, detects project stack |
| `SessionStart` | `session-restore` | Reconnects to a session started < 10 min ago (survives compaction) |
| `SessionEnd` | `session-end` | Closes session, writes duration to SQLite |
| `UserPromptSubmit` | `route` | Routes prompt to best skill + tier; injects BM25 memory context |
| `PreToolUse(Bash)` | `pre-bash` | Blocks `rm -rf /`, `format c:`, and similar destructive patterns |
| `PostToolUse(Write\|Edit\|MultiEdit)` | `post-edit.cjs` | Records edit_event, increments session edit counter, upserts pattern key |
| `Stop` | `post-task` | Consolidates `pending-insights.jsonl` → patterns; reorders MEMORY.md |
| `PreCompact(manual)` | `compact-manual` | Prints pre-compact checklist |
| `PreCompact(auto)` | `compact-auto` | Logs auto-compact notice to stderr |
| `SubagentStop` | `post-subagent` | Runs `intelligence.feedback()` — promotes patterns to `discoveries/` |

---

## CLI Reference

All commands run from the vaultflow root.

### Dashboard

Generate a self-contained HTML analytics dashboard. Opens in any browser — no server required.

```bash
npm run dashboard            # generate dashboard.html
npm run dashboard:open       # generate + open in default browser
npm run dashboard:serve      # start Express API server on localhost:7700
```

The generated `dashboard.html` includes 9 tabs: Overview, Sessions, Hot Files, Tool Calls, Patterns, Prompts, Stacks, Agents, Dictionary.

### Watcher

Monitor a directory for file changes from **any** AI tool (Copilot, Cursor, Windsurf, etc.) — not just Claude Code. Records the same `edit_events` as the Claude hooks.

```bash
npm run watcher              # watch current directory (foreground)
npm run watcher C:\GIT\myproject   # watch specific directory
node .claude/helpers/watcher.mjs --daemon C:\GIT   # background daemon
node .claude/helpers/watcher.mjs --stop            # stop daemon
node .claude/helpers/watcher.mjs --status          # check daemon
```

### Dictionary

Manage the structured knowledge dictionary (anti-hallucination term index).

```bash
npm run dict -- --import               # import from vault/domain/ markdown files
npm run dict -- --search "thermal spray"   # BM25 search
npm run dict -- --add MyTerm domain "definition text"
npm run dict -- --stats                # show counts per category
```

Categories: `domain`, `acronym`, `api`, `schema`, `command`, `config`, `error`, `stack`, `pattern`

### Audit

Run the health audit at any time to check DB integrity, hook wiring, Parquet freshness, and session health.

```bash
npm run audit           # full health report
npm run audit:fix       # same + auto-fix stale sessions
```

### Backfill

Re-index vault and wiki content into the FTS5 memory table.

```bash
npm run backfill                       # full index
node .claude/helpers/backfill.mjs --dry-run   # parse only, no DB writes
```

### Flush to Parquet

Move SQLite hot-store rows to Parquet cold archive.

```bash
npm run flush
```

### Gen Context

Write AI tool context files (Copilot instructions, AGENTS.md, Cursor rules) for a project using vaultflow's current knowledge of it.

```bash
npm run gen-context                    # generate for current directory
npm run gen-context C:\GIT\myproject   # generate for specific project
```

---

## Skill Routing

At `UserPromptSubmit`, the router:

1. Tokenizes the prompt (strips stop words)
2. Computes BM25 keyword overlap against each skill's name + description
3. Returns the best match above threshold (default: 0.1)
4. Tiers are assigned by keyword signals: `security`/`architect`/`plan` → Top, `read`/`search`/`find` → Low, everything else → Mid

The skills list is loaded from `config.paths.skills_index` (your vault's skills index markdown). Falls back to 7 built-in agent descriptions if the index is unavailable.

**Injection tiers** (configured in `intelligence` block):

| Confidence | Injection |
|-----------|-----------|
| ≥ 0.6 (high) | Full skill instructions injected into prompt |
| ≥ 0.3 (low) | Skill description only injected |
| < 0.3 | No injection — `"decision":"continue"` passes through |

---

## Pattern Discovery Pipeline

```
PostToolUse fires
    │
    └── pattern key built: "<ext>::<parent-dir>"  (e.g. ts::src, cjs::helpers)
           │
           └── upsertPattern() → fire_count incremented in patterns table
                                          │
                              SubagentStop → intelligence.feedback()
                                          │
                              fire_count >= pattern_fire_threshold (default: 3)
                                          │
                              discoveries/YYYY-MM-DD-<key>.md written
                              (YAML frontmatter + promotion stub)
                                          │
                              Ralph Loop 5 → human review → vault skill
```

---

## Ralph Loops

Ralph is the nightly AI maintenance pipeline. The orchestrator (`ralph-daily.ps1`) runs all loops sequentially each night at 03:00 via Windows Task Scheduler. Loops are ordered by **priority number** — lower runs first. Loops with interval guards self-skip if run recently.

> Source of truth: `vault/maintenance/loops-config.json`
> Full loop documentation: `vault/methodology/ralph-loop-catalog.md`

### All Loops (by execution order)

| Priority | Name | Script | vaultflow? | What it does |
|----------|------|--------|-----------|--------------|
| 10 | Task Executor | `ralph.ps1` | — | Reads IMPLEMENTATION_PLAN.md, runs first `[ ]` task via active AI provider, marks `[x]` or `[!]`, logs to AGENTS.md |
| 15 | Vault Propagation | `ralph-vault-propagate.ps1` | — | Pushes vault references to all project `llms.txt` files so downstream loops see current pointers |
| **18** | **vaultflow Parquet Flush** | **`ralph-vaultflow-flush.ps1`** | **★ primary** | Flushes vaultflow SQLite hot store → Parquet cold archive. Must run before Session Mining. No-op if vaultflow not installed |
| 20 | Session Mining | `ralph-session-mining.ps1` | feeds from | Extracts session intelligence from vaultflow's sessions + edit_events Parquet files |
| 30 | Session Review | `ralph-session-review.ps1` | feeds from | Invokes `session-reviewer` skill via Claude CLI for projects with new commits (max 3/night) |
| 40 | Knowledge Extraction | `ralph-knowledge-extract.ps1` | feeds from | Invokes knowledge-extraction prompt for projects with new commits; writes to wiki/ and vault/ (max 2/night) |
| 50 | Model Discovery | `ralph-model-discovery.ps1` | — | Queries AI providers for available models; updates `model-capabilities.md` and routing table |
| 60 | Model Parity | `ralph-model-parity.ps1` | — | Validates that `aiopt-config.json` tier_map has working models for all providers |
| **70** | **Index Maintenance** | **`ralph-index-maintenance.ps1`** | **★ touch point** | Regenerates vault index + cache files; refreshes `vault_agents`/`vault_tools` DB tables |
| 90 | Skill Health | `ralph-skill-health.ps1` | — | Checks Claude Code skills for broken references, outdated frontmatter, missing metadata |
| **100** | **Auditor + Discoveries** | **`audit-ralph-logs.ps1`** | **★ touch point** | Reads AGENTS.md logs, promotes discoveries to vault; consumes vaultflow's DISCOVERY.md stubs |
| **110** | **Routing Analysis** | **`ralph-analyze-routing.ps1`** | **feeds from** | Reads `task-routing.csv` (populated by vaultflow router); identifies poorly-routed tasks; updates `model-routing-table.yaml` |
| 120 | Search Analysis | `ralph-analyze-search-success.ps1` | — | Reads `search-success.csv`; identifies low-quality search paths; updates indexes |
| 130 | Compression Analytics | `ralph-compression-analytics.ps1` | — | Reads compression telemetry; reports ctx-opt performance; flags low-ratio projects |
| 140 | Cost Tracking | `ralph-cost-tracking.ps1` | — | Runs `ctx-opt tokens`; logs daily AI spend per provider to `cost-tracking.csv` |
| 145 | Project AI Readiness | `ralph-project-ai-readiness.ps1` | — | Scans all `C:\GIT\*` projects; reports missing CLAUDE.md, llms.txt, AGENTS.md, wiki/ |
| 150 | Agent Grading | `ralph-agent-grading.ps1` | — | Grades agent output quality; flags agents with consistent low-quality results |
| 160 | Eval Runner | `ralph-eval-runner.ps1` | — | Runs skill eval suites (## Examples sections); flags skills below pass threshold |
| 170 | Thinker Feed | `ralph-thinker-feed.ps1` | — | Scrapes new posts from thinkers/index.md sources; appends raw extracts to thinker pages |
| 180 | Principle Promoter | `ralph-principle-promoter.ps1` | — | Grades principles from Loop 170; proposes `~/.claude/rules/` edits for high-grade findings |
| 190 | Vault Audit | `vault-audit.ps1` | — | Scans vault entries for stale path references; appends `<!-- STALE -->` markers |
| 999 | Watchdog *(always last)* | `ralph-watchdog.ps1` | — | Reads all `.ralph/last-*-run.txt` timestamps; alerts on stale or failed loops |

**★ vaultflow loops** — the 4 loops that directly depend on vaultflow data:

### Priority 18 — vaultflow Parquet Flush

Flushes the SQLite hot store to Parquet so all downstream analytics loops see complete data.

```powershell
# What Loop 18 runs:
node C:\GIT\vaultflow\.claude\helpers\flush-parquet.mjs
# Flushes: edit_events, sessions, tool_calls, prompts → .parquet files in metrics_root/parquet/
```

Run manually: `npm run flush`

### Priority 70 — Index Maintenance touch point

After `vault/agents/index.md` or `vault/tools/index.md` changes, refreshes the vaultflow DB tables to match.

```bash
# What to run after vault index changes:
cd C:\GIT\vaultflow && npm run backfill
```

### Priority 100 — Auditor + Discoveries touch point

Reads `metrics_root/discoveries/*.md` stubs written by vaultflow's pattern-promotion pipeline and promotes qualifying ones to vault skills.

### Priority 110 — Routing Analysis

Reads `task-routing.csv` which vaultflow's `hook-handler.cjs` populates on every `UserPromptSubmit`. Loop 110 uses that data to update the model routing table — poor-performing skill assignments get reclassified.

---

## Error Handling

### Hook errors

Every hook handler (`hook-handler.cjs`, `post-edit.cjs`) is wrapped so errors write to stderr but always exit 0 — Claude Code must not be blocked by hook failures. Errors appear in the terminal output of the session. Example:

```
[vaultflow] hook-handler error (session-start): SQLITE_BUSY: database is locked
```

If hooks are silently failing, run `npm run audit` to diagnose.

### Self-healing loop

Failures in Ralph tasks follow the protocol in `vault/methodology/self-healing-loop.md`:

| Failure type | Signal | Action |
|---|---|---|
| Wrong model tier | Output shallow or plausible-but-wrong | Escalate: retry at Top tier |
| Missing context | AI states false facts about the project | Add the fact to wiki before retry |
| Wrong approach | Multiple attempts fail differently | Redesign at Top tier |
| Unrecoverable | Task fails at Top after redesign | Mark `[!]` (blocked), move on |

Blocked tasks are marked `[!]` in `IMPLEMENTATION_PLAN.md` and logged in `AGENTS.md`. They are never silently skipped — the human reviews blocked items at loop completion.

**Escalation rule:** Same task fails twice at Mid → escalate to Top. Fails at Top → human decision required.

### vaultflow audit (Loop 18b)

`npm run audit` is the dedicated health check for vaultflow itself. Run it any time something seems off, or add it to your Ralph schedule as a daily pre-flight.

```bash
npm run audit          # health report (exit 1 if any check fails)
npm run audit:fix      # same + auto-fixes what it can (closes stale sessions)
```

**What it checks:**

| Check | Pass condition | Auto-fix |
|-------|---------------|----------|
| `config/vaultflow.yaml` exists and parses | File present, valid YAML | — |
| `paths.metrics_root` is set | Non-empty path in config | — |
| `metrics_root` directory exists | Directory present | — |
| DB file exists | `vaultflow.db` present in metrics_root | — |
| `PRAGMA integrity_check` | SQLite returns `ok` | — |
| All required tables exist | 6 core tables present | — |
| No stale open sessions | No sessions started >2h ago without `ended_at` | `--fix` closes them |
| Recent session activity | At least one session in the last 7 days | — |
| Parquet flushed within 25h | Latest `.parquet` mtime < 25h | — |
| Node.js ≥ 22 | `node:sqlite` available | — |
| `@duckdb/node-api` installed | Package present in `node_modules` | — |
| Hook events wired | All 5 required events in `settings.json` | — |
| Discovery pipeline | No unreviewed DISCOVERY.md stubs | — |

**Exit codes:** `0` = all checks passed, `1` = one or more checks failed.

---

## File Map

```
vaultflow/
├── .agents/                    Codex CLI agent skills (15 enabled, 119 disabled)
│   ├── config.toml             Codex model, approval policy, skill triggers
│   └── skills/                 134 skill directories
├── .claude/
│   ├── settings.json           Claude Code hook wiring (copy to ~/.claude/ to activate)
│   └── helpers/
│       ├── db.cjs              Core data layer — SQLite + DuckDB/Parquet
│       ├── session.cjs         Session lifecycle — start, restore, end, metrics
│       ├── hook-handler.cjs    Main event dispatcher (all hook events route here)
│       ├── post-edit.cjs       PostToolUse handler — edit recording
│       ├── router.cjs          Skill router — BM25 overlap scoring
│       ├── intelligence.cjs    Pattern consolidation + DISCOVERY.md promotion
│       ├── skill-loader.mjs    Skill content cache for injection
│       ├── stack-detector.mjs  Project tech stack detection
│       ├── gen-context.mjs     Generate Copilot/AGENTS.md/Cursor context files
│       ├── dict.mjs            Dictionary CLI + import API
│       ├── watcher.mjs         File system watcher (multi-tool session tracking)
│       ├── backfill.mjs        One-time FTS5 index backfill
│       ├── flush-parquet.mjs   SQLite → Parquet flush + DuckDB queries
│       ├── audit.mjs           Health audit — DB integrity, sessions, Parquet, hooks
│       ├── install-git-hooks.mjs   Install git commit hooks
│       └── dashboard/
│           ├── gen.mjs         Static HTML dashboard generator (primary)
│           ├── server.mjs      Express API server (optional — npm run dashboard:serve)
│           ├── index.html      SPA for Express server mode
│           └── app.js          Chart.js frontend for Express server mode
├── config/
│   ├── vaultflow.yaml          Example config with placeholder paths (committed)
│   ├── vaultflow.local.yaml    Your real config — gitignored, never leaves your machine
│   └── resolve.cjs             Picks vaultflow.local.yaml over vaultflow.yaml at runtime
├── scripts/
│   └── backfill.mjs            CLI entry point (aliased as `vaultflow` bin)
├── .gitignore
├── .gitattributes
├── package.json
└── README.md
```

---

## Ralph Integration

`flush-parquet.mjs` exports functions for use in Ralph maintenance loops:

```js
import { flushParquet, queryHotFiles, querySessionSummary, queryToolCallSummary }
  from './.claude/helpers/flush-parquet.mjs';

// Move SQLite rows to Parquet archive
const result = await flushParquet();
// → { editsFlushed: 142, sessionsFlushed: 7, parquetDir: "..." }

// Top-edited files across last N days (Parquet + live SQLite via DuckDB UNION)
const hot = await queryHotFiles(30);
// → [{ file_path, edit_count, last_edit, project }, ...]

// 30-day session summary
const summary = querySessionSummary();
// → { total_sessions, total_edits, total_commands, avg_duration_ms, last_session }

// Tool call deduplication stats
const tools = await queryToolCallSummary(30);
// → [{ tool_name, call_count, unique_calls, dupe_rate }, ...]
```

**Ralph Loop 5** reads `discoveries/` stubs and synthesizes them into vault skills. Each stub is written when a pattern key crosses `pattern_fire_threshold` consecutive subagent completions.

---

## Codex CLI (`.agents/`)

vaultflow ships with 134 Codex skill definitions (15 enabled by default) sourced from ruflo's Claude Flow V3. The enabled set covers practical dev/analysis work without requiring swarm infrastructure.

Enabled by default: `agent-coder`, `agent-researcher`, `agent-reviewer`, `agent-security-manager`, `agent-tester`, `agent-planner`, `agent-architecture`, `agent-code-analyzer`, `agent-performance-analyzer`, `agent-docs-api-openapi`, `agent-dev-backend-api`, `agent-code-review-swarm`, `agent-migration-plan`, `agent-specification`, `agent-goal-planner`

Disabled: swarm coordinators, neural/SONA layers, payment agents, GitHub automation, V3 rebuild infra.

To use with Codex CLI:
```bash
codex --config .agents/config.toml "implement X"
```

---

## Data Location

All runtime data lives in `metrics_root` (configured in `vaultflow.yaml`). Nothing is written inside the repo itself.

```
metrics_root/
├── vaultflow.db              SQLite database (all tables)
├── parquet/
│   ├── edit_events.parquet   Flushed edit history
│   └── sessions.parquet      Flushed session history
├── discoveries/              DISCOVERY.md stubs (auto-promoted patterns)
├── sessions/                 Per-session JSON snapshots
├── pending-insights.jsonl    Append-only insight buffer (cleared on consolidate)
└── ranked-context.json       PageRank-ordered memory context (updated at Stop)
```
