---
name: coding-standards
description: >
  Loads the Dev Team coding-standards interface — the contract every dev-team agent honors. Use this
  skill to view, apply, or set up coding standards for a project: when the user says "what are our
  coding standards", "apply the coding standards", "set up coding standards for this repo", "create a
  standards override", or wants to know which rules the developer and reviewer will follow. Also use it
  to scaffold a per-project `.dev-team/standards.md` override.
---

# Coding Standards Interface

This skill surfaces the shared standards contract the Dev Team agents follow. The full interface lives in
[`standards/coding-standards.md`](../../standards/coding-standards.md), with stack-specific rules in
[`csharp.md`](../../standards/csharp.md), [`typescript-web.md`](../../standards/typescript-web.md),
[`python.md`](../../standards/python.md), and [`al.md`](../../standards/al.md).

## To view or apply the standards

Read `${CLAUDE_PLUGIN_ROOT}/standards/coding-standards.md` plus the stack file matching the project's
primary language. Resolve the effective standard in this order (later wins):

1. base contract → 2. matching stack file → 3. project override → 4. the existing code (for style only).

The same resolution every agent performs before it works.

## To set up a project override

A repo can override §2–§4 of the contract by adding `.dev-team/standards.md`. State **only what differs**
from the base — the agents merge it on top, so you don't repeat the whole contract. A useful skeleton:

```markdown
# Coding Standards Override — <project name>

## Strictness default
<pragmatic | configurable (focus: ...) | production-grade>

## Naming & layout
<only the project-specific conventions that differ from the base>

## Required patterns
<e.g. "all data access goes through RepositoryBase", "use Result<T> not exceptions for expected failures">

## Forbidden
<e.g. "no new third-party DI containers", "no direct DOM access in components">

## Tests
<when tests are required for this repo>
```

Place it at `.dev-team/standards.md` in the repo root. The Developer will conform to it, the Reviewer
will enforce it (citing the specific rule), and the Documenter will record any deliberate deviation.
