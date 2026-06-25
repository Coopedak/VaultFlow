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
      ('a.md', 'C/D Title', 'Has a slashy title.', 't'),
      ('a.md', 'Danger <img src=x onerror=alert(1)>', 'XSS title body.', 't');
  `);
  return root;
}
function outTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vf-out-')); }

test('exportQuartz writes index, a page per note, and assets', () => {
  freshDb();
  const out = outTmp();
  const r = exportQuartz({ outDir: out });
  assert.equal(r.pages, 4);
  assert.ok(fs.existsSync(path.join(out, 'index.html')));
  assert.ok(fs.existsSync(path.join(out, 'assets', 'markdown-it.min.js')));
  assert.ok(fs.existsSync(path.join(out, 'assets', 'quartz.css')));
  const htmls = fs.readdirSync(out).filter(f => f.endsWith('.html'));
  assert.equal(htmls.length, 5); // index + 4 notes
});

test('internal wikilinks resolve to existing relative .html files; dangling do not', () => {
  freshDb();
  const out = outTmp();
  exportQuartz({ outDir: out });
  // Find Alpha's page and inspect the preprocessed body embedded in vf-data.
  // WHY: wikilink substitution now happens in Node (preprocessBody), so the
  // embedded body must contain a markdown link for resolved targets and plain
  // text for dangling ones — no [[…]] tokens or client-side regex needed.
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
  // Resolved link: [[Beta]] → [Beta](./beta.html) in the preprocessed body.
  assert.ok(/\[Beta\]\(\.\/[^)]+\.html\)/.test(data.body), 'resolved [[Beta]] wikilink in preprocessed body');
  // Verify the target .html file actually exists.
  const betaHref = data.body.match(/\[Beta\]\((\.\/[^)]+\.html)\)/)[1];
  assert.ok(fs.existsSync(path.join(out, betaHref.replace(/^\.\//, ''))), 'Beta page file exists');
  // Dangling link: [[Ghost]] → plain text "Ghost" (no link markup, no [[…]]).
  assert.ok(!data.body.includes('[[Ghost]]'), 'dangling [[Ghost]] removed from body');
  assert.ok(!data.body.includes('](./ghost'), 'no spurious link for dangling Ghost');
});

test('note titles are HTML-escaped in the static page', () => {
  freshDb();
  const out = outTmp();
  exportQuartz({ outDir: out });
  const allHtmls = fs.readdirSync(out).filter(f => f.endsWith('.html')).map(f => ({
    name: f, html: fs.readFileSync(path.join(out, f), 'utf8'),
  }));

  // Slashy title renders without breaking markup.
  assert.ok(allHtmls.find(({ html }) => html.includes('C/D Title')), 'slashy-title page rendered');

  // index lists titles escaped — no raw <script> from any title
  const idx = allHtmls.find(({ name }) => name === 'index.html').html;
  assert.ok(!/<script>x<\/script>/.test(idx.replace(/<script[\s\S]*?<\/script>/g, ''))); // no stray injected script outside script blocks

  // Angle-bracket title is HTML-escaped: raw `<img` must not appear outside script blocks
  // in either the note's own page or in the index listing.
  const dangerPage = allHtmls.find(({ html }) => html.includes('&lt;img'));
  assert.ok(dangerPage, 'XSS title rendered as escaped HTML entity on its note page');
  // The escaped form must be present in the <h1> and <title> regions (not raw).
  assert.ok(dangerPage.html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'full escaped title present in note page');
  // Raw angle-bracket injection must not appear in the note page (outside script blocks).
  const notePageNoScripts = dangerPage.html.replace(/<script[\s\S]*?<\/script>/g, '');
  assert.ok(!/<img src=x onerror=/.test(notePageNoScripts), 'raw XSS title not present in note page markup');
  // Index page must also escape the title.
  assert.ok(idx.includes('&lt;img src=x onerror=alert(1)&gt;'), 'XSS title escaped in index listing');
  const idxNoScripts = idx.replace(/<script[\s\S]*?<\/script>/g, '');
  assert.ok(!/<img src=x onerror=/.test(idxNoScripts), 'raw XSS title not present in index markup');
});

test('slugs are deterministic and collision-safe', () => {
  freshDb();
  const out1 = outTmp(); exportQuartz({ outDir: out1 });
  const out2 = outTmp(); exportQuartz({ outDir: out2 });
  const a = fs.readdirSync(out1).sort();
  const b = fs.readdirSync(out2).sort();
  assert.deepEqual(a, b); // same filenames across runs
});
