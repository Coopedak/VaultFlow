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
 *   vaultflow find-skill <task> [--json] [--limit N]
 *   vaultflow context [project]   [--json]
 *   vaultflow graph [--center id] [--depth N] [--json]
 *   vaultflow mission             [--json]
 *   vaultflow flows discover|list [project] [--json]
 *   vaultflow flows declare <file> <symbol> [--name N] [--project P] [--json]
 *   vaultflow flows declared [project] [--json]
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
const VALUE_FLAGS = new Set(['--center', '--depth', '--limit', '--project', '--symbol', '--name']);
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
  process.stderr.write('Usage: vaultflow <search|find-skill|context|graph|mission|flows|impact> [args] [--json]\n');
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
    case 'find-skill': {
      const q = positional.join(' ').trim();
      if (!q) usage(1);
      const limit = Number(flagVal('--limit')) || 20;
      const skillReuse = require('../.claude/helpers/skill-reuse.cjs');
      const rows   = db.searchVaultAgents(q, limit);
      const scored = skillReuse.scoreSkillRows(q, rows);
      out(scored, (rs) => {
        if (!rs.length) return `No existing skills matched "${q}".\nNo strong match — OK to build new.`;
        const noStrong = rs.every(r => r.verdict === 'BUILD-NEW-OK');
        const lines = rs.map(r => `[${r.verdict}] ${r.name} (${r.source})${r.description ? ` — ${String(r.description).slice(0, 160)}` : ''}`);
        return lines.join('\n') + (noStrong ? '\n\nNo strong match — OK to build new.' : '');
      });
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
    case 'flows': {
      // Flow catalog. Subcommands: `discover [project]` traces flows from entry
      // points; `list [project]` shows the cataloged flows. Flows are
      // APPROXIMATE (bare-name call resolution) — output says so.
      const fc = require('../.claude/helpers/flow-catalog.cjs');
      const action = positional[0] || 'list';
      // Default project = cwd basename (matches how project-id resolves names).
      const project = positional[1] || path.basename(process.cwd());

      if (action === 'discover') {
        const summary = fc.discoverFlows(db, project, {});
        const conf = (c) => (c == null ? '?' : `${Math.round(c * 100)}%`);
        out(summary, (s) =>
          `Flow discovery for ${s.project} (APPROXIMATE — bare-name call graph):\n` +
          `  entry points: ${s.entryPoints}\n` +
          `  created: ${s.flowsCreated}  updated: ${s.flowsUpdated}  dup-skipped: ${s.flowsSkippedDup}  low-quality-skipped: ${s.flowsSkippedLowQuality}  pruned: ${s.flowsPruned}  truncated: ${s.truncatedCount}\n` +
          (s.flows.length ? s.flows.map(f => `  • ${f.name}  [${f.nodes} nodes, conf ${conf(f.confidence)}${f.truncated ? ', truncated' : ''}]`).join('\n') : '  (no flows discovered)')
        );
      } else if (action === 'list') {
        const rows = db.listFlows(positional[1] || null);
        const conf = (c) => (c == null ? '?' : `${Math.round(c * 100)}%`);
        out(rows, (rs) => rs.length
          ? `Flows (APPROXIMATE — bare-name call graph):\n` +
            rs.map(r => `  • ${r.name}  [${r.source}/${r.status}, ${r.node_count} nodes, conf ${conf(r.confidence)}${r.truncated ? ', truncated' : ''}]  ${r.entry_point || ''}`).join('\n')
          : 'No flows cataloged. Run: vaultflow flows discover [project]');
      } else if (action === 'declare') {
        // Register a user-declared entry point (the RECALL FLOOR) and trace it
        // immediately. `flows declare <file> <symbol> [--name N] [--project P]`.
        // Reuses the full discovery path so the new declared entry is traced the
        // same way nightly would, then surfaces the resulting flow.
        const declProject = flagVal('--project') || path.basename(process.cwd());
        const file   = positional[1];
        const symbol = positional[2];
        if (!file || !symbol) {
          process.stderr.write('Usage: vaultflow flows declare <file> <symbol> [--name N] [--project P] [--json]\n');
          process.exit(1);
        }
        const reg = db.addDeclaredEntry({ project: declProject, file, symbol, name: flagVal('--name') });
        // discoverFlows auto-loads declared entries from the DB and traces them.
        fc.discoverFlows(db, declProject, {});
        // The traced flow's id is derived from (project, file, symbol) — fetch it.
        const flowId = fc.flowIdFor(declProject, { file, name: symbol });
        const full = db.getFlow(flowId);
        const conf = (c) => (c == null ? '?' : `${Math.round(c * 100)}%`);
        out({ declared: reg, flow: full ? full.flow : null, nodes: full ? full.nodes.length : 0, edges: full ? full.edges.length : 0 }, (r) => {
          if (!r.flow) {
            return `Declared entry registered (${reg.created ? 'new' : 'updated'}) but no flow was produced.\n` +
              `  ${file}::${symbol} in ${declProject}\n` +
              `  (The trace resolved to nothing — the declaration persists as the recall floor and will re-trace nightly.)`;
          }
          const f = r.flow;
          return `Declared entry ${reg.created ? 'registered' : 'updated'} and traced (${declProject}):\n` +
            `  • ${f.name}  [${f.source}/${f.status}, ${r.nodes} nodes, conf ${conf(f.confidence)}${f.truncated ? ', truncated' : ''}]\n` +
            `    entry: ${f.entry_point}`;
        });
      } else if (action === 'declared') {
        // List user-declared entry points (recall floor) for a project.
        const rows = db.listDeclaredEntries(positional[1] || null);
        out(rows, (rs) => rs.length
          ? `Declared entry points (recall floor):\n` +
            rs.map(r => `  • ${r.name || r.symbol}  [${r.project}]  ${r.file}::${r.symbol}`).join('\n')
          : 'No declared entry points. Add one: vaultflow flows declare <file> <symbol> [--project P]');
      } else {
        process.stderr.write('Usage: vaultflow flows <discover|list|declare|declared> [args] [--json]\n');
        process.exit(1);
      }
      break;
    }
    case 'impact': {
      // Change-impact report for a file or symbol. The positional target is
      // treated as a file path if it looks like one (has a slash or a known
      // source extension), otherwise as a bare symbol name. --symbol/--project
      // override. Output is APPROXIMATE — the engine says so.
      const fi = require('../.claude/helpers/flow-impact.cjs');
      const raw = positional.join(' ').trim();
      const explicitSymbol = flagVal('--symbol');
      const project = flagVal('--project') || path.basename(process.cwd());
      if (!raw && !explicitSymbol) usage(1);
      const looksLikeFile = /[\\/]/.test(raw) || /\.(ts|tsx|js|jsx|mjs|cjs|cs|py)$/i.test(raw);
      const opts = {
        project,
        mode: flagVal('--debug') ? 'debug' : 'impact',
        file: looksLikeFile ? raw : null,
        symbol: explicitSymbol || (looksLikeFile ? null : raw),
      };
      const rep = fi.analyzeImpact(db, opts);
      out(rep, (r) => fi.renderImpact(r));
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
