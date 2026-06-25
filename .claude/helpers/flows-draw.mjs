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
