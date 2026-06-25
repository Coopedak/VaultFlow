# Atlas Phase 2 — Excalidraw flow diagrams — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Auto-generate a `.excalidraw` diagram per cataloged flow (Obsidian-openable), regenerated on demand + nightly, with a read-only preview in the dashboard Flows view.

**Architecture:** A pure CJS converter `flow-excalidraw.cjs` turns a flow's `{nodes, edges}` (from `db.getFlow`) into a valid `.excalidraw` document with a deterministic layered layout. An ESM writer `flows-draw.mjs` walks `db.listFlows`, writes one file per flow (idempotent — only rewrites on change), exposed as `npm run flows:draw` and wired into `nightly.mjs`. A dashboard endpoint generates the same doc on the fly, rendered as read-only SVG in the v1 Flows view.

**Tech Stack:** Node 22+, `db.cjs` (flows tables), vanilla-JS dashboard. Tests: `node:test` (`node --test`).

## Global Constraints

- Node 22+; `.cjs` is CJS, `.mjs` is ESM. `flow-excalidraw.cjs` is CJS (sibling of `db.cjs`); `flows-draw.mjs` is ESM (like `nightly.mjs`/`cleanup.mjs`).
- **No new npm dependencies.** Use only `node:` builtins + `db.cjs` + `flow-excalidraw.cjs`.
- **Deterministic output:** no `Math.random()`, no `Date.now()`/`new Date()` in the converter — seeds/nonces derived from element index, `updated` is a constant. Same flow → byte-identical `.excalidraw` (so nightly re-runs don't churn files).
- `db.initialize()` is idempotent — call before DB ops; use `db.listFlows(project)` / `db.getFlow(id)`.
- Generated files go to `docs/flows/<project-slug>/<flow-slug>.excalidraw`; add `docs/flows/` to `.gitignore` (generated artifacts).
- Windows path-safe (`node:path`). Tests in `tests/*.test.mjs` via `node --test`. Commit after every task. Branch: `feat/atlas-phase2-excalidraw`.
- Phase 3 (static export) is OUT OF SCOPE.

## Data shapes (from recon — exact)

- `db.getFlow(id)` → `{ flow:{id,project,name,…}, nodes:[{node_id,label,kind,file,terminal,ambiguous}], edges:[{source,target,kind}] }` or `null`.
- `db.listFlows(project|null)` → array of flow headers incl. `id`, `project`, `name`, `node_count`.
- `.excalidraw` doc: `{ type:"excalidraw", version:2, source, elements:[], appState:{}, files:{} }`. Element required fields: `id,type,x,y,width,height,angle,strokeColor,backgroundColor,fillStyle,strokeWidth,strokeStyle,roughness,opacity,seed,version,versionNonce,isDeleted,groupIds,boundElements,link,locked`. Rectangle: `roundness:{type:3}`, `boundElements:[{id:<textId>,type:"text"}]`. Text: `containerId:<rectId>`, `fontFamily:3` (monospace), `textAlign`, `verticalAlign`, `lineHeight`. Arrow: `points:[[0,0],[dx,dy]]`, `startBinding:{elementId,focus:0,gap}`, `endBinding:{…}`, `endArrowhead:"arrow"`.

## File Structure

- **Create** `.claude/helpers/flow-excalidraw.cjs` — pure converter: `toExcalidraw({flow,nodes,edges})`, `layeredLayout(nodes,edges)`.
- **Create** `tests/flowExcalidraw.test.mjs` — converter unit tests.
- **Create** `.claude/helpers/flows-draw.mjs` — ESM writer: `drawAllFlows({outputDir,project})` + CLI.
- **Modify** `.claude/helpers/nightly.mjs` — add a `flows:draw` step (DRY_RUN-guarded).
- **Modify** `package.json` — `"flows:draw"` script.
- **Modify** `.gitignore` — add `docs/flows/`.
- **Modify** `.claude/helpers/dashboard/server.mjs` — add `GET /api/flows/:id/excalidraw`.
- **Modify** `.claude/helpers/dashboard/app.js` — add a read-only `.excalidraw` SVG preview to the Flows view.

---

### Task 1: `flow-excalidraw.cjs` converter

**Files:** Create `.claude/helpers/flow-excalidraw.cjs`; Test `tests/flowExcalidraw.test.mjs`

**Interfaces:**
- Produces: `toExcalidraw({flow,nodes,edges}) -> excalidrawDoc`; `layeredLayout(nodes,edges) -> Map<node_id,{x,y}>`.

- [ ] **Step 1: Write the failing test**

```js
// tests/flowExcalidraw.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { toExcalidraw, layeredLayout } = require('../.claude/helpers/flow-excalidraw.cjs');

const FLOW = {
  flow: { id: 'f1', project: 'proj', name: 'auth · login' },
  nodes: [
    { node_id: 'a', label: 'loginHandler', kind: 'function', file: 'x', terminal: 0, ambiguous: 0 },
    { node_id: 'b', label: 'validate',     kind: 'function', file: 'x', terminal: 0, ambiguous: 1 },
    { node_id: 'c', label: 'db.query',     kind: 'function', file: 'x', terminal: 1, ambiguous: 0 },
  ],
  edges: [ { source: 'a', target: 'b', kind: 'calls' }, { source: 'b', target: 'c', kind: 'calls' } ],
};

test('toExcalidraw emits a valid excalidraw doc shape', () => {
  const d = toExcalidraw(FLOW);
  assert.equal(d.type, 'excalidraw');
  assert.equal(d.version, 2);
  assert.ok(Array.isArray(d.elements));
  assert.deepEqual(Object.keys(d).sort(), ['appState','elements','files','source','type','version']);
});

test('one rectangle + one text per node, one arrow per edge', () => {
  const d = toExcalidraw(FLOW);
  const rects = d.elements.filter(e => e.type === 'rectangle');
  const texts = d.elements.filter(e => e.type === 'text');
  const arrows = d.elements.filter(e => e.type === 'arrow');
  assert.equal(rects.length, 3);
  assert.equal(texts.length, 3);
  assert.equal(arrows.length, 2);
});

test('text is bound to its rectangle and labels match', () => {
  const d = toExcalidraw(FLOW);
  const rect = d.elements.find(e => e.type === 'rectangle' && e.id === 'r-a');
  const text = d.elements.find(e => e.type === 'text' && e.containerId === 'r-a');
  assert.ok(rect.boundElements.some(b => b.id === text.id && b.type === 'text'));
  assert.equal(text.text, 'loginHandler');
});

test('arrows bind source and target rectangles', () => {
  const d = toExcalidraw(FLOW);
  const arr = d.elements.find(e => e.type === 'arrow');
  assert.equal(arr.startBinding.elementId, 'r-a');
  assert.equal(arr.endBinding.elementId, 'r-b');
  assert.equal(arr.endArrowhead, 'arrow');
  assert.equal(arr.points.length, 2);
});

test('terminal and ambiguous nodes get distinct fills', () => {
  const d = toExcalidraw(FLOW);
  const norm = d.elements.find(e => e.id === 'r-a').backgroundColor;
  const amb  = d.elements.find(e => e.id === 'r-b').backgroundColor;
  const term = d.elements.find(e => e.id === 'r-c').backgroundColor;
  assert.notEqual(norm, amb);
  assert.notEqual(norm, term);
});

test('output is deterministic (no random/date)', () => {
  assert.equal(JSON.stringify(toExcalidraw(FLOW)), JSON.stringify(toExcalidraw(FLOW)));
});

test('layeredLayout terminates on a cycle and positions every node', () => {
  const nodes = [{node_id:'a'},{node_id:'b'}];
  const edges = [{source:'a',target:'b'},{source:'b',target:'a'}];
  const pos = layeredLayout(nodes, edges);
  assert.ok(pos.get('a') && pos.get('b'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/flowExcalidraw.test.mjs`
Expected: FAIL — cannot find module `flow-excalidraw.cjs`.

- [ ] **Step 3: Write the implementation**

```js
// .claude/helpers/flow-excalidraw.cjs
'use strict';
// Pure, deterministic flow → Excalidraw converter. No randomness or clock reads,
// so the same flow always yields a byte-identical document (nightly re-runs don't
// churn files, and tests can assert determinism).

const NODE_W = 200, NODE_H = 64, H_GAP = 80, V_GAP = 56;

// First-seen BFS rank from source nodes (no incoming edges). Each node is enqueued
// at most once, so it terminates on cycles; back-edges to already-ranked nodes are skipped.
function layeredLayout(nodes, edges) {
  const ids = new Set(nodes.map(n => n.node_id));
  const adj = new Map(nodes.map(n => [n.node_id, []]));
  const indeg = new Map(nodes.map(n => [n.node_id, 0]));
  for (const e of edges) {
    if (ids.has(e.source) && ids.has(e.target)) {
      adj.get(e.source).push(e.target);
      indeg.set(e.target, indeg.get(e.target) + 1);
    }
  }
  const rank = new Map();
  const queue = [];
  for (const n of nodes) if (indeg.get(n.node_id) === 0) { rank.set(n.node_id, 0); queue.push(n.node_id); }
  if (queue.length === 0 && nodes.length) { rank.set(nodes[0].node_id, 0); queue.push(nodes[0].node_id); }
  while (queue.length) {
    const id = queue.shift();
    const r = rank.get(id);
    for (const t of adj.get(id) || []) {
      if (!rank.has(t)) { rank.set(t, r + 1); queue.push(t); }
    }
  }
  for (const n of nodes) if (!rank.has(n.node_id)) rank.set(n.node_id, 0);
  const byRank = new Map();
  for (const n of nodes) {
    const r = rank.get(n.node_id);
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r).push(n);
  }
  const pos = new Map();
  for (const [r, group] of [...byRank.entries()].sort((a, b) => a[0] - b[0])) {
    group.forEach((n, i) => pos.set(n.node_id, { x: i * (NODE_W + H_GAP), y: r * (NODE_H + V_GAP) }));
  }
  return pos;
}

// Common element fields with deterministic seed/nonce keyed off element index.
function base(i, extra) {
  return Object.assign({
    angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
    fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 1,
    opacity: 100, groupIds: [], frameId: null, roundness: null,
    seed: 100001 + i, version: 1, versionNonce: 200001 + i, isDeleted: false,
    boundElements: null, updated: 1, link: null, locked: false,
  }, extra);
}

function toExcalidraw({ flow, nodes, edges } = {}) {
  nodes = nodes || []; edges = edges || [];
  const pos = layeredLayout(nodes, edges);
  const elements = [];
  let i = 0;
  for (const n of nodes) {
    const p = pos.get(n.node_id) || { x: 0, y: 0 };
    const rectId = `r-${n.node_id}`;
    const textId = `t-${n.node_id}`;
    const fill = n.terminal ? '#f1f3f5' : (n.ambiguous ? '#ffec99' : '#a5d8ff');
    elements.push(base(i++, {
      id: rectId, type: 'rectangle', x: p.x, y: p.y, width: NODE_W, height: NODE_H,
      backgroundColor: fill, fillStyle: 'solid', roundness: { type: 3 },
      boundElements: [{ id: textId, type: 'text' }],
    }));
    const label = String(n.label || n.node_id).slice(0, 40);
    elements.push(base(i++, {
      id: textId, type: 'text', x: p.x + 8, y: p.y + NODE_H / 2 - 10,
      width: NODE_W - 16, height: 20, text: label, originalText: label,
      fontSize: 14, fontFamily: 3, textAlign: 'center', verticalAlign: 'middle',
      containerId: rectId, lineHeight: 1.25, strokeColor: '#1e1e1e',
    }));
  }
  const havePos = new Set(nodes.map(n => n.node_id));
  for (const e of edges) {
    if (!havePos.has(e.source) || !havePos.has(e.target)) continue;
    const s = pos.get(e.source), t = pos.get(e.target);
    const sx = s.x + NODE_W / 2, sy = s.y + NODE_H;
    const tx = t.x + NODE_W / 2, ty = t.y;
    elements.push(base(i++, {
      id: `a-${e.source}-${e.target}`, type: 'arrow',
      x: sx, y: sy, width: tx - sx, height: ty - sy,
      points: [[0, 0], [tx - sx, ty - sy]],
      lastCommittedPoint: null,
      startBinding: { elementId: `r-${e.source}`, focus: 0, gap: 4 },
      endBinding: { elementId: `r-${e.target}`, focus: 0, gap: 4 },
      startArrowhead: null, endArrowhead: 'arrow',
    }));
  }
  return {
    type: 'excalidraw', version: 2,
    source: 'vaultflow:flow-excalidraw',
    elements,
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
    files: {},
  };
}

module.exports = { toExcalidraw, layeredLayout };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/flowExcalidraw.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add .claude/helpers/flow-excalidraw.cjs tests/flowExcalidraw.test.mjs
git commit -m "feat(flows): deterministic flow -> excalidraw converter"
```

---

### Task 2: `flows-draw.mjs` writer + npm script + nightly wiring + gitignore

**Files:** Create `.claude/helpers/flows-draw.mjs`; Modify `package.json`, `.gitignore`, `.claude/helpers/nightly.mjs`

**Interfaces:**
- Consumes: `db.listFlows`, `db.getFlow`, `flow-excalidraw.toExcalidraw`.
- Produces: `drawAllFlows({outputDir?, project?}) -> { generated:number, errors:number, total:number }` (writes `<outputDir>/<project-slug>/<flow-slug>.excalidraw`, idempotent).

- [ ] **Step 1: Write `flows-draw.mjs`**

```js
// .claude/helpers/flows-draw.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('./db.cjs');
const { toExcalidraw } = require('./flow-excalidraw.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'flow';
}

export function drawAllFlows({ outputDir = path.join(REPO_ROOT, 'docs', 'flows'), project = null } = {}) {
  db.initialize();
  const flows = db.listFlows(project);
  let generated = 0, errors = 0;
  for (const f of flows) {
    try {
      const full = db.getFlow(f.id);
      if (!full) continue;
      const json = JSON.stringify(toExcalidraw(full), null, 2);
      const dir = path.join(outputDir, slug(f.project || 'unknown'));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, slug(f.name) + '.excalidraw');
      let prev = null;
      try { prev = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
      if (prev !== json) { fs.writeFileSync(file, json); generated++; }
    } catch { errors++; }
  }
  return { generated, errors, total: flows.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = drawAllFlows();
  console.log(`flows:draw — ${r.generated} written / ${r.total} flows, ${r.errors} error(s)`);
}
```

- [ ] **Step 2: Add npm script** — in `package.json` scripts, next to other helper commands:

```json
"flows:draw": "node .claude/helpers/flows-draw.mjs",
```

- [ ] **Step 3: Add `docs/flows/` to `.gitignore`** — append under a generated-artifacts comment:

```
# generated flow diagrams (regenerable via npm run flows:draw)
docs/flows/
```

- [ ] **Step 4: Wire into `nightly.mjs`** — add after the existing `repo-cleanup` step, matching that pattern exactly:

```js
results.flowsDraw = await step('flows:draw', async () => {
  if (DRY_RUN) return { skipped: true };
  const { drawAllFlows } = await import(pathToFileURL(path.resolve(__dirname, 'flows-draw.mjs')).href);
  const r = drawAllFlows();
  return { generated: r.generated, errors: r.errors, total: r.total };
});
```

- [ ] **Step 5: Verify at runtime**

Run:
```bash
node .claude/helpers/flows-draw.mjs
node -e "const fs=require('fs'),p=require('path');const d=p.join('docs','flows');if(!fs.existsSync(d)){console.log('no flows in DB — empty run OK');process.exit(0)}const f=require('child_process').execSync('git ls-files --others --exclude-standard docs/flows || true').toString().trim().split('\n').filter(Boolean);const one=f[0];if(one){JSON.parse(fs.readFileSync(one,'utf8'));console.log('valid excalidraw:',one)}else console.log('no files written (0 flows)')"
node .claude/helpers/nightly.mjs --dry-run 2>&1 | grep -i "flows:draw"
```
Expected: the writer runs without error (writes N files or "0 flows" cleanly); any written `.excalidraw` parses as JSON; the nightly dry-run shows the `flows:draw` step skipped. Confirm `docs/flows/` is gitignored: `git status --porcelain docs/flows` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add .claude/helpers/flows-draw.mjs package.json .gitignore .claude/helpers/nightly.mjs
git commit -m "feat(flows): flows:draw writer + npm script + nightly step + gitignore"
```

---

### Task 3: dashboard endpoint + read-only Excalidraw preview in the Flows view

**Files:** Modify `.claude/helpers/dashboard/server.mjs` (endpoint), `.claude/helpers/dashboard/app.js` (preview)

**Interfaces:**
- Consumes: `db.getFlow`, `flow-excalidraw.toExcalidraw`; the existing Flows view (`openFlow(id)`, `#flow-graph` container, `api()`).
- Produces (HTTP): `GET /api/flows/:id/excalidraw` → the excalidraw doc, `404 {error}` if absent.

- [ ] **Step 1: Add the endpoint to `server.mjs`** — add `const flowExcalidraw = require('../flow-excalidraw.cjs');` near the other requires, then register beside the existing `/api/flows/:id` route (AFTER it, so `:id` isn't shadowed — Express matches `/:id/excalidraw` distinctly anyway):

```js
// GET /api/flows/:id/excalidraw — on-the-fly Excalidraw doc for the Flows preview.
app.get('/api/flows/:id/excalidraw', (req, res) => {
  try {
    const full = db.getFlow(req.params.id);
    if (!full) return res.status(404).json({ error: 'flow not found' });
    res.json(flowExcalidraw.toExcalidraw(full));
  } catch (err) { apiErr(res, err); }
});
```

- [ ] **Step 2: Verify the endpoint at runtime**

Run:
```bash
npm run dashboard &
ID=$(curl -s "http://localhost:7700/api/flows?project=vaultflow" | grep -oE '"id":"[^"]+"' | head -1 | sed 's/"id":"//;s/"//')
echo "flow id=$ID"
curl -s "http://localhost:7700/api/flows/$ID/excalidraw" | head -c 200
```
Expected: `{"type":"excalidraw","version":2,...}` (or `404` if no flows). Stop the server.

- [ ] **Step 3: Add the read-only SVG preview to the Flows view in `app.js`**

Find the Flows view render (near `renderFlowGraph` / the `#flow-graph` container). Add a small renderer and a toggle. Insert this helper (top-level in app.js, near the other flow helpers):

```js
// Read-only SVG render of an Excalidraw doc (rectangles, text, arrows). No editor,
// no external lib — the doc's deterministic x/y/width/height are drawn directly.
function renderExcalidrawSvg(container, doc) {
  const els = (doc.elements || []).filter(e => !e.isDeleted);
  if (!els.length) { container.innerHTML = '<div class="muted">No diagram</div>'; return; }
  const minX = Math.min(...els.map(e => e.x));
  const minY = Math.min(...els.map(e => e.y));
  const maxX = Math.max(...els.map(e => e.x + (e.width || 0)));
  const maxY = Math.max(...els.map(e => e.y + (e.height || 0)));
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const parts = [];
  for (const e of els) {
    if (e.type === 'rectangle') {
      parts.push(`<rect x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" rx="8" fill="${e.backgroundColor}" stroke="${e.strokeColor}" stroke-width="1.5"/>`);
    } else if (e.type === 'text') {
      parts.push(`<text x="${e.x + e.width / 2}" y="${e.y + e.height / 2}" text-anchor="middle" dominant-baseline="middle" font-family="monospace" font-size="${e.fontSize}" fill="${e.strokeColor}">${esc(e.text)}</text>`);
    } else if (e.type === 'arrow' && e.points && e.points.length >= 2) {
      const [p0, p1] = [e.points[0], e.points[e.points.length - 1]];
      parts.push(`<line x1="${e.x + p0[0]}" y1="${e.y + p0[1]}" x2="${e.x + p1[0]}" y2="${e.y + p1[1]}" stroke="${e.strokeColor}" stroke-width="1.5" marker-end="url(#vf-arrow)"/>`);
    }
  }
  container.innerHTML =
    `<svg viewBox="${minX - 20} ${minY - 20} ${maxX - minX + 40} ${maxY - minY + 40}" width="100%" height="100%" style="background:#fff">` +
    `<defs><marker id="vf-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#1e1e1e"/></marker></defs>` +
    parts.join('') + `</svg>`;
}
```

Then add a preview container + toggle in the Flows view markup (next to `#flow-graph`), and a fetch when toggled. Where the Flows detail renders, add a button and a hidden container:

```html
<button id="flow-view-toggle">Excalidraw preview</button>
<div id="flow-excalidraw" style="display:none;height:420px;border:1px solid var(--border);border-radius:8px"></div>
```

Wire the toggle (in the Flows view setup, where `openFlow`/`flowCy` live, using the currently open flow id — track it as `currentFlowId` set inside `openFlow`):

```js
document.getElementById('flow-view-toggle').addEventListener('click', async () => {
  const graph = document.getElementById('flow-graph');
  const ex = document.getElementById('flow-excalidraw');
  const showingEx = ex.style.display !== 'none';
  if (showingEx) { ex.style.display = 'none'; graph.style.display = ''; return; }
  if (!currentFlowId) return;
  const doc = await api(`/api/flows/${encodeURIComponent(currentFlowId)}/excalidraw`);
  renderExcalidrawSvg(ex, doc);
  graph.style.display = 'none'; ex.style.display = '';
});
```

(Set `currentFlowId = id;` at the top of `openFlow(id)`.)

- [ ] **Step 4: Verify in the browser (controller will drive this)**

Manual/controller check at `http://localhost:7700/` → Flows tab → open a flow → click "Excalidraw preview": the Cytoscape graph hides and an SVG diagram of boxes + arrows renders; toggling again returns to Cytoscape. Console clean (aside from the known favicon 404). Implementer: confirm `node --check` is not applicable (browser JS in app.js); instead confirm the endpoint returns valid JSON (Step 2) and that the added JS is syntactically consistent with app.js (no parse errors when the dashboard loads — check the browser console has no SyntaxError). Report that the visual toggle needs a browser check by the controller.

- [ ] **Step 5: Commit**

```bash
git add .claude/helpers/dashboard/server.mjs .claude/helpers/dashboard/app.js
git commit -m "feat(flows): /api/flows/:id/excalidraw + read-only SVG preview in Flows view"
```

---

## Self-Review

**1. Spec coverage (Phase 2):** flow→.excalidraw converter (Task 1) ✓; `.excalidraw` files per flow + nightly + on-demand (Task 2) ✓; configurable output dir (`drawAllFlows({outputDir})` param; default `docs/flows/`) ✓; dashboard read-only preview (Task 3) ✓; reuse db.cjs flows API + excalidraw skill format + nightly step pattern ✓; Phase 3 deferred ✓.

**2. Placeholder scan:** Every code step contains complete code; commands have expected output; no TBD/TODO.

**3. Type consistency:** node fields (`node_id,label,terminal,ambiguous`), edge fields (`source,target`), and `getFlow`'s `{flow,nodes,edges}` are used identically in Tasks 1–3; element ids (`r-<id>`, `t-<id>`, `a-<src>-<tgt>`) and the doc shape are consistent between the converter, the writer, the endpoint, and the SVG renderer; `drawAllFlows` return `{generated,errors,total}` matches the nightly step's usage.
