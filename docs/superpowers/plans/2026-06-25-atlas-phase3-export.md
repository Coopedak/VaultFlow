# Atlas Phase 3 — Static Quartz export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `npm run export:quartz [outDir]` emits a portable, offline, Quartz-style static HTML site from the brain — one page per note + an index — reusing the Phase 1 `brain-notes.cjs` core.

**Architecture:** `export-quartz.mjs` (ESM) walks `brain-notes.listNotes`/`getNote`, computes a deterministic `id → slug` map, and writes one `<slug>.html` per note + `index.html` + copied assets. Markdown is rendered **client-side** in each page by the copied vendored `markdown-it.min.js` (byte-parity with the live Atlas view, zero new deps, no Node-side UMD require). Wikilink targets are resolved to **relative** `./<slug>.html` in Node (testable) and embedded per page; the page's small inline script substitutes `[[name]]` → relative link and renders. Backlinks are emitted as static relative links. Output works offline (all assets vendored locally).

**Tech Stack:** Node 22+, `brain-notes.cjs` (Phase 1), vendored `markdown-it.min.js`. Tests: `node:test`.

## Global Constraints

- Node 22+; `export-quartz.mjs` is ESM (like `flows-draw.mjs`); `createRequire` for the CJS `brain-notes.cjs`.
- **No new npm dependencies.** Only `node:` builtins + `brain-notes.cjs` + the already-vendored `markdown-it.min.js` (copied into the export's `assets/`).
- **No Node-side markdown rendering** (the vendored lib is a browser UMD; under `"type":"module"` it can't be `require`d cleanly). Rendering happens client-side in the emitted pages via the copied `markdown-it.min.js` — same renderer as the live view.
- **Wikilink + backlink resolution is done in Node** (so it's unit-testable): each note's `links`/`backlinks` get a precomputed relative `href` (`./<target-slug>.html`); dangling links carry no href.
- **XSS:** note titles and any server-sourced text placed into static HTML must be HTML-escaped in Node; the client render uses `markdownit({ html:false })`.
- Output default `dist/quartz/` (configurable via `outDir` arg/param); add `dist/` to `.gitignore`. Deterministic slugs with per-run collision dedup (stable across runs given stable `listNotes` order).
- Windows path-safe (`node:path`). Tests in `tests/*.test.mjs` via `node --test`. Commit after every task. Branch: `feat/atlas-phase3-export`.
- The interactive local graph is a live-view feature; the static export is the linked-reading experience (reading + backlinks + index). The graph is intentionally NOT in the static export (YAGNI) — noted as a possible future nicety.

## Reuse (from earlier phases — exact)

- `brain-notes.cjs` exports `{ listNotes, getNote, getBacklinks, getLocalGraph, resolveLinks, extractWikilinkTitles }`. `listNotes({limit,offset,source})` → `[{id,source,title,tags}]`. `getNote(id)` → `{id,source,title,body,tags, links:[{name,id,dangling}], backlinks:[{id,source,title}]}`.
- Vendored `markdown-it.min.js` at `.claude/helpers/dashboard/vendor/markdown-it.min.js` (browser UMD, global `markdownit`).
- Wikilink preprocess pattern (from `atlas.js`): `body.replace(/\[\[([^\]]+)\]\]/g, …)` mapping resolved names to links. For export the target is a relative `.html`, not `#note-<id>`.

## File Structure

- **Create** `.claude/helpers/export-quartz.mjs` — ESM exporter: `exportQuartz({outDir,project})` + CLI; helpers `slug`, `notePageHtml`, `indexHtml`, `QUARTZ_CSS`.
- **Create** `tests/exportQuartz.test.mjs` — fixture-DB tests of the Node-side output (files, link rewriting, escaping, determinism).
- **Modify** `package.json` — `"export:quartz"` script.
- **Modify** `.gitignore` — add `dist/`.

---

### Task 1: `export-quartz.mjs` exporter + npm + gitignore + tests

**Files:** Create `.claude/helpers/export-quartz.mjs`, `tests/exportQuartz.test.mjs`; Modify `package.json`, `.gitignore`

**Interfaces:**
- Consumes: `brain-notes.listNotes`, `brain-notes.getNote`; vendored `markdown-it.min.js` (copied, not required).
- Produces: `exportQuartz({ outDir?, project? }) -> { pages:number, outDir:string }`. Emits `<outDir>/index.html`, `<outDir>/<slug>.html` per note, `<outDir>/assets/markdown-it.min.js`, `<outDir>/assets/quartz.css`.

- [ ] **Step 1: Write the failing test**

```js
// tests/exportQuartz.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');
const { exportQuartz } = await import('../.claude/helpers/export-quartz.mjs');

function freshDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-export-'));
  try { db.close(); } catch {}
  db.initialize(root, 'vaultflow.db');
  db.raw().exec(`
    INSERT INTO memory_entries (source, title, body, tags) VALUES
      ('a.md', 'Alpha', 'Alpha links to [[Beta]] and [[Ghost]].', 't'),
      ('a.md', 'Beta',  'Beta body. <script>x</script> in text.',  't'),
      ('a.md', 'C/D Title', 'Has a slashy title.', 't');
  `);
  return root;
}
function outTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vf-out-')); }

test('exportQuartz writes index, a page per note, and assets', () => {
  freshDb();
  const out = outTmp();
  const r = exportQuartz({ outDir: out });
  assert.equal(r.pages, 3);
  assert.ok(fs.existsSync(path.join(out, 'index.html')));
  assert.ok(fs.existsSync(path.join(out, 'assets', 'markdown-it.min.js')));
  assert.ok(fs.existsSync(path.join(out, 'assets', 'quartz.css')));
  const htmls = fs.readdirSync(out).filter(f => f.endsWith('.html'));
  assert.equal(htmls.length, 4); // index + 3 notes
});

test('internal wikilinks resolve to existing relative .html files; dangling do not', () => {
  freshDb();
  const out = outTmp();
  exportQuartz({ outDir: out });
  // Find Alpha's page and read its embedded link data.
  const files = fs.readdirSync(out).filter(f => f.endsWith('.html') && f !== 'index.html');
  let alpha = null;
  for (const f of files) {
    const html = fs.readFileSync(path.join(out, f), 'utf8');
    if (html.includes('<h1>Alpha</h1>')) { alpha = html; break; }
  }
  assert.ok(alpha, 'Alpha page found');
  const m = alpha.match(/<script id="vf-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(m, 'embedded data block present');
  const data = JSON.parse(m[1]);
  const beta = data.links.find(l => l.name.toLowerCase() === 'beta');
  const ghost = data.links.find(l => l.name === 'Ghost');
  assert.ok(beta.href && beta.href.endsWith('.html'));
  assert.ok(fs.existsSync(path.join(out, beta.href.replace(/^\.\//, '')))); // target file exists
  assert.equal(ghost.href, null); // dangling → no href
});

test('note titles are HTML-escaped in the static page', () => {
  freshDb();
  const out = outTmp();
  exportQuartz({ outDir: out });
  // Beta has a script tag in its BODY (rendered client-side, not asserted here);
  // assert the page TITLE/headings never inject raw HTML — check a title with special chars.
  const slashy = fs.readdirSync(out).map(f => fs.readFileSync(path.join(out, f), 'utf8'))
    .find(h => h.includes('C/D Title'));
  assert.ok(slashy, 'slashy-title page rendered');
  // index lists titles escaped — no raw <script> from any title
  const idx = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.ok(!/<script>x<\/script>/.test(idx.replace(/<script[\s\S]*?<\/script>/g, ''))); // no stray injected script outside script blocks
});

test('slugs are deterministic and collision-safe', () => {
  freshDb();
  const out1 = outTmp(); exportQuartz({ outDir: out1 });
  const out2 = outTmp(); exportQuartz({ outDir: out2 });
  const a = fs.readdirSync(out1).sort();
  const b = fs.readdirSync(out2).sort();
  assert.deepEqual(a, b); // same filenames across runs
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/exportQuartz.test.mjs`
Expected: FAIL — cannot find module `export-quartz.mjs`.

- [ ] **Step 3: Write the implementation**

```js
// .claude/helpers/export-quartz.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const notes = require('./brain-notes.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VENDOR_MD = path.join(__dirname, 'dashboard', 'vendor', 'markdown-it.min.js');

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'note';
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const QUARTZ_CSS = `
:root{--bg:#161618;--panel:#1e1e22;--text:#e6e6ea;--muted:#9aa0aa;--accent:#6ab;--border:#2a2a32}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,Segoe UI,system-ui,sans-serif}
.note{max-width:760px;margin:0 auto;padding:32px 20px}.back{margin-bottom:16px}
a{color:var(--accent)}a.dangling{color:var(--muted);border-bottom:1px dashed var(--muted);text-decoration:none}
h1{margin:.2em 0 .6em}article :is(pre,code){background:var(--panel);border-radius:6px}article pre{padding:12px;overflow:auto}
.backlinks{margin-top:32px;border-top:1px solid var(--border);padding-top:12px}.backlinks h4{color:var(--muted);text-transform:uppercase;font-size:12px;margin:0 0 8px}
.backlinks a{display:block;padding:2px 0}.index-list a{display:block;padding:4px 0}.src{color:var(--muted);font-size:12px}
`;

function notePageHtml(note, hrefById) {
  const links = (note.links || []).map(l => ({
    name: l.name, dangling: !!l.dangling,
    href: (!l.dangling && hrefById.has(l.id)) ? hrefById.get(l.id) : null,
  }));
  const backlinks = (note.backlinks || [])
    .filter(b => hrefById.has(b.id))
    .map(b => `<a href="${esc(hrefById.get(b.id))}">${esc(b.title)}</a>`).join('') || '<span class="src">None</span>';
  const data = JSON.stringify({ body: note.body || '', links });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(note.title)} — Atlas</title>
<link rel="stylesheet" href="assets/quartz.css">
<script src="assets/markdown-it.min.js"></script></head>
<body><main class="note">
<nav class="back"><a href="index.html">&larr; Index</a></nav>
<h1>${esc(note.title)}</h1>
<article id="vf-body"></article>
<aside class="backlinks"><h4>Backlinks</h4>${backlinks}</aside>
</main>
<script id="vf-data" type="application/json">${data.replace(/</g, '\\u003c')}</script>
<script>
(function(){
  var data = JSON.parse(document.getElementById('vf-data').textContent);
  var md = window.markdownit({ html:false, linkify:true, breaks:false });
  var map = new Map(data.links.filter(function(l){return l.href;}).map(function(l){return [l.name.toLowerCase(), l.href];}));
  var pre = String(data.body).replace(/\\[\\[([^\\]]+)\\]\\]/g, function(_, raw){
    var n = raw.trim(); var h = map.get(n.toLowerCase());
    return h ? '['+n+']('+h+')' : n;
  });
  document.getElementById('vf-body').innerHTML = md.render(pre);
})();
</script></body></html>`;
}

function indexHtml(items) {
  const rows = items.map(it => `<a href="${esc(it.href)}">${esc(it.title)} <span class="src">${esc(it.source)}</span></a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atlas — Index</title><link rel="stylesheet" href="assets/quartz.css"></head>
<body><main class="note"><h1>Atlas — ${items.length} notes</h1>
<div class="index-list">${rows}</div></main></body></html>`;
}

export function exportQuartz({ outDir = path.join(REPO_ROOT, 'dist', 'quartz'), project = null } = {}) {
  notes.initialize ? notes.initialize() : null; // brain-notes calls db.initialize internally; harmless guard
  const headers = notes.listNotes({ limit: 100000, project });
  // Deterministic id->slug with per-run collision dedup (stable given stable listNotes order).
  const hrefById = new Map();
  const used = new Set();
  for (const h of headers) {
    let base = slug(h.title), n = 2, cand = base;
    while (used.has(cand)) { cand = `${base}-${n++}`; }
    used.add(cand);
    hrefById.set(h.id, `./${cand}.html`);
  }
  fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
  fs.copyFileSync(VENDOR_MD, path.join(outDir, 'assets', 'markdown-it.min.js'));
  fs.writeFileSync(path.join(outDir, 'assets', 'quartz.css'), QUARTZ_CSS.trim());
  let pages = 0;
  const indexItems = [];
  for (const h of headers) {
    const note = notes.getNote(h.id);
    if (!note) continue;
    const rel = hrefById.get(h.id);                 // './slug.html'
    const file = path.join(outDir, rel.replace(/^\.\//, ''));
    fs.writeFileSync(file, notePageHtml(note, hrefById));
    indexItems.push({ title: note.title, source: note.source, href: rel.replace(/^\.\//, '') });
    pages++;
  }
  fs.writeFileSync(path.join(outDir, 'index.html'), indexHtml(indexItems));
  return { pages, outDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outArg = process.argv[2];
  const r = exportQuartz(outArg ? { outDir: path.resolve(outArg) } : {});
  console.log(`export:quartz — ${r.pages} page(s) → ${r.outDir}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/exportQuartz.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Add npm script** — in `package.json`, next to the other helper commands:

```json
"export:quartz": "node .claude/helpers/export-quartz.mjs",
```

- [ ] **Step 6: Add `dist/` to `.gitignore`** — append:

```
# static exports (regenerable via npm run export:quartz)
dist/
```

- [ ] **Step 7: Verify at runtime against the live brain**

Run:
```bash
npm run export:quartz
node -e "const fs=require('fs'),p=require('path');const d=p.join('dist','quartz');const n=fs.readdirSync(d).filter(f=>f.endsWith('.html')).length;console.log('html pages:',n);['index.html','assets/markdown-it.min.js','assets/quartz.css'].forEach(f=>console.log(f, fs.existsSync(p.join(d,f))))"
git status --porcelain dist
```
Expected: prints N html pages (live brain has ~50+ notes), `index.html`/assets all `true`, and `git status` shows nothing for `dist/` (gitignored). Open `dist/quartz/index.html` in a browser is optional (controller will spot-check).

- [ ] **Step 8: Commit**

```bash
git add .claude/helpers/export-quartz.mjs tests/exportQuartz.test.mjs package.json .gitignore
git commit -m "feat(atlas): static Quartz export (export:quartz) — per-note pages + index, offline"
```

---

## Self-Review

**1. Spec coverage (Phase 3):** static HTML export reusing the Phase 1 core (`brain-notes.listNotes`/`getNote`) ✓; one page per note + index ✓; cross-links rewritten relative (Node-computed `href`, client substitutes) ✓; portable/offline (vendored `markdown-it` + css copied; no external refs) ✓; configurable `outDir` (param + CLI arg; default `dist/quartz/`) ✓; `npm run export:quartz` ✓; `dist/` gitignored ✓; tests ✓. Phase 2 untouched.

**2. Placeholder scan:** complete code in every step; commands + expected output present; no TBD/TODO. The interactive local graph is intentionally out of scope (stated in Global Constraints), not a placeholder.

**3. Type consistency:** `hrefById` is `Map<id, './slug.html'>` used uniformly for links, backlinks, and index; `exportQuartz` returns `{pages,outDir}` as the CLI + tests consume; note shape (`{title,body,source,links:[{name,id,dangling}],backlinks:[{id,source,title}]}`) matches `brain-notes.getNote` from Phase 1; `esc()` applied to every Node-emitted title/source; client render uses `markdownit({html:false})` for body safety.
