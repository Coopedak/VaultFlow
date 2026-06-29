/**
 * viz-util.js — Shared color + layout helpers for the CodeFlow visualisations.
 *
 * Exported pure functions so that tests/codeflowViz.test.mjs can import them
 * without a DOM or fetch context.
 *
 * WHY a separate module: both code-graph.js and treemap.js need churnColor and
 * folderColor. Keeping them here avoids duplicating the logic and makes the
 * pure-function tests trivial to wire up.
 */

/**
 * Map a churn ratio (0..1) to a traffic-light color string.
 * Matches the legend: red > 0.7, orange > 0.4, green otherwise.
 * @param {number} ratio
 * @returns {string} CSS color
 */
export function churnColor(ratio) {
  if (ratio > 0.7) return '#fb7185'; // var(--red)
  if (ratio > 0.4) return '#facc15'; // var(--amber)
  return '#4ade80';                  // var(--green)
}

/**
 * Map a folder path string to a stable hsl color.
 * "Stable" means identical input → identical output across calls; the hash is
 * deterministic and does NOT depend on call order or insertion order.
 *
 * Uses djb2 so the distribution is reasonable without a crypto import.
 * Saturation and lightness are fixed to stay readable on the dark Synapse theme.
 *
 * @param {string} folder
 * @returns {string} CSS hsl() color
 */
export function folderColor(folder) {
  const s = String(folder || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0; // keep unsigned 32-bit
  }
  const hue = h % 360;
  return `hsl(${hue},55%,58%)`;
}

/**
 * Map a 0-100 health score to an A–F letter grade.
 * @param {number} score
 * @returns {string}
 */
export function scoreToGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/**
 * Map a grade letter to a CSS color variable string (using Synapse palette).
 * A/B → green, C/D → amber, F → red.
 * @param {string} grade
 * @returns {string} CSS var() expression
 */
export function gradeColor(grade) {
  if (grade === 'A' || grade === 'B') return 'var(--green)';
  if (grade === 'C' || grade === 'D') return 'var(--amber)';
  return 'var(--red)';
}

/**
 * Squarified treemap layout (Bruls et al. 2000).
 *
 * PURE — no DOM, no fetch. Kept here so tests can import from viz-util.js
 * without pulling in any module that touches window.
 *
 * @param {Array<{value:number, [key:string]:any}>} items  - value > 0. Sort descending for best aspect ratios.
 * @param {number} W  - Container width  (px)
 * @param {number} H  - Container height (px)
 * @returns {Array<{x:number, y:number, w:number, h:number, [key:string]:any}>}
 */
export function squarify(items, W, H) {
  if (!items || !items.length || W <= 0 || H <= 0) return [];

  const total = items.reduce((s, n) => s + (n.value || 0), 0);
  if (total <= 0) return [];

  const area   = W * H;
  const result = [];

  // Scale each item's value to its proportional area in the container.
  const normed = items.map(it => ({ ...it, _area: (it.value / total) * area }));

  function worst(rowNodes, rowLen) {
    if (!rowNodes.length) return Infinity;
    const ra   = rowNodes.reduce((s, n) => s + n._area, 0);
    const maxA = Math.max(...rowNodes.map(n => n._area));
    const minA = Math.min(...rowNodes.map(n => n._area));
    const l2   = rowLen * rowLen;
    return Math.max((l2 * maxA) / (ra * ra), (ra * ra) / (l2 * minA));
  }

  function layout(nodes, x, y, w, h) {
    if (!nodes.length) return;
    if (nodes.length === 1) {
      result.push({ ...nodes[0], x, y, w, h });
      return;
    }

    const rowLen = Math.min(w, h); // shorter dimension drives the strip
    const row    = [];
    let i;
    for (i = 0; i < nodes.length; i++) {
      const candidate = [...row, nodes[i]];
      // Commit row when adding another item would worsen the worst aspect ratio.
      if (row.length && worst(candidate, rowLen) > worst(row, rowLen)) break;
      row.push(nodes[i]);
    }

    const ra = row.reduce((s, n) => s + n._area, 0);

    if (w >= h) {
      // Horizontal strip — tiles stacked vertically on the left edge.
      const stripW = ra / h;
      let curY = y;
      for (const node of row) {
        const tileH = (node._area / ra) * h;
        result.push({ ...node, x, y: curY, w: stripW, h: tileH });
        curY += tileH;
      }
      layout(nodes.slice(i), x + stripW, y, w - stripW, h);
    } else {
      // Vertical strip — tiles stacked horizontally on the top edge.
      const stripH = ra / w;
      let curX = x;
      for (const node of row) {
        const tileW = (node._area / ra) * w;
        result.push({ ...node, x: curX, y, w: tileW, h: stripH });
        curX += tileW;
      }
      layout(nodes.slice(i), x, y + stripH, w, h - stripH);
    }
  }

  layout(normed, 0, 0, W, H);
  return result;
}
