# Dev Team — install guide

A Claude Code plugin: a multi-agent development team. A **Project Manager** orchestrates a
**Researcher**, **Code Developer**, **Code Reviewer**, **Documenter**, **Integrator**, and a
**Voice of Reason** advisor through a Plan → Research → Develop → Review → Document → Integrate
pipeline. Ships a shared coding-standards interface every agent honors, built-in analytics, and an
integrator that **never pushes, merges, or force-pushes without explicit human approval**.

Version **1.5.1**. Works across C# / .NET / WPF, Angular, Vue, and React / TypeScript.

## Requirements

- **Claude Code** CLI (or the desktop app's bundled CLI)
- **Node.js** — needed for analytics (event logging + the `/dev-team-report` command). The rest of the
  plugin works without it.

## Install (from this folder)

This folder is a self-contained Claude Code plugin **and** its own marketplace, so it installs straight
from disk — no clone, no GitHub access needed.

**Easiest — run the local installer from a terminal in this folder:**

```bash
# Windows (PowerShell)
pwsh scripts/install-local.ps1

# macOS / Linux
./scripts/install-local.sh
```

**Or do the two steps yourself inside Claude Code** (replace the path with wherever you extracted this):

```
/plugin marketplace add "C:\path\to\dev-team"
/plugin install dev-team@dev-team
```

To remove later: `/plugin uninstall dev-team@dev-team` and `/plugin marketplace remove dev-team`.

> Note: the other scripts here — `scripts/install.ps1` / `install.sh` — install from a GitHub repo
> (`ProgressiveSurface/dev-team`) and are for the published version. For this hand-off copy, use the
> **`install-local`** scripts above.

## Use

In any project, just ask:

> "Use the dev team to add a customer search feature."

The session becomes the Project Manager and runs the pipeline — dispatching the specialist agents,
consulting the Voice of Reason at decision points, and stopping for your approval before any push/merge.

See team activity any time:

```
/dev-team-report
```

## Customizing standards per project

Drop a `.dev-team/standards.md` in any repo to override the coding standards for that project (state only
what differs). See `standards/coding-standards.md` and the `coding-standards` skill.

## More

- `README.md` — full overview, the roster, headless/CI usage, and the layout.
- `CHANGELOG.md` — what's in each version.
- `standards/` — the coding-standards interface every agent follows.
