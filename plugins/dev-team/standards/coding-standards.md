# Coding Standards Interface

This file is the **contract** that every Dev Team agent honors. The Developer follows it,
the Reviewer enforces it, the Researcher respects its constraints, the Documenter records
deviations from it, the Project Manager sets its strictness, and the Voice of Reason checks
decisions against it.

It is an **interface**, not a fixed rulebook: a project can override or extend any part of it.

---

## 1. Resolution Order (how an agent decides which standards apply)

When an agent starts work, it resolves the effective standard by reading, in order, and
letting **later sources win** on any conflict:

1. **This base contract** — `${CLAUDE_PLUGIN_ROOT}/standards/coding-standards.md` (universal floor)
2. **The matching stack file** — `${CLAUDE_PLUGIN_ROOT}/standards/csharp.md`,
   `.../typescript-web.md`, `.../python.md`, or `.../al.md`, selected from the project's primary language
3. **Project override** — the first of these that exists in the target repo:
   - `.dev-team/standards.md`
   - `docs/coding-standards.md`
   - a `## Coding Standards` section in the repo's `CLAUDE.md` or `CONTRIBUTING.md`
4. **The existing code itself** — when the written rule and the surrounding code disagree on
   a *style* matter (naming, layout, error-handling idiom), **match the surrounding code** and
   note the discrepancy. Correctness and security rules below are never overridden by local style.

If no project override exists, the base contract plus the stack file are authoritative.

---

## 2. Universal Principles (the floor — apply to every language)

**Fit before preference.** Code you add must read as if the existing team wrote it. Match the
project's naming, file layout, async idioms, DI patterns, and comment style. A reviewer should
not be able to tell where existing code ends and new code begins.

**Minimal, focused diffs.** Change what the task requires and nothing else. No drive-by
refactors, reformatting, or import reshuffling unless that *is* the task.

**Error handling is proportional.** Guard the things that actually fail at runtime — I/O,
network, parsing, user input, external APIs — and let the rest stay readable. Don't wrap every
line in defensive code; don't swallow exceptions silently.

**Comment the why, not the what.** Inline comments explain intent, business rules, workarounds,
and non-obvious side effects. Never restate what the code plainly says.

**Names carry meaning.** No single-letter names outside tight loops, no abbreviations the
codebase doesn't already use, no magic numbers or strings — name them.

**Security baseline (non-negotiable, never overridden by local style):**
- Never commit secrets, tokens, connection strings, or keys. Read them from config/env.
- Validate and parameterize all external input; never build SQL or shell strings by concatenation.
- Escape/encode output that crosses a trust boundary (HTML, logs, file paths).
- Don't widen access (public, CORS, file permissions) beyond what the task needs.

**Leave it buildable.** Every file is syntactically valid and wired up (namespaces, imports, DI
registration, route/module declarations) when you stop. The build must pass before you report done.

**Tests are scoped, not assumed.** Write or update tests when the task says so, when changing
shared/core logic, or when fixing a bug that a test could have caught. Otherwise don't invent a
test burden the project doesn't already carry.

---

## 3. Per-Role Obligations (how each agent uses this interface)

| Role | Obligation against this contract |
|------|----------------------------------|
| **Code Developer** | Resolve the effective standard (§1) before writing. Produce code that conforms. If a project override conflicts with a task instruction, flag it to the PM rather than guessing. |
| **Code Reviewer** | Enforce the *resolved* standard, not personal taste. Cite the specific rule a finding violates. Don't flag style the surrounding code already accepts. Strictness tier (§4) sets how far you go past the floor. |
| **Researcher** | Recommend approaches that fit the resolved standard and the existing stack. Don't propose a pattern the project's standards forbid. |
| **Documenter** | Record any *deliberate* deviation from the standard (and its justification) in the changelog or an ADR. Update the project override file if a new convention was established. |
| **Project Manager** | Choose the review strictness tier per task (§4) and pass it, plus any project-specific focus, into every dispatch. Raise the tier for sensitive code. |
| **Voice of Reason** | Sanity-check that the chosen approach and strictness actually match the risk. Flag both over-engineering (gold-plating low-risk code) and under-engineering (pragmatic tier on auth/payments/deletes). |

---

## 4. Strictness Tiers (set by the PM, enforced by the Reviewer)

- **Pragmatic** (default) — Bugs, crashes, data-loss, and security floor only. Don't block on style the code already tolerates.
- **Configurable (focus: X)** — Pragmatic plus deep attention on a named area (e.g. performance, the API contract, concurrency). Still catch obvious bugs elsewhere.
- **Production-grade** — Full SOLID, complete error-handling coverage, security review, performance review, naming/organization, and test-coverage expectations.

**Auto-escalate to production-grade** (regardless of default) when the change touches:
authentication, authorization, payment, data deletion or migration, cryptography, or external
API integration.

---

## 5. Extending This Interface

To customize standards for a specific repo, drop a `.dev-team/standards.md` in that repo. Anything
you put there overrides §2–§4 for that project. Keep it short and state only what differs from this
base — the agents merge it on top, they don't need the whole contract repeated.

Stack-specific rules live in sibling files:
- [`csharp.md`](csharp.md) — C# / .NET Framework / .NET Core / WPF
- [`typescript-web.md`](typescript-web.md) — Angular, Vue, React, TypeScript
- [`python.md`](python.md) — Python
- [`al.md`](al.md) — AL (Microsoft Dynamics 365 Business Central)
