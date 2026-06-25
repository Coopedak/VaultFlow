# Atlas — Quartz-hybrid knowledge site + Excalidraw flows

**Date:** 2026-06-25
**Status:** Design approved; pending spec review → implementation plan (Phase 1 first)
**Topic:** Add a Quartz-style knowledge surface and auto-generated Excalidraw flow diagrams to the vaultflow dashboard.

---

## 1. Summary

Augment the existing "Synapse" dashboard frontend with **Atlas**: a Quartz-style, linked-notes reading experience over vaultflow's brain, plus auto-generated **Excalidraw** drawings of every cataloged project flow. This is **additive** — nothing in the shipped live-metrics dashboard is removed. A single shared data + render core feeds three surfaces (live notes, static export, flow diagrams), reusing existing infrastructure wherever possible.

## 2. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | What "Obsidian Quartz / HTML hybrid" means | **Additive hybrid** — keep the live Synapse dashboard, add a Quartz-style knowledge site beside it under one shell |
| 2 | Content corpus | **Brain DB content** — `memory_entries` (decisions, patterns, imported chats, domain knowledge), not raw `.md` files |
| 3 | Excalidraw delivery | **`.excalidraw` files per flow** (Obsidian-openable) **+ read-only dashboard preview** |
| 4 | Render model | **Both** — live-served by the dashboard **and** a static HTML export |
| 5 | Build approach | **Shared rendering core, vaultflow-native** — no React, no real-Quartz SSG dependency; Quartz *aesthetic*, vaultflow architecture |

## 3. Goals / Non-Goals

**Goals**
- A live, Quartz-styled "Atlas" view in the dashboard: per-note reading page, backlinks panel, local graph, full-text search — sourced from the brain.
- One `.excalidraw` file per cataloged flow per project, regenerated on demand and nightly, openable in Obsidian's Excalidraw plugin.
- A read-only `.excalidraw` preview inside the dashboard's Flows view.
- A static-export command that emits a portable, offline Quartz-style HTML site from the same note core.

**Non-Goals**
- Not adopting the real Quartz SSG (esbuild/preact toolchain) — rejected for the no-dep ethos.
- Not embedding the full interactive Excalidraw React editor in-browser (preview is read-only).
- Not rendering arbitrary on-disk `.md` files in Phase 1 (corpus is the brain DB; file-corpus is a possible later extension, explicitly out of scope here).
- Not removing or restyling the existing Synapse dashboard beyond adding the Atlas surface and the Flows preview.

## 4. Architecture

```
                        ┌────────────────────┐
 memory_entries  ─────► │  brain-notes.cjs   │ ──► live JSON API ──► Atlas SPA view (Quartz-styled)
 brain graph edges ───► │  (note data core)  │ ──► export-quartz.mjs ──► portable static HTML site
 [[wikilinks]] in body  └────────────────────┘
                                                    (shared markdown renderer, vendored)

 flow_nodes / flow_edges ─► flow-excalidraw.cjs ─► .excalidraw files (per flow) ─► dashboard read-only SVG preview
```

A single note data core (`brain-notes.cjs`) is the source of truth for both the live view and the static export, guaranteeing they render identically. The Excalidraw generator is an independent module wired into the same nightly/on-demand maintenance pattern established by `cleanup.mjs`.

## 5. Components

### 5.1 `brain-notes.cjs` — note data core (CJS, sibling of `db.cjs`)
Transforms brain records into note objects. Implemented against the **actual** `memory_entries` schema (the implementer verifies real column names via `db.cjs`; the model below is at the conceptual altitude).

- **Note model:** `{ id, title, body (markdown), type, source, createdAt, links[] (outbound), backlinks[] }`
- **API:**
  - `listNotes({ project?, type?, limit?, offset? })` → note headers
  - `getNote(id)` → full note + resolved outbound links
  - `getBacklinks(id)` → notes referencing this one (via brain graph edges + `[[wikilink]]` scan of bodies)
  - `getLocalGraph(id, depth=1)` → `{ nodes, edges }` neighborhood for the local-graph panel (same shape the existing graph view consumes, so the vendored Cytoscape renderer is reused)
- **Link extraction:** parse `[[name]]` references from note bodies and combine with brain graph edges to build the link/backlink index. A `[[name]]` that resolves to no note is rendered as a "dangling" link (Quartz behavior), not an error.
- Calls `db.initialize()` (idempotent) before queries; honors the BM25 `ORDER BY rank ASC` convention for any FTS use.

### 5.2 Vendored markdown renderer
- Vendor `markdown-it` (MIT) UMD build into `.claude/helpers/dashboard/vendor/` alongside `chart.umd.min.js` / `cytoscape.min.js`. **This is the one new dependency.** No build step, no CDN (consistent with existing vendoring).
- A thin wrapper resolves `[[wikilinks]]` to note routes (live: `#/notes/:id`; export: relative `./<slug>.html`) and marks dangling links.
- The renderer is shared by the live API and the export command so output is identical.

### 5.3 Live Atlas view (Express + SPA)
- **Endpoints** (added to `dashboard/server.mjs`, following the existing 59-endpoint conventions):
  - `GET /api/notes` → list (supports `project`, `type`, paging)
  - `GET /api/notes/:id` → `{ note, html, backlinks, localGraph }`
- **SPA:** a new "Atlas" view registered in the modular v2 shell (`dashboard/js/`, alongside `command-center.js`), Quartz-styled: centered reading column, backlinks panel, local Cytoscape graph, and a search box wired to the **existing** FTS search endpoint. Styling lives in `dashboard/css/` (Quartz aesthetic: typography, dark theme, link affordances).

### 5.4 `flow-excalidraw.cjs` — flow → Excalidraw generator (CJS)
- Converts one flow (`flow_nodes` / `flow_edges` via `db.cjs`) to `.excalidraw` JSON using the format from the `excalidraw-diagram` skill: nodes → rounded rectangles with labels, edges → arrows, simple top-down/left-right layout, sketchy hand-drawn style.
- **CLI / wiring:** `npm run flows:draw` regenerates one `.excalidraw` file per flow per project into a **configurable output directory** (default `docs/flows/<project>/<flow-slug>.excalidraw`, Obsidian-openable). Wired into `nightly.mjs` (regenerate on the nightly loop) following the `cleanup.mjs` step pattern; report-only/idempotent (rewrites files, never deletes unrelated content).
- Path of the output dir is resolved via the existing config resolution (`config/resolve.cjs`) so the portable D:/E: copies and other machines behave correctly.

### 5.5 Dashboard Excalidraw preview
- The Flows view gains a **read-only** preview: a small custom `.excalidraw`-JSON → SVG renderer (rectangles, arrows, text, diamonds) — no React, no Excalidraw package. The existing Cytoscape Flows graph remains available; the preview shows the generated `.excalidraw` so what you see matches the file you'd open in Obsidian.

### 5.6 `export-quartz.mjs` — static export (ESM helper)
- `npm run export:quartz [outDir]` walks all notes through `brain-notes.cjs` + the shared renderer and emits a standalone HTML site: one page per note, an index/graph landing page, and copied vendored assets (css/js). Cross-links rewritten to relative `.html`. Output is portable and works offline. Output dir configurable (default `dist/quartz/`, gitignored).

## 6. Data flow

1. **Live note read:** SPA requests `GET /api/notes/:id` → `server.mjs` calls `brain-notes.getNote` + `getBacklinks` + `getLocalGraph` → markdown rendered to HTML server-side (or shipped raw + rendered client-side via the vendored lib — implementer picks one and applies it to both surfaces) → SPA renders reading column + backlinks + Cytoscape local graph.
2. **Static export:** `export-quartz.mjs` iterates `listNotes()` → renders each via the shared renderer → writes `<slug>.html` + index → rewrites links relative.
3. **Flows:** `flow-excalidraw.cjs` reads `flow_nodes`/`flow_edges` → emits `.excalidraw` files; dashboard Flows view fetches the generated JSON and renders read-only SVG.

## 7. Phased decomposition

This feature is too large for one implementation plan. Three phases, each its own plan → PR. **Phase 1 is planned first** (this brainstorming transitions into the Phase 1 plan).

- **Phase 1 — Brain-notes core + live Atlas view.** `brain-notes.cjs`, vendored markdown renderer, `/api/notes` + `/api/notes/:id`, the Atlas SPA view (reading column, backlinks, local graph, search). Acceptance: navigate brain notes in the dashboard with working backlinks, local graph, and search; dangling `[[links]]` handled gracefully.
- **Phase 2 — Excalidraw flows.** `flow-excalidraw.cjs`, `npm run flows:draw` + nightly wiring, configurable output dir, dashboard read-only SVG preview. Acceptance: each cataloged flow produces a valid `.excalidraw` file openable in Obsidian; dashboard preview matches; nightly regenerates.
- **Phase 3 — Static export.** `export-quartz.mjs` + `npm run export:quartz`. Acceptance: every note emits a page, links rewritten relative, site browses offline, output identical in structure to the live view.

## 8. Testing

Follow the house pattern (`tests/*.test.mjs`, `node --test`):
- **brain-notes:** wikilink + backlink extraction, dangling-link handling, local-graph shape, note model mapping (fixture DB).
- **flow-excalidraw:** node/edge → schema-valid `.excalidraw` JSON (parse + assert element types/bindings); deterministic output for a fixed flow fixture.
- **export-quartz:** every listed note yields a page; internal links rewritten to existing relative files; no dangling file refs.
- Windows-path-safe; no network; graceful degradation if the brain DB is unavailable (consistent with `cleanup.mjs`).

## 9. Reuse-before-build ledger

| Need | Reused asset |
|------|--------------|
| Graph rendering (local graph, Flows) | Vendored **Cytoscape** (already present) |
| Full-text search in Atlas | Existing FTS **search endpoint** + `db.cjs` |
| Excalidraw JSON format | **`excalidraw-diagram`** skill reference |
| Nightly + on-demand regeneration pattern | **`cleanup.mjs`** / `nightly.mjs` step pattern (just built) |
| DB access, idempotent init, BM25 convention | **`db.cjs`** |
| Config/path resolution (portable copies) | **`config/resolve.cjs`** |
| New dependency | Only **`markdown-it`** (vendored, MIT) — required for live + export rendering |

## 10. Risks / open notes

- **`memory_entries` schema:** the note model must map to real columns — verified against `db.cjs` at implementation time, not assumed here.
- **Markdown rendering location (server vs client):** pick one and use it for *both* live and export to keep parity; decided in the Phase 1 plan.
- **Excalidraw layout quality:** auto-layout of arbitrary flow graphs can look messy; Phase 2 uses a simple deterministic layered layout and accepts "good enough," matching the "flow catalog is APPROXIMATE" stance already documented for flows.
- **Export staleness:** static export is a point-in-time snapshot by design; the live view is the always-current surface.
- **CSP/no-CDN:** all assets vendored locally; nothing fetched from external hosts.
