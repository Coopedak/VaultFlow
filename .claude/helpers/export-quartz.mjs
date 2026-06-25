// .claude/helpers/export-quartz.mjs
//
// WHY: Static Quartz-style HTML export for the Atlas brain view. Emits one
// page per memory_entry note + an index page, with wikilinks resolved to
// relative .html paths in Node (testable) and markdown rendered client-side
// via the vendored markdown-it.min.js (zero new deps, offline-capable output).
//
// Consumes: brain-notes.cjs (Phase 1) — listNotes + getNote
// Produces: outDir/index.html, outDir/<slug>.html per note, outDir/assets/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const notes = require('./brain-notes.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VENDOR_MD = path.join(__dirname, 'dashboard', 'vendor', 'markdown-it.min.js');

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Deterministic slug from a title: lowercase, non-alphanum → hyphen, max 80 chars.
 * WHY: stable filenames across runs given stable listNotes order.
 */
export function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'note';
}

/**
 * HTML-escape a string for safe Node-side embedding in static pages.
 * WHY: titles and source paths come from user data; must not inject markup.
 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Minimal dark Quartz-style CSS — inlined into assets/quartz.css.
// WHY: zero external requests; works offline. Mirrors the Atlas live-view palette.
const QUARTZ_CSS = `
:root{--bg:#161618;--panel:#1e1e22;--text:#e6e6ea;--muted:#9aa0aa;--accent:#6ab;--border:#2a2a32}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,Segoe UI,system-ui,sans-serif}
.note{max-width:760px;margin:0 auto;padding:32px 20px}.back{margin-bottom:16px}
a{color:var(--accent)}a.dangling{color:var(--muted);border-bottom:1px dashed var(--muted);text-decoration:none}
h1{margin:.2em 0 .6em}article :is(pre,code){background:var(--panel);border-radius:6px}article pre{padding:12px;overflow:auto}
.backlinks{margin-top:32px;border-top:1px solid var(--border);padding-top:12px}.backlinks h4{color:var(--muted);text-transform:uppercase;font-size:12px;margin:0 0 8px}
.backlinks a{display:block;padding:2px 0}.index-list a{display:block;padding:4px 0}.src{color:var(--muted);font-size:12px}
`.trim();

// ── Page generators ───────────────────────────────────────────────────────

/**
 * Generate one note page.
 *
 * WHY for the vf-data script block: wikilink hrefs are precomputed in Node
 * (testable, deterministic) and embedded as JSON. The inline script only
 * substitutes [[name]] → relative link before handing off to markdown-it.
 * This keeps XSS surface contained: body renders via markdownit({html:false}),
 * JSON data escapes `<` to `<` so an embedded `</script>` in body can't
 * break out of the data block.
 *
 * @param {object} note — getNote() result
 * @param {Map<number,string>} hrefById — id → './slug.html'
 * @returns {string} full HTML page
 */
export function notePageHtml(note, hrefById) {
  const links = (note.links || []).map(l => ({
    name: l.name, dangling: !!l.dangling,
    href: (!l.dangling && hrefById.has(l.id)) ? hrefById.get(l.id) : null,
  }));
  const backlinks = (note.backlinks || [])
    .filter(b => hrefById.has(b.id))
    .map(b => `<a href="${esc(hrefById.get(b.id))}">${esc(b.title)}</a>`).join('') || '<span class="src">None</span>';
  // Escape `<` in JSON so an embedded `</script>` in note body can't break the data block.
  const data = JSON.stringify({ body: note.body || '', links }).replace(/</g, '\\u003c');
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
<script id="vf-data" type="application/json">${data}</script>
<script>
(function(){
  var data = JSON.parse(document.getElementById('vf-data').textContent);
  var md = window.markdownit({ html:false, linkify:true, breaks:false });
  var map = new Map(data.links.filter(function(l){return l.href;}).map(function(l){return [l.name.toLowerCase(), l.href];}));
  var pre = String(data.body).replace(/\[\[([^\]]+)\]\]/g, function(_, raw){
    var n = raw.trim(); var h = map.get(n.toLowerCase());
    return h ? '['+n+']('+h+')' : n;
  });
  document.getElementById('vf-body').innerHTML = md.render(pre);
})();
</script></body></html>`;
}

/**
 * Generate the index page listing all notes.
 * @param {Array<{title:string, source:string, href:string}>} items
 * @returns {string} full HTML page
 */
export function indexHtml(items) {
  const rows = items.map(it =>
    `<a href="${esc(it.href)}">${esc(it.title)} <span class="src">${esc(it.source)}</span></a>`
  ).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atlas — Index</title><link rel="stylesheet" href="assets/quartz.css"></head>
<body><main class="note"><h1>Atlas — ${items.length} notes</h1>
<div class="index-list">${rows}</div></main></body></html>`;
}

// ── Main export ───────────────────────────────────────────────────────────

/**
 * Export the brain as a static Quartz-style HTML site.
 *
 * WHY default outDir is dist/quartz/ (under dist/, which is gitignored):
 * regenerable at any time via `npm run export:quartz`; no reason to commit.
 *
 * @param {object} [opts]
 * @param {string} [opts.outDir] — output directory (default: dist/quartz/)
 * @param {string|null} [opts.project] — filter by project name (passed to listNotes)
 * @returns {{ pages: number, outDir: string }}
 */
export function exportQuartz({ outDir = path.join(REPO_ROOT, 'dist', 'quartz'), project = null } = {}) {
  // brain-notes calls db.initialize() internally via ensure(); the guard below
  // is harmless (brain-notes has no initialize export) — included per plan for clarity.
  notes.initialize ? notes.initialize() : null;

  const headers = notes.listNotes({ limit: 100000, ...(project ? { project } : {}) });

  // Build deterministic id→slug map with per-run collision dedup.
  // WHY: stable filenames across runs given stable listNotes order.
  const hrefById = new Map();
  const used = new Set();
  for (const h of headers) {
    let base = slug(h.title), n = 2, cand = base;
    while (used.has(cand)) { cand = `${base}-${n++}`; }
    used.add(cand);
    hrefById.set(h.id, `./${cand}.html`);
  }

  // Ensure output directories exist.
  fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });

  // Copy vendored markdown-it (browser UMD — not required in Node, copied verbatim).
  fs.copyFileSync(VENDOR_MD, path.join(outDir, 'assets', 'markdown-it.min.js'));
  fs.writeFileSync(path.join(outDir, 'assets', 'quartz.css'), QUARTZ_CSS);

  // Emit one page per note.
  let pages = 0;
  const indexItems = [];
  for (const h of headers) {
    const note = notes.getNote(h.id);
    if (!note) continue;
    const rel = hrefById.get(h.id); // './slug.html'
    const file = path.join(outDir, rel.replace(/^\.\//, ''));
    fs.writeFileSync(file, notePageHtml(note, hrefById));
    indexItems.push({ title: note.title, source: note.source, href: rel.replace(/^\.\//, '') });
    pages++;
  }

  // Emit index page.
  fs.writeFileSync(path.join(outDir, 'index.html'), indexHtml(indexItems));

  return { pages, outDir };
}

// ── CLI entry point ───────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outArg = process.argv[2];
  const r = exportQuartz(outArg ? { outDir: path.resolve(outArg) } : {});
  console.log(`export:quartz — ${r.pages} page(s) → ${r.outDir}`);
}
