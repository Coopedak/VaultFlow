# Agency-Agents Harvest Candidates

Source: https://github.com/msitarzewski/agency-agents (103k stars, MIT)
Audit date: 2026-05-21
Categories audited: 18/18 (~165 agents scanned)

## Triage summary

| Bucket | Count |
|---|---|
| HARVEST | 21 |
| SKIP-DUPLICATE | ~38 (covered by existing skills) |
| SKIP-IRRELEVANT | ~106 (marketing/legal/HR/healthcare/etc — not DCC's domain) |

## Top 5 highest-confidence picks

1. **engineering-minimal-change-engineer** — amplifies ethos.md "minimum scope, maximum depth"
2. **specialized-mcp-builder** — DCC actively builds MCP infra (vaultflow itself)
3. **specialized-workflow-architect** — fills documented gap in project-lift pipeline (pre-plan stage)
4. **testing-reality-checker** + **testing-evidence-collector** — adversarial shipping gates currently missing
5. **engineering-software-architect** — upstream of researcher for cross-app PSI work

## Full HARVEST list (21)

| # | Source file | One-line purpose | Action |
|---|---|---|---|
| 1 | engineering/engineering-minimal-change-engineer.md | Surgical-diff discipline; refuses scope creep | Augment dev-team |
| 2 | engineering/engineering-codebase-onboarding-engineer.md | Reads code, traces paths, states facts only | New (cold-start) |
| 3 | engineering/engineering-database-optimizer.md | EXPLAIN ANALYZE, indexing, N+1 detection | Augment developer-database |
| 4 | engineering/engineering-git-workflow-master.md | Complex history surgery, bisect, recovery | New (complements superpowers git) |
| 5 | engineering/engineering-incident-response-commander.md | Severity frameworks, post-mortems, runbooks | New |
| 6 | engineering/engineering-sre.md | SLOs, error budgets, observability | New |
| 7 | engineering/engineering-threat-detection-engineer.md | SIEM rules, MITRE ATT&CK, detection-as-code | New (orthogonal to security-reviewer) |
| 8 | engineering/engineering-software-architect.md | DDD, bounded contexts, ADRs | New (upstream of researcher) |
| 9 | engineering/engineering-data-engineer.md | ETL/ELT, lakehouse, dbt, streaming | New (OLAP sibling) |
| 10 | engineering/engineering-embedded-firmware-engineer.md | ESP32/STM32/RTOS firmware | MAYBE (harvest, enable when needed) |
| 11 | engineering/engineering-ai-data-remediation-engineer.md | Self-healing data pipelines, deterministic fixes | New |
| 12 | testing/testing-evidence-collector.md | Screenshot-required QA | Augment verify |
| 13 | testing/testing-reality-checker.md | Demands overwhelming evidence before "ready" | New (gate before done) |
| 14 | testing/testing-performance-benchmarker.md | Measure → optimize → prove | New (general perf) |
| 15 | specialized/specialized-mcp-builder.md | Designs/builds/tests MCP servers | New (distinct from claude-api) |
| 16 | specialized/specialized-workflow-architect.md | Maps workflow branches/handoffs before code | New (pre-plan stage) |
| 17 | specialized/lsp-index-engineer.md | LSP client orchestration, semantic indexing | New (relevant to vaultflow roadmap) |
| 18 | specialized/specialized-model-qa.md | Independent ML model audit | New |
| 19 | specialized/specialized-document-generator.md | Programmatic PDF/PPTX/DOCX/XLSX | New (sibling to documenter) |
| 20 | specialized/automation-governance-architect.md | Decides what should/shouldn't be automated | New (pairs with voice-of-reason) |
| 21 | engineering/engineering-rapid-prototyper.md | POC/MVP delivery in days | MAYBE (spike mode) |

## Import caveats

- Every source file has `vibe:` / `emoji:` / personality framing → strip during import (DCC prefers minimal style)
- Substance to keep: Core Mission, methodology, decision matrices, output formats
- Target location: `C:\Users\DCC\.claude\skills\<kebab-name>\SKILL.md`
- After import, register in `C:\Users\DCC\vault\agents\index.md`
- Do NOT add to `C:\GIT\vaultflow\.agents\config.toml` unless Codex CLI should also see them
- License: MIT — permissive but attribute on import

## Suggested workflow

1. Pull files raw from `raw.githubusercontent.com/msitarzewski/agency-agents/main/<path>`
2. Normalize: strip vibe/emoji/personality, convert description to trigger-phrase style
3. Drop into `C:\Users\DCC\.claude\skills\<kebab-name>\SKILL.md`
4. Update vault/agents/index.md
5. Run vault-librarian to re-sync agent registry
