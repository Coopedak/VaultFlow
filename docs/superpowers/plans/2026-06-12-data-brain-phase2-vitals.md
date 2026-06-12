# Data Brain — Phase 2: Vitals + Learning Loops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "is it getting smarter" measurable: a `brain_snapshots` trend table written nightly, a 0–100 composite promotion score, and four closed learning-loop circuits (implicit retrieval feedback, verdict→decision attribution, promoted-flag read-back, model-recommendation accept), surfaced as a Vitals panel on the Brain tab.

**Architecture:** One new table (`brain_snapshots`) + one nullable column (`agent_verdicts.decision_id`) — both via the existing idempotent-migration pattern. New nightly steps record metrics using the existing isolated-`step()` wrapper. A composite-score function lives in `db.cjs`. The router gains a small promoted boost. Two new endpoints serve recommendations and snapshots.

**Tech Stack:** `node:sqlite` (`db.cjs`), `nightly.mjs` (ESM), `model-router.cjs` / `router.cjs` / `intelligence.cjs` / `hook-handler.cjs` (CJS), Express (`server.mjs`), Chart.js sparklines (`app.js`), `node --test`.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `.claude/helpers/db.cjs` | `brain_snapshots` table + migration; `recordBrainSnapshot`/`getBrainSnapshots`; `compositePromotionScore`; `agent_verdicts.decision_id` migration; `recordVerdict` accepts decision_id | Modify |
| `.claude/helpers/nightly.mjs` | snapshot step, implicit-feedback correlation step, score-based promotion | Modify |
| `.claude/helpers/intelligence.cjs` | log retrieval impressions in `getContext()` | Modify |
| `.claude/helpers/router.cjs` | promoted boost in scoring | Modify |
| `.claude/helpers/hook-handler.cjs` | thread `decision_id` into verdict recording | Modify |
| `.claude/helpers/model-router.cjs` | `applyRecommendation()` | Modify |
| `.claude/helpers/dashboard/server.mjs` | `/api/brain/snapshots`, `/api/model/recommendations`, POST accept | Modify |
| `.claude/helpers/dashboard/app.js` + `index.html` | Vitals panel on Brain tab | Modify |
| `tests/brainSnapshots.test.mjs`, `tests/promotionScore.test.mjs`, `tests/retrievalFeedback.test.mjs`, `tests/verdictAttribution.test.mjs` | tests | Create |

---

## Task 1: `brain_snapshots` table + record/read functions

**Files:**
- Modify: `.claude/helpers/db.cjs` (SCHEMA_SQL + two functions + exports)
- Test: `tests/brainSnapshots.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/brainSnapshots.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

function fresh() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-snap-'));
  db.close(); db.initialize(root, 'vaultflow.db'); return root;
}

test('recordBrainSnapshot then getBrainSnapshots round-trips', () => {
  fresh();
  db.recordBrainSnapshot('2026-06-10', 'patterns.count', '', 42);
  db.recordBrainSnapshot('2026-06-11', 'patterns.count', '', 47);
  const rows = db.getBrainSnapshots({ metric: 'patterns.count', scope: '', days: 30 });
  assert.equal(rows.length, 2);
  assert.equal(rows[rows.length - 1].value, 47);
});

test('recordBrainSnapshot is idempotent per (date,metric,scope)', () => {
  fresh();
  db.recordBrainSnapshot('2026-06-10', 'memory.count', '', 100);
  db.recordBrainSnapshot('2026-06-10', 'memory.count', '', 105); // same key → overwrite
  const rows = db.getBrainSnapshots({ metric: 'memory.count', scope: '', days: 30 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 105);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/brainSnapshots.test.mjs`
Expected: FAIL — `db.recordBrainSnapshot is not a function`.

- [ ] **Step 3: Add the table to SCHEMA_SQL**

In the `const SCHEMA_SQL = ` string in `db.cjs` (before line ~700), add:

```sql
CREATE TABLE IF NOT EXISTS brain_snapshots (
  snapshot_date TEXT NOT NULL,
  metric        TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT '',
  value         REAL NOT NULL,
  PRIMARY KEY (snapshot_date, metric, scope)
);
```

- [ ] **Step 4: Add the functions + exports**

Before `module.exports`:

```javascript
/**
 * Upsert a daily metric snapshot. Key is (snapshot_date, metric, scope) so
 * re-running nightly the same day overwrites rather than duplicates.
 * @param {string} date YYYY-MM-DD
 * @param {string} metric dotted key e.g. 'patterns.count'
 * @param {string} scope  '' for global, else project/agent
 * @param {number} value
 */
function recordBrainSnapshot(date, metric, scope, value) {
  if (!_db) throw new Error('db.recordBrainSnapshot: call initialize() first');
  _db.prepare(`
    INSERT INTO brain_snapshots (snapshot_date, metric, scope, value)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(snapshot_date, metric, scope) DO UPDATE SET value = excluded.value
  `).run(date, metric, scope || '', Number(value) || 0);
}

/**
 * Read a metric's trend. @returns {Array<{snapshot_date,metric,scope,value}>} ASC by date.
 */
function getBrainSnapshots(opts) {
  if (!_db) throw new Error('db.getBrainSnapshots: call initialize() first');
  const o = opts || {};
  const days = Math.max(1, o.days || 30);
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  if (o.metric) {
    return _db.prepare(`SELECT * FROM brain_snapshots WHERE metric = ? AND scope = ? AND snapshot_date >= ? ORDER BY snapshot_date ASC`)
      .all(o.metric, o.scope || '', cutoff);
  }
  return _db.prepare(`SELECT * FROM brain_snapshots WHERE snapshot_date >= ? ORDER BY metric, snapshot_date ASC`).all(cutoff);
}
```

Add to `module.exports`: `recordBrainSnapshot,` and `getBrainSnapshots,`.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/brainSnapshots.test.mjs`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add tests/brainSnapshots.test.mjs .claude/helpers/db.cjs
git commit -m "feat(vaultflow): brain_snapshots table + record/read functions"
```

---

## Task 2: Composite promotion score

**Files:**
- Modify: `.claude/helpers/db.cjs` (`compositePromotionScore` + export)
- Test: `tests/promotionScore.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/promotionScore.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

const DAY = 864e5;

test('high-signal type + tags + recent + many refs scores >= 90', () => {
  const s = db.compositePromotionScore({
    type: 'decision', crossProjectRefs: 3, references: 4,
    tags: ['architecture'], ageMs: 2 * 60 * 60 * 1000,   // 2h old
  });
  assert.ok(s >= 90, `expected >=90, got ${s}`);
});

test('weak entry scores low', () => {
  const s = db.compositePromotionScore({
    type: 'observation', crossProjectRefs: 0, references: 0, tags: [], ageMs: 40 * DAY,
  });
  assert.ok(s < 30, `expected <30, got ${s}`);
});

test('score is clamped to 0..100', () => {
  const s = db.compositePromotionScore({
    type: 'pattern', crossProjectRefs: 50, references: 50, tags: ['design','decision'], ageMs: 0,
  });
  assert.ok(s <= 100 && s >= 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/promotionScore.test.mjs`
Expected: FAIL — `db.compositePromotionScore is not a function`.

- [ ] **Step 3: Implement the function**

In `db.cjs` before `module.exports` (the formula mirrors the studied IJFW rubric, calibrated to promote at ≥90):

```javascript
const PROMOTED_TAGS = new Set(['decision', 'pattern', 'architecture', 'design', 'global']);
const SCORE_RECENCY_PEAK_MS = 24 * 60 * 60 * 1000;   // full boost under 24h
const SCORE_RECENCY_MAX_MS  = 30 * 24 * 60 * 60 * 1000; // decays to 0 at 30d

/**
 * 0–100 composite score for promoting a memory/pattern entry.
 *   +30 high-signal type (decision|pattern)
 *   +10 per cross-project reference
 *   +5  per reference/fire
 *   +20 if any tag is a promoted tag
 *   +15 recency, full <24h, linear decay to 0 at 30d
 * @param {{type?:string,crossProjectRefs?:number,references?:number,tags?:string[],ageMs?:number}} e
 * @returns {number} integer 0..100
 */
function compositePromotionScore(e) {
  let score = 0;
  if (e.type === 'decision' || e.type === 'pattern') score += 30;
  score += (Number(e.crossProjectRefs) || 0) * 10;
  score += (Number(e.references) || 0) * 5;
  if (Array.isArray(e.tags) && e.tags.some(t => PROMOTED_TAGS.has(String(t).toLowerCase()))) score += 20;
  const age = Number(e.ageMs) || 0;
  if (age <= SCORE_RECENCY_PEAK_MS) score += 15;
  else if (age < SCORE_RECENCY_MAX_MS) score += Math.round(15 * (1 - (age - SCORE_RECENCY_PEAK_MS) / (SCORE_RECENCY_MAX_MS - SCORE_RECENCY_PEAK_MS)));
  return Math.min(100, Math.max(0, Math.round(score)));
}
```

Add to `module.exports`: `compositePromotionScore,`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/promotionScore.test.mjs`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add tests/promotionScore.test.mjs .claude/helpers/db.cjs
git commit -m "feat(vaultflow): composite 0-100 promotion score (IJFW-informed)"
```

---

## Task 3: Nightly snapshot step

**Files:**
- Modify: `.claude/helpers/nightly.mjs` (add a `step()` call in `main()`)

- [ ] **Step 1: Add the snapshot step**

In `nightly.mjs` `main()`, after the existing promotion step, add:

```javascript
// N. record daily brain vitals snapshot (trend data for the dashboard)
results.snapshot = await step('brain-snapshot', () => {
  if (DRY_RUN) return { skipped: true };
  const today = new Date().toISOString().slice(0, 10);
  const conn = db.raw();
  const one = (sql) => { try { return conn.prepare(sql).get()?.v ?? 0; } catch (_) { return 0; } };
  const metrics = {
    'patterns.count':        one(`SELECT COUNT(*) v FROM patterns`),
    'patterns.fires.total':  one(`SELECT COALESCE(SUM(fire_count),0) v FROM patterns`),
    'memory.count':          one(`SELECT COUNT(*) v FROM memory_entries`),
    'memory.stale.count':    one(`SELECT COUNT(*) v FROM memory_stale`),
    'sessions.total':        one(`SELECT COUNT(*) v FROM sessions`),
    'tools.calls.total':     one(`SELECT COUNT(*) v FROM tool_calls`),
    'verdicts.total':        one(`SELECT COUNT(*) v FROM agent_verdicts`),
    'verdicts.approved':     one(`SELECT COUNT(*) v FROM agent_verdicts WHERE verdict='APPROVED'`),
    'embeddings.memory':     one(`SELECT COUNT(*) v FROM memory_embeddings`),
  };
  let n = 0;
  for (const [metric, value] of Object.entries(metrics)) { db.recordBrainSnapshot(today, metric, '', value); n++; }
  return { metrics: n };
});
```

- [ ] **Step 2: Run nightly in dry-run, then for real against the live DB**

Run: `npm run nightly:dry-run`
Expected: log line `brain-snapshot — ok (...) {"skipped":true}`.

Run: `npm run nightly`
Expected: log line `brain-snapshot — ok (...) {"metrics":9}`.

- [ ] **Step 3: Verify rows landed**

Run: `node -e "const d=require('./.claude/helpers/db.cjs');d.initialize();console.log(d.getBrainSnapshots({days:2}).length)"`
Expected: a number ≥ 9.

- [ ] **Step 4: Commit**

```bash
git add .claude/helpers/nightly.mjs
git commit -m "feat(vaultflow): nightly brain-snapshot step records daily vitals"
```

---

## Task 4: Implicit retrieval feedback (impression logging + correlation)

**Files:**
- Modify: `.claude/helpers/intelligence.cjs` (log impressions in `getContext()`)
- Modify: `.claude/helpers/nightly.mjs` (correlation step)
- Modify: `.claude/helpers/db.cjs` (add `recordRetrievalImpression` + `correlateRetrievalFeedback` helpers)
- Test: `tests/retrievalFeedback.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/retrievalFeedback.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

function fresh() { const r = fs.mkdtempSync(path.join(os.tmpdir(),'vf-rf-')); db.close(); db.initialize(r,'vaultflow.db'); return r; }

test('recordRetrievalImpression writes a useful=null row', () => {
  fresh();
  db.recordRetrievalImpression({ sessionId: 's1', query: 'auth', sourceType: 'memory', sourceId: 'vault/x.md#1' });
  const rows = db.raw().prepare(`SELECT * FROM retrieval_feedback`).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'injected');
  assert.equal(rows[0].useful, null);
});

test('correlateRetrievalFeedback marks useful=1 when source file later edited in same session', () => {
  fresh();
  db.recordRetrievalImpression({ sessionId: 's1', query: 'auth', sourceType: 'memory', sourceId: 'src/auth.js#1' });
  db.raw().exec(`INSERT INTO edit_events (timestamp, session_id, file_path, project) VALUES ('2026-06-10T11:00:00Z','s1','src/auth.js','alpha')`);
  const res = db.correlateRetrievalFeedback();
  assert.ok(res.marked >= 1);
  const row = db.raw().prepare(`SELECT useful FROM retrieval_feedback LIMIT 1`).get();
  assert.equal(row.useful, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/retrievalFeedback.test.mjs`
Expected: FAIL — `db.recordRetrievalImpression is not a function`.

- [ ] **Step 3: Add the two db.cjs helpers + exports**

```javascript
/**
 * Log that a retrieved doc was injected into context (impression). useful=NULL
 * until a nightly correlation pass resolves it. Crash-safe.
 */
function recordRetrievalImpression(o) {
  if (!_db) return;
  try {
    _db.prepare(`INSERT INTO retrieval_feedback (batch_id, timestamp, session_id, query_text, source_type, source_id, action, rank, rerank_score, useful)
                 VALUES (?, ?, ?, ?, ?, ?, 'injected', ?, ?, NULL)`)
      .run(o.batchId || null, new Date().toISOString(), o.sessionId || null, o.query || null,
           o.sourceType || 'memory', String(o.sourceId || ''), o.rank ?? null, o.rerankScore ?? null);
  } catch (_) {}
}

/**
 * Nightly: resolve open impressions. useful=1 if the same session later edited
 * the doc's source file; useful=0 once the impression is >7 days old with no hit.
 * @returns {{marked:number,expired:number}}
 */
function correlateRetrievalFeedback() {
  if (!_db) throw new Error('db.correlateRetrievalFeedback: call initialize() first');
  const marked = _db.prepare(`
    UPDATE retrieval_feedback
       SET useful = 1
     WHERE useful IS NULL
       AND EXISTS (
         SELECT 1 FROM edit_events e
          WHERE e.session_id = retrieval_feedback.session_id
            AND retrieval_feedback.source_id LIKE e.file_path || '%'
            AND e.timestamp >= retrieval_feedback.timestamp )
  `).run();
  const expired = _db.prepare(`
    UPDATE retrieval_feedback SET useful = 0
     WHERE useful IS NULL AND timestamp < ?
  `).run(new Date(Date.now() - 7 * 864e5).toISOString());
  return { marked: marked.changes || 0, expired: expired.changes || 0 };
}
```

Add to `module.exports`: `recordRetrievalImpression,` and `correlateRetrievalFeedback,`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/retrievalFeedback.test.mjs`
Expected: PASS.

- [ ] **Step 5: Log impressions from getContext()**

In `intelligence.cjs`, inside `getContext()`, in the loop that records injected sources (~line 268, `for (const r of filtered)`), add the impression call:

```javascript
    // Record injected sources in session state
    for (const r of filtered) {
      if (r.source) {
        session.addInjectedSource(r.source);
        try {
          const sObj = session.get() || {};
          getDb().recordRetrievalImpression({
            sessionId: sObj.id || null, query: prompt,
            sourceType: 'memory', sourceId: r.source, rank: r.rank,
          });
        } catch (_) {}
      }
    }
```

- [ ] **Step 6: Add the nightly correlation step**

In `nightly.mjs` `main()`, after the snapshot step:

```javascript
// N+1. resolve implicit retrieval feedback (did we inject docs the session then used?)
results.feedback = await step('retrieval-feedback-correlate', () => DRY_RUN ? { skipped: true } : db.correlateRetrievalFeedback());
```

- [ ] **Step 7: Run full suite + commit**

Run: `npm test`
Expected: all PASS.

```bash
git add tests/retrievalFeedback.test.mjs .claude/helpers/db.cjs .claude/helpers/intelligence.cjs .claude/helpers/nightly.mjs
git commit -m "feat(vaultflow): implicit retrieval feedback — impression logging + nightly correlation"
```

---

## Task 5: Verdict → decision attribution

**Files:**
- Modify: `.claude/helpers/db.cjs` (`agent_verdicts.decision_id` migration; `recordVerdict` accepts decision_id; helper `getLatestDecisionId`)
- Modify: `.claude/helpers/hook-handler.cjs` (pass decision_id in `clear-review`)
- Test: `tests/verdictAttribution.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/verdictAttribution.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const db = require('../.claude/helpers/db.cjs');

function fresh() { const r = fs.mkdtempSync(path.join(os.tmpdir(),'vf-va-')); db.close(); db.initialize(r,'vaultflow.db'); return r; }

test('agent_verdicts has a decision_id column after migration', () => {
  fresh();
  const cols = db.raw().prepare(`PRAGMA table_info(agent_verdicts)`).all().map(c => c.name);
  assert.ok(cols.includes('decision_id'), 'decision_id column missing');
});

test('recordVerdict persists decision_id', () => {
  fresh();
  db.recordVerdict('s1', 'voice-of-reason', 'APPROVED', 'looks good', null, 77);
  const row = db.raw().prepare(`SELECT decision_id FROM agent_verdicts LIMIT 1`).get();
  assert.equal(row.decision_id, 77);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/verdictAttribution.test.mjs`
Expected: FAIL — column missing / `recordVerdict` ignores the 6th arg.

- [ ] **Step 3: Add the migration**

In the additive-migrations block of `db.cjs` `initialize()` (~line 1241), add to the migration loop array:

```javascript
  'ALTER TABLE agent_verdicts ADD COLUMN decision_id INTEGER',
```

- [ ] **Step 4: Extend `recordVerdict`**

Find `recordVerdict` in `db.cjs`. Add a trailing `decisionId` parameter and include it in the INSERT. (Append the param so existing 5-arg callers keep working.) Example:

```javascript
function recordVerdict(sessionId, agentType, verdict, reason, flaggedAt, decisionId) {
  if (!_db) throw new Error('db.recordVerdict: call initialize() first');
  _db.prepare(`INSERT INTO agent_verdicts (timestamp, session_id, agent_type, verdict, reason, flagged_at, decision_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(new Date().toISOString(), sessionId ?? null, agentType ?? null, verdict ?? null,
         reason ?? null, flaggedAt ?? null, decisionId ?? null);
}
```

> Match the existing column list in the current `recordVerdict` body — only add `decision_id` to both the column list and the VALUES. If the table lacks a `timestamp`/`flagged_at` column under a different name, keep the existing names; only the `decision_id` addition is new.

Also add a helper:

```javascript
/** Most recent skill_injection_decisions.id for a session, or null. */
function getLatestDecisionId(sessionId) {
  if (!_db || !sessionId) return null;
  try { return _db.prepare(`SELECT id FROM skill_injection_decisions WHERE session_id = ? ORDER BY id DESC LIMIT 1`).get(sessionId)?.id ?? null; }
  catch (_) { return null; }
}
```

Add `getLatestDecisionId,` to `module.exports`.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/verdictAttribution.test.mjs`
Expected: PASS.

- [ ] **Step 6: Thread decision_id through the hook**

In `hook-handler.cjs` `clear-review` case (~line 596), change the verdict recording to look up and pass the decision id:

```javascript
        const sess = session.get();
        const decisionId = db.getLatestDecisionId(sess ? sess.id : null);
        db.recordVerdict(sess ? sess.id : null, agentType, verdict, reason, flaggedAt, decisionId);
```

- [ ] **Step 7: Commit**

```bash
git add tests/verdictAttribution.test.mjs .claude/helpers/db.cjs .claude/helpers/hook-handler.cjs
git commit -m "feat(vaultflow): attribute agent verdicts to skill-injection decisions"
```

---

## Task 6: Promoted-flag read-back (router boost)

**Files:**
- Modify: `.claude/helpers/router.cjs` (apply a boost when a matched skill is promoted)
- Test: covered by a focused unit test `tests/routerBoost.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/routerBoost.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const router = require('../.claude/helpers/router.cjs');

test('applyPromotedBoost multiplies score for promoted skills only', () => {
  assert.equal(router.applyPromotedBoost(0.5, false), 0.5);
  assert.ok(router.applyPromotedBoost(0.5, true) > 0.5);
  assert.ok(router.applyPromotedBoost(0.5, true) <= 1.0); // never exceeds 1.0
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/routerBoost.test.mjs`
Expected: FAIL — `router.applyPromotedBoost is not a function`.

- [ ] **Step 3: Add `applyPromotedBoost` + use it in `routeTask`**

In `router.cjs`, add near `overlapScore`:

```javascript
/** 10% multiplicative boost for promoted skills/tools, capped at 1.0. */
const PROMOTED_BOOST = 1.10;
function applyPromotedBoost(score, promoted) {
  return promoted ? Math.min(1.0, score * PROMOTED_BOOST) : score;
}
```

In `routeTask`, inside the `for (const skill of skills)` loop, replace the score line:

```javascript
    const score    = applyPromotedBoost(overlapScore(promptTokens, combined), !!skill.promoted);
```

Add `applyPromotedBoost,` to `router.cjs` `module.exports`.

> `skill.promoted` comes from the skills loader. If `loadSkills()` does not already surface a `promoted` field, this evaluates to `false` (no behavior change) until the loader is enriched — acceptable; the boost is wired and tested now, data follows.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/routerBoost.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/routerBoost.test.mjs .claude/helpers/router.cjs
git commit -m "feat(vaultflow): router boost for promoted skills (promoted-flag read-back)"
```

---

## Task 7: Score-based nightly promotion

**Files:**
- Modify: `.claude/helpers/nightly.mjs` (use `compositePromotionScore` for the pattern-promotion step)

- [ ] **Step 1: Add a score-based promotion step**

In `nightly.mjs` `main()`, after the existing vault-tool promotion step, add a pattern-promotion step that uses the composite score:

```javascript
// N+2. score-based pattern promotion (composite 0-100, promote at >=90)
results.scorePromote = await step('promote-patterns-by-score', () => {
  if (DRY_RUN) return { skipped: true };
  const conn = db.raw();
  const rows = conn.prepare(`SELECT pattern_key, agent, COALESCE(fire_count,0) fc, last_fired, COALESCE(promoted,0) promoted FROM patterns WHERE COALESCE(promoted,0)=0`).all();
  let promoted = 0;
  for (const r of rows) {
    const ageMs = r.last_fired ? (Date.now() - new Date(r.last_fired).getTime()) : 40 * 864e5;
    const score = db.compositePromotionScore({ type: 'pattern', references: r.fc, crossProjectRefs: 0, tags: ['pattern'], ageMs });
    if (score >= 90) { try { db.markPromoted(r.pattern_key); promoted++; } catch (_) {} }
  }
  return { scanned: rows.length, promoted };
});
```

> Uses the existing `db.markPromoted(...)` exported in db.cjs. If `markPromoted` takes a different key (e.g. an id), adjust the argument to match its current signature — confirm with `grep -n "function markPromoted" .claude/helpers/db.cjs`.

- [ ] **Step 2: Verify in dry-run then real**

Run: `npm run nightly:dry-run`
Expected: `promote-patterns-by-score — ok (...) {"skipped":true}`.

Run: `npm run nightly`
Expected: `promote-patterns-by-score — ok (...) {"scanned":N,"promoted":M}`.

- [ ] **Step 3: Commit**

```bash
git add .claude/helpers/nightly.mjs
git commit -m "feat(vaultflow): score-based nightly pattern promotion (>=90 composite)"
```

---

## Task 8: Model recommendations — apply + endpoints

**Files:**
- Modify: `.claude/helpers/model-router.cjs` (`applyRecommendation` + export)
- Modify: `.claude/helpers/dashboard/server.mjs` (GET recommendations, POST accept, GET snapshots)

- [ ] **Step 1: Add `applyRecommendation` to model-router.cjs**

```javascript
/**
 * Apply a pending model recommendation: set the agent's current model to the
 * recommended one (mark prior current=0, new row current=1). Mirrors the
 * checkAndDemote write but driven by an explicit operator accept.
 * @param {string} agent
 * @param {string} toModel
 * @returns {{applied:boolean, agent:string, model:string}|null}
 */
function applyRecommendation(agent, toModel) {
  try {
    const db = getDb(); db.initialize(null, null);
    const rows = db.getModelPerformance(agent) || [];
    const cur  = rows.find(r => r.current === 1);
    const now  = new Date().toISOString();
    if (cur) db.upsertModelPerformance(agent, cur.model, {
      task_type: 'general', verdicts_total: cur.verdicts_total, verdicts_approved: cur.verdicts_approved,
      sessions_on_model: cur.sessions_on_model, promoted_at: cur.promoted_at, demoted_at: now, current: 0,
    });
    db.upsertModelPerformance(agent, toModel, {
      task_type: 'general', verdicts_total: 0, verdicts_approved: 0, sessions_on_model: 0,
      promoted_at: now, demoted_at: null, current: 1,
    });
    return { applied: true, agent, model: toModel };
  } catch (err) {
    process.stderr.write(`[model-router] applyRecommendation error — ${err.message}\n`);
    return null;
  }
}
```

Add `applyRecommendation,` to `model-router.cjs` `module.exports`.

- [ ] **Step 2: Add the three endpoints to server.mjs**

```javascript
const modelRouter = require('../model-router.cjs');

// ── GET /api/brain/snapshots?metric=&scope=&days= ─────────────────────────
app.get('/api/brain/snapshots', (req, res) => {
  try {
    res.json(db.getBrainSnapshots({ metric: req.query.metric || null, scope: req.query.scope || '', days: Number(req.query.days) || 30 }));
  } catch (err) { apiErr(res, err); }
});

// ── GET /api/model/recommendations ────────────────────────────────────────
app.get('/api/model/recommendations', (_req, res) => {
  try {
    const p = path.join(METRICS, 'model-recommendations.json');
    res.json(fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {});
  } catch (err) { apiErr(res, err); }
});

// ── POST /api/model/recommendations/accept { agent } ──────────────────────
app.post('/api/model/recommendations/accept', (req, res) => {
  try {
    const agent = req.body && req.body.agent;
    if (!agent) return res.status(400).json({ error: 'agent required' });
    const p = path.join(METRICS, 'model-recommendations.json');
    const recs = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    const rec = recs[agent];
    if (!rec) return res.status(404).json({ error: 'no recommendation for agent' });
    const applied = modelRouter.applyRecommendation(agent, rec.model);
    if (applied) { delete recs[agent]; fs.writeFileSync(p, JSON.stringify(recs, null, 2)); }
    res.json({ ok: !!applied, applied });
  } catch (err) { apiErr(res, err); }
});
```

- [ ] **Step 3: Manual endpoint check**

Run: `npm run dashboard:serve`, then in another shell:
`curl "http://localhost:7700/api/brain/snapshots?days=7"` → JSON array.
`curl "http://localhost:7700/api/model/recommendations"` → JSON object (possibly `{}`).
Expected: both return 200 with JSON.

- [ ] **Step 4: Commit**

```bash
git add .claude/helpers/model-router.cjs .claude/helpers/dashboard/server.mjs
git commit -m "feat(vaultflow): model-recommendation apply + snapshots/recommendations endpoints"
```

---

## Task 9: Vitals panel UI

**Files:**
- Modify: `.claude/helpers/dashboard/index.html` (vitals container in `#tab-brain`)
- Modify: `.claude/helpers/dashboard/app.js` (`loadVitals()`, called from `loadBrain()`)

- [ ] **Step 1: Add the vitals container to the Brain section**

In `index.html`, inside `#tab-brain` (after the `#brain-detail` div):

```html
    <div class="chart-full" style="margin-top:16px">
      <h2>Brain Vitals — trends</h2>
      <div id="brain-vitals" class="stat-row"></div>
    </div>
    <div class="chart-grid">
      <div class="chart-card"><h2>Patterns fired (total)</h2><canvas id="chart-vital-fires"></canvas></div>
      <div class="chart-card"><h2>Memory entries</h2><canvas id="chart-vital-memory"></canvas></div>
    </div>
    <div class="table-card" style="margin-top:12px">
      <h2>Pending model recommendations</h2>
      <table><thead><tr><th>Agent</th><th>→ Model</th><th>From</th><th></th></tr></thead>
        <tbody id="model-recs-body"><tr><td colspan="4" class="loading">Loading…</td></tr></tbody></table>
    </div>
```

- [ ] **Step 2: Add `loadVitals()` and call it from `loadBrain()`**

In `app.js`, add:

```javascript
async function loadVitals() {
  const [snaps, recs] = await Promise.all([
    api('/api/brain/snapshots?days=30').catch(() => []),
    api('/api/model/recommendations').catch(() => ({})),
  ]);
  // group snapshots by metric
  const byMetric = {};
  for (const s of snaps) (byMetric[s.metric] ||= []).push(s);
  const latest = (m) => { const a = byMetric[m] || []; return a.length ? a[a.length - 1].value : 0; };
  const delta  = (m) => { const a = byMetric[m] || []; return a.length > 1 ? a[a.length - 1].value - a[0].value : 0; };
  const card = (label, m) => { const d = delta(m); const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '·';
    return `<div class="stat-card"><div class="label">${label}</div><div class="value">${fmtNum(latest(m))}</div><div class="mono" style="font-size:11px;opacity:.6">${arrow} ${d>=0?'+':''}${fmtNum(d)}</div></div>`; };
  document.getElementById('brain-vitals').innerHTML =
    card('Patterns', 'patterns.count') + card('Pattern fires', 'patterns.fires.total') +
    card('Memory', 'memory.count') + card('Stale memory', 'memory.stale.count') +
    card('Verdicts', 'verdicts.total');

  const line = (id, m, color) => { const a = byMetric[m] || [];
    if (!a.length) return;
    makeChart(id, 'line', { labels: a.map(r => r.snapshot_date), datasets: [{ label: m, data: a.map(r => r.value), borderColor: color, backgroundColor: color + '33', tension: .3, fill: true }] }, CHART_DEFAULTS); };
  line('chart-vital-fires', 'patterns.fires.total', '#fb7185');
  line('chart-vital-memory', 'memory.count', '#34d399');

  const body = document.getElementById('model-recs-body');
  const entries = Object.entries(recs);
  body.innerHTML = entries.length
    ? entries.map(([agent, r]) => `<tr><td>${escapeHtml(agent)}</td><td class="mono">${escapeHtml(r.model)}</td><td class="mono" style="opacity:.6">${escapeHtml(r.demoted_from||'')}</td>
        <td><button class="rec-accept" data-agent="${escapeHtml(agent)}">Accept</button></td></tr>`).join('')
    : '<tr><td colspan="4" class="loading">None pending</td></tr>';
  document.querySelectorAll('.rec-accept').forEach(b => b.addEventListener('click', async () => {
    await fetch('/api/model/recommendations/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: b.dataset.agent }) });
    loadVitals();
  }));
}
```

In `loadBrain()`, add a call at the end: `loadVitals();`

- [ ] **Step 3: Manual verification**

Run: `npm run dashboard:serve`, open Brain tab.
Expected: vitals stat cards show numbers + delta arrows; two line charts render (may be sparse until snapshots accumulate); model-recs table shows "None pending" or rows with Accept buttons.

- [ ] **Step 4: Commit**

```bash
git add .claude/helpers/dashboard/index.html .claude/helpers/dashboard/app.js
git commit -m "feat(vaultflow): Brain Vitals panel — trend cards, sparklines, model-rec accept"
```

---

## Self-Review

- **Spec coverage:** `brain_snapshots` (Task 1) ✓; nightly metrics (Task 3) ✓; composite score (Task 2) + score-based promotion (Task 7) ✓; implicit retrieval feedback (Task 4) ✓; verdict attribution `decision_id` (Task 5) ✓; promoted-flag read-back (Task 6) ✓; model-rec panel + accept (Tasks 8–9) ✓; vitals UI incl verdicts summary (Task 9) ✓. Routing-miss audit summary in UI: not built here (data already produced by existing nightly audit; surfacing it is a one-card add deferred to polish) — noted, not silently dropped.
- **Placeholder scan:** none — concrete code/commands throughout. Two steps carry explicit "confirm signature with grep" notes where an existing function's exact arg list must be matched (`markPromoted`, `recordVerdict` column names) — these are verification instructions, not placeholders.
- **Type consistency:** `recordBrainSnapshot(date,metric,scope,value)` / `getBrainSnapshots({metric,scope,days})` consistent across db/nightly/server/app; `compositePromotionScore({type,crossProjectRefs,references,tags,ageMs})` consistent Task 2↔7; `recordVerdict(...,decisionId)` 6th-arg consistent Task 5 db↔hook; `applyRecommendation(agent,toModel)` consistent Task 8 model-router↔server.
