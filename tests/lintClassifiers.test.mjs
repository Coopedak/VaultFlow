/**
 * lintClassifiers.test.mjs — pin the data-hygiene thresholds in lint.mjs.
 * Same rationale as doctorClassifiers: the WARN/PASS boundaries are the part
 * that silently regresses; the SQLite queries that feed them are left to
 * manual runs. Importing lint.mjs must NOT open the DB or call process.exit.
 */

import test   from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDbSize,
  classifyStaleMemory,
  classifyUnusedTools,
  classifyStuckPipeline,
} from '../.claude/helpers/lint.mjs';

const MB = 1_048_576;

test('classifyDbSize: <=500MB pass / >500MB warn, with accurate message', () => {
  const small = classifyDbSize(100 * MB);
  assert.equal(small.level, 'PASS');
  assert.match(small.detail, /^100\.00 MB$/);

  const big = classifyDbSize(547 * MB);
  assert.equal(big.level, 'WARN');
  assert.match(big.detail, /VACUUM/);          // points at the real lever
  assert.doesNotMatch(big.detail, /run flush/); // not the misleading old advice
});

test('classifyStaleMemory: <50 pass / >=50 warn', () => {
  assert.equal(classifyStaleMemory(10).level, 'PASS');
  assert.equal(classifyStaleMemory(49).level, 'PASS');
  assert.equal(classifyStaleMemory(50).level, 'WARN');
  assert.equal(classifyStaleMemory(93).level, 'WARN');
});

test('classifyUnusedTools: <10 pass / >=10 info', () => {
  assert.equal(classifyUnusedTools(5).level, 'PASS');
  assert.equal(classifyUnusedTools(10).level, 'INFO');
  assert.equal(classifyUnusedTools(38).level, 'INFO');
});

test('classifyStuckPipeline: <=2h ok / >2h warn (exact edge)', () => {
  assert.equal(classifyStuckPipeline(0.1 * 3_600_000).level, 'PASS');
  assert.equal(classifyStuckPipeline(2 * 3_600_000).level, 'PASS');     // exactly 2h is not > 2h
  assert.equal(classifyStuckPipeline(2 * 3_600_000 + 1).level, 'WARN'); // just over
  assert.equal(classifyStuckPipeline(3 * 3_600_000).level, 'WARN');
});
