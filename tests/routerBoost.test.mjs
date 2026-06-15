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
