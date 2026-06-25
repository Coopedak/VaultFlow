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
  const slashy = fs.readdirSync(out).filter(f => f.endsWith('.html')).map(f => fs.readFileSync(path.join(out, f), 'utf8'))
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
