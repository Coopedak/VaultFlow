import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtNum, fmtAgo, fmtBytesMb, pct, healthTone } from '../.claude/helpers/dashboard/js/format.js';

test('format helpers', () => {
  assert.equal(fmtNum(7749), '7,749');
  assert.equal(fmtNum(0), '0');
  assert.equal(fmtAgo(9.1), '9.1h ago');
  assert.equal(fmtAgo(null), 'never');
  assert.equal(fmtBytesMb(548), '548 MB');
  assert.equal(pct(98, 100), 98);
  assert.equal(pct(0, 0), 0);
  assert.equal(healthTone({ ok: 13, warn: 0, fail: 0 }), 'ok');
  assert.equal(healthTone({ ok: 11, warn: 1, fail: 1 }), 'fail');
  assert.equal(healthTone({ ok: 12, warn: 1, fail: 0 }), 'warn');
});
