'use strict';
// Pure, deterministic flow → Excalidraw converter. No randomness or clock reads,
// so the same flow always yields a byte-identical document (nightly re-runs don't
// churn files, and tests can assert determinism).

const NODE_W = 200, NODE_H = 64, H_GAP = 80, V_GAP = 56;

// First-seen BFS rank from source nodes (no incoming edges). Each node is enqueued
// at most once, so it terminates on cycles; back-edges to already-ranked nodes are skipped.
function layeredLayout(nodes, edges) {
  const ids = new Set(nodes.map(n => n.node_id));
  const adj = new Map(nodes.map(n => [n.node_id, []]));
  const indeg = new Map(nodes.map(n => [n.node_id, 0]));
  for (const e of edges) {
    if (ids.has(e.source) && ids.has(e.target)) {
      adj.get(e.source).push(e.target);
      indeg.set(e.target, indeg.get(e.target) + 1);
    }
  }
  const rank = new Map();
  const queue = [];
  for (const n of nodes) if (indeg.get(n.node_id) === 0) { rank.set(n.node_id, 0); queue.push(n.node_id); }
  if (queue.length === 0 && nodes.length) { rank.set(nodes[0].node_id, 0); queue.push(nodes[0].node_id); }
  while (queue.length) {
    const id = queue.shift();
    const r = rank.get(id);
    for (const t of adj.get(id) || []) {
      if (!rank.has(t)) { rank.set(t, r + 1); queue.push(t); }
    }
  }
  for (const n of nodes) if (!rank.has(n.node_id)) rank.set(n.node_id, 0);
  const byRank = new Map();
  for (const n of nodes) {
    const r = rank.get(n.node_id);
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r).push(n);
  }
  const pos = new Map();
  for (const [r, group] of [...byRank.entries()].sort((a, b) => a[0] - b[0])) {
    group.forEach((n, i) => pos.set(n.node_id, { x: i * (NODE_W + H_GAP), y: r * (NODE_H + V_GAP) }));
  }
  return pos;
}

// Common element fields with deterministic seed/nonce keyed off element index.
function base(i, extra) {
  return Object.assign({
    angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
    fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 1,
    opacity: 100, groupIds: [], frameId: null, roundness: null,
    seed: 100001 + i, version: 1, versionNonce: 200001 + i, isDeleted: false,
    boundElements: null, updated: 1, link: null, locked: false,
  }, extra);
}

function toExcalidraw({ flow, nodes, edges } = {}) {
  nodes = nodes || []; edges = edges || [];
  const pos = layeredLayout(nodes, edges);
  const elements = [];
  let i = 0;
  for (const n of nodes) {
    const p = pos.get(n.node_id) || { x: 0, y: 0 };
    const rectId = `r-${n.node_id}`;
    const textId = `t-${n.node_id}`;
    const fill = n.terminal ? '#f1f3f5' : (n.ambiguous ? '#ffec99' : '#a5d8ff');
    elements.push(base(i++, {
      id: rectId, type: 'rectangle', x: p.x, y: p.y, width: NODE_W, height: NODE_H,
      backgroundColor: fill, fillStyle: 'solid', roundness: { type: 3 },
      boundElements: [{ id: textId, type: 'text' }],
    }));
    const label = String(n.label || n.node_id).slice(0, 40);
    elements.push(base(i++, {
      id: textId, type: 'text', x: p.x + 8, y: p.y + NODE_H / 2 - 10,
      width: NODE_W - 16, height: 20, text: label, originalText: label,
      fontSize: 14, fontFamily: 3, textAlign: 'center', verticalAlign: 'middle',
      containerId: rectId, lineHeight: 1.25, strokeColor: '#1e1e1e',
    }));
  }
  const havePos = new Set(nodes.map(n => n.node_id));
  for (const e of edges) {
    if (!havePos.has(e.source) || !havePos.has(e.target)) continue;
    const s = pos.get(e.source), t = pos.get(e.target);
    const sx = s.x + NODE_W / 2, sy = s.y + NODE_H;
    const tx = t.x + NODE_W / 2, ty = t.y;
    elements.push(base(i++, {
      id: `a-${e.source}-${e.target}`, type: 'arrow',
      x: sx, y: sy, width: tx - sx, height: ty - sy,
      points: [[0, 0], [tx - sx, ty - sy]],
      lastCommittedPoint: null,
      startBinding: { elementId: `r-${e.source}`, focus: 0, gap: 4 },
      endBinding: { elementId: `r-${e.target}`, focus: 0, gap: 4 },
      startArrowhead: null, endArrowhead: 'arrow',
    }));
  }
  return {
    type: 'excalidraw', version: 2,
    source: 'vaultflow:flow-excalidraw',
    elements,
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
    files: {},
  };
}

module.exports = { toExcalidraw, layeredLayout };
