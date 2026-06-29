# Phase 2 — Synapse (v2) Dashboard Migration Roadmap

> Port the remaining **v1 dashboard tabs** into the **v2 "Synapse" modular shell**
> (`index-v2.html` + `js/{view}.js` modules). Purely additive frontend — no server,
> DB, or v1 changes. v1 (`/`) stays fully working throughout.
> Source: discovery pass 2026-06-29 (grounded in `app.js`, `core.js`, existing v2 views).

## Status today
- **Working v2 views:** `command-center`, `atlas`, `agents` (Create Agent wizard — shipped).
- **Everything else** in the v2 nav falls through to the `__placeholder` ("Coming in the migration") — these are what Phase 2 fills.

## 3 decisions to make BEFORE coding
1. **Split the collapsed nav keys.** v2 currently routes multiple v1 tabs to one `data-view` key (`activity`=Sessions/Edits/Tool Calls/Prompts, `brain`=Graph/Memory/Dictionary/Discoveries, `code`=Code Graph/Flows/Stacks, `learning`=Patterns/Agents-list, `system`=Health/Control). The router highlights only one link per key. **Recommended: give each sub-view a unique key** (`brain-memory`, `code-stacks`, etc.) — ~12 attribute edits in `index-v2.html`, zero `core.js` logic change. Keeps each module small and independently registered.
2. **Split the v1 `graph` mega-tab.** v1 `loadGraph` (app.js L768-1025, 257 lines) is ~12 distinct tools, not one view. Decide the split (e.g. `system-health`, `code-graph` metrics, `code-search`) before Batch 5.
3. **`agents` list ≠ `agents` wizard.** The read-only agent list (v1 `loadAgents`) goes to a NEW `learning-agents` key; the Create wizard keeps `agents`.

## HARD PREREQUISITE (Batch 0)
**`index-v2.html` does NOT load Chart.js.** It loads `cytoscape.min.js` + `markdown-it.min.js` but not `chart.umd.min.js` (the file exists at `vendor/chart.umd.min.js`, just not wired). **All chart batches silently no-op until** `<script src="/vendor/chart.umd.min.js"></script>` is added before the module scripts. Do this first.

## The canonical port pattern (per view)
1. New `js/{key}.js`: `import { api, registerView, F } from './core.js';` (+ `import { line, sparkline } from './charts.js';` if charts).
2. Module-scope cleanup state: `let _charts = {}; let _cy = null;` (persist across re-renders).
3. `registerView(key, async (el) => {...})` — `core.js` resets `el.innerHTML` to a loader before calling; fetch via `api()` (throws on non-ok; `Promise.all` for parallel).
4. **Chart.js lifecycle (critical):** before creating, `if (_charts.x) { _charts.x.destroy(); }` then build via `charts.js` `line()`/`sparkline()` factories (never `new Chart` directly). Re-route without destroy → "Canvas is already in use".
5. **Cytoscape lifecycle:** `if (_cy) { _cy.destroy(); _cy = null; }` then `window.cytoscape({...})` (global UMD, not an import). Mirror `renderBrain`/`renderFlowGraph`.
6. Scoped CSS: inject once via `if (!document.getElementById('x-styles')) {...}` (see `agents.js`).
7. Add `<script type="module" src="/js/{key}.js">` to `index-v2.html`. No `core.js` change (placeholder auto-displaced on register).
8. Use Synapse CSS vars (`var(--muted)`, `var(--accent)`, `var(--border)`) — NOT v1's palette. Copy `esc()` from `atlas.js` for any user-data innerHTML.

## Batches (ordered; each is a pipeline pass)

| Batch | Views | Complexity | Notes |
|---|---|---|---|
| **0 — Prereqs** | wire Chart.js vendor + split nav keys (decisions 1 & 3) | XS | Blocker for all chart work; ~15 line edits in `index-v2.html` |
| **1 — Simple lists** | `memory` (search table), `discoveries` (table), `stacks` (card grid), `system-health` (table + unified search) | S | No charts, no Cytoscape — proves the pattern |
| **2 — Single-chart** | `sessions`, `edits`, `prompts`, `dictionary`, `learning-agents` (list) | S/M | One Chart.js each — proves destroy-before-init |
| **3 — Multi-chart + mutations** | `tool-calls` (2 charts), `patterns` (chart + promote POST), `control` (7 action buttons) | M | First mutations |
| **4 — Cytoscape** | `flows` (flowCy + declare/annotate + Excalidraw), `brain` graph (brainCy + **SSE pulse** + vitals charts + mission + model-rec mutation) | L | Brain graph is the most complex view; needs SSE teardown on nav-away |
| **5 — Code/graph mega-view** | split `loadGraph` remainder into `code-graph` (metrics/MCP/hubs/blast-radius/...) (+ `code-search`?) | L | Make decision 2 first |

## Key gotchas
- **Chart.js / Cytoscape re-init leak** — `el.innerHTML=''` does NOT `.destroy()`. Track instances at module scope; destroy before recreate.
- **SSE teardown** (Brain graph) — v1 `startPulse()` opens a persistent `EventSource('/api/brain/events')` never torn down. In v2 the render fn fires on every nav-in. Add a `hashchange` listener that calls `stopPulse()` when hash leaves `#/brain` (or add an optional `cleanup()` to `core.js` registerView — small additive change).
- **Markdown** — reuse `window.markdownit({html:false, linkify:true})` (loaded already, used by `atlas.js`); don't port v1's hand-rolled `mdToHtml`.
- **Nav active-state** — only one link per `data-view` gets `.active`; the split-key decision (1) fixes this.

## Execution model
Each batch = one pipeline pass: `developer-frontend` builds it → `voice-of-reason` per-agent check → `reviewer-code` → smoke-test in browser. Batch 0 + Batch 1 are the natural first session. Given the size, run batches across **fresh sessions** with clean budgets.
