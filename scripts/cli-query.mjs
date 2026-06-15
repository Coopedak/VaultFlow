#!/usr/bin/env node
/**
 * cli-query.mjs — in-process vaultflow data queries for the `vaultflow` bin.
 *
 * WHY: db.cjs has no CLI entry of its own (it's a pure data layer). This thin
 * module imports it once, runs ONE query, prints text (default) or JSON
 * (--json), and exits. It's what makes vaultflow's brain reachable headlessly
 * by Codex / Copilot / cron / shell — the wayland-core-style entry point.
 *
 * Usage:
 *   vaultflow search <query> [--json] [--limit N]
 *   vaultflow context [project]   [--json]
 *   vaultflow graph [--center id] [--depth N] [--json]
 *   vaultflow mission             [--json]
 *   vaultflow doctor              (delegates to doctor.mjs)
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = require('../.claude/helpers/db.cjs');

const argv = process.argv.slice(2);
const sub  = argv[0];

// Single-pass argv parser: --json is a boolean flag; --center/--depth/--limit
// each consume the following token as their value; everything else after the
// subcommand is a positional term (e.g. the words of a `search <terms>` query).
// Using indexOf() to map values back to flags is unsafe when a positional term
// repeats or collides with a flag value, so we walk the array once instead.
const VALUE_FLAGS = new Set(['--center', '--depth', '--limit']);
const flags = {};         // flag name -> value (string) or true (boolean)
const positional = [];    // non-flag terms after the subcommand
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') { flags['--json'] = true; }
  else if (VALUE_FLAGS.has(a)) { flags[a] = argv[i + 1] ?? null; i++; }
  else if (a.startsWith('--')) { flags[a] = true; }
  else { positional.push(a); }
}
const JSON_OUT = flags['--json'] === true;
const flagVal = (name) => (name in flags ? flags[name] : null);

function out(obj, textFn) {
  if (JSON_OUT) process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  else process.stdout.write(textFn(obj) + '\n');
}
function usage(code) {
  process.stderr.write('Usage: vaultflow <search|context|graph|mission> [args] [--json]\n');
  process.exit(code);
}

try {
  // metrics root override for tests / explicit targeting
  const root = process.env.VAULTFLOW_METRICS_ROOT || null;
  db.initialize(root, null);

  switch (sub) {
    case 'search': {
      const q = positional.join(' ').trim();
      if (!q) usage(1);
      const limit = Number(flagVal('--limit')) || 10;
      const rows = db.searchMemory(q, limit);
      out(rows, (rs) => rs.length ? rs.map(r => `• ${r.title}  [${r.source}]\n  ${String(r.body || '').slice(0, 160)}`).join('\n') : 'No results.');
      break;
    }
    case 'context': {
      const intel = require('../.claude/helpers/intelligence.cjs');
      const items = intel.getContext(positional.join(' ') || 'current project context');
      out(items, (xs) => xs.length ? xs.map(i => `## ${i.title} [${i.source}]\n${i.body}`).join('\n\n') : 'No context.');
      break;
    }
    case 'graph': {
      const g = db.getBrainGraph({ center: flagVal('--center'), depth: Number(flagVal('--depth')) || 1, limit: Number(flagVal('--limit')) || 150 });
      out(g, (gr) => `${gr.meta.mode}: ${gr.meta.nodeCount} nodes, ${gr.meta.edgeCount} edges\n` +
        gr.nodes.slice(0, 30).map(n => `  [${n.type}] ${n.label} (w=${n.weight})`).join('\n'));
      break;
    }
    case 'mission': {
      const mc = db.getMissionControl();
      out(mc, (m) => `Mission Control @ ${m.generatedAt}\n` +
        Object.entries(m.counts).filter(([, n]) => n > 0).map(([s, n]) => `  ${s}: ${n}`).join('\n') + '\n' +
        m.entries.slice(0, 20).map(e => `  [${e.status}] ${e.title} — ${e.detail}`).join('\n'));
      break;
    }
    case 'doctor': {
      // delegate: doctor.mjs is a standalone script; spawn it with inherited stdio
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync(process.execPath, [path.join(__dirname, '..', '.claude', 'helpers', 'doctor.mjs'), ...argv.slice(1)], { stdio: 'inherit' });
      process.exit(r.status ?? 0);
      break;
    }
    default:
      usage(1);
  }
  db.close();
} catch (err) {
  process.stderr.write(`[vaultflow] ${sub || '(none)'}: ${err.message}\n`);
  process.exit(1);
}
