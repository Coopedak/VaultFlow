# Dev Team — Multi-Agent Development Plugin

**v1.5.1** · A coordinated development team for Claude Code. A Project Manager orchestrates six
specialist agents through a structured pipeline, every agent honors a shared coding-standards
interface, a Voice of Reason keeps the PM honest, an Integrator carries the work to a PR behind a
human approval gate, and team activity is logged for analytics.

```
PLAN ─▶ [voice of reason] ─▶ RESEARCH ─▶ [voice of reason] ─▶ DEVELOP ─▶ REVIEW ⟲(≤3) ─▶ DOCUMENT ─▶ INTEGRATE ─▶ REPORT
                                                                                              (human gate on push/merge)
```

## The team

| Agent | Role | Tools |
|-------|------|-------|
| **project-manager** | Orchestrates the pipeline, delegates, decides, sets review strictness | runs in the main session |
| **researcher** | Investigates approaches, recommends before code is written | read-only |
| **code-developer** | Writes/modifies code, verifies the build | read + write |
| **code-reviewer** | Reviews for correctness, security, standards; configurable strictness | read-only |
| **documenter** | Inline docs, changelogs, ADRs, runbooks | read + write |
| **integrator** | Branch, local commit, merge-conflict resolution, PR prep | git — push/merge **human-gated** |
| **voice-of-reason** | Skeptical advisor — pressure-tests the PM's decisions at the gates | read-only |

The PM runs in the **main session** (via the `dev-team` skill) so it can dispatch the other roles as
real subagents — a nested subagent can't fan out, which is why orchestration lives at the top level.

## What's new

**1.5.1** — Added the **Integrator** (Phase 6): branches, commits locally with the documenter's message,
resolves merge conflicts, and prepares the PR. It **never pushes, merges, or force-pushes on its own** —
each such operation returns an `APPROVAL REQUIRED` block that the PM relays to you for explicit final
sign-off (never auto-approved, even headless). The code-reviewer now also accepts a PR URL/diff.

**1.5.0**

- **Real subagents per role.** Each role is a proper agent definition dispatched by `subagent_type`,
  not a skill prompt stuffed into a generic agent.
- **Coding-standards interface.** A shared, overridable contract (`standards/`) every agent resolves
  before working — base rules + per-stack rules + a per-project `.dev-team/standards.md` override.
- **Voice of Reason.** A new advisor agent that challenges the PM's plan, flags over-/under-engineering
  and scope creep, and pushes business tradeoffs back to the user.
- **Analytics.** Hook-based, automatic logging of every dispatch; `/dev-team-report` shows dispatches
  per role, review-loop depth, and cycle time.
- **Deployable.** This repo is both the plugin **and** its own marketplace, so it installs on any
  device in two commands — no local clone needed.

## Install

Inside Claude Code:

```
/plugin marketplace add ProgressiveSurface/dev-team
/plugin install dev-team@dev-team
```

Pull later updates with:

```
/plugin marketplace update dev-team
```

Or run the bundled installer (does the same two steps from a shell):

```bash
# macOS / Linux
scripts/install.sh                 # add --scope project to scope it to one repo
# Windows
pwsh scripts/install.ps1
```

**Requirements:** Claude Code CLI, and Node.js for the analytics features.

## Use

In any project, say:

> "Use the dev team to add a customer search feature."

The session adopts the PM role and runs the pipeline, dispatching the specialists, consulting the Voice
of Reason at the decision gates, and keeping you in the loop at plan / research-approval / stalled-review
checkpoints.

See your team's activity any time:

```
/dev-team-report
```

## Run from another process (headless)

The team can run non-interactively — from CI, a scheduler, or another app.

**Installed plugin + CLI** (shell out to `claude -p`):

```bash
# macOS / Linux
scripts/run-team.sh --project ~/git/MyApp "add a search box to the customer list"
# Windows
pwsh scripts/run-team.ps1 -Project C:\git\MyApp "add a search box to the customer list"
```

Add `--json`/`-Json` for structured output and `--yolo`/`-Yolo` for fully unattended runs
(`--dangerously-skip-permissions`; sandbox/CI only). Default is `--permission-mode acceptEdits`.

**Embedded via the Agent SDK** (loads the plugin *by path* — no global install needed):

```bash
npm install @anthropic-ai/claude-agent-sdk
node examples/run-team.mjs --project /path/to/repo "implement issue #42"
```

See [`examples/run-team.mjs`](examples/run-team.mjs).

**Note on human-in-the-loop:** headless runs have no human at the approval checkpoints (confirm plan,
approve research, stalled-review decision). With `acceptEdits`/`bypassPermissions` the PM proceeds on
its own judgment, leaning on the Voice of Reason instead of you. For oversight without a live human,
use the SDK's `canUseTool` callback to approve/deny tool calls programmatically.

## Coding standards

The shared contract lives in [`standards/coding-standards.md`](standards/coding-standards.md). To
customize it for a repo, drop a `.dev-team/standards.md` in that repo stating only what differs — the
agents merge it on top. The `coding-standards` skill can scaffold one for you.

## Layout

This repo is the plugin and its own marketplace (like `psi-wiki`): both manifests live in
`.claude-plugin/`, and the marketplace's plugin `source` is `"."`.

```
dev-team/
├── .claude-plugin/
│   ├── marketplace.json          makes this repo installable as a marketplace
│   └── plugin.json               the plugin manifest (v1.5.1)
├── agents/                       the 7 role definitions (PM + 6 specialists)
├── skills/
│   ├── dev-team/                 orchestration entry point (PM in the main session)
│   └── coding-standards/         loads / scaffolds the standards interface
├── standards/                    the coding-standards contract + per-stack rules
├── hooks/hooks.json              analytics logging hooks
├── analytics/                    log-event.mjs, report.mjs
├── commands/dev-team-report.md   /dev-team-report
├── examples/run-team.mjs         Agent SDK runner (loads plugin by path)
└── scripts/                      install.* and run-team.* (headless runner)
```

## Supported stacks

C# / .NET Framework / .NET Core / WPF · Angular · Vue · React / TypeScript · Python · AL (Business Central)
