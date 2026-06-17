# ADR-002: Skill Reuse Finder via Existing Search Engine

**Status:** Accepted (2026-06-17)

**Date:** 2026-06-17

## Context

vaultflow already implements a reuse-before-build mandate for vault tools: the `search_vault_tools` MCP tool surfaces overlapping existing tools before authoring new ones, backed by `db.searchVaultAgents()` — a BM25 full-text search over tool name/description in the `vault_agents` table.

The system needed to extend this mandate to skills. Skills live in `.agents/skills/`, `.claude/skills/`, or user skill directories, and are authored by multiple agents independently. There is no current enforcement that a new skill should check for existing work.

The design required deciding:
1. Whether to build a new skill-specific search engine or reuse the existing tool infrastructure
2. How to gate the authoring surface (when should the warning appear?)
3. What search scope is appropriate (name/description only vs. body/semantic)

## Decision

**Adopted: Reuse `db.searchVaultAgents()` for skills; implement three reuse checkpoints backed by the same BM25 search.**

Skills are indexed in the `vault_agents` table alongside tools (distinguished by `agent_type='skill'`). Three surfaces expose the search:
1. **MCP tool** `search_skills` — explicit query tool (mandate: "ALWAYS call before creating a new skill")
2. **CLI** `vaultflow find-skill "<task>"` — headless access for scripts/cron
3. **Authoring gate** — non-blocking PreToolUse(Write) hook in `pre-edit.cjs` that triggers when a NEW skill file is written with name+description frontmatter

All three are backed by the same `db.searchVaultAgents()` query. The verdict is based on an **overlap coefficient** (shared tokens / min(set sizes)):
- **REUSE**: overlap ≥ 0.30 (substantial semantic overlap, high likelihood of duplication)
- **MODIFY**: overlap ≥ 0.15 (partial overlap, consider adapting existing skill)
- **BUILD-NEW-OK**: below 0.15 (minimal overlap, new skill is justified)

The backfill pipeline (`backfill.mjs`) was extended to fall back to the skill's first paragraph when frontmatter description is a stub (`< 10 chars`), so search has meaningful text to rank against.

## Consequences

### Positive
- **Zero new infrastructure**: Reuses the proven `db.searchVaultAgents()` query and `vault_agents` table. No new search engine, no new ranking algorithm, no new indexing pipeline.
- **Three surfaces, one source of truth**: MCP tool, CLI, and authoring gate all query the same DB row set. Keeping them in sync is automatic.
- **Nightly freshness**: Skills are backfilled on the nightly vault-librarian-sync job (which already runs `backfill --skills-only`). No new daemon needed.
- **Author-friendly gate**: The PreToolUse(Write) hook catches new skill authoring at the moment of creation and reminds authors to search first. Non-blocking, so experimentation isn't hampered.
- **Explicit mandate at query time**: `search_skills` MCP tool description mirrors `search_vault_tools` ("ALWAYS call before creating a new skill"), making the expectation clear.

### Tradeoffs Accepted
- **Search is advisory, not enforced**: The verdict (REUSE / MODIFY / BUILD-NEW-OK) is a recommendation, not a gate. Authors can ignore it and build new. This is by design — skill experimentation should not be blocked.
- **Body text not indexed**: Search is over name and description only. Semantic indexing of skill body logic and examples is deferred (would require embedding the full skill code, which is expensive at indexing time).
- **Overlap coefficient is uncalibrated**: The thresholds (0.30 / 0.15) are heuristic. In early use, these may be tuned based on false negatives/positives.
- **Edit/MultiEdit not gated**: The PreToolUse(Write) hook only fires on NEW file writes, not edits to existing skill files. Authors using Edit or MultiEdit to create a new skill's content won't see the gate. This is a known limitation; the MCP tool mandate covers this case.
- **Nightly, not real-time**: Skill freshness is nightly. If two authors create similar skills in the same day, the second won't see the first's skill in the search results until the next nightly run. Acceptable for a reuse-reminder system (the first publish will surface the overlap in the next session).

### What Was Rejected
- **Blocking gate**: Considered a hard gate that prevents skill writes if overlap is high. Rejected because skill experimentation and iteration should be low-friction; a warning is sufficient.
- **Semantic indexing**: Indexing the full skill body (code + docstrings) via embeddings. Rejected because the cost is high (vector storage, embedding API calls at backfill time) and the skill corpus is small enough that name/description search is effective for duplication detection.
- **New search table**: Creating a dedicated `skills_fts` table. Rejected because `vault_agents` already has BM25 and the field structure needed (name, description, agent_type).

## Implementation Notes

- **Search query**: `db.searchVaultAgents(query, 'skill')` filters to `agent_type='skill'` and ranks by BM25.
- **Overlap scorer**: `skill-reuse.cjs` exports `computeOverlap(result, query)` — tokenizes name + description, computes intersection / min(set sizes).
- **Verdict logic**: Applied in `search_skills.mjs` (MCP), `find-skill.mjs` (CLI), and `pre-edit.cjs` (gate). Each surfaces the verdict + top 3-5 results.
- **Backfill fallback**: `backfill.mjs` checks if `description.length < 10`, then reads the skill file and extracts the first paragraph (up to 150 chars) from the body or docstring.
- **Gate non-blocking**: The PreToolUse(Write) hook in `pre-edit.cjs` logs a warning to stderr and continues (does not throw or abort). Message includes the CLI command to re-search manually.
- **Nightly refresh**: The nightly vault-librarian-sync job calls `backfill --skills-only`, which re-indexes all skills in `.agents/skills/`, `.claude/skills/`, and the user skills directory.

## Verification

The feature has been tested with:
- New skill writes via `Write` tool (gate fires with advisory warning)
- `vaultflow find-skill "webhook retry logic"` (returns ranked existing skills)
- `search_skills` MCP tool with overlap scoring (REUSE/MODIFY/BUILD-NEW-OK verdicts match expected heuristic)
- Backfill fallback (skills with stub descriptions now have searchable body text)
- Nightly sync (new skills appear in search results after the nightly job)
