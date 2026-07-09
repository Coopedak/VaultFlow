# ADR-001: Claude Desktop Chat Import Reuses Sessions Table

**Status:** Accepted (2026-06-17)

**Date:** 2026-06-17

## Context

vaultflow gained the ability to import conversations from Anthropic's official Claude Desktop / claude.ai account data export. Each export is a `conversations.json` file containing an array of conversation objects with metadata, messages, and optional project mappings.

The design needed to decide whether imported conversations should:
1. Reuse the existing `sessions` table (distinguished by `cli='claude-desktop'`)
2. Create a new `conversations` table with its own schema and graph node type

Both approaches would accomplish the goal of making conversations discoverable in the Brain graph.

## Decision

**Adopted: Reuse the existing `sessions` table.**

Imported conversations become `sessions` rows with `cli='claude-desktop'` and `platform='imported'`. Each human turn becomes a `prompts` row (FTS-searchable). The full transcript becomes a `memory_entries` row (FTS + embeddings).

## Consequences

### Positive
- **Zero graph-engine changes**: The `sessions` table rows already flow into `getBrainGraph()` as nodes linked to their project via a `belongs` edge. No new node type, no new edge type, no dashboard color mapping needed.
- **Automatic dashboard integration**: Conversations appear in the Brain session list and pulse/vitals automatically, with no UI wiring required.
- **Consistent session semantics**: The `sessions` table is the canonical representation of any editing/collaboration context, whether it came from Claude Code, Copilot, Codex CLI, or Claude Desktop.
- **Minimal code**: The import logic is additive; the rest of the system treats them as regular sessions by default.
- **Idempotency handled at import time**: The `imported_chats` table records conversation uuid + updated_at, so re-runs skip unchanged conversations and re-process changed ones (deleting old prompts, rewriting transcripts) without duplicating data.

### Tradeoffs Accepted
- **Visual identity**: Conversations look identical to CLI sessions in the UI (same node type, same edges). Distinguishing them requires reading the `cli` column. Acceptable because both are authentic collaboration contexts vaultflow should treat equally.
- **Query complexity for import-specific logic**: Any future feature that needs to treat imported chats specially must filter on `cli='claude-desktop'`. This is explicit and maintainable (not a hidden table).

### Consequences Rejected (Why Not a New Table)
The alternative — a dedicated `conversations` table — was rejected because:
1. **Graph changes required**: Would need a new `conversation` node type in `getBrainGraph()`, new `belongs_via_conv` edge, or a `is_conv` boolean on the edge.
2. **Dashboard wiring**: Dashboard column definitions, color scheme, vitals aggregation, and session list filters would all need conversation-specific handling.
3. **Bridge logic needed**: The conversation's prompts would need to reference both `conversation.id` AND map back to which `session` they came from (or none), creating a data integrity edge case.
4. **No benefit to the user**: The person running vaultflow doesn't care if a context came from a database or an export file — they just want it searchable and visible in the Brain.

## Implementation Notes

- **Idempotency**: Conversations are tracked in the `imported_chats` table (uuid, file_path, updated_at, imported_at). A re-run compares updated_at; if unchanged, the conversation is skipped. If changed, its old prompts and retrieval_docs are deleted and rewritten.
- **No transactions**: The import is ordered to be crash-recoverable without explicit transactions (upsertMemoryEntry handles its own BEGIN/COMMIT; imported_chats is written last).
- **Watched folder**: `paths.claude_export_dir` in config points to a folder where users drop Anthropic's export files or unzipped export folders. The nightly job auto-detects new/changed conversations.
- **CLI access**: `npm run import-chats [path]` and `npm run import-chats [path] --dry-run` for manual runs. `vaultflow import-chats` for headless access.

## Verification

The import has been tested with:
- Single conversations.json files (direct export)
- Unzipped export folders (multiple nested conversations.json files)
- Conversations with and without associated projects
- Changed conversations (updated_at > last imported_at)
- Dry-run mode (parsing without DB writes)
