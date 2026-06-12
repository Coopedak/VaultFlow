# Data Brain — Phase 4: `vaultflow` Core CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make vaultflow's brain available headlessly to any tool (Codex, Copilot, cron, shell scripts) the way wayland-core is for Wayland — one bin with query subcommands (`vaultflow search|context|graph|mission`), reusing logic that already exists. No new intelligence.

**Architecture:** The `vaultflow`/`vault` bin already exists (`scripts/cli.mjs`) and forwards process-spawn subcommands to helper scripts. `db.cjs` has no CLI entry, so the data-query subcommands need a thin in-process query module (`scripts/cli-query.mjs`) that imports `db.cjs`, runs one query, prints text or `--json`, and exits. `cli.mjs` gains a fast-path that runs query subcommands in-process and keeps forwarding the rest.

**Tech Stack:** Node ESM (`scripts/*.mjs`), CJS `db.cjs` via `createRequire`, `node --test`.

**Depends on:** Phase 1 (`getBrainGraph`) and Phase 3 (`getMissionControl`) for the `graph`/`mission` subcommands. `search`/`context` use existing functions and work standalone.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `scripts/cli-query.mjs` | In-process query dispatch: search/context/graph/mission/doctor; `--json` flag | Create |
| `scripts/cli.mjs` | Route query subcommands to `cli-query.mjs`; extend help text | Modify |
| `tests/cliQuery.test.mjs` | Smoke test each subcommand resolves + `--json` parses | Create |

---

## Task 1: `cli-query.mjs` — in-process query dispatch

**Files:**
- Create: `scripts/cli-query.mjs`
- Test: `tests/cliQuery.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/cliQuery.test.mjs`:

```javascript
/**
 * vaultflow query CLI — each subcommand resolves and --json parses.
 * Runs the real cli-query.mjs as a child against a seeded fixture DB.
 * Run: node --test tests/cliQuery.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

const QUERY = path.resolve('scripts/cli-query.mjs');

function seedRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-cli-'));
  db.close(); db.initialize(root, 'vaultflow.db');
  db.raw().exec(`
    INSERT INTO sessions (id, started_at, project) VALUES ('s1','2026-06-10T10:00:00Z','alpha');
    INSERT INTO memory_entries (source, title, body, tags) VALUES ('vault/x.md#1','Auth note','use bcrypt for hashing','security');
  `);
  db.close();
  return root;
}

function run(root, args) {
  return spawnSync(process.execPath, [QUERY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, VAULTFLOW_METRICS_ROOT: root },
    timeout: 15000,
  });
}

test('graph --json prints parseable {nodes,edges}', () => {
  const root = seedRoot();
  const r = run(root, ['graph', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const g = JSON.parse(r.stdout);
  assert.ok(Array.isArray(g.nodes) && Array.isArray(g.edges));
});

test('mission --json prints parseable ledger', () => {
  const root = seedRoot();
  const r = run(root, ['mission', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const mc = JSON.parse(r.stdout);
  assert.ok(Array.isArray(mc.entries));
});

test('search prints text results', () => {
  const root = seedRoot();
  const r = run(root, ['search', 'bcrypt']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Auth note|bcrypt/i);
});

test('unknown subcommand exits non-zero with usage', () => {
  const root = seedRoot();
  const r = run(root, ['frobnicate']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /unknown|usage/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cliQuery.test.mjs`
Expected: FAIL — `scripts/cli-query.mjs` does not exist (spawn error / non-zero).

- [ ] **Step 3: Create `scripts/cli-query.mjs`**

```javascript
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
const JSON_OUT = argv.includes('--json');
const flagVal = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const positional = argv.slice(1).filter(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--center' && argv[argv.indexOf(a) - 1] !== '--depth' && argv[argv.indexOf(a) - 1] !== '--limit');

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/cliQuery.test.mjs`
Expected: PASS (graph/mission/search/unknown).

> If `graph`/`mission` tests fail with "not a function", Phase 1 / Phase 3 db functions aren't merged yet. This plan depends on them — land Phases 1 and 3 first, or stub those two cases to print `{}` until they exist.

- [ ] **Step 5: Commit**

```bash
git add scripts/cli-query.mjs tests/cliQuery.test.mjs
git commit -m "feat(vaultflow): cli-query.mjs in-process query dispatch (search/context/graph/mission/doctor)"
```

---

## Task 2: Route query subcommands through `cli.mjs`

**Files:**
- Modify: `scripts/cli.mjs`

- [ ] **Step 1: Add a query fast-path**

In `scripts/cli.mjs`, after `const command = args[0] || 'tui';` and the help check, add a set of query commands that run `cli-query.mjs` in-process-style (still a child, but the query module) — insert before the `if (scriptKey === 'dict:import')` block:

```javascript
const QUERY_COMMANDS = new Set(['search', 'context', 'graph', 'mission', 'doctor']);
if (QUERY_COMMANDS.has(command)) {
  runNodeScript(path.join(ROOT, 'scripts', 'cli-query.mjs'), args, nodeArgs);
  return; // runNodeScript wires process.exit via child 'exit'
}
```

> `runNodeScript` is defined at module scope and calls `process.exit` from the child's `exit` handler; the `return` here is inside the top-level module body. If the surrounding code is not in a function, replace `return;` with wrapping the remainder in `else { ... }`. Confirm structure: the file currently runs top-level statements, so use the `else`-wrap form:
>
> ```javascript
> if (QUERY_COMMANDS.has(command)) {
>   runNodeScript(path.join(ROOT, 'scripts', 'cli-query.mjs'), args, nodeArgs);
> } else if (scriptKey === 'dict:import') {
>   runNodeScript(path.join(ROOT, '.claude', 'helpers', 'dict.mjs'), ['--import', ...forwardedArgs], nodeArgs);
> } else {
>   const segments = COMMANDS[scriptKey];
>   // ... existing unknown-command + runNodeScript logic ...
> }
> ```
>
> i.e. fold the existing `if (scriptKey === 'dict:import') {...} else {...}` into this `else if`/`else` chain.

- [ ] **Step 2: Extend the help text**

In `printHelp()`, add these lines to the Commands block (after `mcp-server`):

```javascript
    `\nQuery (headless brain access):\n` +
    `  search <query>    Search memory/symbols/commits (add --json)\n` +
    `  context [project] Show the context vaultflow would inject\n` +
    `  graph [--center]  Print the brain graph (add --json)\n` +
    `  mission           Mission Control ledger (add --json)\n` +
    `  doctor            Run the health audit\n`
```

- [ ] **Step 3: Manual verification**

Run: `node scripts/cli.mjs search "session" --limit 3`
Expected: text results (or "No results.").

Run: `node scripts/cli.mjs mission --json`
Expected: a JSON ledger object.

Run: `node scripts/cli.mjs --help`
Expected: help text now lists the Query commands.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/cli.mjs
git commit -m "feat(vaultflow): route search/context/graph/mission/doctor through the vaultflow bin"
```

---

## Task 3: Verify the installed bin works end-to-end

**Files:** none (verification only)

- [ ] **Step 1: Link and invoke the bin as a user would**

Run: `npm link` (registers the `vaultflow` + `vault` bins globally), then:
`vaultflow mission`
Expected: Mission Control text output. (If `npm link` is undesirable, run `node scripts/cli.mjs mission` instead and note that in the commit.)

- [ ] **Step 2: Confirm `--json` is machine-consumable**

Run: `node scripts/cli.mjs graph --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const g=JSON.parse(s);console.log('nodes',g.nodes.length)})"`
Expected: prints `nodes <N>` — proves the JSON is pipeable for Codex/Copilot/scripts.

- [ ] **Step 3: Unlink (cleanup, if linked)**

Run: `npm unlink` (only if Step 1 used `npm link`).
Expected: clean exit.

- [ ] **Step 4: Final commit (docs only, if README/CLAUDE.md mentions the CLI)**

If `CLAUDE.md`'s Run Commands section should list the new subcommands, add them under a "Headless brain access" note, then:

```bash
git add CLAUDE.md
git commit -m "docs(vaultflow): document headless vaultflow query subcommands"
```

---

## Self-Review

- **Spec coverage:** unified `vaultflow` bin (already exists; extended) ✓; `search`/`context`/`graph`/`mission`/`doctor` subcommands (Task 1) ✓; `--json` for machine consumers (Task 1, verified Task 3) ✓; thin argv router reusing existing logic, no new intelligence (Task 1 imports db.cjs/intelligence.cjs/doctor.mjs) ✓. The spec's `nightly`/`dict`/`flush` subcommands already exist in `cli.mjs`'s `COMMANDS` map (process-spawn forwards) — no work needed; only the data-query commands required the new in-process module.
- **Placeholder scan:** none. One structural note (fold the new branch into the existing `if/else` chain rather than using a bare `return`) is an explicit instruction with the exact replacement code, not a placeholder.
- **Type consistency:** `cli-query.mjs` calls `db.getBrainGraph({center,depth,limit})` and `db.getMissionControl()` with the exact signatures defined in the Phase 1 and Phase 3 plans; `db.searchMemory(q, limit)` matches the existing db.cjs signature; `intelligence.getContext(prompt)` matches its existing signature.
- **Cross-phase dependency** is stated at the top and re-flagged at Task 1 Step 4 so an out-of-order executor isn't surprised.
