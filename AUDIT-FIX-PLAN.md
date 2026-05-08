# Vaultflow — Audit Fix Plan

Built from `AUDIT-FINDINGS.md` after 5-agent audit + meta-audit. Tiered by
impact. Each fix lists: file, change, verification, and source finding ID.

## TIER 1 — Critical (correctness / data loss)

### F1 — Dashboard env-var precedence bug (DB2)
- **File:** `.claude/helpers/dashboard/server.mjs:37`
- **Change:** `(process.env.USERPROFILE || '') + 'vault/methodology/.metrics'` → `path.join(process.env.USERPROFILE || os.homedir(), 'vault', 'methodology', '.metrics')`. Same fix in `gen.mjs:38`.
- **Verify:** `node -e "console.log(typeof process.env.USERPROFILE)"` — server still resolves DB path when env unset.

### F2 — Sessions never close (H1 / D1)
- **File:** `.claude/helpers/db.cjs` (new export `closeStaleSessions`) and `session.cjs` (call on start).
- **Change:** On every `session.start()`, sweep for sessions where `ended_at IS NULL` and `started_at < now-12h` AND there exists at least one `tool_call`/`edit_event` for that session. Set `ended_at = MAX(timestamp from tool_calls + edit_events)` and compute `duration_ms`.
- **Verify:** Run sweep against current DB. Expected: 39 → 0 stale unclosed sessions older than 12h.

### F3 — Project detection produces garbage (H4 / D11)
- **Files:** `.claude/helpers/post-edit.cjs:40-51`, `.claude/helpers/watcher.mjs:147-156`, `.claude/helpers/session.cjs` (cwd → project), `.claude/helpers/copilot-resume.cjs:51`.
- **Change:** New shared helper `deriveProject(filePath)` that walks up the path looking for a `.git` directory; the project is the dirname containing `.git`. Fallback: only the GIT/Projects-anchor segment lookup. Last-resort fallback: `null` (not basename).
- **Verify:** Manually run helper against `C:\Windows\System32\foo.txt` → null; against `C:\GIT\vaultflow\.claude\helpers\db.cjs` → "vaultflow"; against `C:\Users\YOU\.claude\rules\foo.md` → null.

### F4 — vault_tools.path always NULL (P1 / D9)
- **File:** `.claude/helpers/backfill.mjs:526`
- **Change:** `backfillTools()` derives `toolPath = path.join(toolsRoot, toolId)` if that directory exists, else `path.join(toolsRoot, toolId + '.md')` if file exists, else `null`.
- **Verify:** After re-run, `SELECT COUNT(*) FROM vault_tools WHERE path IS NULL OR path=''` → 0 (or only intentionally-missing rows).

### F5 — `npm test` broken on Node 24 (D16)
- **File:** `package.json:41`
- **Change:** `"test": "node --test tests/*.test.mjs"`
- **Verify:** `npm test` runs both test files; both pass.

## TIER 2 — High (data completeness)

### F6 — Watcher sessions missing cli (H2 / D5)
- **File:** `.claude/helpers/watcher.mjs:76-98` (and any other generic session create paths).
- **Change:** Pass `cli: 'watcher'` on `upsertSession`. Pass `project` derived from the session's cwd/first edit.
- **Verify:** New watcher sessions have `cli='watcher'` and a non-NULL `project`.

### F7 — Claude sessions don't capture model/version/provider (H3 / D2-D4)
- **File:** `.claude/helpers/session.cjs:84-108` (`newSession`).
- **Change:** Sniff env vars: `CLAUDE_CODE_MODEL`, `ANTHROPIC_MODEL`, `npm_package_version`, plus `process.env.CLAUDECODE_VERSION` if available. Fall back to `null` if unknown. Set `model_provider='anthropic'` for any model starting with `claude-`.
- **Verify:** Next claude session row has `model`, `model_provider`, `cli_version`.

### F8 — Delete the rogue `C:GITvaultflowdocs` folder + find the source (D12)
- **Search code for likely sources:** unguarded `cwd + 'docs'` string concat. If not found in current code, just delete the empty folder.
- **Verify:** Folder gone; rerunning all helpers does not recreate it.

### F9 — Model name normalizer (R1 / D13)
- **File:** new helper `.claude/helpers/normalize-model.cjs`. Used in `db.cjs.upsertSession`, `model-router.cjs`, `db.cjs.recordModelSession`.
- **Change:** Normalize `claude-sonnet-4.6` → `claude-sonnet-4-6`; `GPT-5` → `gpt-5`; consistent lower-case + dash form. Apply on write.
- **Verify:** New model_performance and sessions rows use canonical form. Migration backfill normalizes existing rows.

### F10 — Dashboard avg_duration excludes active sessions (DB6)
- **File:** `.claude/helpers/dashboard/server.mjs:149`
- **Change:** Compute `AVG(duration_ms) FILTER (WHERE ended_at IS NOT NULL)` and surface separate `active_sessions` count next to it.
- **Verify:** API returns both fields; UI shows them.

### F11 — byProject endpoint drops NULL projects (DB7)
- **File:** `.claude/helpers/dashboard/server.mjs:162`
- **Change:** `COALESCE(project, '(unknown)')` instead of `WHERE project IS NOT NULL`.
- **Verify:** byProject result includes a "(unknown)" bucket equal to count(NULL).

### F12 — Wire retrieval feedback (R5 / D15)
- **File:** `.claude/helpers/intelligence.cjs` (`getContext` / search paths).
- **Change:** When a memory entry is included in injection, write a `retrieval_feedback` row with score=1; when prompt-similar prompts are surfaced, also record. Skim the dashboard's pattern-promote endpoint for similar wiring.
- **Verify:** After 1 session, `retrieval_feedback` table grows >4.

## TIER 3 — Medium

### F13 — Empty prompt_text validation (H7 / D8)
- **File:** `db.cjs.recordPrompt` — early-return when `prompt_text` is empty/whitespace.
- **Verify:** Existing 19 empty rows accepted as historical; new prompts with empty text not inserted.

### F14 — Dashboard NaN/NULL handling (DB10, DB12)
- **Files:** `app.js:325`, `tui/db-reader.mjs:94-105`
- **Change:** Render explicit "—" for NULL/NaN dupe_rate / approval_rate.

### F15 — UTC indicator on dashboard timestamps (DB9)
- **File:** `app.js:41`
- **Change:** Append " local" suffix or always render UTC-Z form.

### F16 — Hardcoded `C:/GIT` in index.html (DB11)
- **File:** `.claude/helpers/dashboard/index.html:554`
- **Change:** Read from `/api/config` and substitute.

### F17 — `/api/patterns/:id/promote` connection leak (DB8)
- **File:** `server.mjs:200`
- **Change:** Wrap in `withRawDb()`.

### F18 — Backfill descriptions for Codex/user-skills (P2 / D10)
- **File:** `backfill.mjs:358-383, 429`
- **Change:** Read full SKILL.md frontmatter; pull `description:` from YAML; fall back to first markdown paragraph.

### F19 — auto-memory-hook EPIPE (D17)
- **File:** `auto-memory-hook.mjs:248`
- **Change:** Wrap stderr write in try/catch + ignore EPIPE.

## TIER 4 — Doc / cleanup

### F20 — Update "12 endpoints" doc strings to "24" (DB1)
- **Files:** `CLAUDE.md`, `CHANGELOG.md`, `server.mjs:4`.

### F21 — AGENTS.md placeholder substitution + description parsing (gen-context bug)
- **File:** `gen-context.mjs` — substitute `os.homedir()` user, parse YAML frontmatter `description:` properly.

### F22 — CHANGELOG version sync
- **File:** `CHANGELOG.md` — add 1.2.0, 1.3.0 entries.

### F23 — Patterns track real agent (R3)
- **File:** `intelligence.cjs:115-117` — write `agent` into `pending-insights.jsonl` upstream so it propagates to `patterns.agent`.

### F24 — `vault_tools.last_used` never updated
- **File:** `db.cjs.incrementVaultToolUse` — set `last_used = datetime('now')`.

## DEFERRED — ideas from claude-mem (separate work)

- Persistent message queue (`pending_messages` UNIQUE on tool_use_id) to survive hook crashes.
- `<private>...</private>` tag stripping at hook edge.
- Structured session_summary fields (request/investigated/learned/completed/next_steps).

## END-TO-END VERIFICATION PLAN

After fixes, run:
1. `npm test` — both files pass.
2. Run `audit-stats.cjs` — fewer NULLs in sessions.cli, sessions.model, vault_tools.path.
3. Start watcher, edit a file in `C:\GIT\vaultflow\` → edit_event has `project='vaultflow'`, session has `cli='watcher'`, `project='vaultflow'`.
4. Edit a file in `C:\Users\YOU\.claude\rules\foo.md` → project resolves to null/`.claude` removed.
5. Start dashboard, hit each of the 24 endpoints, no 500s, all timestamps render.
6. Trigger a session-end → `ended_at` populated.
7. Manually run `closeStaleSessions()` → 39 stale sessions reduced.
