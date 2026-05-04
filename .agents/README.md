# .agents — vaultflow Codex Skills

Codex CLI skills for vaultflow. Sourced from ruflo's Claude Flow V3 (134 total),
curated down to 15 practical dev/analysis agents. Swarm infra, neural/SONA layers,
payments, GitHub automation, and V3 rebuilds are all disabled.

## Structure

```
.agents/
  config.toml          # Codex configuration (model, approval, 15 enabled skills)
  skills/              # 134 skill directories (15 enabled, 119 disabled)
    agent-*/
      SKILL.md         # Skill instructions + trigger conditions
  README.md            # This file
```

## Quick Start

```sh
# Run with a specific skill
codex --config .agents/config.toml "$agent-coder implement the CustomerSearch service"

# Let auto-routing pick the skill (via vaultflow hook)
codex --config .agents/config.toml "add unit tests for OrderService"

# Use CI profile (no approval prompts)
codex --config .agents/config.toml --profile ci "run the test suite"
```

## Enabled Skills (15)

| Skill | Trigger keywords |
|-------|----------------|
| `agent-coder` | implement, code, write, build |
| `agent-researcher` | research, investigate, compare, what is |
| `agent-reviewer` | review, check, validate, quality |
| `agent-security-manager` | security, vulnerability, auth, injection, owasp |
| `agent-tester` | test, unit test, coverage, TDD |
| `agent-planner` | plan, roadmap, strategy, approach |
| `agent-architecture` | architecture, design, system design, patterns |
| `agent-code-analyzer` | analyze, code quality, complexity, tech debt |
| `agent-performance-analyzer` | performance, slow, bottleneck, optimize |
| `agent-docs-api-openapi` | openapi, swagger, api docs |
| `agent-dev-backend-api` | backend, api, endpoint, REST |
| `agent-code-review-swarm` | code review, deep review, review all files |
| `agent-migration-plan` | migrate, migration, upgrade, convert |
| `agent-specification` | spec, requirements, acceptance criteria |
| `agent-goal-planner` | goal, objective, achieve, action plan |

## Auto-Routing

vaultflow's router (`hook-handler.cjs`) intercepts every `UserPromptSubmit` event,
scores the prompt against both Claude skills and these Codex trigger keywords, and
injects the matching skill's instructions into the prompt context automatically.

- Confidence ≥ 0.6: full skill instructions injected
- Confidence 0.3–0.59: skill description injected
- < 0.3: silent (no injection)

The same 10-minute session suppression that applies to Claude skills also applies
here — the same Codex skill won't be re-injected within the same session window.

## vaultflow DB Registration

All 15 adopted skills are registered in `vault_agents` (source='codex') during
`npm run backfill`. Use counts are tracked by `db.incrementAgentUse()` each time
the router matches a Codex trigger, keeping the registry sorted by actual usage.

## Disabled Skills (119)

Disabled skills remain in `skills/` for reference but are set `enabled = false`
in `config.toml`. Categories disabled:

- **Swarm / coordination** (34): hierarchical/mesh/ring coordinators, quorum, raft, gossip
- **Neural / ML / SONA** (14): neural network, embeddings, agentdb, vector search
- **GitHub automation** (13): PR manager, release manager, workflow automation
- **V3 infra rebuilds** (13): memory unification, DDD architecture, security overhaul
- **Payments / domain** (6): payments, trading, app store, claims
- **ruflo misc** (39): sparc-methodology, worker-benchmarks, hooks-automation, etc.

To re-enable any: set `enabled = true` in `config.toml` and run `npm run backfill --skills-only`.

## Configuration Notes

- **Model**: `claude-sonnet` (Mid tier). Override per-run: `codex --model claude-opus`
- **Approval**: `on-failure` — only prompts when something goes wrong
- **Sandbox**: `workspace-write` — can write within project, no system-wide access
- **No MCP claude-flow**: vaultflow uses its own hook system instead
- **No auto-push**: explicitly excluded (ruflo had `AUTO_PUSH=true` by default)
