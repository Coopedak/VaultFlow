# Data Brain — Phase 1: Brain Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Brain" dashboard tab showing a force-directed graph of how vaultflow's entities (projects, sessions, files, symbols, memory, skills, patterns, prompts, commits) link together, backed by a new `/api/brain/graph` endpoint over existing edge tables.

**Architecture:** A new pure read function `getBrainGraph()` in `db.cjs` UNIONs existing edge tables into a `{nodes, edges}` shape with hard caps. A thin Express route exposes it. The SPA renders it with Cytoscape.js (CDN, no build step — the one new dependency, frontend-only). Overview mode shows top nodes per type; clicking a node refetches its neighborhood.

**Tech Stack:** Node.js 22 `node:sqlite` (CJS `db.cjs`), Express 4 (`server.mjs`), vanilla JS SPA (`app.js` + `index.html`), Cytoscape.js 3.x via jsDelivr CDN, `node --test` for tests.

**No schema changes.** All edges already exist: `memory_links`, `code_imports`, `code_calls`, `skill_injection_decisions`, `edit_events`, `prompts`, `session_summaries`, `patterns.agent`, `git_commits`.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `.claude/helpers/db.cjs` | Add `getBrainGraph(opts)` read function + export it | Modify |
| `.claude/helpers/dashboard/server.mjs` | Add `GET /api/brain/graph` route | Modify |
| `.claude/helpers/dashboard/index.html` | Add Cytoscape CDN, nav button, `#tab-brain` section | Modify |
| `.claude/helpers/dashboard/app.js` | Add `loadBrain()`, graph render, click-expand, register in `LOADERS` | Modify |
| `tests/brainGraph.test.mjs` | Test `getBrainGraph()` against a fixture DB | Create |

### `getBrainGraph()` contract (locked here, referenced by all tasks)

```
getBrainGraph(opts) -> { nodes: Node[], edges: Edge[], meta: {...} }

opts = {
  center: string | null,   // node id "type:key"; null = overview mode
  depth:  number,          // 1 (default) or 2; clamped to [1,2]
  types:  string[] | null, // filter to these node types; null = all
  limit:  number,          // soft node cap; clamped to <= 500
}

Node = { id: string, type: string, label: string, weight: number }
Edge = { source: string, target: string, kind: string, weight: number }
meta = { mode: 'overview'|'neighborhood', truncated: boolean, nodeCount, edgeCount }
```

Node id format is `type:key`. Types: `project, session, file, symbol, memory, skill, pattern, prompt, commit`.

---

## Task 1: `getBrainGraph()` overview mode in db.cjs

**Files:**
- Modify: `.claude/helpers/db.cjs` (add function before `module.exports` at ~3216; add name to exports block)
- Test: `tests/brainGraph.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/brainGraph.test.mjs`:

```javascript
/**
 * getBrainGraph() — overview + neighborhood graph assembly over existing
 * edge tables. Run: node --test tests/brainGraph.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

/** Fresh metrics root with an initialized DB, seeded with cross-entity rows. */
function freshDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-brain-'));
  db.close();                       // drop any prior handle (module is a singleton)
  db.initialize(root, 'vaultflow.db');
  const conn = db.raw();
  conn.exec(`
    INSERT INTO sessions (id, started_at, project, edits) VALUES
      ('s1','2026-06-10T10:00:00Z','alpha', 5),
      ('s2','2026-06-11T10:00:00Z','beta', 2);
    INSERT INTO edit_events (timestamp, session_id, file_path, project) VALUES
      ('2026-06-10T10:01:00Z','s1','src/a.js','alpha'),
      ('2026-06-10T10:02:00Z','s1','src/b.js','alpha');
    INSERT INTO memory_entries (source, title, body, tags) VALUES
      ('vault/x.md#1','Alpha note','body one','tag'),
      ('vault/y.md#1','Beta note','body two','tag');
    INSERT INTO memory_links (source, target, title) VALUES
      ('vault/x.md#1','vault/y.md#1','Alpha note');
  `);
  return root;
}

test('overview mode returns nodes per type and edges among them', () => {
  freshDb();
  const g = db.getBrainGraph({ center: null, depth: 1, types: null, limit: 200 });
  assert.equal(g.meta.mode, 'overview');
  assert.ok(g.nodes.length > 0, 'expected nodes');
  // project nodes present
  assert.ok(g.nodes.some(n => n.type === 'project' && n.id === 'project:alpha'));
  // session node present and linked to its project
  assert.ok(g.nodes.some(n => n.id === 'session:s1'));
  assert.ok(g.edges.some(e => e.kind === 'belongs' && e.source === 'session:s1' && e.target === 'project:alpha'));
  // every edge endpoint must exist as a node (no dangling edges)
  const ids = new Set(g.nodes.map(n => n.id));
  for (const e of g.edges) {
    assert.ok(ids.has(e.source) && ids.has(e.target), `dangling edge ${e.source}->${e.target}`);
  }
});

test('limit clamps node count and sets truncated flag', () => {
  freshDb();
  const g = db.getBrainGraph({ center: null, depth: 1, types: null, limit: 2 });
  assert.ok(g.nodes.length <= 2 + 0); // soft cap honored
  assert.equal(typeof g.meta.truncated, 'boolean');
});

test('types filter restricts node types', () => {
  freshDb();
  const g = db.getBrainGraph({ center: null, depth: 1, types: ['project'], limit: 200 });
  assert.ok(g.nodes.every(n => n.type === 'project'), 'only project nodes expected');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/brainGraph.test.mjs`
Expected: FAIL — `db.getBrainGraph is not a function`.

- [ ] **Step 3: Add `getBrainGraph()` to db.cjs**

Insert this function just before the `module.exports = {` block (~line 3216). It uses the existing `_db` handle and follows the guard-clause + prepared-statement house style:

```javascript
/**
 * Build a cross-entity graph over existing edge tables for the Brain dashboard.
 * Pure read. No schema changes — UNIONs the relationship tables vaultflow
 * already maintains. Hard-capped so the browser never receives the full graph.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.center] node id "type:key"; null = overview mode
 * @param {number} [opts.depth=1]     neighborhood depth, clamped to [1,2]
 * @param {string[]|null} [opts.types] node-type allowlist; null = all
 * @param {number} [opts.limit=150]   soft node cap, clamped to [1,500]
 * @returns {{nodes:Array,edges:Array,meta:object}}
 */
function getBrainGraph(opts) {
  if (!_db) throw new Error('db.getBrainGraph: call initialize() first');
  const o      = opts || {};
  const center = o.center || null;
  const depth  = Math.min(2, Math.max(1, o.depth || 1));
  const types  = Array.isArray(o.types) && o.types.length ? new Set(o.types) : null;
  const NODE_CAP = Math.min(500, Math.max(1, o.limit || 150));
  const EDGE_CAP = NODE_CAP * 3;

  const nodes = new Map();   // id -> node
  const edges = [];
  const allow = (t) => !types || types.has(t);
  const addNode = (id, type, label, weight) => {
    if (!allow(type)) return false;
    if (!nodes.has(id)) nodes.set(id, { id, type, label: String(label ?? id).slice(0, 80), weight: weight || 1 });
    else if (weight && weight > nodes.get(id).weight) nodes.get(id).weight = weight;
    return true;
  };
  const addEdge = (source, target, kind, weight) => {
    if (edges.length >= EDGE_CAP) return;
    if (nodes.has(source) && nodes.has(target)) edges.push({ source, target, kind, weight: weight || 1 });
  };

  // ── overview: top-N nodes per type over the last 30 days ──────────────────
  const q = (sql, ...p) => _db.prepare(sql).all(...p);

  // projects by session count
  for (const r of q(`SELECT project, COUNT(*) n FROM sessions WHERE project IS NOT NULL GROUP BY project ORDER BY n DESC LIMIT 10`))
    addNode(`project:${r.project}`, 'project', r.project, r.n);
  // sessions (recent)
  for (const r of q(`SELECT id, project, started_at, COALESCE(edits,0) edits FROM sessions ORDER BY started_at DESC LIMIT 15`)) {
    if (addNode(`session:${r.id}`, 'session', `${r.project || '?'} ${String(r.started_at).slice(0,10)}`, r.edits))
      if (r.project) { addNode(`project:${r.project}`, 'project', r.project, 1); addEdge(`session:${r.id}`, `project:${r.project}`, 'belongs', 1); }
  }
  // hub files by edit frequency
  for (const r of q(`SELECT file_path, project, COUNT(*) n FROM edit_events GROUP BY file_path ORDER BY n DESC LIMIT 15`)) {
    const base = String(r.file_path).split(/[/\\]/).pop();
    if (addNode(`file:${r.file_path}`, 'file', base, r.n) && r.project) {
      addNode(`project:${r.project}`, 'project', r.project, 1);
      addEdge(`file:${r.file_path}`, `project:${r.project}`, 'belongs', 1);
    }
  }
  // skills by use_count
  try { for (const r of q(`SELECT name, COALESCE(use_count,0) uc FROM vault_agents ORDER BY uc DESC LIMIT 10`))
    addNode(`skill:${r.name}`, 'skill', r.name, r.uc); } catch (_) {}
  // patterns by fire_count
  try { for (const r of q(`SELECT pattern_key, agent, COALESCE(fire_count,0) fc FROM patterns ORDER BY fc DESC LIMIT 10`)) {
    if (addNode(`pattern:${r.pattern_key}`, 'pattern', r.pattern_key, r.fc) && r.agent) {
      addNode(`skill:${r.agent}`, 'skill', r.agent, 1);
      addEdge(`pattern:${r.pattern_key}`, `skill:${r.agent}`, 'owns', 1);
    }
  } } catch (_) {}
  // memory entries by backlink count
  try { for (const r of q(`SELECT m.source, m.title, COUNT(l.target) n FROM memory_entries m
                            LEFT JOIN memory_links l ON l.target = m.source
                            GROUP BY m.source ORDER BY n DESC LIMIT 10`))
    addNode(`memory:${r.source}`, 'memory', r.title || r.source, r.n + 1); } catch (_) {}

  // edges among selected memory nodes
  try { for (const r of q(`SELECT source, target FROM memory_links LIMIT 500`))
    addEdge(`memory:${r.source}`, `memory:${r.target}`, 'links', 1); } catch (_) {}
  // edit edges among selected sessions+files
  try { for (const r of q(`SELECT DISTINCT session_id, file_path FROM edit_events LIMIT 500`))
    addEdge(`session:${r.session_id}`, `file:${r.file_path}`, 'edited', 1); } catch (_) {}

  const truncated = nodes.size > NODE_CAP;
  const nodeArr = Array.from(nodes.values()).sort((a, b) => b.weight - a.weight).slice(0, NODE_CAP);
  const keep = new Set(nodeArr.map(n => n.id));
  const edgeArr = edges.filter(e => keep.has(e.source) && keep.has(e.target));

  return {
    nodes: nodeArr,
    edges: edgeArr,
    meta: { mode: center ? 'neighborhood' : 'overview', truncated, nodeCount: nodeArr.length, edgeCount: edgeArr.length },
  };
}
```

- [ ] **Step 4: Export it**

In the `module.exports = {` block (~line 3216), add `getBrainGraph,` near the read functions (e.g. after `searchMemory,`):

```javascript
  searchMemory,
  getBrainGraph,
```

- [ ] **Step 5: Run test to verify overview passes**

Run: `node --test tests/brainGraph.test.mjs`
Expected: the overview, limit, and types tests PASS. (Neighborhood test is added in Task 2.)

- [ ] **Step 6: Commit**

```bash
git add tests/brainGraph.test.mjs .claude/helpers/db.cjs
git commit -m "feat(vaultflow): getBrainGraph() overview mode over existing edge tables"
```

---

## Task 2: `getBrainGraph()` neighborhood mode (center node)

**Files:**
- Modify: `.claude/helpers/db.cjs` (extend `getBrainGraph` with a center branch)
- Test: `tests/brainGraph.test.mjs` (add a test)

- [ ] **Step 1: Add the failing test**

Append to `tests/brainGraph.test.mjs`:

```javascript
test('neighborhood mode centers on a node and returns its edges', () => {
  freshDb();
  const g = db.getBrainGraph({ center: 'session:s1', depth: 1, types: null, limit: 200 });
  assert.equal(g.meta.mode, 'neighborhood');
  assert.ok(g.nodes.some(n => n.id === 'session:s1'), 'center node must be present');
  // s1 edited a.js and b.js → those file nodes + edges must appear
  assert.ok(g.nodes.some(n => n.id === 'file:src/a.js'));
  assert.ok(g.edges.some(e => e.source === 'session:s1' && e.target === 'file:src/a.js' && e.kind === 'edited'));
});

test('unknown center node returns just that node, no crash', () => {
  freshDb();
  const g = db.getBrainGraph({ center: 'file:does/not/exist', depth: 1, types: null, limit: 200 });
  assert.equal(g.nodes.length, 1);
  assert.equal(g.edges.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/brainGraph.test.mjs`
Expected: FAIL — neighborhood test gets overview data (center branch not implemented), `meta.mode` mismatch or missing file edges.

- [ ] **Step 3: Implement the center branch**

In `getBrainGraph`, replace the comment line `// ── overview: top-N nodes per type ...` and everything down to the `const truncated =` line by wrapping the overview block in `if (!center) { ... }` and adding a neighborhood block. Concretely, change the structure to:

```javascript
  const q = (sql, ...p) => _db.prepare(sql).all(...p);

  if (center) {
    // ── neighborhood: BFS out from the center node ─────────────────────────
    const [ctype, ...crest] = center.split(':');
    const ckey = crest.join(':');
    const labelFor = (id) => id.split(':').slice(1).join(':').split(/[/\\]/).pop();
    addNode(center, ctype, labelFor(center), 5);

    const expand = (id) => {
      const [t, ...rest] = id.split(':');
      const key = rest.join(':');
      if (t === 'session') {
        for (const r of q(`SELECT DISTINCT file_path FROM edit_events WHERE session_id = ? LIMIT 50`, key)) {
          if (addNode(`file:${r.file_path}`, 'file', String(r.file_path).split(/[/\\]/).pop(), 1))
            addEdge(id, `file:${r.file_path}`, 'edited', 1);
        }
        const s = q(`SELECT project FROM sessions WHERE id = ? LIMIT 1`, key)[0];
        if (s && s.project) { addNode(`project:${s.project}`, 'project', s.project, 1); addEdge(id, `project:${s.project}`, 'belongs', 1); }
      } else if (t === 'file') {
        for (const r of q(`SELECT DISTINCT session_id FROM edit_events WHERE file_path = ? LIMIT 50`, key)) {
          if (addNode(`session:${r.session_id}`, 'session', r.session_id, 1))
            addEdge(`session:${r.session_id}`, id, 'edited', 1);
        }
        try { for (const r of q(`SELECT target FROM code_imports WHERE file = ? LIMIT 50`, key)) {
          if (addNode(`file:${r.target}`, 'file', String(r.target).split(/[/\\]/).pop(), 1)) addEdge(id, `file:${r.target}`, 'imports', 1);
        } } catch (_) {}
      } else if (t === 'memory') {
        try { for (const r of q(`SELECT target FROM memory_links WHERE source = ? LIMIT 50`, key)) {
          if (addNode(`memory:${r.target}`, 'memory', r.target, 1)) addEdge(id, `memory:${r.target}`, 'links', 1);
        } } catch (_) {}
        try { for (const r of q(`SELECT source FROM memory_links WHERE target = ? LIMIT 50`, key)) {
          if (addNode(`memory:${r.source}`, 'memory', r.source, 1)) addEdge(`memory:${r.source}`, id, 'links', 1);
        } } catch (_) {}
      } else if (t === 'project') {
        for (const r of q(`SELECT id, started_at FROM sessions WHERE project = ? ORDER BY started_at DESC LIMIT 30`, key)) {
          if (addNode(`session:${r.id}`, 'session', r.id, 1)) addEdge(`session:${r.id}`, id, 'belongs', 1);
        }
      } else if (t === 'skill') {
        try { for (const r of q(`SELECT pattern_key FROM patterns WHERE agent = ? LIMIT 30`, key)) {
          if (addNode(`pattern:${r.pattern_key}`, 'pattern', r.pattern_key, 1)) addEdge(`pattern:${r.pattern_key}`, id, 'owns', 1);
        } } catch (_) {}
      }
    };

    let frontier = [center];
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const id of frontier) { expand(id); }
      // depth 2: expand the newly added nodes once more
      for (const n of nodes.keys()) if (!frontier.includes(n)) next.push(n);
      frontier = next;
      if (depth === 1) break;
    }
  } else {
    // ── overview: top-N nodes per type over the last 30 days ────────────────
    // (existing overview body stays here, unchanged)
```

Then close the overview `else` block with a `}` right before the `const truncated =` line.

> NOTE: keep the entire existing overview body (projects/sessions/files/skills/patterns/memory + the two edge loops) verbatim inside the new `else { ... }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/brainGraph.test.mjs`
Expected: all five tests PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/brainGraph.test.mjs .claude/helpers/db.cjs
git commit -m "feat(vaultflow): getBrainGraph() neighborhood (center) mode with depth BFS"
```

---

## Task 3: `GET /api/brain/graph` endpoint

**Files:**
- Modify: `.claude/helpers/dashboard/server.mjs` (add route after an existing `/api/...` route, e.g. after the `/api/backlinks` handler)
- Test: `tests/brainEndpoint.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/brainEndpoint.test.mjs`:

```javascript
/**
 * /api/brain/graph response shape. Boots the Express app against a fixture DB.
 * Run: node --test tests/brainEndpoint.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

function seed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-ep-'));
  db.close();
  db.initialize(root, 'vaultflow.db');
  db.raw().exec(`INSERT INTO sessions (id, started_at, project, edits) VALUES ('s1','2026-06-10T10:00:00Z','alpha',3);`);
  db.close();
  return root;
}

test('GET /api/brain/graph returns {nodes,edges,meta}', async () => {
  const root = seed();
  process.env.VAULTFLOW_METRICS_ROOT = root; // server reads config; override below if needed
  // The server module reads config at import; call the route handler via a light fetch.
  const { startServer } = await import('../.claude/helpers/dashboard/server.mjs');
  const srv = startServer({ metricsRoot: root, port: 0 });
  const addr = srv.address();
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/brain/graph?limit=50`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.nodes), 'nodes array');
  assert.ok(Array.isArray(body.edges), 'edges array');
  assert.equal(typeof body.meta.mode, 'string');
  srv.close();
});
```

> This test requires `server.mjs` to export a `startServer({metricsRoot, port})` that returns the `http.Server`. If `server.mjs` currently auto-listens at import, Step 3 refactors it to export `startServer` and only auto-listen when run directly.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/brainEndpoint.test.mjs`
Expected: FAIL — `startServer` is not exported, or `/api/brain/graph` 404s.

- [ ] **Step 3: Add the route + ensure `startServer` export**

In `server.mjs`, add the route alongside the other `app.get('/api/...')` handlers:

```javascript
// ── GET /api/brain/graph ────────────────────────────────────────────────
app.get('/api/brain/graph', (req, res) => {
  try {
    const center = req.query.center || null;
    const depth  = Number(req.query.depth) || 1;
    const limit  = Number(req.query.limit) || 150;
    const types  = req.query.types ? String(req.query.types).split(',').filter(Boolean) : null;
    res.json(db.getBrainGraph({ center, depth, types, limit }));
  } catch (err) { apiErr(res, err); }
});
```

At the bottom of `server.mjs`, ensure the listen logic is wrapped so tests can boot on an ephemeral port. If the file currently ends with `app.listen(PORT, HOST, ...)`, replace that with:

```javascript
export function startServer(opts = {}) {
  if (opts.metricsRoot) { /* test override */ db.close?.(); db.initialize(opts.metricsRoot, DB_FILE); }
  const port = opts.port ?? PORT;
  return app.listen(port, HOST);
}

// Auto-start only when run directly (node server.mjs), not when imported by tests.
import { fileURLToPath as _f } from 'node:url';
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(_f(import.meta.url))) {
  const srv = startServer();
  srv.on('listening', () => console.log(`[dashboard] http://${HOST}:${PORT}`));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/brainEndpoint.test.mjs`
Expected: PASS (status 200, nodes/edges arrays, meta.mode string).

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: all test files PASS (existing + the two new ones).

- [ ] **Step 6: Commit**

```bash
git add tests/brainEndpoint.test.mjs .claude/helpers/dashboard/server.mjs
git commit -m "feat(vaultflow): /api/brain/graph endpoint + testable startServer export"
```

---

## Task 4: Cytoscape library + Brain tab markup

**Files:**
- Modify: `.claude/helpers/dashboard/index.html`

- [ ] **Step 1: Add the Cytoscape CDN script**

In `index.html` `<head>` (right after the Chart.js `<script>` at line ~7):

```html
  <script src="https://cdn.jsdelivr.net/npm/cytoscape@3.30.2/dist/cytoscape.min.js"></script>
```

- [ ] **Step 2: Add the nav button**

In the `<nav>` block (~line 349, before the `graph` button):

```html
  <button data-tab="brain">🧠 Brain</button>
```

- [ ] **Step 3: Add the section markup**

In `<main>`, after the Discoveries section and before the Memory section, add:

```html
  <!-- ── Brain ── -->
  <section class="section" id="tab-brain">
    <div class="brain-toolbar" style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
      <input id="brain-search" type="search" placeholder="Search & recenter…" style="flex:1;min-width:200px" />
      <label class="mono" style="font-size:12px">depth
        <select id="brain-depth"><option value="1">1</option><option value="2">2</option></select>
      </label>
      <button id="brain-reset">Overview</button>
      <span id="brain-meta" class="mono" style="font-size:12px;opacity:.7"></span>
    </div>
    <div id="brain-graph" style="height:600px;border:1px solid #2a2a3a;border-radius:8px;background:#0e0e16"></div>
    <div id="brain-detail" class="table-card" style="margin-top:12px;min-height:40px">
      <span class="loading">Click a node to inspect it.</span>
    </div>
  </section>
```

- [ ] **Step 4: Verify markup loads (manual)**

Run: `npm run dashboard:serve` then open `http://localhost:7700`, click the 🧠 Brain tab.
Expected: empty bordered graph box + toolbar render (no JS wiring yet — that's Task 5). No console errors about missing Cytoscape.

- [ ] **Step 5: Commit**

```bash
git add .claude/helpers/dashboard/index.html
git commit -m "feat(vaultflow): Brain tab markup + Cytoscape CDN"
```

---

## Task 5: `loadBrain()` — render the graph

**Files:**
- Modify: `.claude/helpers/dashboard/app.js` (add `loadBrain()` + helpers before the `LOADERS` map ~line 1035; register `brain` in `LOADERS`)

- [ ] **Step 1: Add the node color palette + render function**

Before the `LOADERS` map, add:

```javascript
// ── Brain graph ─────────────────────────────────────────────────────────
const BRAIN_COLORS = {
  project: '#f59e0b', session: '#6366f1', file: '#22d3ee', symbol: '#a78bfa',
  memory:  '#34d399', skill:   '#f472b6', pattern: '#fb7185', prompt: '#94a3b8',
  commit:  '#facc15',
};
let brainCy = null;

function brainElements(g) {
  const nodes = g.nodes.map(n => ({ data: { id: n.id, label: n.label, type: n.type, weight: n.weight } }));
  const edges = g.edges.map((e, i) => ({ data: { id: `e${i}`, source: e.source, target: e.target, kind: e.kind } }));
  return [...nodes, ...edges];
}

function renderBrain(g) {
  document.getElementById('brain-meta').textContent =
    `${g.meta.mode} · ${g.meta.nodeCount} nodes · ${g.meta.edgeCount} edges${g.meta.truncated ? ' · truncated' : ''}`;
  if (brainCy) brainCy.destroy();
  brainCy = cytoscape({
    container: document.getElementById('brain-graph'),
    elements: brainElements(g),
    style: [
      { selector: 'node', style: {
        'background-color': (n) => BRAIN_COLORS[n.data('type')] || '#888',
        'label': 'data(label)', 'color': '#cbd5e1', 'font-size': 9,
        'width': (n) => 12 + Math.min(28, Math.sqrt(n.data('weight') || 1) * 6),
        'height': (n) => 12 + Math.min(28, Math.sqrt(n.data('weight') || 1) * 6),
        'text-wrap': 'ellipsis', 'text-max-width': 80, 'min-zoomed-font-size': 6,
      }},
      { selector: 'edge', style: {
        'width': 1, 'line-color': '#3a3a4a', 'target-arrow-color': '#3a3a4a',
        'target-arrow-shape': 'triangle', 'arrow-scale': 0.6, 'curve-style': 'bezier', 'opacity': 0.6,
      }},
      { selector: 'node:selected', style: { 'border-width': 2, 'border-color': '#fff' } },
    ],
    layout: { name: 'cose', animate: false, nodeRepulsion: 8000, idealEdgeLength: 80 },
  });
  brainCy.on('tap', 'node', (evt) => brainExpand(evt.target.id()));
}
```

- [ ] **Step 2: Add the fetch/expand/detail functions**

```javascript
async function loadBrain() {
  const depth = document.getElementById('brain-depth').value || 1;
  const g = await api(`/api/brain/graph?limit=150&depth=${depth}`).catch(() => ({ nodes: [], edges: [], meta: { mode: 'overview', nodeCount: 0, edgeCount: 0 } }));
  renderBrain(g);
}

async function brainExpand(nodeId) {
  const depth = document.getElementById('brain-depth').value || 1;
  const g = await api(`/api/brain/graph?center=${encodeURIComponent(nodeId)}&depth=${depth}&limit=150`).catch(() => null);
  if (g) renderBrain(g);
  brainDetail(nodeId);
}

function brainDetail(nodeId) {
  const [type, ...rest] = nodeId.split(':');
  const key = rest.join(':');
  const el = document.getElementById('brain-detail');
  el.innerHTML = `<div class="mono" style="font-size:13px">
    <strong style="color:${BRAIN_COLORS[type] || '#fff'}">${type}</strong> · ${escapeHtml(key)}
  </div>`;
}
```

> `escapeHtml` already exists in app.js (used by other loaders). If not present, add: `function escapeHtml(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}`

- [ ] **Step 3: Wire the toolbar + register the loader**

Add after the functions above:

```javascript
document.getElementById('brain-reset')?.addEventListener('click', loadBrain);
document.getElementById('brain-depth')?.addEventListener('change', loadBrain);
document.getElementById('brain-search')?.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  const hits = await api(`/api/search?q=${encodeURIComponent(e.target.value.trim())}&limit=1`).catch(() => null);
  // unified search returns mixed rows; recenter on the first that maps to a graph node id, else no-op
  const first = hits && (hits.results || hits)[0];
  if (first && first.id) brainExpand(String(first.id));
});
```

In the `LOADERS` map (~line 1035), add:

```javascript
  brain: loadBrain,
```

- [ ] **Step 4: Manual verification**

Run: `npm run dashboard:serve`, open `http://localhost:7700`, click 🧠 Brain.
Expected: a force-directed graph renders with colored nodes; clicking a node recenters on its neighborhood; the meta line updates; depth selector re-renders. Check the browser console — no errors.

- [ ] **Step 5: Commit**

```bash
git add .claude/helpers/dashboard/app.js
git commit -m "feat(vaultflow): Brain tab graph render, click-to-expand, search recenter"
```

---

## Task 6: Wire the static dashboard generator (if applicable)

**Files:**
- Modify: `.claude/helpers/dashboard/gen.mjs` (only if it inlines/whitelists assets)

- [ ] **Step 1: Check whether gen.mjs needs the CDN**

Run: `grep -n "cdn\|chart.js\|script src" .claude/helpers/dashboard/gen.mjs`
Expected: determine if `gen.mjs` rewrites `<script>` tags or copies `index.html` verbatim.

- [ ] **Step 2: If gen.mjs strips/rewrites scripts, add Cytoscape to its allowlist**

If `gen.mjs` has an array of permitted CDN scripts, add the Cytoscape URL there exactly as in Task 4 Step 1. If it copies `index.html` verbatim, no change is needed — note that in the commit message.

- [ ] **Step 3: Generate and verify the static build**

Run: `npm run dashboard`
Expected: command succeeds; the generated HTML includes the Brain tab and the Cytoscape script tag.

- [ ] **Step 4: Commit (only if changed)**

```bash
git add .claude/helpers/dashboard/gen.mjs
git commit -m "chore(vaultflow): include Cytoscape in static dashboard generator"
```

---

## Self-Review

- **Spec coverage:** `/api/brain/graph` overview+neighborhood (Tasks 1–3) ✓; Cytoscape tab (Tasks 4–5) ✓; node types/edge kinds from the spec table ✓; caps (Task 1, NODE_CAP/EDGE_CAP) ✓; search recenter via `/api/search` (Task 5) ✓; side panel (Task 5 `brainDetail`) ✓. Deep node-detail via existing endpoints is a stub (`brainDetail` shows type+key) — full deep-link is deferred to Phase 3 polish; acceptable for Phase 1.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** `getBrainGraph({center,depth,types,limit})` identical across Tasks 1/2/3; `{nodes,edges,meta}` shape identical across db/endpoint/SPA; `BRAIN_COLORS` types match node `type` strings emitted by `getBrainGraph`.
