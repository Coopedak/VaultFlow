# Standards Interface

The shared coding-standards contract every Dev Team agent reads before acting.

- [`coding-standards.md`](coding-standards.md) — the interface: resolution order, universal floor,
  per-role obligations, strictness tiers, and how to override per project.
- [`csharp.md`](csharp.md) — C# / .NET / WPF stack rules.
- [`typescript-web.md`](typescript-web.md) — Angular / Vue / React / TypeScript stack rules.
- [`python.md`](python.md) — Python stack rules.
- [`al.md`](al.md) — AL / Microsoft Dynamics 365 Business Central stack rules.

## Per-project override

Drop a `.dev-team/standards.md` in any target repo to override §2–§4 of the contract for that repo.
State only what differs from the base — the agents merge it on top. See §5 of the contract.
