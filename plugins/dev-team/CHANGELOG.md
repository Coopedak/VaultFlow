# Changelog

All notable changes to the Dev Team plugin.

## [1.5.1] — 2026-06-29

### Added
- **Integrator agent** (`agents/integrator.md`) — a new Phase 6 (Integrate) that branches, commits
  locally with the documenter's message, resolves merge conflicts, and prepares the pull request.
  Scoped deliberately to version-control mechanics + conflict resolution; it does **not** author commit
  messages (documenter) or judge code quality (reviewer).
- **Human approval gate on destructive git.** The integrator never performs a **push, merge, or
  force-push** on its own — each returns an `APPROVAL REQUIRED` block with the exact commands, and the PM
  must relay it to the human for explicit, per-operation sign-off. Commit ≠ push ≠ merge are separate
  gates, and the PM is forbidden from auto-approving them, even in headless/auto-approve runs.
- **Code-reviewer accepts a PR/diff.** It can now review a `gh` PR URL or a `git diff` (and re-review the
  specific hunks an integrator changed while resolving a conflict), not just working-tree changes.

### Changed
- PM pipeline is now Plan → Research → Develop → Review → Document → **Integrate** → Report, with the
  Integrate phase behind the mandatory human push/merge gate.
- Analytics now track `integrator` dispatches (`/dev-team-report`).
- **Parallelism guidance sharpened.** The PM playbook now defines an explicit independence test (disjoint
  files / no shared contract / no ordering dependency), **mandates `isolation: worktree` for concurrent
  developers**, and states the rule plainly: keep dependent tasks serial. Clarified that splitting one
  feature across separate "frontend"/"backend" developers is not parallelism — one developer owns a
  vertical slice; use parallel developers only for independent features or separate repos.

## [1.5.0] — 2026-06-29

Major restructure from the v1.0 skill bundle into a deployable Claude Code plugin.

### Added
- **Real subagents per role.** All five roles are now proper agent definitions (`agents/*.md`) dispatched
  by `subagent_type`, plus a new sixth role. Each has scoped tools and a model suited to its job.
- **Voice of Reason agent.** A skeptical advisor that pressure-tests the PM's plan at decision gates —
  flagging over-/under-engineering, scope creep, risky assumptions, and tradeoffs the user should decide.
- **Coding-standards interface.** A shared, overridable contract (`standards/`) every agent resolves
  before working: a universal floor, per-stack rules (C#/.NET, TypeScript web), per-role obligations,
  strictness tiers, and a per-project `.dev-team/standards.md` override mechanism. A `coding-standards`
  skill views or scaffolds it.
- **Analytics.** Hook-based automatic logging of every subagent dispatch and session boundary to the
  plugin data dir, plus a `/dev-team-report` command showing dispatches per role, review-loop depth, and
  cycle time. Fail-safe logger that never blocks a session.
- **Deployable packaging.** Restructured as a plugin inside a marketplace repo, installable on any device
  via `claude plugin marketplace add` + `claude plugin install`, with `install.ps1` / `install.sh` helpers.
- **Headless runner.** `scripts/run-team.ps1` / `run-team.sh` wrap `claude -p` to drive the team from CI,
  a scheduler, or another process; `examples/run-team.mjs` embeds it via the Agent SDK, loading the plugin
  by path (no global install needed). Both default to `acceptEdits` with a `--yolo` fully-unattended switch.

### Changed
- The Project Manager now runs in the main session (via the `dev-team` skill) and dispatches real
  subagents, instead of every role being a skill prompt handed to a generic agent.
- The PM pipeline gained explicit Voice of Reason gates after planning and before committing to a costly
  research recommendation or when a review loop stalls.
- Every developer/reviewer brief now carries an explicit strictness tier; the standards contract defines
  auto-escalation for auth/payments/deletes/migrations/crypto/external APIs.

### Migration from 1.0
The v1.0 skill bundle (`~/.claude/skills/dev-team-bundle/`) is unchanged and can be left installed as a
fallback. Once 1.5 is installed and verified, remove or ignore the old bundle to avoid duplicate triggers.

## [1.0.0] — 2026-04-03
- Initial five-agent skill bundle: project-manager, researcher, code-developer, code-reviewer, documenter.
