// tests/codeflowViz.test.mjs — unit tests for the pure CodeFlow helpers.
//
// Covers:
//   • churnColor   — threshold behaviour at exact boundaries
//   • folderColor  — determinism (same input → same output)
//   • scoreToGrade / gradeColor — grade mapping
//   • squarify     — rectangles fit within bounds, no overlap, areas ∝ values
//
// WHY pure-function tests: these helpers run in the browser but have NO
// DOM or fetch dependencies so node:test can load them directly.

import test   from 'node:test';
import assert from 'node:assert/strict';

// All pure helpers live in viz-util.js — no DOM or fetch, safe for node:test.
import { churnColor, folderColor, scoreToGrade, gradeColor, squarify }
  from '../.claude/helpers/dashboard/js/viz-util.js';

// ── churnColor ─────────────────────────────────────────────────────────────

test('churnColor: 0.8 is red (above 0.7 threshold)', () => {
  assert.equal(churnColor(0.8), '#fb7185');
});

test('churnColor: 0.5 is amber (above 0.4, not above 0.7)', () => {
  assert.equal(churnColor(0.5), '#facc15');
});

test('churnColor: 0.1 is green (below 0.4)', () => {
  assert.equal(churnColor(0.1), '#4ade80');
});

test('churnColor: exact boundary 0.7 is NOT red (> 0.7 required)', () => {
  // 0.7 is not > 0.7, so falls through to amber check (0.7 > 0.4 → amber).
  assert.equal(churnColor(0.7), '#facc15');
});

test('churnColor: exact boundary 0.4 is NOT amber (> 0.4 required)', () => {
  // 0.4 is not > 0.4, falls to green.
  assert.equal(churnColor(0.4), '#4ade80');
});

test('churnColor: 0 is green', () => {
  assert.equal(churnColor(0), '#4ade80');
});

test('churnColor: 1.0 is red', () => {
  assert.equal(churnColor(1.0), '#fb7185');
});

// ── folderColor ────────────────────────────────────────────────────────────

test('folderColor: same input → same output (stability)', () => {
  const a = folderColor('src/components');
  const b = folderColor('src/components');
  assert.equal(a, b);
});

test('folderColor: different inputs → different outputs (distribution)', () => {
  const a = folderColor('src/components');
  const b = folderColor('lib/utils');
  assert.notEqual(a, b);
});

test('folderColor: empty string is stable', () => {
  assert.equal(folderColor(''), folderColor(''));
});

test('folderColor: returns an hsl() string', () => {
  const c = folderColor('some/folder');
  assert.match(c, /^hsl\(\d+,\d+%,\d+%\)$/);
});

test('folderColor: hue is in 0–359 range', () => {
  const c = folderColor('deep/nested/path/to/something');
  const hue = parseInt(c.match(/^hsl\((\d+)/)[1], 10);
  assert.ok(hue >= 0 && hue < 360, `hue ${hue} out of range`);
});

// ── scoreToGrade ───────────────────────────────────────────────────────────

test('scoreToGrade: 90 → A', () => { assert.equal(scoreToGrade(90), 'A'); });
test('scoreToGrade: 95 → A', () => { assert.equal(scoreToGrade(95), 'A'); });
test('scoreToGrade: 89 → B', () => { assert.equal(scoreToGrade(89), 'B'); });
test('scoreToGrade: 80 → B', () => { assert.equal(scoreToGrade(80), 'B'); });
test('scoreToGrade: 79 → C', () => { assert.equal(scoreToGrade(79), 'C'); });
test('scoreToGrade: 70 → C', () => { assert.equal(scoreToGrade(70), 'C'); });
test('scoreToGrade: 69 → D', () => { assert.equal(scoreToGrade(69), 'D'); });
test('scoreToGrade: 60 → D', () => { assert.equal(scoreToGrade(60), 'D'); });
test('scoreToGrade: 59 → F', () => { assert.equal(scoreToGrade(59), 'F'); });
test('scoreToGrade: 0  → F', () => { assert.equal(scoreToGrade(0),  'F'); });

// ── gradeColor ─────────────────────────────────────────────────────────────

test('gradeColor: A → green', () => { assert.equal(gradeColor('A'), 'var(--green)'); });
test('gradeColor: B → green', () => { assert.equal(gradeColor('B'), 'var(--green)'); });
test('gradeColor: C → amber', () => { assert.equal(gradeColor('C'), 'var(--amber)'); });
test('gradeColor: D → amber', () => { assert.equal(gradeColor('D'), 'var(--amber)'); });
test('gradeColor: F → red',   () => { assert.equal(gradeColor('F'), 'var(--red)');   });

// ── squarify ───────────────────────────────────────────────────────────────

const W = 800, H = 600;

/** All tiles returned by squarify() for a given input set. */
function tiles(items) { return squarify(items, W, H); }

test('squarify: returns one rect per item', () => {
  const items = [
    { value: 10 }, { value: 20 }, { value: 30 }, { value: 40 },
  ];
  assert.equal(tiles(items).length, items.length);
});

test('squarify: all rects fit within container bounds', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ value: (i + 1) * 5 }));
  for (const t of tiles(items)) {
    assert.ok(t.x >= -0.5,           `x ${t.x} < 0`);
    assert.ok(t.y >= -0.5,           `y ${t.y} < 0`);
    assert.ok(t.x + t.w <= W + 0.5,  `right edge ${t.x + t.w} > W`);
    assert.ok(t.y + t.h <= H + 0.5,  `bottom edge ${t.y + t.h} > H`);
  }
});

test('squarify: total area of tiles ≈ container area (within 1%)', () => {
  const items = [
    { value: 100 }, { value: 200 }, { value: 300 },
    { value: 50  }, { value: 75  }, { value: 175 },
  ];
  const result = tiles(items);
  const totalTileArea = result.reduce((s, t) => s + t.w * t.h, 0);
  const containerArea = W * H;
  const diff = Math.abs(totalTileArea - containerArea) / containerArea;
  assert.ok(diff < 0.01, `area diff ${(diff * 100).toFixed(2)}% exceeds 1%`);
});

test('squarify: larger value → larger area', () => {
  const items = [
    { value: 300, id: 'big' },
    { value: 10,  id: 'small' },
  ];
  const result = tiles(items);
  const big   = result.find(t => t.id === 'big');
  const small = result.find(t => t.id === 'small');
  assert.ok(big.w * big.h > small.w * small.h, 'big tile should have bigger area');
});

test('squarify: no overlapping rectangles', () => {
  const items = Array.from({ length: 15 }, (_, i) => ({ value: (i + 1) * 7 }));
  const result = tiles(items);
  for (let i = 0; i < result.length; i++) {
    for (let j = i + 1; j < result.length; j++) {
      const a = result[i], b = result[j];
      // Two rects overlap if neither is fully to one side of the other.
      const noOverlap =
        a.x + a.w <= b.x + 0.5 || b.x + b.w <= a.x + 0.5 ||
        a.y + a.h <= b.y + 0.5 || b.y + b.h <= a.y + 0.5;
      assert.ok(noOverlap, `tiles ${i} and ${j} overlap`);
    }
  }
});

test('squarify: empty input returns empty array', () => {
  assert.deepEqual(squarify([], W, H), []);
});

test('squarify: single item fills entire container', () => {
  const result = squarify([{ value: 42 }], W, H);
  assert.equal(result.length, 1);
  assert.ok(Math.abs(result[0].w - W) < 0.5);
  assert.ok(Math.abs(result[0].h - H) < 0.5);
});

test('squarify: zero-dimension container returns empty array', () => {
  assert.deepEqual(squarify([{ value: 10 }], 0, H), []);
  assert.deepEqual(squarify([{ value: 10 }], W, 0), []);
});
