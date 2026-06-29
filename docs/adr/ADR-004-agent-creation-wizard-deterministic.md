# ADR-004: Agent Creation Wizard — Deterministic Schema-Based Design

**Status:** Accepted (2026-06-29)

**Date:** 2026-06-29

## Context

vaultflow stores 134 agent skill definitions (in `.agents/skills/`) and needed a user-facing way to author new agents without leaving the dashboard. The decision required choosing:

1. Whether to use an LLM to generate agent definitions or fill schemas deterministically
2. Where to write the new agent (project config, ~/.claude, or both?)
3. Whether to support single agents only (v1) or teams (v1)
4. How to enforce reuse-before-build for skills
5. How to inject context (tech stack detection, existing agent search)

An LLM-powered generator would need an API key, introduce inference latency, and require user review of generated prose. A deterministic wizard avoids all three and aligns with the "no hidden API calls" principle.

## Decision

**Adopted: Deterministic 7-step wizard (pure schema validation + file rendering) for single-agent creation, writing to ~/.claude, reusing existing stack-detect and skill-reuse infrastructure, with teams deferred to v2.**

### Design

The agent-creation flow is:
1. **Project listing** — browse projects detected by vaultflow
2. **Stack detection** — reuse existing `stack-detector.mjs` (22 rules, no API calls)
3. **Reuse search** — call existing `skill-reuse.cjs` scorer to surface REUSE/MODIFY/BUILD-NEW-OK verdicts
4. **Agent details** — form: name, description, trigger-pattern (slug-safe regex), persona, output-style, optional YAML-frontmatter notes
5. **Skill selection** — pick from existing skills (cached from vault + project index)
6. **Dry-run preview** — show what SKILL.md and agents/*.md would look like (no write yet)
7. **Confirm & write** — render final files, merge devteam-config.json, register in skills/index.md, surface liveness caveat

All rendering is pure function (no async I/O during form validation). The schema is baked into the form validation layer (input length, slug regex, enum choices).

### Where Does the Agent Live?

**Decision: Write to ~/.claude/agents/ + ~/.claude/skills/index.md + ~/.claude/devteam-config.json**

Rationale:
- Created agents serve Claude Code (the hook system) and Codex CLI, not the project
- User agents go in ~/.claude, not the project repo (keeps repos clean, respects workspace/user boundary)
- Project agents are created via project-specific skill directories (future scope, not v1)
- The devteam-config.json merge is safe: a new [agent] section with unique `name` will never collide with existing agents (trigger patterns are optional regex; collision checking is on agent name, which form enforces as unique)

### Why No LLM?

- **Zero dependencies** — no API key management, no rate limits, no internet required
- **Instant feedback** — 10ms form validation vs 5–30s model latency
- **Transparent determinism** — the wizard output is predictable; no risk of surprising behavior
- **Prototype-friendly** — easy to iterate the schema without embedding cost considerations
- **Aligns with vaultflow philosophy** — hooks are deterministic; context is curated; intelligence is applied *before* (stack detect, reuse search) not during (code generation)

An LLM summarizer for agent description/persona could be added in v2 without changing the architecture; v1 keeps it simple.

### Teams Deferred

v1 creates single agents only. Creating teams (multi-agent rosters with a coordinator) requires:
- Selecting multiple agents from the form
- Merging skill definitions into a team-level `.agents/team-{name}/` structure
- Generating a team-level trigger pattern aggregating all member triggers
- Updating devteam-config.json with a [team] section instead of [agent]

This is out of scope for v1. The form has `agent_type` enum ready (values: 'agent' for v1, 'team' for v2), so v2 can be implemented without breaking the schema.

## Consequences

### Positive
- **Zero external dependencies** — no LLM, no API keys, runs offline
- **Reuse before build is enforced at creation time** — the wizard calls `skill-reuse.cjs` before writing, surfacing overlaps upfront
- **Stack context is injected automatically** — no guessing which tech stack the agent should know
- **Safe file writes** — slug validation + path containment guard prevents write-anywhere exploits; 409 collision detection prevents silent overwrites
- **Newly created agents are immediately usable** — agent appears in devteam-config.json; dispatchable after Claude Code restarts; searchable after `npm run backfill --skills-only`
- **Low complexity** — 280 LOC in agent-authoring.mjs; no new infrastructure; reuses proven stack/skill-reuse components

### Tradeoffs Accepted
- **Agent descriptions are user-written, not AI-generated** — prose quality depends on the author. Mitigated by form hints and examples in the SKILL.md template.
- **Teams are explicitly deferred** — v1 cannot create multi-agent rosters. Acceptable because single agents cover ~90% of use cases; team creation is a natural v2 feature.
- **Liveness caveat** — new agents are not dispatchable until Claude Code restarts. Documented in the success notice; acceptable because agent setup is a one-time-per-agent task.
- **Backfill delay** — new agent does not appear in reuse-search (for other agents to discover) until the nightly `backfill --skills-only` job runs. Mitigated by the success notice with explicit command (`npm run backfill -- --skills-only`) if the user wants immediate visibility.

### What Was Rejected
- **LLM-powered generation** — rejected for reasons above; determinism + speed + transparency win
- **Project-local agent creation** — rejected because agents serve Claude Code (a user-level tool), not the project; project-local agents are a future variant
- **Blocking on missing required fields** — form allows optional fields (e.g., trigger-pattern, notes) to reduce friction; required fields are name + description only
- **Semantic skill search** — rejected (same reasoning as ADR-002); name/description overlap coefficient is sufficient for duplication detection at creation time

## Implementation Notes

- **Location:** `.claude/helpers/agent-authoring.mjs` (ESM, pure functions). Dashboard handler: `.claude/helpers/dashboard/server.mjs` endpoints `/api/agents/*`. UI: `.claude/helpers/dashboard/js/agents.js`.
- **Validation:** Slug regex `^[a-z][a-z0-9-]*[a-z0-9]$` (kebab-case, 2–64 chars). Path containment: agent is always written to `~/.claude/agents/{slug}/`, never outside.
- **YAML-frontmatter safety:** Input fields (description, persona, output_style) are newline-sanitized so multi-line pastes don't break agent YAML parsability.
- **Collision detection:** 409 response if the agent name already exists in devteam-config.json. Returned on the dry-run request (step 6) so the user can choose a different name before committing.
- **Safe merge:** `devteam-config.json` is read, a new [agent] section appended (or updated if retrying), and written back. No atomic transaction (acceptable for a local config file).
- **Registration:** New agent is appended to `skills/index.md` as `- name: {name}\n  path: {slug}/\n  type: agent`.
- **Backfill:** `npm run backfill -- --skills-only` rescans `.agents/` and indexes new agents by tomorrow's nightly run. The success notice surfaces this command.
- **Tests:** `tests/agentWizard.test.mjs` covers 9 cases: slug validation, collision detection, stack detection, skill reuse scoring, SKILL.md rendering, agents/*.md rendering, safe merge, safe write, liveness caveat display.

## Verification

The feature has been tested with:
- Slug validation (valid: `my-agent`, `a1`, `x-y-z`; invalid: `MyAgent`, `agent-`, `-agent`, `a`)
- Collision detection (409 on duplicate agent name)
- Stack detection (reuses stack-detector.mjs; returns 3–5 frameworks per project)
- Skill reuse scoring (REUSE/MODIFY/BUILD-NEW-OK verdicts on example skill queries)
- SKILL.md rendering (frontmatter + persona + output-style → valid YAML/Markdown)
- agents/*.md rendering (schema-driven template with optional fields)
- Safe merge (read devteam-config.json, append [agent], write back; no corruption on concurrent writes or missing fields)
- Dry-run preview (form shows what will be written; user can cancel or confirm)
- Liveness caveat (success notice displays restart requirement + backfill command)
