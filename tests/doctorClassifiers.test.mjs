/**
 * doctorClassifiers.test.mjs — lock the OK/WARN/FAIL threshold boundaries in
 * doctor.mjs. These classifiers are the part of the health audit that can
 * silently regress (a flipped `>=` hides a real problem or cries wolf), so the
 * boundaries are pinned here. The DB queries that feed them are left to manual
 * runs — only the pure decision logic is unit-tested.
 *
 * Importing doctor.mjs must NOT run the audit or call process.exit (isMain
 * guard); if this import hangs or exits, the guard regressed.
 */

import test   from 'node:test';
import assert from 'node:assert/strict';

import {
  classifySchema,
  classifyFillRate,
  classifyPatternQuality,
  classifyVaultToolsPromotion,
  classifyRetrievalActivity,
  classifyStaleSessions,
  classifyHeartbeat,
  classifyEmbeddingCoverage,
  classifyEmbedQueue,
  classifyCodeGraph,
  classifyWatcher,
  classifyDocDrift,
  classifyScheduledTask,
} from '../.claude/helpers/doctor.mjs';

test('classifySchema: complete vs missing tables', () => {
  assert.equal(classifySchema([], 84).status, 'OK');
  assert.equal(classifySchema(['embed_queue'], 83).status, 'FAIL');
});

test('classifyFillRate: 80 ok / 50 warn boundaries', () => {
  assert.equal(classifyFillRate(80, 100).status, 'OK');   // 80% — boundary
  assert.equal(classifyFillRate(79, 100).status, 'WARN'); // 79%
  assert.equal(classifyFillRate(50, 100).status, 'WARN'); // 50% — boundary
  assert.equal(classifyFillRate(49, 100).status, 'FAIL'); // 49%
  assert.equal(classifyFillRate(0, 0).status, 'OK');      // no closed sessions → 100%
});

test('classifyVaultToolsPromotion: 0 ok / <=5 warn / >5 fail', () => {
  assert.equal(classifyVaultToolsPromotion(0).status, 'OK');
  assert.equal(classifyVaultToolsPromotion(5).status, 'WARN');
  assert.equal(classifyVaultToolsPromotion(6).status, 'FAIL');
});

test('classifyStaleSessions: 0 ok / <=3 warn / >3 fail', () => {
  assert.equal(classifyStaleSessions(0).status, 'OK');
  assert.equal(classifyStaleSessions(3).status, 'WARN');
  assert.equal(classifyStaleSessions(4).status, 'FAIL');
});

test('classifyHeartbeat: <30h ok / <72h warn / else fail (exact edges)', () => {
  assert.equal(classifyHeartbeat(9.1).status, 'OK');
  assert.equal(classifyHeartbeat(30).status, 'WARN'); // 30 is not < 30
  assert.equal(classifyHeartbeat(40).status, 'WARN');
  assert.equal(classifyHeartbeat(72).status, 'FAIL'); // 72 is not < 72
  assert.equal(classifyHeartbeat(80).status, 'FAIL');
});

test('classifyEmbeddingCoverage: live coverage + orphan-bloat detection', () => {
  assert.equal(classifyEmbeddingCoverage(0, 0, 0).status, 'OK');          // no entries
  assert.equal(classifyEmbeddingCoverage(100, 98, 0).status, 'OK');       // 98% live
  assert.equal(classifyEmbeddingCoverage(100, 60, 0).status, 'WARN');     // 60% live
  assert.equal(classifyEmbeddingCoverage(100, 1200, 1200).status, 'FAIL');// orphan flood
  assert.equal(classifyEmbeddingCoverage(100, 700, 600).status, 'WARN');  // >500 orphans
});

test('classifyEmbedQueue: empty ok / fresh ok / large warn / stale fail', () => {
  assert.equal(classifyEmbedQueue(0, 0).status, 'OK');
  assert.equal(classifyEmbedQueue(16, 3.4).status, 'OK');
  assert.equal(classifyEmbedQueue(150, 3).status, 'WARN');
  assert.equal(classifyEmbedQueue(10, 30).status, 'FAIL'); // oldest survived a nightly cycle
});

test('classifyDocDrift: 0 ok / <=2 warn / >2 fail', () => {
  assert.equal(classifyDocDrift(0, '—').status, 'OK');
  assert.equal(classifyDocDrift(2, 'File Map').status, 'WARN');
  assert.equal(classifyDocDrift(3, 'File Map, Stack').status, 'FAIL');
});

test('classifyCodeGraph: indexed ok / empty fail', () => {
  assert.equal(classifyCodeGraph(8975, 55123, 400124).status, 'OK');
  assert.equal(classifyCodeGraph(0, 0, 0).status, 'FAIL');
});

test('classifyPatternQuality: none ok / noise fail / real signal ok', () => {
  assert.equal(classifyPatternQuality(null).status, 'OK');
  assert.equal(classifyPatternQuality('wal::db').status, 'FAIL');   // infrastructure noise
  assert.equal(classifyPatternQuality('tmp::cache').status, 'FAIL');
  assert.equal(classifyPatternQuality('tsx::pages').status, 'OK');  // real signal
});

test('classifyRetrievalActivity: activity ok / none warn', () => {
  assert.equal(classifyRetrievalActivity(1205).status, 'OK');
  assert.equal(classifyRetrievalActivity(0).status, 'WARN');
});

test('classifyWatcher: running ok / absent warn', () => {
  assert.equal(classifyWatcher(1).status, 'OK');
  assert.equal(classifyWatcher(0).status, 'WARN');
});

test('classifyScheduledTask: Ready ok / unregistered warn / other state warn', () => {
  assert.equal(classifyScheduledTask('Ready').status, 'OK');
  assert.equal(classifyScheduledTask('').status, 'WARN');       // not registered
  assert.equal(classifyScheduledTask('Disabled').status, 'WARN');
});
