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
