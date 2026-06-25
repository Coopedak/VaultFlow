// tests/flowExcalidraw.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { toExcalidraw, layeredLayout } = require('../.claude/helpers/flow-excalidraw.cjs');

const FLOW = {
  flow: { id: 'f1', project: 'proj', name: 'auth · login' },
  nodes: [
    { node_id: 'a', label: 'loginHandler', kind: 'function', file: 'x', terminal: 0, ambiguous: 0 },
    { node_id: 'b', label: 'validate',     kind: 'function', file: 'x', terminal: 0, ambiguous: 1 },
    { node_id: 'c', label: 'db.query',     kind: 'function', file: 'x', terminal: 1, ambiguous: 0 },
  ],
  edges: [ { source: 'a', target: 'b', kind: 'calls' }, { source: 'b', target: 'c', kind: 'calls' } ],
};

test('toExcalidraw emits a valid excalidraw doc shape', () => {
  const d = toExcalidraw(FLOW);
  assert.equal(d.type, 'excalidraw');
  assert.equal(d.version, 2);
  assert.ok(Array.isArray(d.elements));
  assert.deepEqual(Object.keys(d).sort(), ['appState','elements','files','source','type','version']);
});

test('one rectangle + one text per node, one arrow per edge', () => {
  const d = toExcalidraw(FLOW);
  const rects = d.elements.filter(e => e.type === 'rectangle');
  const texts = d.elements.filter(e => e.type === 'text');
  const arrows = d.elements.filter(e => e.type === 'arrow');
  assert.equal(rects.length, 3);
  assert.equal(texts.length, 3);
  assert.equal(arrows.length, 2);
});

test('text is bound to its rectangle and labels match', () => {
  const d = toExcalidraw(FLOW);
  const rect = d.elements.find(e => e.type === 'rectangle' && e.id === 'r-a');
  const text = d.elements.find(e => e.type === 'text' && e.containerId === 'r-a');
  assert.ok(rect.boundElements.some(b => b.id === text.id && b.type === 'text'));
  assert.equal(text.text, 'loginHandler');
});

test('arrows bind source and target rectangles', () => {
  const d = toExcalidraw(FLOW);
  const arr = d.elements.find(e => e.type === 'arrow');
  assert.equal(arr.startBinding.elementId, 'r-a');
  assert.equal(arr.endBinding.elementId, 'r-b');
  assert.equal(arr.endArrowhead, 'arrow');
  assert.equal(arr.points.length, 2);
});

test('terminal and ambiguous nodes get distinct fills', () => {
  const d = toExcalidraw(FLOW);
  const norm = d.elements.find(e => e.id === 'r-a').backgroundColor;
  const amb  = d.elements.find(e => e.id === 'r-b').backgroundColor;
  const term = d.elements.find(e => e.id === 'r-c').backgroundColor;
  assert.notEqual(norm, amb);
  assert.notEqual(norm, term);
});

test('output is deterministic (no random/date)', () => {
  assert.equal(JSON.stringify(toExcalidraw(FLOW)), JSON.stringify(toExcalidraw(FLOW)));
});

test('layeredLayout terminates on a cycle and positions every node', () => {
  const nodes = [{node_id:'a'},{node_id:'b'}];
  const edges = [{source:'a',target:'b'},{source:'b',target:'a'}];
  const pos = layeredLayout(nodes, edges);
  assert.ok(pos.get('a') && pos.get('b'));
});
