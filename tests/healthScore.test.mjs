/**
 * healthScore.test.mjs — unit tests for health-score.cjs
 *
 * Covers:
 *   countCycles  — Tarjan SCC on directed edge lists
 *   scoreFromStats — formula, penalties, grade boundaries, deadUnavailable path
 *
 * All tests operate on pure functions (no DB, no disk) to stay deterministic
 * and fast. computeHealthScore is integration-level and exercised via the
 * dashboard endpoint in other test suites.
 *
 * Run: node --test tests/healthScore.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { countCycles, scoreFromStats } = require('../.claude/helpers/health-score.cjs');

// ── countCycles ───────────────────────────────────────────────────────────────

test('countCycles: empty graph → 0', () => {
  assert.equal(countCycles([]), 0);
});

test('countCycles: DAG (no cycles) → 0', () => {
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'a', target: 'c' },
  ];
  assert.equal(countCycles(edges), 0);
});

test('countCycles: single 3-node cycle → 1', () => {
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'c', target: 'a' },
  ];
  assert.equal(countCycles(edges), 1);
});

test('countCycles: two independent cycles → 2', () => {
  // Cycle 1: a → b → a
  // Cycle 2: x → y → z → x
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'a' },
    { source: 'x', target: 'y' },
    { source: 'y', target: 'z' },
    { source: 'z', target: 'x' },
  ];
  assert.equal(countCycles(edges), 2);
});

test('countCycles: self-loops are ignored (not a meaningful circular dep)', () => {
  const edges = [
    { source: 'a', target: 'a' },
    { source: 'b', target: 'b' },
  ];
  assert.equal(countCycles(edges), 0);
});

test('countCycles: cycle embedded in a larger DAG → 1', () => {
  // entry → a → b → c → a (cycle of 3), d is a DAG leaf
  const edges = [
    { source: 'entry', target: 'a' },
    { source: 'a',     target: 'b' },
    { source: 'b',     target: 'c' },
    { source: 'c',     target: 'a' }, // back-edge
    { source: 'a',     target: 'd' },
  ];
  assert.equal(countCycles(edges), 1);
});

test('countCycles: duplicate edges are deduped — a→b appears twice, cycle a↔b counts once', () => {
  // Pins the Set-dedup behavior in the adjacency-list builder: two identical
  // {source:'a', target:'b'} edges must not produce two entries in adj.get('a'),
  // which would make BFS visit 'b' twice and potentially mis-count SCCs.
  assert.equal(countCycles([
    { source: 'a', target: 'b' },
    { source: 'a', target: 'b' }, // duplicate
    { source: 'b', target: 'a' },
  ]), 1);
});

// ── scoreFromStats: perfect repo ──────────────────────────────────────────────

test('scoreFromStats: zero everything → score 100, grade A', () => {
  const { score, grade } = scoreFromStats({
    functions: 0, dead: 0, deadUnavailable: false,
    circular: 0, godObjects: 0, connections: 0, files: 0,
  });
  assert.equal(score, 100);
  assert.equal(grade, 'A');
});

// ── scoreFromStats: deadUnavailable path ──────────────────────────────────────

test('scoreFromStats: deadUnavailable=true yields penalty 0 and breakdown.unavailable=true', () => {
  const { score, grade, breakdown } = scoreFromStats({
    functions: 100, dead: 80, deadUnavailable: true,
    circular: 0, godObjects: 0, connections: 0, files: 0,
  });
  // No dead-code penalty when call graph is absent.
  assert.equal(score, 100);
  assert.equal(grade, 'A');
  assert.equal(breakdown.deadCode.unavailable, true);
  assert.equal(breakdown.deadCode.penalty, 0);
  assert.equal(breakdown.deadCode.value, null);
});

// ── scoreFromStats: individual penalty terms ──────────────────────────────────

test('scoreFromStats: 50% dead code (50/100 fns) → penalty 50 capped at 20 → score 80', () => {
  const { score, breakdown } = scoreFromStats({
    functions: 100, dead: 50, deadUnavailable: false,
    circular: 0, godObjects: 0, connections: 0, files: 0,
  });
  assert.equal(breakdown.deadCode.penalty, 20); // capped
  assert.equal(score, 80);
});

test('scoreFromStats: 10% dead code (10/100 fns) → penalty 10 → score 90', () => {
  const { score, breakdown } = scoreFromStats({
    functions: 100, dead: 10, deadUnavailable: false,
    circular: 0, godObjects: 0, connections: 0, files: 0,
  });
  assert.equal(breakdown.deadCode.penalty, 10);
  assert.equal(score, 90);
});

test('scoreFromStats: 4 circular deps → penalty 20 (4*5=20, at cap) → score 80', () => {
  const { score, breakdown } = scoreFromStats({
    functions: 0, dead: 0, deadUnavailable: false,
    circular: 4, godObjects: 0, connections: 0, files: 0,
  });
  assert.equal(breakdown.circularDeps.penalty, 20);
  assert.equal(score, 80);
});

test('scoreFromStats: 10 circular deps → capped at 20, not 50 → score 80', () => {
  const { score, breakdown } = scoreFromStats({
    functions: 0, dead: 0, deadUnavailable: false,
    circular: 10, godObjects: 0, connections: 0, files: 0,
  });
  assert.equal(breakdown.circularDeps.penalty, 20); // capped, not 50
  assert.equal(score, 80);
});

test('scoreFromStats: 5 god objects → penalty 15 (5*3=15, at cap) → score 85', () => {
  const { score, breakdown } = scoreFromStats({
    functions: 0, dead: 0, deadUnavailable: false,
    circular: 0, godObjects: 5, connections: 0, files: 0,
  });
  assert.equal(breakdown.godObjects.penalty, 15);
  assert.equal(score, 85);
});

test('scoreFromStats: 10 god objects → capped at 15, not 30 → score 85', () => {
  const { score, breakdown } = scoreFromStats({
    functions: 0, dead: 0, deadUnavailable: false,
    circular: 0, godObjects: 10, connections: 0, files: 0,
  });
  assert.equal(breakdown.godObjects.penalty, 15); // capped
  assert.equal(score, 85);
});

test('scoreFromStats: coupling avgCoup=3 → no penalty (threshold is exactly 3)', () => {
  const { breakdown } = scoreFromStats({
    functions: 0, dead: 0, deadUnavailable: false,
    circular: 0, godObjects: 0, connections: 30, files: 10,
  });
  // avgCoup = 30/10 = 3.0; penalty = max(0, 3-3)*2 = 0
  assert.equal(breakdown.coupling.penalty, 0);
  assert.equal(breakdown.coupling.value, 3.00);
});

test('scoreFromStats: high coupling avgCoup=10 → penalty 14 → score 86', () => {
  // avgCoup=10; penalty=min(15, max(0,10-3)*2) = min(15,14) = 14
  const { score, breakdown } = scoreFromStats({
    functions: 0, dead: 0, deadUnavailable: false,
    circular: 0, godObjects: 0, connections: 100, files: 10,
  });
  assert.equal(breakdown.coupling.penalty, 14);
  assert.equal(score, 86);
});

test('scoreFromStats: coupling penalty capped at 15', () => {
  // avgCoup=11; penalty=min(15, (11-3)*2)=min(15,16)=15
  const { breakdown } = scoreFromStats({
    functions: 0, dead: 0, deadUnavailable: false,
    circular: 0, godObjects: 0, connections: 110, files: 10,
  });
  assert.equal(breakdown.coupling.penalty, 15);
});

test('scoreFromStats: security penalty always 0, no unavailable field', () => {
  const { breakdown } = scoreFromStats({
    functions: 0, dead: 0, deadUnavailable: false,
    circular: 0, godObjects: 0, connections: 0, files: 0,
  });
  assert.equal(breakdown.security.penalty, 0);
  assert.equal(breakdown.security.note, 'not scanned');
  // WHY: the FE distinguishes "not scanned" (no unavailable) from "n/a"
  // (unavailable:true). Security must NOT have an unavailable field.
  assert.ok(!('unavailable' in breakdown.security));
});

// ── scoreFromStats: grade boundaries ─────────────────────────────────────────

test('scoreFromStats: score 90 → grade A (boundary)', () => {
  // Use 2 circular (penalty 10) to get score = 90
  const { score, grade } = scoreFromStats({
    functions: 0, dead: 0, deadUnavailable: false,
    circular: 2, godObjects: 0, connections: 0, files: 0,
  });
  assert.equal(score, 90);
  assert.equal(grade, 'A');
});

test('scoreFromStats: score 89 → grade B', () => {
  // penalty=11 to force score=89; use dead code path
  const { score, grade } = scoreFromStats({
    functions: 100, dead: 11, deadUnavailable: false,
    circular: 0, godObjects: 0, connections: 0, files: 0,
  });
  assert.equal(score, 89);
  assert.equal(grade, 'B');
});

test('scoreFromStats: score 80 → grade B (boundary)', () => {
  // 4 circular → penalty 20 → score 80
  const { score, grade } = scoreFromStats({
    functions: 0, dead: 0, deadUnavailable: false,
    circular: 4, godObjects: 0, connections: 0, files: 0,
  });
  assert.equal(score, 80);
  assert.equal(grade, 'B');
});

test('scoreFromStats: score 79 → grade C', () => {
  // 4 circular (20) + 1 god object (3) = 23 → score 77
  // Use 4 circular (20) + coupling: need 1 more point
  // 100 fns, 21 dead = 21% dead → penalty 20 (cap); + circular=0, godObjects=0
  // Actually: let's target exactly 79.
  // 4 circular (20) + coupling (avgCoup=3.5, 10 files, 35 conns) → (3.5-3)*2=1 → score=79
  const { score, grade } = scoreFromStats({
    functions: 0, dead: 0, deadUnavailable: false,
    circular: 4, godObjects: 0, connections: 35, files: 10,
  });
  assert.equal(score, 79);
  assert.equal(grade, 'C');
});

test('scoreFromStats: score 70 → grade C (boundary)', () => {
  // 4 circular (20) + 5 god objects (15) → penalty 35 → score 65? No.
  // 2 circular (10) + 5 god objects (15) + coupling: 3 + x*2 = 5 → x=1 → avgCoup=4 → 20 conns / 5 files
  // 10 + 15 + 2 = 27 → penalty 27 → score 73. Need penalty 30.
  // 2 circular (10) + 5 god objects (15) + coupling: (avgCoup-3)*2 = 5 → avgCoup=5.5 → 55 conns, 10 files → min(15,5)=5
  // total = 10+15+5 = 30 → score 70
  const { score, grade } = scoreFromStats({
    functions: 0, dead: 0, deadUnavailable: false,
    circular: 2, godObjects: 5, connections: 55, files: 10,
  });
  assert.equal(score, 70);
  assert.equal(grade, 'C');
});

test('scoreFromStats: score 60 → grade D (boundary)', () => {
  // Need penalty 40: max penalties are dead(20)+circular(20)+godObjects(15)+coupling(15)=70
  // 20 + 15 + 5 = 40: 4 circular (20) + 5 god objects (15) + coupling (55 conns / 10 files → avgCoup=5.5 → 5)
  const { score, grade } = scoreFromStats({
    functions: 0, dead: 0, deadUnavailable: false,
    circular: 4, godObjects: 5, connections: 55, files: 10,
  });
  assert.equal(score, 60);
  assert.equal(grade, 'D');
});

test('scoreFromStats: score 59 → grade F', () => {
  // 20 + 15 + 5 + 1 extra from coupling: avgCoup=5.5+0.5=6 → (6-3)*2=6 min(15,6)=6
  // 4 circular (20) + 5 godObjects (15) + 60 conns / 10 files (avgCoup=6, penalty=6) = 41 → score 59
  const { score, grade } = scoreFromStats({
    functions: 0, dead: 0, deadUnavailable: false,
    circular: 4, godObjects: 5, connections: 60, files: 10,
  });
  assert.equal(score, 59);
  assert.equal(grade, 'F');
});

test('scoreFromStats: all penalties maxed → score stays non-negative', () => {
  // Max possible penalty: 20+20+15+15 = 70 → score is 30, not below 0.
  // The formula cannot produce a negative score (caps prevent penalty > 70).
  // This test pins that invariant and confirms score = 100 − 70 = 30.
  const { score } = scoreFromStats({
    functions: 100, dead: 100, deadUnavailable: false,
    circular: 100, godObjects: 100, connections: 1000, files: 10,
  });
  assert.ok(score >= 0);
  assert.equal(score, 30); // 100 − (20+20+15+15)
});
