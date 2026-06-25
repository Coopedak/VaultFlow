# Atlas Phase 1 — Brain-notes core + live Atlas view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live, Quartz-styled "Atlas" knowledge view to the vaultflow dashboard that reads the brain's `memory_entries` as linked notes (reading column, backlinks, local graph, search).

**Architecture:** A new CJS data core `brain-notes.cjs` turns `memory_entries` rows + their `[[wikilink]]` references into note objects with resolved links/backlinks/local-graph. Two thin Express endpoints expose it. A new vanilla-JS SPA view (`atlas.js`) renders notes Quartz-style, rendering markdown with a vendored `markdown-it` and the local graph with the already-vendored Cytoscape. Markdown is rendered **client-side** in Phase 1 (the data core is the shared piece; Phase 3 export will reuse `markdown-it` in Node).

**Tech Stack:** Node.js 22+, `node:sqlite` via `db.cjs`, Express 4 (`server.mjs`), vanilla-JS ESM SPA modules, vendored `markdown-it` (MIT) + `cytoscape`. Tests: `node:test` (`node --test`).

## Global Constraints

- Node.js 22+; ESM for `.mjs`, CJS for `.cjs`. `brain-notes.cjs` is CJS (sibling of `db.cjs`).
- No new npm dependencies. The only new lib is `markdown-it`, **vendored** as a local file in `.claude/helpers/dashboard/vendor/` (no `package.json` entry, no CDN — matches `chart.umd.min.js`/`cytoscape.min.js`).
- `db.initialize()` is idempotent — call it before any DB op. Use `db.raw()` for direct SQL.
- Windows path-safe (`node:path`; no hardcoded separators).
- Tests live in `tests/*.test.mjs`, run via `node --test`. Use the fixture-DB pattern: `db.close()` then `db.initialize(tmpRoot, 'vaultflow.db')`.
- Working branch: `feat/atlas-quartz`. Commit after every task.
- Phases 2 (Excalidraw) and 3 (static export) are OUT OF SCOPE for this plan.

## File Structure

- **Create** `.claude/helpers/brain-notes.cjs` — note data core. Responsibility: map `memory_entries` + `[[wikilinks]]` → `{listNotes, getNote, getBacklinks, getLocalGraph, extractWikilinkTitles, resolveLinks}`.
- **Create** `tests/brainNotes.test.mjs` — unit tests for the core against a fixture DB.
- **Modify** `.claude/helpers/dashboard/server.mjs` — add `GET /api/notes` and `GET /api/notes/:id` (require `../brain-notes.cjs`).
- **Create** `.claude/helpers/dashboard/vendor/markdown-it.min.js` — vendored UMD build (exposes `window.markdownit`).
- **Create** `.claude/helpers/dashboard/js/atlas.js` — the Atlas SPA view.
- **Modify** `.claude/helpers/dashboard/index-v2.html` — add the Atlas nav item + `<script type="module">` import.
- **Modify** `.claude/helpers/dashboard/css/` — append Atlas styles (reading column, backlinks panel, graph pane).

---

### Task 1: brain-notes core — `listNotes` + `getNote`

**Files:**
- Create: `.claude/helpers/brain-notes.cjs`
- Test: `tests/brainNotes.test.mjs`

**Interfaces:**
- Consumes: `db.cjs` — `db.initialize(root?, file?)`, `db.raw()` (better-sqlite-style connection with `.prepare().all()/.get()`), `db.close()`.
- Produces:
  - `listNotes({ limit=100, offset=0, source=null }) -> Array<{id:number, source:string, title:string, tags:string}>`
  - `getNote(id:number) -> {id, source, title, body, tags, links:Link[], backlinks:Ref[]} | null` (links/backlinks added in Task 2; in Task 1 they may be omitted)
  - `Link = {name:string, id:number|null, dangling:boolean}`; `Ref = {id:number, source:string, title:string}`

- [ ] **Step 1: Write the failing test**

```js
// tests/brainNotes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');
const notes = require('../.claude/helpers/brain-notes.cjs');

function freshDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-notes-'));
  try { db.close(); } catch {}
  db.initialize(root, 'vaultflow.db');
  db.raw().exec(`
    INSERT INTO memory_entries (source, title, body, tags) VALUES
      ('a.md', 'Alpha', 'Alpha links to [[Beta]] here.', 'x'),
      ('a.md', 'Beta',  'Beta is a plain note.',          'y'),
      ('a.md', 'Gamma', 'Gamma sees [[Beta]] and [[Ghost]].', 'z');
  `);
  return root;
}
function idOf(title) {
  return db.raw().prepare('SELECT id FROM memory_entries WHERE title = ?').get(title).id;
}

test('listNotes returns all note headers, newest first', () => {
  freshDb();
  const rows = notes.listNotes({ limit: 10 });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.title).sort(), ['Alpha', 'Beta', 'Gamma']);
  assert.ok('source' in rows[0] && 'tags' in rows[0] && !('body' in rows[0]));
});

test('getNote returns the full note including body', () => {
  freshDb();
  const n = notes.getNote(idOf('Beta'));
  assert.equal(n.title, 'Beta');
  assert.match(n.body, /plain note/);
});

test('getNote returns null for a missing id', () => {
  freshDb();
  assert.equal(notes.getNote(999999), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/brainNotes.test.mjs`
Expected: FAIL — `Cannot find module '../.claude/helpers/brain-notes.cjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// .claude/helpers/brain-notes.cjs
'use strict';
const db = require('./db.cjs');

function ensure() { db.initialize(); }

function listNotes({ limit = 100, offset = 0, source = null } = {}) {
  ensure();
  const lim = Math.min(Number(limit) || 100, 500);
  const off = Number(offset) || 0;
  const where = source ? 'WHERE source = ?' : '';
  const args = source ? [source, lim, off] : [lim, off];
  return db.raw().prepare(
    `SELECT id, source, title, tags FROM memory_entries ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...args);
}

function getNote(id) {
  ensure();
  const note = db.raw().prepare(
    `SELECT id, source, title, body, tags FROM memory_entries WHERE id = ?`
  ).get(Number(id));
  return note || null;
}

module.exports = { listNotes, getNote };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/brainNotes.test.mjs`
Expected: PASS (3 tests). (Backlinks/links tests are added in Task 2.)

- [ ] **Step 5: Commit**

```bash
git add .claude/helpers/brain-notes.cjs tests/brainNotes.test.mjs
git commit -m "feat(atlas): brain-notes core — listNotes + getNote over memory_entries"
```

---

### Task 2: brain-notes core — wikilink extraction, `resolveLinks`, `getBacklinks`

**Files:**
- Modify: `.claude/helpers/brain-notes.cjs`
- Test: `tests/brainNotes.test.mjs` (add cases)

**Interfaces:**
- Produces:
  - `extractWikilinkTitles(body:string) -> string[]` (the trimmed names inside `[[ ]]`)
  - `resolveLinks(body:string) -> Link[]` where `Link = {name, id:number|null, dangling:boolean}` (case-insensitive title match)
  - `getBacklinks(id:number) -> Ref[]` (`Ref = {id, source, title}`) — notes whose body links to this note's title
  - `getNote(id)` now also returns `links` (= `resolveLinks(body)`) and `backlinks` (= `getBacklinks(id)`)

- [ ] **Step 1: Write the failing test (append)**

```js
test('extractWikilinkTitles pulls names out of [[ ]]', () => {
  assert.deepEqual(notes.extractWikilinkTitles('see [[Beta]] and [[Ghost]] ok'), ['Beta', 'Ghost']);
  assert.deepEqual(notes.extractWikilinkTitles('none here'), []);
});

test('resolveLinks marks resolved vs dangling, case-insensitively', () => {
  freshDb();
  const links = notes.resolveLinks('Gamma sees [[beta]] and [[Ghost]].');
  const beta = links.find(l => l.name.toLowerCase() === 'beta');
  const ghost = links.find(l => l.name === 'Ghost');
  assert.equal(beta.dangling, false);
  assert.equal(beta.id, idOf('Beta'));
  assert.equal(ghost.dangling, true);
  assert.equal(ghost.id, null);
});

test('getBacklinks finds notes linking to this note', () => {
  freshDb();
  const refs = notes.getBacklinks(idOf('Beta'));
  assert.deepEqual(refs.map(r => r.title).sort(), ['Alpha', 'Gamma']);
});

test('getNote includes links and backlinks', () => {
  freshDb();
  const gamma = notes.getNote(idOf('Gamma'));
  assert.equal(gamma.links.length, 2);
  const beta = notes.getNote(idOf('Beta'));
  assert.deepEqual(beta.backlinks.map(r => r.title).sort(), ['Alpha', 'Gamma']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/brainNotes.test.mjs`
Expected: FAIL — `notes.extractWikilinkTitles is not a function`.

- [ ] **Step 3: Write minimal implementation (edit brain-notes.cjs)**

Add these functions and extend `getNote` + `module.exports`:

```js
function extractWikilinkTitles(body) {
  return [...String(body || '').matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1].trim());
}

function titleIndex() {
  ensure();
  const rows = db.raw().prepare(`SELECT id, title FROM memory_entries`).all();
  const map = new Map();
  for (const r of rows) map.set(r.title.toLowerCase(), r.id);
  return map;
}

function resolveLinks(body) {
  const idx = titleIndex();
  return extractWikilinkTitles(body).map(name => {
    const id = idx.get(name.toLowerCase());
    return { name, id: id == null ? null : id, dangling: id == null };
  });
}

function getBacklinks(id) {
  ensure();
  const target = db.raw().prepare(`SELECT title FROM memory_entries WHERE id = ?`).get(Number(id));
  if (!target) return [];
  const t = target.title.toLowerCase();
  const rows = db.raw().prepare(`SELECT id, source, title, body FROM memory_entries WHERE id != ?`).all(Number(id));
  return rows
    .filter(r => extractWikilinkTitles(r.body).some(n => n.toLowerCase() === t))
    .map(r => ({ id: r.id, source: r.source, title: r.title }));
}
```

Extend `getNote` (after fetching `note`, before returning):

```js
function getNote(id) {
  ensure();
  const note = db.raw().prepare(
    `SELECT id, source, title, body, tags FROM memory_entries WHERE id = ?`
  ).get(Number(id));
  if (!note) return null;
  note.links = resolveLinks(note.body);
  note.backlinks = getBacklinks(note.id);
  return note;
}

module.exports = { listNotes, getNote, getBacklinks, resolveLinks, extractWikilinkTitles };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/brainNotes.test.mjs`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add .claude/helpers/brain-notes.cjs tests/brainNotes.test.mjs
git commit -m "feat(atlas): wikilink resolution + backlinks in brain-notes"
```

---

### Task 3: brain-notes core — `getLocalGraph`

**Files:**
- Modify: `.claude/helpers/brain-notes.cjs`
- Test: `tests/brainNotes.test.mjs` (add cases)

**Interfaces:**
- Produces: `getLocalGraph(id:number) -> { nodes: Array<{id:string, label:string, center:boolean}>, edges: Array<{source:string, target:string}> }` (node ids are stringified memory ids; Cytoscape-ready)

- [ ] **Step 1: Write the failing test (append)**

```js
test('getLocalGraph returns the note plus linked + backlinking neighbors', () => {
  freshDb();
  const g = notes.getLocalGraph(idOf('Beta'));
  const ids = g.nodes.map(n => n.label).sort();
  assert.deepEqual(ids, ['Alpha', 'Beta', 'Gamma']);     // Beta + its two backlinkers
  const center = g.nodes.find(n => n.center);
  assert.equal(center.label, 'Beta');
  assert.ok(g.edges.length >= 2);
  for (const e of g.edges) { assert.equal(typeof e.source, 'string'); assert.equal(typeof e.target, 'string'); }
});

test('getLocalGraph on a missing id returns empty graph', () => {
  freshDb();
  assert.deepEqual(notes.getLocalGraph(999999), { nodes: [], edges: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/brainNotes.test.mjs`
Expected: FAIL — `notes.getLocalGraph is not a function`.

- [ ] **Step 3: Write minimal implementation (edit brain-notes.cjs)**

```js
function getLocalGraph(id) {
  ensure();
  const note = db.raw().prepare(`SELECT id, title, body FROM memory_entries WHERE id = ?`).get(Number(id));
  if (!note) return { nodes: [], edges: [] };
  const nodes = new Map();
  const edges = [];
  nodes.set(note.id, { id: String(note.id), label: note.title, center: true });
  for (const l of resolveLinks(note.body)) {
    if (l.id != null) {
      if (!nodes.has(l.id)) nodes.set(l.id, { id: String(l.id), label: l.name, center: false });
      edges.push({ source: String(note.id), target: String(l.id) });
    }
  }
  for (const b of getBacklinks(note.id)) {
    if (!nodes.has(b.id)) nodes.set(b.id, { id: String(b.id), label: b.title, center: false });
    edges.push({ source: String(b.id), target: String(note.id) });
  }
  return { nodes: [...nodes.values()], edges };
}
```

Add `getLocalGraph` to `module.exports`:

```js
module.exports = { listNotes, getNote, getBacklinks, getLocalGraph, resolveLinks, extractWikilinkTitles };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/brainNotes.test.mjs`
Expected: PASS (all brain-notes tests).

- [ ] **Step 5: Commit**

```bash
git add .claude/helpers/brain-notes.cjs tests/brainNotes.test.mjs
git commit -m "feat(atlas): local graph builder in brain-notes"
```

---

### Task 4: Express endpoints `GET /api/notes` + `GET /api/notes/:id`

**Files:**
- Modify: `.claude/helpers/dashboard/server.mjs` (add `require('../brain-notes.cjs')` near the other requires; register the two routes alongside the existing `/api/memory` route)

**Interfaces:**
- Consumes: `brain-notes.cjs` (`listNotes`, `getNote`, `getLocalGraph`); existing `apiErr(res, err)` helper in server.mjs.
- Produces (HTTP):
  - `GET /api/notes?limit&offset&source` → `{ notes: [{id,source,title,tags}] }`
  - `GET /api/notes/:id` → `{ note: {id,source,title,body,tags,links,backlinks}, localGraph: {nodes,edges} }`; `404 {error}` if absent.

- [ ] **Step 1: Add the require (top of server.mjs, near `const db = require('../db.cjs')`)**

```js
const brainNotes = require('../brain-notes.cjs');
```

- [ ] **Step 2: Register the routes (near the existing `app.get('/api/memory', ...)`)**

```js
// ── Atlas: brain notes (Quartz-style knowledge view) ──
app.get('/api/notes', (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const source = req.query.source || null;
    res.json({ notes: brainNotes.listNotes({ limit, offset, source }) });
  } catch (err) { apiErr(res, err); }
});

app.get('/api/notes/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const note = brainNotes.getNote(id);
    if (!note) return res.status(404).json({ error: 'note not found' });
    res.json({ note, localGraph: brainNotes.getLocalGraph(id) });
  } catch (err) { apiErr(res, err); }
});
```

- [ ] **Step 3: Verify at runtime (no unit test — thin glue over tested core)**

Run (PowerShell, in repo root):
```bash
npm run dashboard &
# wait ~2s for "listening on http://localhost:7700"
curl -s "http://localhost:7700/api/notes?limit=3"
curl -s "http://localhost:7700/api/notes/1"
```
Expected: first returns `{"notes":[...]}` (array of headers); second returns `{"note":{...,"links":[...],"backlinks":[...]},"localGraph":{"nodes":[...],"edges":[...]}}` or `404 {"error":"note not found"}` if id 1 is absent. Stop the server afterward.

- [ ] **Step 4: Commit**

```bash
git add .claude/helpers/dashboard/server.mjs
git commit -m "feat(atlas): /api/notes + /api/notes/:id endpoints"
```

---

### Task 5: Vendor `markdown-it` + Atlas styles

**Files:**
- Create: `.claude/helpers/dashboard/vendor/markdown-it.min.js` (UMD build, exposes global `markdownit`)
- Modify: `.claude/helpers/dashboard/css/` (append an Atlas block — use the existing v2 stylesheet; if there are multiple, the one `index-v2.html` links)

**Interfaces:**
- Produces: browser global `window.markdownit` (constructor); CSS classes `.atlas`, `.atlas-list`, `.atlas-read`, `.atlas-backlinks`, `.atlas-graph`, `.wikilink`.

- [ ] **Step 1: Fetch the vendored library file**

Obtain the official UMD minified `markdown-it` (v14.x, MIT). Since the dashboard forbids CDNs at runtime, the file must be saved locally. Acquire it once via npm's tarball without adding a dependency:
```bash
npm pack markdown-it@14 --pack-destination "%TEMP%"
# extract dist/markdown-it.min.js from the tarball into the vendor dir:
tar -xzf "%TEMP%/markdown-it-14.*.tgz" -C "%TEMP%" package/dist/markdown-it.min.js
cp "%TEMP%/package/dist/markdown-it.min.js" .claude/helpers/dashboard/vendor/markdown-it.min.js
```
(If `tar`/`cp` differ on the shell, any method that lands the official `dist/markdown-it.min.js` at the target path is fine. Do NOT hand-write the library.)

- [ ] **Step 2: Verify the vendored file loads as a UMD global**

Run:
```bash
node -e "global.window={};const f=require('./.claude/helpers/dashboard/vendor/markdown-it.min.js');const md=(global.window.markdownit||f)();console.log(md.render('# hi **x**').trim())"
```
Expected: prints `<h1>hi <strong>x</strong></h1>`.

- [ ] **Step 3: Append Atlas styles**

Add to the v2 stylesheet (the file `index-v2.html` links from `css/`), reusing existing CSS variables (`--border`, `--muted`, etc. already used by `command-center`):
```css
/* Atlas — Quartz-style knowledge view */
.atlas { display: grid; grid-template-columns: 240px minmax(0,1fr) 280px; gap: 16px; height: 100%; }
.atlas-list { overflow-y: auto; border-right: 1px solid var(--border); padding-right: 8px; }
.atlas-list a { display:block; padding:4px 6px; border-radius:6px; color:inherit; text-decoration:none; }
.atlas-list a:hover, .atlas-list a.active { background: var(--border); }
.atlas-read { overflow-y: auto; line-height: 1.6; max-width: 720px; }
.atlas-read a.wikilink { border-bottom: 1px dashed var(--muted); text-decoration: none; }
.atlas-side { display:flex; flex-direction:column; gap:12px; }
.atlas-backlinks { border:1px solid var(--border); border-radius:8px; padding:8px; }
.atlas-backlinks h4 { margin:0 0 6px; font-size:12px; color:var(--muted); text-transform:uppercase; }
.atlas-graph { height: 240px; border:1px solid var(--border); border-radius:8px; }
.atlas-search { width:100%; margin-bottom:8px; padding:6px 8px; }
```

- [ ] **Step 4: Commit**

```bash
git add .claude/helpers/dashboard/vendor/markdown-it.min.js .claude/helpers/dashboard/css
git commit -m "chore(atlas): vendor markdown-it + Atlas styles"
```

---

### Task 6: Atlas SPA view (`atlas.js`) + nav wiring

**Files:**
- Create: `.claude/helpers/dashboard/js/atlas.js`
- Modify: `.claude/helpers/dashboard/index-v2.html` (nav item + `<script type="module">` import + ensure `markdown-it.min.js` and the vendored `cytoscape` are loaded before the module)

**Interfaces:**
- Consumes: `core.js` (`api`, `registerView`, `F`); `GET /api/notes`, `GET /api/notes/:id`, `GET /api/memory?q=`; browser globals `window.markdownit`, `window.cytoscape`.
- Produces: a registered view keyed `atlas`. Master-detail; note selection is internal state (NOT shell-routed), so wikilinks load notes in-place without touching the top-level hash router.

- [ ] **Step 1: Add the nav item + scripts to `index-v2.html`**

In the `<aside class="side">` nav, under a `Knowledge` group:
```html
<div class="nav-group">Knowledge</div>
<a class="nav-item" href="#/atlas" data-view="atlas">
  <span class="ico">▦</span><span class="lbl">Atlas</span></a>
```
Before the existing `js/*.js` module scripts, ensure the vendor globals are present (add if missing):
```html
<script src="/vendor/cytoscape.min.js"></script>
<script src="/vendor/markdown-it.min.js"></script>
```
Then register the view module (with the other `js` modules):
```html
<script type="module" src="/js/atlas.js"></script>
```

- [ ] **Step 2: Write `atlas.js`**

```js
import { api, registerView } from './core.js';

const md = window.markdownit({ html: false, linkify: true, breaks: false });

// [[Name]] -> markdown link to an in-view anchor (#note-<id>); dangling -> plain text.
function preprocessWikilinks(body, links) {
  const map = new Map((links || []).map(l => [l.name.toLowerCase(), l]));
  return String(body || '').replace(/\[\[([^\]]+)\]\]/g, (_, raw) => {
    const name = raw.trim();
    const l = map.get(name.toLowerCase());
    return (l && !l.dangling) ? `[${name}](#note-${l.id})` : name;
  });
}

function renderGraph(container, graph) {
  if (!graph.nodes.length || !window.cytoscape) { container.innerHTML = ''; return; }
  window.cytoscape({
    container,
    elements: [
      ...graph.nodes.map(n => ({ data: { id: n.id, label: n.label }, classes: n.center ? 'center' : '' })),
      ...graph.edges.map(e => ({ data: { source: e.source, target: e.target } })),
    ],
    style: [
      { selector: 'node', style: { 'label': 'data(label)', 'font-size': 9, 'background-color': '#888', 'color': '#ccc' } },
      { selector: 'node.center', style: { 'background-color': '#6ab' } },
      { selector: 'edge', style: { 'width': 1, 'line-color': '#555', 'target-arrow-shape': 'triangle', 'target-arrow-color': '#555', 'curve-style': 'bezier' } },
    ],
    layout: { name: 'cose', animate: false },
  });
}

registerView('atlas', async (el) => {
  const { notes } = await api('/api/notes?limit=300');
  el.innerHTML = `
    <div class="atlas">
      <div class="atlas-list">
        <input class="atlas-search" placeholder="Search notes…" />
        <div class="atlas-list-items"></div>
      </div>
      <article class="atlas-read"><p class="loading">Select a note.</p></article>
      <div class="atlas-side">
        <div class="atlas-backlinks"><h4>Backlinks</h4><div class="bl"></div></div>
        <div class="atlas-graph"></div>
      </div>
    </div>`;
  const listEl = el.querySelector('.atlas-list-items');
  const readEl = el.querySelector('.atlas-read');
  const blEl   = el.querySelector('.bl');
  const graphEl= el.querySelector('.atlas-graph');
  const search = el.querySelector('.atlas-search');

  function renderList(items) {
    listEl.innerHTML = items.map(n => `<a href="#" data-id="${n.id}">${n.title}</a>`).join('');
  }
  renderList(notes);

  async function loadNote(id) {
    const { note, localGraph } = await api('/api/notes/' + id);
    readEl.innerHTML = `<h1>${note.title}</h1>` + md.render(preprocessWikilinks(note.body, note.links));
    readEl.querySelectorAll('a[href^="#note-"]').forEach(a => a.classList.add('wikilink'));
    blEl.innerHTML = note.backlinks.length
      ? note.backlinks.map(b => `<a href="#" data-id="${b.id}">${b.title}</a>`).join('<br>')
      : '<span class="loading">None</span>';
    renderGraph(graphEl, localGraph);
    listEl.querySelectorAll('a').forEach(a => a.classList.toggle('active', a.dataset.id == String(id)));
  }

  // Delegate clicks: list items, backlinks, and in-body wikilinks.
  el.addEventListener('click', (e) => {
    const byId = e.target.closest('a[data-id]');
    if (byId) { e.preventDefault(); loadNote(Number(byId.dataset.id)); return; }
    const wl = e.target.closest('a[href^="#note-"]');
    if (wl) { e.preventDefault(); loadNote(Number(wl.getAttribute('href').slice('#note-'.length))); }
  });

  // Search via the existing FTS endpoint; falls back to the full list when cleared.
  let t;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = search.value.trim();
      if (!q) return renderList(notes);
      const { results } = await api('/api/memory?q=' + encodeURIComponent(q));
      renderList(results.map(r => ({ id: r.id, title: r.title })));
    }, 250);
  });

  if (notes.length) loadNote(notes[0].id);
});
```

- [ ] **Step 3: Verify at runtime (browser)**

Run: `npm run dashboard` then open `http://localhost:7700/index-v2.html#/atlas`.
Expected:
- The note list renders; selecting a note shows rendered markdown in the reading column.
- `[[wikilinks]]` to existing notes are underlined and clicking one loads that note in place; dangling links render as plain text.
- The Backlinks panel lists referring notes; clicking one navigates.
- The local graph renders in the graph pane (center node highlighted).
- Typing in the search box filters the list via `/api/memory`; clearing restores the full list.
Stop the server afterward.

- [ ] **Step 4: Commit**

```bash
git add .claude/helpers/dashboard/js/atlas.js .claude/helpers/dashboard/index-v2.html
git commit -m "feat(atlas): live Quartz-styled Atlas view (reading + backlinks + graph + search)"
```

---

## Self-Review

**1. Spec coverage (Phase 1 scope):**
- brain-notes core over `memory_entries` + `[[wikilink]]` extraction → Tasks 1-3. ✓
- Vendored `markdown-it` → Task 5. ✓
- `GET /api/notes` + `GET /api/notes/:id` → Task 4. ✓
- Quartz-styled Atlas SPA view (reading column + backlinks + local Cytoscape graph + search via existing FTS endpoint) → Task 6. ✓
- Reuse: `db.cjs` (Tasks 1-3), vendored Cytoscape (Task 6), `/api/memory` search (Task 6). ✓
- Deferred: Excalidraw (Phase 2), static export (Phase 3) — not present. ✓
- Note: `config/resolve.cjs` is not needed in Phase 1 (no new output paths until Phases 2/3); intentionally unused here.

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**3. Type consistency:** `Link = {name,id,dangling}` and `Ref = {id,source,title}` are used consistently across `resolveLinks`/`getBacklinks`/`getLocalGraph`/`getNote` and the `atlas.js` consumer; node ids are strings everywhere they reach Cytoscape; endpoint shapes match what `atlas.js` reads (`notes`, `note`, `localGraph`, `results`). ✓
