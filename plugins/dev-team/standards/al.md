# Stack Standards: AL (Microsoft Dynamics 365 Business Central)

Extends [`coding-standards.md`](coding-standards.md). Local code style still wins on §1.4 matters.

## Objects & identity
- Every new object ID must fall inside an `idRange` declared in `app.json`. Never hardcode an ID
  outside the app's assigned range, and never reuse base-application IDs.
- Apply the app's mandatory **affix/prefix** (from `AppSourceCookbook` / the project's ruleset) to
  every new object, and to fields/controls/actions added to base or other apps' objects. If the
  project defines an affix, an unaffixed identifier is a defect.
- Object names are `PascalCase` and stay within the platform length limit; match the project's
  existing naming (e.g. `<Affix> Customer Sync`).

## Extend, don't fork the base app
- Add to standard tables/pages with **table/page extensions**, not by copying the object. Never modify
  base-application source.
- Hook standard logic through **event subscribers** (or the published integration events) rather than
  overriding it. Prefer the narrowest published event that exists.
- Business logic lives in codeunits; keep pages/tables thin. Put reusable logic behind a codeunit the
  same way siblings expose it.

## Data, errors & transactions
- Give every new table-relation field a correct `TableRelation`; validate with `TestField`/`FieldError`
  where the base pattern does.
- Raise user-facing failures with `Error()` (use a `Label` for the text, not a bare string literal, so
  it's translatable). Wrap fallible calls in a `[TryFunction]` instead of swallowing.
- Do **not** add explicit `Commit()` to force a partial write — it breaks the transaction/rollback
  model. Only where the project's existing pattern demonstrably requires it.
- Ship a `.permissionset` (or extend one) for new objects; don't rely on SUPER.

## Build & verify
- `app.json` must stay valid: `dependencies`, `platform`/`application` versions, and `idRanges`
  consistent with what you added. Add a dependency only when you actually reference that app.
- Compile with the AL compiler (VS Code AL extension / `alc`) against the project's target runtime;
  fix all compiler errors before reporting. If the compiler isn't available, do a manual check:
  IDs in range, affixes present, referenced objects/fields exist, `TableRelation`s resolve.

## Reviewer hot-spots
IDs outside the `app.json` range or colliding with base, missing affix on new/added identifiers,
direct modification of the base app instead of extension/subscriber, missing or wrong `TableRelation`,
hardcoded user-facing strings instead of `Label`, gratuitous `Commit()`, missing permission set, and
`app.json` dependency/version drift.
