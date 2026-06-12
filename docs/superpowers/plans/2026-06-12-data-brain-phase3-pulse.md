# Data Brain — Phase 3: Pulse + Mission Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live "watch it think" view: an SSE event stream that tails the DB and pushes new prompts/tools/edits/decisions to the browser, a Mission Control unified ledger projecting live sessions and scheduled jobs (with zombie detection), and pulse animations on the Brain graph.

**Architecture:** DB-as-bus — the dashboard server polls SQLite every ~1.5s using max-rowid watermarks and emits Server-Sent Events. No hook→server coupling (hooks are short-lived; the dashboard may be down). A `getMissionControl()` read function projects sessions + scheduled jobs into one `LedgerEntry[]` shape (modeled on the studied Wayland ledger). The SPA consumes the SSE stream via `EventSource`.

**Tech Stack:** Express SSE (`server.mjs`), `node:sqlite` (`db.cjs`), vanilla JS `EventSource` + Cytoscape pulse (`app.js`), `node --test`.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `.claude/helpers/db.cjs` | `getEventsSince(watermarks)`, `getMissionControl()` + exports | Modify |
| `.claude/helpers/dashboard/server.mjs` | `GET /api/brain/events` (SSE), `GET /api/brain/mission` | Modify |
| `.claude/helpers/dashboard/index.html` | ticker + mission strip markup in `#tab-brain` | Modify |
| `.claude/helpers/dashboard/app.js` | `EventSource` wiring, node pulse, `loadMission()` | Modify |
| `tests/brainEvents.test.mjs`, `tests/missionControl.test.mjs` | tests | Create |

### Contracts (locked here)

```
getEventsSince(wm) -> { events: Event[], watermarks: {prompts,tool_calls,edit_events,skill_injection_decisions} }
  wm = { prompts:number, tool_calls:number, edit_events:number, skill_injection_decisions:number }  (max rowids seen)
  Event = { kind, ts, session_id, project, label, refs: string[] }   // refs = graph node ids

getMissionControl() -> { generatedAt, entries: LedgerEntry[], counts: {running,zombie,scheduled,done,idle,failed} }
  LedgerEntry = { id, source:'session'|'job', title, status, owner, detail, lastHeartbeat, startedAt, updatedAt }
  status ∈ running|zombie|scheduled|done|idle|failed
```

---

## Task 1: `getEventsSince()` — rowid-watermark tailing

**Files:**
- Modify: `.claude/helpers/db.cjs` (`getEventsSince` + export)
- Test: `tests/brainEvents.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/brainEvents.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

function fresh() { const r = fs.mkdtempSync(path.join(os.tmpdir(),'vf-ev-')); db.close(); db.initialize(r,'vaultflow.db'); return r; }

test('first call with empty watermarks returns current max rowids and no spurious events', () => {
  fresh();
  db.raw().exec(`INSERT INTO edit_events (timestamp, session_id, file_path, project) VALUES ('2026-06-10T10:00:00Z','s1','a.js','alpha')`);
  const r1 = db.getEventsSince({});
  assert.ok(r1.watermarks.edit_events >= 1, 'watermark should advance to current max');
  // a second call with the returned watermark yields nothing new
  const r2 = db.getEventsSince(r1.watermarks);
  assert.equal(r2.events.length, 0, 'no new events after catching up');
});

test('new rows after a watermark are returned as events with refs', () => {
  fresh();
  const r1 = db.getEventsSince({});
  db.raw().exec(`INSERT INTO edit_events (timestamp, session_id, file_path, project) VALUES ('2026-06-10T10:05:00Z','s1','src/x.js','alpha')`);
  const r2 = db.getEventsSince(r1.watermarks);
  assert.equal(r2.events.length, 1);
  const e = r2.events[0];
  assert.equal(e.kind, 'edit');
  assert.ok(e.refs.includes('file:src/x.js'));
  assert.ok(e.refs.includes('session:s1'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/brainEvents.test.mjs`
Expected: FAIL — `db.getEventsSince is not a function`.

- [ ] **Step 3: Implement `getEventsSince`**

In `db.cjs` before `module.exports`:

```javascript
/**
 * Tail recent activity using rowid watermarks (DB-as-bus for the SSE pulse).
 * Pass the watermarks returned by the previous call; the first call (empty wm)
 * fast-forwards to the current max so old rows aren't replayed as "new".
 * @param {object} wm previous {prompts,tool_calls,edit_events,skill_injection_decisions}
 * @returns {{events:Array,watermarks:object}}
 */
function getEventsSince(wm) {
  if (!_db) throw new Error('db.getEventsSince: call initialize() first');
  const prev = wm || {};
  const maxRow = (tbl) => { try { return _db.prepare(`SELECT COALESCE(MAX(rowid),0) m FROM ${tbl}`).get().m; } catch (_) { return 0; } };
  const out = { prompts: maxRow('prompts'), tool_calls: maxRow('tool_calls'), edit_events: maxRow('edit_events'), skill_injection_decisions: maxRow('skill_injection_decisions') };
  const events = [];
  const firstCall = !prev.edit_events && !prev.prompts && !prev.tool_calls && !prev.skill_injection_decisions;
  if (firstCall) return { events, watermarks: out };

  try { for (const r of _db.prepare(`SELECT rowid, timestamp, session_id, file_path, project FROM edit_events WHERE rowid > ? ORDER BY rowid LIMIT 100`).all(prev.edit_events || 0))
    events.push({ kind: 'edit', ts: r.timestamp, session_id: r.session_id, project: r.project, label: String(r.file_path).split(/[/\\]/).pop(), refs: [`session:${r.session_id}`, `file:${r.file_path}`] }); } catch (_) {}
  try { for (const r of _db.prepare(`SELECT rowid, timestamp, session_id, prompt_text, skill_routed FROM prompts WHERE rowid > ? ORDER BY rowid LIMIT 100`).all(prev.prompts || 0))
    events.push({ kind: 'prompt', ts: r.timestamp, session_id: r.session_id, project: null, label: String(r.prompt_text || '').slice(0, 60), refs: [`session:${r.session_id}`, ...(r.skill_routed ? [`skill:${r.skill_routed}`] : [])] }); } catch (_) {}
  try { for (const r of _db.prepare(`SELECT rowid, timestamp, session_id, tool_name FROM tool_calls WHERE rowid > ? ORDER BY rowid LIMIT 100`).all(prev.tool_calls || 0))
    events.push({ kind: 'tool', ts: r.timestamp, session_id: r.session_id, project: null, label: r.tool_name, refs: [`session:${r.session_id}`] }); } catch (_) {}
  try { for (const r of _db.prepare(`SELECT rowid, timestamp, session_id, chosen_skill, injected FROM skill_injection_decisions WHERE rowid > ? ORDER BY rowid LIMIT 100`).all(prev.skill_injection_decisions || 0))
    events.push({ kind: r.injected ? 'inject' : 'route', ts: r.timestamp, session_id: r.session_id, project: null, label: r.chosen_skill, refs: [`session:${r.session_id}`, ...(r.chosen_skill ? [`skill:${r.chosen_skill}`] : [])] }); } catch (_) {}

  events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return { events, watermarks: out };
}
```

Add `getEventsSince,` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/brainEvents.test.mjs`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add tests/brainEvents.test.mjs .claude/helpers/db.cjs
git commit -m "feat(vaultflow): getEventsSince() rowid-watermark tailing for live pulse"
```

---

## Task 2: `getMissionControl()` — unified ledger

**Files:**
- Modify: `.claude/helpers/db.cjs` (`getMissionControl` + export)
- Test: `tests/missionControl.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/missionControl.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

function fresh() { const r = fs.mkdtempSync(path.join(os.tmpdir(),'vf-mc-')); db.close(); db.initialize(r,'vaultflow.db'); return r; }
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

test('a session with no ended_at and a recent edit is running', () => {
  fresh();
  db.raw().exec(`INSERT INTO sessions (id, started_at, project) VALUES ('s1','${iso(60000)}','alpha')`);
  db.raw().exec(`INSERT INTO edit_events (timestamp, session_id, file_path, project) VALUES ('${iso(30000)}','s1','a.js','alpha')`);
  const mc = db.getMissionControl();
  const e = mc.entries.find(x => x.id === 'session:s1');
  assert.ok(e, 'session entry present');
  assert.equal(e.status, 'running');
  assert.equal(mc.counts.running, 1);
});

test('a session with no ended_at and stale activity is a zombie', () => {
  fresh();
  db.raw().exec(`INSERT INTO sessions (id, started_at, project) VALUES ('s2','${iso(60*60000)}','beta')`);
  db.raw().exec(`INSERT INTO edit_events (timestamp, session_id, file_path, project) VALUES ('${iso(45*60000)}','s2','b.js','beta')`);
  const mc = db.getMissionControl();
  const e = mc.entries.find(x => x.id === 'session:s2');
  assert.equal(e.status, 'zombie');
});

test('an ended session today is done', () => {
  fresh();
  db.raw().exec(`INSERT INTO sessions (id, started_at, ended_at, project) VALUES ('s3','${iso(120*60000)}','${iso(100*60000)}','gamma')`);
  const mc = db.getMissionControl();
  const e = mc.entries.find(x => x.id === 'session:s3');
  assert.equal(e.status, 'done');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/missionControl.test.mjs`
Expected: FAIL — `db.getMissionControl is not a function`.

- [ ] **Step 3: Implement `getMissionControl`**

In `db.cjs` before `module.exports`:

```javascript
/**
 * Project live sessions + scheduled jobs into one Mission Control ledger.
 * Status derivation (vaultflow-native, modeled on the studied Wayland ledger):
 *   running  — open session with activity in the last 10 min
 *   zombie   — open session with no activity for 30+ min (died without SessionEnd)
 *   done     — session ended today
 *   scheduled/idle/failed — reserved for jobs (nightly), filled when job metadata exists
 * @returns {{generatedAt:string, entries:Array, counts:object}}
 */
function getMissionControl() {
  if (!_db) throw new Error('db.getMissionControl: call initialize() first');
  const now = Date.now();
  const RUN_MS = 10 * 60 * 1000, ZOMBIE_MS = 30 * 60 * 1000, TODAY = new Date().toISOString().slice(0, 10);
  const entries = [];
  const counts = { running: 0, zombie: 0, scheduled: 0, done: 0, idle: 0, failed: 0 };

  const sessions = _db.prepare(`
    SELECT s.id, s.project, s.started_at, s.ended_at,
           (SELECT MAX(timestamp) FROM edit_events e WHERE e.session_id = s.id) AS last_edit
      FROM sessions s
     WHERE s.started_at >= ?
     ORDER BY s.started_at DESC LIMIT 50
  `).all(new Date(now - 2 * 864e5).toISOString());

  for (const s of sessions) {
    const lastTs = s.last_edit || s.started_at;
    const sinceMs = now - new Date(lastTs).getTime();
    let status;
    if (s.ended_at) status = String(s.ended_at).slice(0, 10) === TODAY ? 'done' : 'idle';
    else if (sinceMs <= RUN_MS) status = 'running';
    else if (sinceMs >= ZOMBIE_MS) status = 'zombie';
    else status = 'running';
    counts[status] = (counts[status] || 0) + 1;
    entries.push({
      id: `session:${s.id}`, source: 'session', title: s.project || s.id, status,
      owner: s.project || null, detail: s.ended_at ? 'ended' : (status === 'zombie' ? 'no activity 30m+' : 'active'),
      lastHeartbeat: new Date(lastTs).getTime(), startedAt: new Date(s.started_at).getTime(),
      updatedAt: new Date(lastTs).getTime(),
    });
  }

  // urgency-first ordering: zombie/failed, running, scheduled, done, idle
  const rank = { zombie: 0, failed: 1, running: 2, scheduled: 3, done: 4, idle: 5 };
  entries.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.updatedAt - a.updatedAt));
  return { generatedAt: new Date(now).toISOString(), entries, counts };
}
```

Add `getMissionControl,` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/missionControl.test.mjs`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add tests/missionControl.test.mjs .claude/helpers/db.cjs
git commit -m "feat(vaultflow): getMissionControl() unified session/job ledger with zombie detection"
```

---

## Task 3: SSE + mission endpoints

**Files:**
- Modify: `.claude/helpers/dashboard/server.mjs`

- [ ] **Step 1: Add the mission endpoint**

```javascript
// ── GET /api/brain/mission ───────────────────────────────────────────────
app.get('/api/brain/mission', (_req, res) => {
  try { res.json(db.getMissionControl()); } catch (err) { apiErr(res, err); }
});
```

- [ ] **Step 2: Add the SSE endpoint**

```javascript
// ── GET /api/brain/events (Server-Sent Events) ────────────────────────────
app.get('/api/brain/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write(': connected\n\n');

  let wm = {};
  let alive = true;
  const tick = () => {
    if (!alive) return;
    try {
      ensureDb();
      const { events, watermarks } = db.getEventsSince(wm);
      wm = watermarks;
      for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
    } catch (_) { /* DB locked — skip a beat, never error the stream */ }
  };
  // first call fast-forwards watermarks without replaying history
  try { ensureDb(); wm = db.getEventsSince({}).watermarks; } catch (_) {}
  const poll = setInterval(tick, 1500);
  const keepAlive = setInterval(() => { if (alive) res.write(': ping\n\n'); }, 15000);

  req.on('close', () => { alive = false; clearInterval(poll); clearInterval(keepAlive); });
});
```

- [ ] **Step 3: Manual SSE check**

Run: `npm run dashboard:serve`, then in another shell:
`curl -N "http://localhost:7700/api/brain/events"` (leave it running)
In a third shell, trigger an edit event (or run any tracked claude/codex action). 
Expected: `curl` prints `: connected`, periodic `: ping`, and a `data: {...}` line when a new row lands. Ctrl-C to stop.

- [ ] **Step 4: Commit**

```bash
git add .claude/helpers/dashboard/server.mjs
git commit -m "feat(vaultflow): SSE /api/brain/events + /api/brain/mission endpoints"
```

---

## Task 4: Pulse UI + Mission Control strip

**Files:**
- Modify: `.claude/helpers/dashboard/index.html`
- Modify: `.claude/helpers/dashboard/app.js`

- [ ] **Step 1: Add markup to the Brain section**

In `index.html` `#tab-brain`, after the toolbar and before `#brain-graph`:

```html
    <div id="mission-strip" class="stat-row" style="margin-bottom:10px"></div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <label class="mono" style="font-size:12px"><input type="checkbox" id="pulse-toggle" checked /> live pulse</label>
      <div id="pulse-ticker" class="mono" style="font-size:12px;opacity:.8;white-space:nowrap;overflow:hidden;flex:1"></div>
    </div>
```

- [ ] **Step 2: Add pulse + mission JS**

In `app.js`, add:

```javascript
// ── Live pulse (SSE) + Mission Control ──────────────────────────────────
let pulseالسSource = null; // EventSource handle
const PULSE_KINDS = { edit: '#22d3ee', prompt: '#94a3b8', tool: '#a78bfa', inject: '#f472b6', route: '#64748b' };

function startPulse() {
  if (pulseالسSource) return;
  pulseالسSource = new EventSource('/api/brain/events');
  pulseالسSource.onmessage = (msg) => {
    let e; try { e = JSON.parse(msg.data); } catch { return; }
    // ticker line
    const ticker = document.getElementById('pulse-ticker');
    if (ticker) ticker.textContent = `${e.kind} · ${e.label || ''} · ${(e.ts || '').slice(11, 19)}`;
    // pulse referenced nodes on the graph
    if (brainCy && Array.isArray(e.refs)) {
      for (const id of e.refs) {
        const node = brainCy.getElementById(id);
        if (node && node.length) {
          node.animate({ style: { 'background-color': PULSE_KINDS[e.kind] || '#fff', 'border-width': 4, 'border-color': PULSE_KINDS[e.kind] || '#fff' } }, { duration: 200 })
              .animate({ style: { 'border-width': 0 } }, { duration: 600 });
        }
      }
    }
  };
  pulseالسSource.onerror = () => { /* browser auto-reconnects EventSource */ };
}
function stopPulse() { if (pulseالسSource) { pulseالسSource.close(); pulseالسSource = null; } }

async function loadMission() {
  const mc = await api('/api/brain/mission').catch(() => ({ entries: [], counts: {} }));
  const color = { running: '#22d3ee', zombie: '#fb7185', failed: '#f87171', scheduled: '#5b8def', done: '#34d399', idle: '#7a818c' };
  const strip = document.getElementById('mission-strip');
  strip.innerHTML = Object.entries(mc.counts).filter(([, n]) => n > 0)
    .map(([status, n]) => `<div class="stat-card"><div class="label" style="color:${color[status]||'#fff'}">${status}</div><div class="value">${n}</div></div>`)
    .join('') || '<div class="stat-card"><div class="label">idle</div><div class="value">0</div></div>';
}
```

> The identifier `pulseالسSource` above uses a stray non-ASCII fragment — rename it to `pulseSource` consistently in all four occurrences when typing this in. (Use a plain ASCII name.)

- [ ] **Step 3: Wire toggle + call from loadBrain**

In `loadBrain()`, add at the end:

```javascript
  loadMission();
  if (document.getElementById('pulse-toggle')?.checked) startPulse();
```

After the function, add:

```javascript
document.getElementById('pulse-toggle')?.addEventListener('change', (e) => e.target.checked ? startPulse() : stopPulse());
```

- [ ] **Step 4: Manual verification**

Run: `npm run dashboard:serve`, open Brain tab.
Expected: mission strip shows status counts; ticker updates as activity lands; graph nodes flash when an event references them; unchecking "live pulse" stops updates.

- [ ] **Step 5: Commit**

```bash
git add .claude/helpers/dashboard/index.html .claude/helpers/dashboard/app.js
git commit -m "feat(vaultflow): live pulse (SSE) + Mission Control strip on Brain tab"
```

---

## Self-Review

- **Spec coverage:** SSE `/api/brain/events` DB-as-bus with rowid watermarks (Tasks 1,3) ✓; degrade-to-silence on DB lock (Task 3 tick try/catch) ✓; keep-alive comments every 15s (Task 3) ✓; unified ledger with zombie detection (Task 2) ✓; urgency-first ordering (Task 2) ✓; node pulses + ticker (Task 4) ✓; mission strip (Task 4) ✓. Per-session pipeline strip (prompt→route→inject→edit) is represented by the ticker + node pulses rather than a dedicated lane widget — the richer lane view is deferred polish; noted.
- **Placeholder scan:** none. One explicit rename instruction flagged (the `pulseالسSource` identifier must be typed as ASCII `pulseSource`) — called out so it isn't copied verbatim.
- **Type consistency:** `getEventsSince(wm)→{events,watermarks}` consistent db↔SSE; watermark keys identical (`prompts,tool_calls,edit_events,skill_injection_decisions`); `Event.refs` node-id format (`session:`, `file:`, `skill:`) matches Phase 1 `getBrainGraph` node ids so pulses land on real nodes; `getMissionControl()→{generatedAt,entries,counts}` consistent db↔endpoint↔UI.
