/**
 * Router scoring — the automatic skill-injection decision.
 * Run: node --test tests/routerScoring.test.mjs
 *
 * Context: the router injected a skill ONCE in 1,222 logged decisions across two
 * months. The scorer divided shared tokens by max(prompt, description), so a
 * 5-token prompt matching an 80-token description perfectly scored 0.06 against
 * a 0.30 threshold — the better a description was written, the less it could
 * ever be selected. Swapping to min() inverted the failure: replaying 800 real
 * prompts fired on 41% of them, matching "even with the max plan ?" to a
 * migration agent on the shared word "plan".
 *
 * These tests pin the properties that make both failures impossible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildIdf, weightedCoverage, tokenize } = require('../.claude/helpers/router.cjs');

/** Build a corpus + scorer the way routeTask does. */
function corpus(descriptions) {
  const skills = descriptions.map((d, i) => ({ name: `skill-${i}`, tokens: new Set(tokenize(d)) }));
  return { skills, idf: buildIdf(skills) };
}

const score = (prompt, descIndex, c) =>
  weightedCoverage(new Set(tokenize(prompt)), c.skills[descIndex].tokens, c.idf);

test('a long, well-written description is not penalized for its length', () => {
  // The original bug: denominator was max(prompt, description), so richer
  // descriptions scored strictly worse. Same prompt, same matched terms —
  // the verbose description must not score below the terse one.
  const terse = 'thermal spray coating';
  const rich  = 'thermal spray coating expert covering pre-grit weight capture, cart status '
              + 'transitions, powder lot tracking, dashboards, AEP two-pass flow, and machine '
              + 'driven line assignment across the production pipeline for turbine components';
  const c = corpus([terse, rich]);
  const p = 'the thermal spray coating weight page is wrong';
  assert.ok(score(p, 1, c) >= score(p, 0, c) * 0.75,
    'a detailed description must stay competitive with a terse one');
  assert.ok(score(p, 1, c) > 0, 'the detailed description must still match at all');
});

test('one incidental common word cannot select a skill', () => {
  // "even with the max plan ?" -> agent-migration-plan, purely on "plan".
  const c = corpus([
    'migration plan for converting commands to agents',
    'planning and roadmap strategy',
    'plan the release',
    'frontend react components and plan layout',
  ]);
  for (let i = 0; i < 4; i++) {
    assert.equal(score('even with the max plan ?', i, c), 0,
      'a single ubiquitous term must not produce a match');
  }
});

test('a short prompt cannot reach a high score on coverage alone', () => {
  // Coverage is a ratio, so a 1-2 token prompt trivially "covers" 100%.
  // "how is the deploy" scored a perfect 1.00 before evidence dampening.
  const c = corpus(['deployment preparation and release checklist for production deploys']);
  const s = score('how is the deploy', 0, c);
  assert.ok(s < 0.6, `a thin prompt must not reach full-injection confidence (got ${s.toFixed(2)})`);
});

test('a specific, information-dense prompt scores well', () => {
  const c = corpus([
    'thermal spray production expert: pre-grit and thermal weight pages, coating analysis, cart status',
    'frontend react typescript components and routing',
  ]);
  const s = score('the thermal spray pre-grit weight page is not saving coating values', 0, c);
  assert.ok(s >= 0.3, `a clearly on-topic request should reach injection (got ${s.toFixed(2)})`);
  assert.ok(s > score('the thermal spray pre-grit weight page is not saving coating values', 1, c),
    'the on-topic skill must outrank the unrelated one');
});

test('rare terms outweigh ubiquitous ones', () => {
  // Every description mentions "code"; only one mentions "powder".
  const c = corpus([
    'code review for powder lot inventory and material usage',
    'code formatting and style',
    'code generation scaffolding',
    'code search and navigation',
  ]);
  const onPowder = score('powder lot inventory is wrong', 0, c);
  const onCode   = score('code code code', 1, c);
  assert.ok(onPowder > onCode, 'a distinctive term must beat a saturated one');
});

test('empty and degenerate inputs are safe', () => {
  const c = corpus(['some skill description here']);
  assert.equal(weightedCoverage(new Set(), c.skills[0].tokens, c.idf), 0);
  assert.equal(weightedCoverage(new Set(tokenize('anything')), new Set(), c.idf), 0);
  assert.equal(score('', 0, c), 0);
});

test('scores stay within 0..1', () => {
  const c = corpus(['thermal spray coating powder lot cart status weight']);
  for (const p of ['thermal spray coating powder lot cart status weight', 'thermal', 'unrelated words entirely']) {
    const s = score(p, 0, c);
    assert.ok(s >= 0 && s <= 1, `${p} -> ${s} out of range`);
  }
});
