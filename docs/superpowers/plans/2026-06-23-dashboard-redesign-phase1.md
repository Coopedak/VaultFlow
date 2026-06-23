# Synapse Dashboard — Phase 0+1 (Foundation + Command Center) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the new "Synapse" dashboard shell + design system, vendor charting assets for offline use, add a `/api/overview` aggregator, and build the Command Center home — served in parallel at `/v2` so the existing dashboard keeps working untouched.

**Architecture:** Additive only. Keep `dashboard/server.mjs` + all ~54 endpoints and the old `index.html`/`app.js` working at `/`. Add static assets under the already-statically-served dashboard dir (`css/`, `js/`, `vendor/`), one read-only aggregator endpoint, and a new shell `index-v2.html` reachable at `/v2`. Vanilla ES modules served over HTTP — no build step. When Phase 2 finishes migrating every section, `/` flips to the new shell and the old files are deleted.

**Tech Stack:** Node 22+ (ESM dashboard server, CJS `db.cjs` via `createRequire`), Express 4 static + JSON, `node:sqlite`, Chart.js 4.4.0 + Cytoscape 3.30.2 (vendored locally), `node:test`.

## Global Constraints

- Node **>= 22.0.0**; the dashboard server is ESM, `db.cjs` is CJS — cross it only via `createRequire`, never `require()` an `.mjs`.
- **No build step, no framework, no bundler.** Browser code is native ES modules (`<script type="module">`) served over HTTP by Express (never `file://`).
- **No external/CDN runtime dependencies.** Chart.js + Cytoscape are vendored into `dashboard/vendor/` and referenced locally.
- **Backend is additive-only:** the sole new endpoint is read-only `GET /api/overview`. Do not modify or remove existing endpoints, `index.html`, or `app.js` in this plan.
- **Tests** run via `node --test tests/*.test.mjs`. Server tests import `startServer` from `server.mjs` and bind **port 0** (`startServer({ port: 0, metricsRoot })`) — never the real port; always `server.close()` in a `finally`.
- **Design tokens** are canonical in `css/synapse.css`; the committed mockup `docs/superpowers/specs/2026-06-23-synapse-mockup.html` is the visual source of truth for exact colors/markup.
- **Commits:** conventional-commit style, **no `Co-Authored-By` trailer** (repo rule). Work on branch `feat/dashboard-redesign-synapse`.
- Dashboard dir path: `.claude/helpers/dashboard/` (referred to below as `dashboard/`).

---

## File Structure (this plan)

**Create:**
- `dashboard/vendor/chart.umd.min.js`, `dashboard/vendor/cytoscape.min.js` — vendored libs
- `dashboard/css/synapse.css` — the design system (tokens + components), ported from the mockup
- `dashboard/js/format.js` — pure formatting helpers (unit-tested)
- `dashboard/js/core.js` — module entry: fetch helper, hash router, group registry, ⌘K stub
- `dashboard/js/charts.js` — Chart.js dark theme + sparkline/line factories
- `dashboard/js/command-center.js` — the Command Center home view
- `dashboard/index-v2.html` — new shell (sidebar + topbar + `<main>` mount), parallel to old
- `docs/superpowers/specs/2026-06-23-synapse-mockup.html` — committed visual reference
- `tests/dashboardFormat.test.mjs`, `tests/dashboardOverview.test.mjs`, `tests/dashboardShell.test.mjs`

**Modify:**
- `dashboard/server.mjs` — add `GET /api/overview` (after the other `/api` routes, before `app.get('/')`) and a `GET /v2` alias (next to `app.get('/')`).

---

## Task 1: Commit the approved mockup as the visual reference

**Files:**
- Create: `docs/superpowers/specs/2026-06-23-synapse-mockup.html`

- [ ] **Step 1: Copy the approved mockup into the repo**

The approved Synapse mockup is at `…/scratchpad/mockup-synapse.html`. Copy it verbatim to `docs/superpowers/specs/2026-06-23-synapse-mockup.html` (it becomes the canonical reference every later task extracts CSS/markup from).

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-06-23-synapse-mockup.html
git commit -m "docs(vaultflow): commit approved Synapse dashboard mockup as visual reference"
```

---

## Task 2: Vendor Chart.js + Cytoscape locally

**Files:**
- Create: `dashboard/vendor/chart.umd.min.js`, `dashboard/vendor/cytoscape.min.js`
- Test: `tests/dashboardShell.test.mjs` (asset-serving portion)

**Interfaces:**
- Produces: `/vendor/chart.umd.min.js` and `/vendor/cytoscape.min.js` served 200 by the existing `express.static(__dirname)`.

- [ ] **Step 1: Write the failing test** (`tests/dashboardShell.test.mjs`)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../.claude/helpers/dashboard/server.mjs';

async function boot() {
  const srv = startServer({ port: 0 });
  await new Promise(r => srv.on('listening', r));
  const port = srv.address().port;
  return { srv, base: `http://127.0.0.1:${port}` };
}

test('vendored chart + cytoscape assets are served', async () => {
  const { srv, base } = await boot();
  try {
    for (const f of ['/vendor/chart.umd.min.js', '/vendor/cytoscape.min.js']) {
      const r = await fetch(base + f);
      assert.equal(r.status, 200, `${f} should be 200`);
      const body = await r.text();
      assert.ok(body.length > 1000, `${f} should have real content`);
    }
  } finally { srv.close(); }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/dashboardShell.test.mjs`
Expected: FAIL — 404 (files don't exist yet).

- [ ] **Step 3: Download the exact versions the SPA already uses**

```bash
mkdir -p .claude/helpers/dashboard/vendor
curl -L -o .claude/helpers/dashboard/vendor/chart.umd.min.js https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js
curl -L -o .claude/helpers/dashboard/vendor/cytoscape.min.js https://cdn.jsdelivr.net/npm/cytoscape@3.30.2/dist/cytoscape.min.js
```
(One-time network fetch; pin these versions — they match the current `index.html`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/dashboardShell.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .claude/helpers/dashboard/vendor/ tests/dashboardShell.test.mjs
git commit -m "feat(dashboard): vendor Chart.js + Cytoscape locally for offline use"
```

---

## Task 3: `GET /api/overview` aggregator

**Files:**
- Modify: `dashboard/server.mjs` (add route before `app.get('/')` ~line 1290)
- Test: `tests/dashboardOverview.test.mjs`

**Interfaces:**
- Produces: `GET /api/overview` → JSON:
```
{
  health:    { ok:int, warn:int, fail:int },
  memory:    { total:int, embedded:int, pct:int },
  codeGraph: { files:int, symbols:int, edges:int },
  sessions:  { total:int, summarizedPct:int },
  retrieval7d:int,
  nightly:   { ageHours:number|null },
  embedQueue:{ depth:int, oldestHours:number|null },
  db:        { sizeMb:number, integrity:"ok"|string },
  discoveriesUnreviewed:int,
  staleMemory:int,
  watcher:   { running:bool },
  recentSessions: [ { id, project, startedAt, durationMs, edits } ]
}
```
Read-only; composes the same queries the individual endpoints already run. Use `withRawDb` for SQLite and read the nightly heartbeat / DB file size from disk (same as `/api/health`).

- [ ] **Step 1: Write the failing test** (`tests/dashboardOverview.test.mjs`)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../.claude/helpers/dashboard/server.mjs';

function seedRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-overview-'));
  // initialize a real schema in the fixture, then seed a couple of rows
  const db = require('../.claude/helpers/db.cjs');
  db.close?.(); db.initialize(dir, 'vaultflow.db');
  const c = db.raw();
  c.exec("INSERT INTO sessions (started_at, ended_at, project) VALUES (datetime('now'), datetime('now'), 'vaultflow')");
  c.exec("INSERT INTO memory_entries (title, body, source) VALUES ('t','b','x')");
  return dir;
}

test('GET /api/overview returns the documented shape', async () => {
  const metricsRoot = seedRoot();
  const srv = startServer({ port: 0, metricsRoot });
  await new Promise(r => srv.on('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await fetch(base + '/api/overview');
    assert.equal(r.status, 200);
    const o = await r.json();
    for (const k of ['health','memory','codeGraph','sessions','retrieval7d','nightly','embedQueue','db','discoveriesUnreviewed','staleMemory','watcher','recentSessions']) {
      assert.ok(k in o, `missing key: ${k}`);
    }
    assert.equal(typeof o.health.ok, 'number');
    assert.equal(typeof o.memory.total, 'number');
    assert.ok(Array.isArray(o.recentSessions));
  } finally { srv.close(); }
});
```
(Note: `require` in the test via `import { createRequire }` — add `const require = createRequire(import.meta.url);` at top if needed, matching existing test files.)

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/dashboardOverview.test.mjs`
Expected: FAIL — 404 / route missing.

- [ ] **Step 3: Implement the endpoint** in `server.mjs` (insert before `app.get('/')`)

```js
// ── GET /api/overview — composed Command Center payload (read-only) ─────────
app.get('/api/overview', (_req, res) => {
  try {
    const out = withRawDb((c) => {
      const one = (sql) => { try { return c.prepare(sql).get(); } catch { return {}; } };
      const mem = one("SELECT (SELECT COUNT(*) FROM memory_entries) AS total, (SELECT COUNT(*) FROM memory_embeddings me JOIN memory_entries m ON m.id=me.memory_id) AS embedded");
      const cg  = one("SELECT (SELECT COUNT(DISTINCT file) FROM code_symbols) AS files, (SELECT COUNT(*) FROM code_symbols) AS symbols, (SELECT COUNT(*) FROM code_calls) AS edges");
      const ses = one("SELECT COUNT(*) AS total FROM sessions");
      const sum = one("SELECT COUNT(*) AS n FROM session_summaries WHERE summary_at > date('now','-7 days')");
      const ses7= one("SELECT COUNT(*) AS n FROM sessions WHERE started_at > date('now','-7 days') AND ended_at IS NOT NULL");
      const ret = one("SELECT COUNT(*) AS n FROM retrieval_docs WHERE timestamp > date('now','-7 days')");
      const eq  = one("SELECT COUNT(*) AS depth, MIN(queued_at) AS oldest FROM embed_queue");
      const disc= one("SELECT COUNT(*) AS n FROM patterns WHERE 0");            // placeholder replaced below
      const stale = one("SELECT COUNT(*) AS n FROM memory_stale");
      const recent = (() => { try {
        return c.prepare("SELECT id, project, started_at AS startedAt, duration_ms AS durationMs, (SELECT COUNT(*) FROM edit_events e WHERE e.session_id=s.id) AS edits FROM sessions s ORDER BY started_at DESC LIMIT 5").all();
      } catch { return []; } })();
      const memTotal = mem.total||0, emb = mem.embedded||0;
      return {
        memory: { total: memTotal, embedded: emb, pct: memTotal ? Math.round(100*emb/memTotal) : 0 },
        codeGraph: { files: cg.files||0, symbols: cg.symbols||0, edges: cg.edges||0 },
        sessions: { total: ses.total||0, summarizedPct: ses7.n ? Math.round(100*(sum.n||0)/ses7.n) : 100 },
        retrieval7d: ret.n||0,
        embedQueue: { depth: eq.depth||0, oldestHours: eq.oldest ? +( (Date.now()-new Date(eq.oldest).getTime())/3.6e6 ).toFixed(1) : null },
        staleMemory: stale.n||0,
        recentSessions: recent,
      };
    });
    // disk + health-derived fields (mirror /api/health logic)
    const dbPath = path.join(METRICS, DB_FILE);
    out.db = { sizeMb: +(fs.statSync(dbPath).size/1048576).toFixed(2), integrity: 'ok' };
    let hb = null; try { hb = JSON.parse(fs.readFileSync(path.join(METRICS,'nightly-heartbeat.json'),'utf8')); } catch {}
    out.nightly = { ageHours: hb ? +((Date.now()-new Date(hb.last_run_at).getTime())/3.6e6).toFixed(1) : null };
    out.health = { ok: 0, warn: 0, fail: 0 };  // filled by reusing computeHealth() if extracted; else summarized client-side from /api/health
    out.discoveriesUnreviewed = 0;             // sourced from discoveries dir scan (see /api/discoveries); 0 when dir absent
    out.watcher = { running: false };          // sourced from /api/watcher/status logic
    res.json(out);
  } catch (err) { apiErr(res, err); }
});
```
Then wire the three stubbed fields to the existing helpers: reuse the discoveries-dir scan from `/api/discoveries` (count files without `promoted: true`), the watcher-detection from `/api/watcher/status`, and the health tallies from `/api/health` (extract its check-builder into a shared `function computeHealth()` if it isn't already callable, and call it here). Keep all three read-only.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/dashboardOverview.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: all existing tests still pass + the 2 new ones.

- [ ] **Step 6: Commit**

```bash
git add .claude/helpers/dashboard/server.mjs tests/dashboardOverview.test.mjs
git commit -m "feat(dashboard): add read-only /api/overview aggregator for the Command Center"
```

---

## Task 4: `css/synapse.css` design system

**Files:**
- Create: `dashboard/css/synapse.css`
- Test: extend `tests/dashboardShell.test.mjs`

**Interfaces:**
- Produces: `/css/synapse.css` served 200, defining `:root` tokens `--ground:#0B0E1A`, `--accent:#34E1FF`, `--accent-2:#9A86FF`, `--text:#DCE3F2`, etc., plus the component classes used by the shell + command center (`.app`, `.side`, `.nav-item`, `.topbar`, `.hero`, `.tile`, `.card`, `.ring`, `.spark`, `.badge`, `.led`).

- [ ] **Step 1: Add the failing assertion** to `tests/dashboardShell.test.mjs`

```js
test('synapse.css is served with the committed tokens', async () => {
  const { srv, base } = await boot();
  try {
    const r = await fetch(base + '/css/synapse.css');
    assert.equal(r.status, 200);
    const css = await r.text();
    assert.match(css, /--ground:\s*#0B0E1A/i);
    assert.match(css, /--accent:\s*#34E1FF/i);
  } finally { srv.close(); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/dashboardShell.test.mjs`
Expected: FAIL — 404.

- [ ] **Step 3: Create `css/synapse.css`**

Extract the `<style>` block from `docs/superpowers/specs/2026-06-23-synapse-mockup.html` into `css/synapse.css` verbatim (it is the approved system). Keep the `:root` token block, layout (`.app/.side/.main/.topbar`), `.hero`, `.tile`/`.grid`, `.card`/`.row`, `.ring`, `.spark`, `.nav-*`, `.badge`/`.led`, and the `@media`/`prefers-reduced-motion` rules. Do not change any hex values.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/dashboardShell.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .claude/helpers/dashboard/css/synapse.css tests/dashboardShell.test.mjs
git commit -m "feat(dashboard): add Synapse design-system stylesheet"
```

---

## Task 5: `js/format.js` pure helpers

**Files:**
- Create: `dashboard/js/format.js`
- Test: `tests/dashboardFormat.test.mjs`

**Interfaces:**
- Produces (pure, no DOM): `fmtNum(n)→"7,749"`, `fmtAgo(hours)→"9.1h ago"|"never"`, `fmtBytesMb(mb)→"548 MB"`, `pct(part,total)→int`, `healthTone({ok,warn,fail})→"ok"|"warn"|"fail"`.

- [ ] **Step 1: Write the failing test** (`tests/dashboardFormat.test.mjs`)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtNum, fmtAgo, fmtBytesMb, pct, healthTone } from '../.claude/helpers/dashboard/js/format.js';

test('format helpers', () => {
  assert.equal(fmtNum(7749), '7,749');
  assert.equal(fmtNum(0), '0');
  assert.equal(fmtAgo(9.1), '9.1h ago');
  assert.equal(fmtAgo(null), 'never');
  assert.equal(fmtBytesMb(548), '548 MB');
  assert.equal(pct(98, 100), 98);
  assert.equal(pct(0, 0), 0);
  assert.equal(healthTone({ ok: 13, warn: 0, fail: 0 }), 'ok');
  assert.equal(healthTone({ ok: 11, warn: 1, fail: 1 }), 'fail');
  assert.equal(healthTone({ ok: 12, warn: 1, fail: 0 }), 'warn');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/dashboardFormat.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `js/format.js`**

```js
export const fmtNum = (n) => (n == null ? '0' : Number(n).toLocaleString('en-US'));
export const fmtAgo = (h) => (h == null ? 'never' : `${Number(h).toFixed(1)}h ago`);
export const fmtBytesMb = (mb) => `${Math.round(Number(mb) || 0)} MB`;
export const pct = (part, total) => (total ? Math.round((100 * part) / total) : 0);
export const healthTone = ({ ok = 0, warn = 0, fail = 0 }) => (fail > 0 ? 'fail' : warn > 0 ? 'warn' : 'ok');
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/dashboardFormat.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .claude/helpers/dashboard/js/format.js tests/dashboardFormat.test.mjs
git commit -m "feat(dashboard): add pure formatting helpers (format.js)"
```

---

## Task 6: `js/core.js` entry — fetch, router, group registry

**Files:**
- Create: `dashboard/js/core.js`

**Interfaces:**
- Consumes: `js/format.js`.
- Produces: `api(path)` (fetch JSON helper), `registerView(key, renderFn)`, a hash router that mounts the active view into `#view`, a group registry for the 6 sections, and a ⌘K no-op stub. Imported as the page's `type="module"` entry; on load it renders the default route (`command-center`).

- [ ] **Step 1: Implement `js/core.js`**

```js
import * as fmt from './format.js';
export const F = fmt;
export async function api(p) { const r = await fetch(p); if (!r.ok) throw new Error(p + ' → ' + r.status); return r.json(); }
const views = new Map();
export function registerView(key, render) { views.set(key, render); }
const mount = () => document.getElementById('view');
async function route() {
  const key = (location.hash.replace(/^#\/?/, '') || 'command-center');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === key));
  const render = views.get(key) || views.get('__placeholder');
  const el = mount(); el.innerHTML = '<div class="loading">Loading…</div>';
  try { await render(el); } catch (e) { el.innerHTML = `<div class="loading">Error: ${e.message}</div>`; }
}
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);
// Phase-2 stub for sections not yet migrated
registerView('__placeholder', (el) => { el.innerHTML = '<div class="card"><h3>Coming in the migration</h3><p style="color:var(--muted)">This section moves into the Synapse shell in Phase 2.</p></div>'; });
```

- [ ] **Step 2: Verify it imports cleanly** (no DOM crash at import in a browser)

This module is DOM-bound; it's verified at render time in Task 9. No unit test (pure logic lives in `format.js`, already tested).

- [ ] **Step 3: Commit**

```bash
git add .claude/helpers/dashboard/js/core.js
git commit -m "feat(dashboard): add core module (fetch, hash router, view registry)"
```

---

## Task 7: `index-v2.html` shell + `/v2` route

**Files:**
- Create: `dashboard/index-v2.html`
- Modify: `dashboard/server.mjs` (add `GET /v2` next to `app.get('/')`)
- Test: extend `tests/dashboardShell.test.mjs`

**Interfaces:**
- Consumes: `/css/synapse.css`, `/js/core.js` (module entry).
- Produces: `/v2` → the new shell with the 6-group sidebar (`Command Center · Activity · Brain · Code · Learning · System`) and a `<main id="view">` mount. Each nav item has `data-view="<key>"` and an `href="#/<key>"`.

- [ ] **Step 1: Add the failing test** to `tests/dashboardShell.test.mjs`

```js
test('/v2 shell serves the grouped sidebar and module entry', async () => {
  const { srv, base } = await boot();
  try {
    const r = await fetch(base + '/v2');
    assert.equal(r.status, 200);
    const html = await r.text();
    for (const g of ['Command Center','Activity','Brain','Code','Learning','System'])
      assert.ok(html.includes(g), `sidebar missing group: ${g}`);
    assert.match(html, /<link[^>]+css\/synapse\.css/);
    assert.match(html, /<script[^>]+type="module"[^>]+js\/core\.js/);
    assert.match(html, /id="view"/);
  } finally { srv.close(); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/dashboardShell.test.mjs`
Expected: FAIL — `/v2` 404.

- [ ] **Step 3: Create `index-v2.html`**

Build the shell using the sidebar + topbar markup from the mockup (`docs/superpowers/specs/2026-06-23-synapse-mockup.html`), but: (a) link the stylesheet `<link rel="stylesheet" href="/css/synapse.css">` instead of an inline `<style>`; (b) give each `.nav-item` an `href="#/<key>"` + `data-view="<key>"` (keys: `command-center`, `activity`, `brain`, `code`, `learning`, `system`); (c) replace the hard-coded `<main>` content with a single `<main class="main"><div id="view"></div></main>`; (d) end with `<script type="module" src="/js/core.js"></script>` and `<script type="module" src="/js/command-center.js"></script>`.

- [ ] **Step 4: Add the `/v2` route** in `server.mjs` (next to `app.get('/')`)

```js
app.get('/v2', (_req, res) => { res.sendFile(path.join(__dirname, 'index-v2.html')); });
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test tests/dashboardShell.test.mjs`
Expected: PASS (all shell assertions).

- [ ] **Step 6: Commit**

```bash
git add .claude/helpers/dashboard/index-v2.html .claude/helpers/dashboard/server.mjs tests/dashboardShell.test.mjs
git commit -m "feat(dashboard): add Synapse shell at /v2 with grouped navigation"
```

---

## Task 8: `js/charts.js` + `js/command-center.js` — the Command Center

**Files:**
- Create: `dashboard/js/charts.js`, `dashboard/js/command-center.js`

**Interfaces:**
- Consumes: `core.js` (`api`, `registerView`, `F`), `/api/overview`, vendored `/vendor/chart.umd.min.js` (loaded globally by the shell), `format.js`.
- Produces: a `command-center` view rendering hero (System Pulse + health ring), the Brain Vitals grid (tiles + sparklines), Recent Sessions, and Needs Attention — all from one `/api/overview` call.

- [ ] **Step 1: Implement `js/charts.js`**

Set Chart.js global dark defaults (grid `#202845`, ticks `#7C89A8`, font family monospace) and export `sparkline(canvas, points, color)` + `line(canvas, labels, data)` factories. Reference the mockup's inline-SVG sparklines for the visual target (canvas equivalents). Chart.js is available as the global `Chart` (the shell loads `/vendor/chart.umd.min.js` before the modules).

- [ ] **Step 2: Implement `js/command-center.js`**

```js
import { api, registerView, F } from './core.js';
registerView('command-center', async (el) => {
  const o = await api('/api/overview');
  const tone = F.healthTone(o.health);
  el.innerHTML = render(o, tone);     // build hero + vitals grid + panels from mockup markup, with live values
  startPulse(el.querySelector('#pulse'));  // port the canvas pulse from the mockup; respect prefers-reduced-motion
});
```
Port the hero/vitals/panels markup from the mockup, substituting live values via the `format.js` helpers (`F.fmtNum(o.memory.total)`, `F.fmtAgo(o.nightly.ageHours)`, etc.). Reuse the mockup's `<canvas id="pulse">` animation (gate on `prefers-reduced-motion`). Wire the default route to this view (already registered).

- [ ] **Step 3: Render verification (manual)**

```bash
npm run dashboard
```
Open `http://localhost:7700/v2`. Verify: the animated node pulse renders in the hero; the health ring shows the live `ok/total`; vitals tiles show live numbers (memory, code graph, sessions, retrieval, nightly, embed queue, DB, pattern signal) matching `curl -s localhost:7700/api/overview`; Recent Sessions + Needs Attention populate; the 5 not-yet-migrated nav items show the Phase-2 placeholder. Toggle OS reduced-motion → pulse is static.

- [ ] **Step 4: Confirm the old dashboard is untouched**

Open `http://localhost:7700/` — the existing 15-tab dashboard still works exactly as before.

- [ ] **Step 5: Commit**

```bash
git add .claude/helpers/dashboard/js/charts.js .claude/helpers/dashboard/js/command-center.js
git commit -m "feat(dashboard): build the Synapse Command Center home"
```

---

## Task 9: Full-suite gate + phase wrap

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: all prior tests + `dashboardFormat`, `dashboardOverview`, `dashboardShell` pass; 0 fail.

- [ ] **Step 2: Run the guardrails**

Run: `npm run doctor` (13 ok / 0 fail) and `npm run audit` (no new failures).

- [ ] **Step 3: Commit any fixes**, then stop for review before Phase 2 (section migration).

---

## Self-Review

- **Spec coverage (this phase):** vendored offline assets ✓ (Task 2); `/api/overview` ✓ (Task 3); Synapse design system ✓ (Task 4); module split (format/core/charts/command-center) ✓ (Tasks 5–8); new shell + IA sidebar ✓ (Task 7); Command Center home ✓ (Task 8); old dashboard untouched / parallel `/v2` ✓ (Tasks 7–8). Deferred to later plans: section migration + Graph-tab split (P2), WebView2 window (P3), polish/⌘K/a11y (P4) — explicitly out of this plan's scope.
- **Placeholder scan:** the three `/api/overview` fields (health tallies, discoveries count, watcher) are specified to reuse named existing-endpoint logic (`/api/health`, `/api/discoveries`, `/api/watcher/status`), not left as TODO; the inline `disc` placeholder line in the sketch is replaced in Step 3's wiring instruction.
- **Type consistency:** `/api/overview` keys produced in Task 3 are the same ones consumed in Task 8 (`o.memory.total`, `o.health`, `o.nightly.ageHours`, `o.recentSessions`); `format.js` signatures in Task 5 match their use in Task 8.

---

## Follow-on plans (not this document)

- **Phase 2 — Section migration:** move Activity/Brain/Code/Learning/System into the shell, dismantle the Graph kitchen-sink, then flip `/` → new shell and delete old `index.html`/`app.js`.
- **Phase 3 — Native window:** convert `desktop/VaultFlow.DashboardLauncher` to a WebView2 host with browser fallback.
- **Phase 4 — Polish:** motion/reduced-motion, responsive, ⌘K global search, focus/a11y.
