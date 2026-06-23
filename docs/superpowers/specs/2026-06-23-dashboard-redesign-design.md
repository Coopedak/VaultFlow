# vaultflow Dashboard Redesign — "Synapse" Command Center — Design

- **Date:** 2026-06-23
- **Status:** Draft — pending user review
- **Scope:** Full visual redesign + information-architecture overhaul of the dashboard SPA, a new **Synapse** design system, a **Command Center** home, and a **native WebView2 desktop window**. Vanilla JS, **no build step**. Reuses all existing Express endpoints unchanged.

> **Decisions locked during brainstorming (2026-06-23):**
> - **Approach A — refine in place.** Keep vanilla JS + the existing Express server + all ~54 endpoints. No framework, no build toolchain (preserves the repo's self-contained, zero-build property).
> - **Direction: Synapse** — a dense neural-telemetry console. Deep indigo-ink ground, signal-cyan + synapse-violet accents, monospace data, an animated node-pulse hero. (Chosen over "Atlas", the calm/spacious alternative.) Mockup: `scratchpad/mockup-synapse.html` → deployed artifact.
> - **Delivery: native WebView2 window** — a real desktop app window wrapping the served UI, not a browser tab.
> - **Ambition: full redesign + IA overhaul** — restyle every section AND regroup the 15 tabs into 6 logical sections, splitting the kitchen-sink Graph tab.

---

## North Star

The dashboard should feel like the **instrument panel of a living brain** — open it and the state of vaultflow is legible in three seconds: is it healthy, what has it learned, what changed, what needs me. Today it is a functional-but-flat 15-tab SPA opened in a browser tab; the redesign makes it a state-of-the-art, self-contained desktop command center.

**What stays (and why):** the Express server (`dashboard/server.mjs`) and all ~54 endpoints are solid and stay byte-for-byte. The data layer, SQLite, Chart.js, and Cytoscape stay. This is a **frontend + packaging** redesign — the riskiest parts of the system are untouched.

**Non-goals:** no new backend endpoints unless a Command Center widget genuinely needs aggregated data (at most one read-only `/api/overview` aggregator — see below); no framework/build step; no auth/multi-user; no remote access (stays localhost); no change to hook/DB/nightly internals.

---

## 1. Information Architecture

The 15 flat tabs collapse into **6 groups** in a left sidebar. The kitchen-sink **Graph** tab (≈12 unrelated tables) is dismantled and its contents rehomed.

| Group | Sections (current tab → new home) | Primary endpoints |
|---|---|---|
| **Command Center** | New home (replaces *Overview*) | `/api/status`, `/api/health`, `/api/sessions/summary`, `/api/embeddings/stats`, `/api/code-graph/stats`, `/api/brain/snapshots`, `/api/watcher/status`, `/api/discoveries`, `/api/memory/stale` |
| **Activity** | Sessions · Edits · Tool Calls · Prompts · Session Replay | `/api/sessions`, `/api/sessions/:id/timeline`, `/api/edits/hot`, `/api/tool-calls`, `/api/prompts/recent` |
| **Brain** | Graph · Memory (+ Stale Memory, Backlinks) · Dictionary · Discoveries · Brain Vitals · Model Recs | `/api/brain/graph`, `/api/brain/note`, `/api/brain/events`, `/api/brain/snapshots`, `/api/memory`, `/api/memory/stale`, `/api/backlinks`, `/api/dictionary`, `/api/discoveries`, `/api/model/recommendations` |
| **Code** | Code Graph (Hubs, Top Files, Symbol Search, Blast Radius, Callers, MCP Adoption) · Flows · Stacks · Git Context | `/api/code-graph/*`, `/api/flows*`, `/api/stacks`, `/api/git-context` |
| **Learning** | Patterns · Agents · Verdicts | `/api/patterns`, `/api/patterns/:id/promote`, `/api/agents`, `/api/verdicts` |
| **System** | Health · Control (flush/backfill/learning/dict/watcher) · Config · Project Focus · Stale Vault Tools | `/api/health`, `/api/audit`, `/api/flush`, `/api/backfill`, `/api/learning/run`, `/api/watcher/*`, `/api/dict/import`, `/api/config`, `/api/focus`, `/api/vault-tools/stale` |

**Graph kitchen-sink split:** unified/semantic search → **global ⌘K search** in the top bar (cross-cuts all groups); health → System + Command Center summary; focus & stale-tools → System; hubs/top-files/blast-radius/symbol-search/callers/git-context/MCP-adoption → Code; session replay → Activity; stale-memory & backlinks → Brain.

---

## 2. Command Center (the new home)

Replaces the current Overview. Three-second legibility, top to bottom:

1. **System Pulse hero** — headline verdict ("All systems nominal" / "N checks need attention"), a health ring (green count / total from `/api/health`), one-line status (nightly age, watcher, embedded %), behind an animated node-pulse canvas (the brain). Reduced-motion → static.
2. **Brain Vitals grid** — tiles with value + sparkline + status LED: Memory (count + embedded %), Code Graph (files/symbols/edges), Sessions (count + summarized %), Retrieval (docs/7d), Nightly (age), Embed Queue (depth/oldest), Database (size + integrity), Pattern Signal (top key / noise check).
3. **Recent Sessions** (last 5, from `/api/sessions`) + **Needs Attention** (unreviewed discoveries, stale memories, failing checks — each links to its section).

**Data sourcing:** all values already exist across `/api/health`, `/api/status`, `/api/code-graph/stats`, `/api/embeddings/stats`, `/api/sessions/summary`, `/api/brain/snapshots`. To avoid 8 round-trips on load, add **one read-only aggregator** `GET /api/overview` that composes these server-side (the only backend addition; purely a fan-out of existing queries).

---

## 3. Synapse design system

Formalized from the approved mockup. Lives in `dashboard/css/synapse.css` as CSS custom properties; every color derives from these tokens.

**Color**
```
--ground:#0B0E1A   deep indigo-ink (not black)
--panel:#12172A    raised surface
--panel-2:#0E1322  inset surface
--border:#202845 / --border-soft:#1A2138
--text:#DCE3F2     cool off-white   / --muted:#7C89A8 / --faint:#4D5876
--accent:#34E1FF   signal cyan (primary)
--accent-2:#9A86FF synapse violet (secondary, sparing)
--green:#4ADE80  --amber:#FACC15  --red:#FB7185   (status)
```
Ambient depth from two faint radial gradients (cyan top-right, violet bottom-left). Accent never used as a flat fill on large areas — it is signal, used on data, focus rings, and the pulse.

**Type**
- **Data / display:** `ui-monospace, "Cascadia Code", Consolas` — big numbers, vitals, eyebrows, labels. Monospace is the identity (telemetry instrument).
- **UI / body:** `"Segoe UI", system-ui` — nav, prose, table cells.
- No external/CDN fonts (works offline, no FOUT). Scale: 10/11/12/13/14/18/26/30px; eyebrows uppercase, letter-spacing .16–.22em.

**Components** (themed once, reused everywhere): sidebar (grouped nav + active inset-bar), top bar (title/crumb + ⌘K search + status pill), `tile` (vitals), `card` (panels/tables), `ring` (conic health), `spark` (inline SVG sparkline), `badge`/`led`, buttons (`.btn-action` family retained, restyled), tables (restyled to the dark grid). Radius 8–16px, 4/8px spacing rhythm.

**Motion (one orchestrated moment):** the hero node-pulse (nodes + edges + travelling signal on canvas). Everything else is still. All motion gated behind `prefers-reduced-motion`.

**Charts:** a single Chart.js theme module sets dark grid/tick/legend colors + the accent palette so every chart matches without per-call styling. Cytoscape (Brain graph, Flows) gets a matching stylesheet (cyan/violet nodes on `--ground`).

---

## 4. Frontend structure (no build step)

Today: one `index.html` + one `app.js`. The redesign splits for clarity and isolation — using native ES modules (`<script type="module">`), which need **no bundler** because the page is served over HTTP by Express (not `file://`).

```
dashboard/
  index.html            shell only: sidebar, top bar, <main> mount, module entry
  css/synapse.css       the design system (all tokens + components)
  js/
    core.js             fetch helpers, hash router, ⌘K search, theme constants
    charts.js           Chart.js dark theme + chart factories
    command-center.js   the home view (+ optional /api/overview)
    activity.js  brain.js  code.js  learning.js  system.js   one per group
  vendor/
    chart.umd.min.js    cytoscape.min.js   (vendored locally — see §6)
```
Each module owns one group, exposes `render(mountEl)`, and depends only on `core.js`/`charts.js` — so a section can be understood and changed in isolation. The router shows/hides group views and lazy-renders on first visit.

---

## 5. Native window (WebView2)

`desktop/VaultFlow.DashboardLauncher` today is a console app that starts the server then **opens the default browser**. It becomes a real window:

- Convert to a WinForms host (csproj is already `net8.0-windows` with WinForms available) with a maximized window hosting a **`Microsoft.Web.WebView2`** control navigated to `http://localhost:7700` once the server is reachable.
- Keep the existing server-bootstrap + reachability-wait logic (it already works).
- App icon + title "VaultFlow"; window remembers size/position.
- **Fallback:** if the WebView2 runtime is absent (rare on Win11 — it ships in-box), show a one-line notice and fall back to today's open-in-browser behavior. No hard failure.
- `npm run dashboard:desktop:build/publish/shortcut` stay the entry points.

---

## 6. Offline assets

Today `index.html` loads Chart.js + Cytoscape from `cdn.jsdelivr.net` — a network dependency that's wrong for a self-contained desktop app. Vendor both (MIT-licensed) into `dashboard/vendor/` and reference locally. The app then works with no internet. (One-time download committed to the repo.)

---

## 7. Phasing

Each phase is independently shippable and leaves the dashboard working.

- **P0 — Foundation:** vendor assets (§6); extract `synapse.css`; build the shell (sidebar + top bar + router) and design tokens. No data behavior change.
- **P1 — Command Center:** the home view + `/api/overview` aggregator + vitals/hero/attention.
- **P2 — Migrate sections:** move each current tab into its group module under the new system; dismantle the Graph kitchen-sink per §1.
- **P3 — Native window:** WebView2 host + offline + icon + fallback.
- **P4 — Polish:** motion + reduced-motion, responsive breakpoints, keyboard (⌘K), focus states, a11y pass.

---

## 8. Testing

- **Server smoke test** (`node:test`, matches existing `tests/brain*.test.mjs` style): server boots; `index.html`, `css/synapse.css`, `js/*.js`, and `vendor/*` are served 200; `/api/overview` returns the composed shape; representative endpoints still 200.
- **`/api/overview` unit test:** composes the same numbers the individual endpoints return (no drift).
- **.NET build gate:** `dotnet build` of the launcher must succeed (WebView2 reference resolves).
- **Visual QA:** launch via `npm run dashboard`, click every group; verify reduced-motion; verify offline (disconnect, reload). The `/run` skill drives this.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Scope is large | Strict phasing; P0–P2 ship value even if P3/P4 slip. |
| WebView2 runtime missing | Fallback to open-in-browser (current behavior). |
| ES modules over `file://` fail (CORS) | Real app is HTTP-served by Express — modules load fine; only the throwaway mockup uses inline JS. |
| Endpoint shape drift in `/api/overview` | It only fans out existing queries; unit-tested against the source endpoints. |
| Charting regressions during reskin | Single shared theme module; migrate one chart, verify, then the rest. |

---

## 10. Open questions

None blocking. Defaults taken: aggregator endpoint `/api/overview` (read-only, additive); WebView2 over alternatives (matches "native window" + reuses the web UI); vendor charts rather than keep CDN (offline-correct).
