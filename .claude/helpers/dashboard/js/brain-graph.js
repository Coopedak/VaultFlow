/**
 * brain-graph.js — Brain Graph view for the Synapse v2 dashboard.
 *
 * Ports v1 Brain tab (app.js ~1033-1251) to the v2 module pattern.
 *
 * Layout:
 *   TOP BAR   — depth selector, reset, search, pulse toggle
 *   3-col body:
 *     LEFT     — Mission Control strip + Model Recommendations table
 *     CENTER   — Cytoscape knowledge graph (full height)
 *     RIGHT    — Note pane (type chip · title · meta · body · links)
 *   BOTTOM     — 2 vitals line charts (Pattern Fires · Memory Count)
 *
 * Lifecycles (all module-scoped to survive re-routes):
 *   Cytoscape  — `_cy`   destroyed before re-create on every loadBrain call
 *   Charts     — `_cFires`, `_cMemory`  destroyed before re-create on loadVitals
 *   EventSource — `_es`  closed before re-open; also closed on hash-away
 *
 * Consumes:
 *   GET  /api/brain/graph?limit=150&depth=N[&center=id]
 *   GET  /api/brain/note?id=<id>
 *   GET  /api/brain/mission
 *   GET  /api/brain/snapshots?days=30
 *   GET  /api/brain/events          (SSE)
 *   GET  /api/model/recommendations
 *   POST /api/model/recommendations/accept   { agent }
 *
 * Globals:  window.cytoscape (UMD), window.markdownit (UMD)
 * Imports:  api, registerView from core.js; line from charts.js
 */

import { api, registerView } from './core.js';
import { line } from './charts.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const md = window.markdownit ? window.markdownit({ html: false, linkify: true, breaks: false }) : null;

function mdToHtml(src) {
  if (!src) return '';
  if (md) return md.render(String(src));
  // Minimal fallback when markdownit not loaded
  return String(src).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
}

// ── node type → color (mirrors v1 BRAIN_COLORS) ───────────────────────────────

const BRAIN_COLORS = {
  project: '#f59e0b', session: '#6366f1', file: '#22d3ee', symbol: '#a78bfa',
  memory:  '#34d399', skill:   '#f472b6', pattern: '#fb7185', prompt: '#94a3b8',
  commit:  '#facc15',
};
function brainColor(type) { return BRAIN_COLORS[String(type || '').toLowerCase()] || '#888'; }

// ── pulse event kind → flash color ───────────────────────────────────────────

const PULSE_KINDS = {
  edit: '#22d3ee', prompt: '#94a3b8', tool: '#a78bfa', inject: '#f472b6', route: '#64748b',
};

// ── scoped CSS ────────────────────────────────────────────────────────────────

const BG_CSS = `
  .bg-root {
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: calc(100vh - 90px);
    min-height: 540px;
    overflow: hidden;
  }

  /* topbar row */
  .bg-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }
  .bg-toolbar label {
    font: 11px/1 var(--mono);
    color: var(--muted);
  }
  .bg-select, .bg-input {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 7px;
    color: var(--text);
    padding: 5px 9px;
    font: 12px var(--ui);
    outline: none;
  }
  .bg-select:focus, .bg-input:focus { border-color: var(--accent); }
  .bg-input { width: 180px; }
  .bg-btn {
    padding: 5px 13px;
    border-radius: 7px;
    border: 1px solid var(--border);
    background: var(--panel-2);
    color: var(--text);
    font: 600 11px/1 var(--ui);
    cursor: pointer;
    transition: background .12s, border-color .12s;
  }
  .bg-btn:hover { background: var(--panel); }
  .bg-btn-accent {
    background: rgba(52,225,255,.1);
    border-color: rgba(52,225,255,.35);
    color: var(--accent);
  }
  .bg-btn-accent:hover { background: rgba(52,225,255,.18); }
  .bg-pulse-label {
    font: 11px/1 var(--mono);
    color: var(--muted);
    margin-left: 4px;
  }
  .bg-ticker {
    font: 11px/1 var(--mono);
    color: var(--muted);
    margin-left: auto;
    padding-right: 4px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* 3-col body */
  .bg-body {
    display: grid;
    grid-template-columns: 200px 1fr 280px;
    gap: 12px;
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
  }

  /* LEFT col */
  .bg-left {
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
    min-height: 0;
  }
  .bg-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 14px;
  }
  .bg-sec {
    font: 700 10px/1 var(--mono);
    letter-spacing: .12em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 8px;
  }
  .bg-mission-strip {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .bg-stat-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 4px 0;
  }
  .bg-stat-label {
    font: 11px/1 var(--mono);
    color: var(--muted);
  }
  .bg-stat-val {
    font: 700 14px/1 var(--mono);
    color: var(--text);
  }

  /* rec table */
  .bg-rec-table {
    width: 100%;
    border-collapse: collapse;
    font: 11px/1.4 var(--mono);
  }
  .bg-rec-table th {
    font: 700 9px/1 var(--mono);
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--muted);
    padding: 0 4px 6px 0;
    text-align: left;
  }
  .bg-rec-table td {
    color: var(--text);
    padding: 3px 4px 3px 0;
    border-top: 1px solid var(--border);
    vertical-align: middle;
  }
  .bg-accept-btn {
    padding: 3px 9px;
    border-radius: 5px;
    border: 1px solid rgba(52,225,255,.3);
    background: rgba(52,225,255,.07);
    color: var(--accent);
    font: 600 10px/1 var(--mono);
    cursor: pointer;
  }
  .bg-accept-btn:hover { background: rgba(52,225,255,.15); }

  /* CENTER — graph */
  .bg-center {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    position: relative;
    overflow: hidden;
  }
  .bg-graph-el {
    width: 100%;
    height: 100%;
  }
  .bg-meta {
    position: absolute;
    bottom: 8px;
    left: 12px;
    font: 10px/1 var(--mono);
    color: var(--muted);
    pointer-events: none;
  }

  /* RIGHT col — note pane */
  .bg-right {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow-y: auto;
    padding: 14px;
    min-height: 0;
  }
  .bg-note-empty {
    color: var(--muted);
    font: 13px/1.6 var(--ui);
  }
  .bn-type {
    display: inline-block;
    font: 700 9px/1 var(--mono);
    padding: 2px 8px;
    border-radius: 10px;
    color: #0e0e16;
    margin-bottom: 8px;
    letter-spacing: .06em;
    text-transform: uppercase;
  }
  .bn-title {
    font: 700 15px/1.3 var(--ui);
    color: var(--text);
    margin-bottom: 8px;
    word-break: break-all;
  }
  .bn-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-bottom: 8px;
  }
  .bn-meta span {
    font: 10px/1 var(--mono);
    color: var(--muted);
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 2px 6px;
  }
  .bn-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-bottom: 8px;
  }
  .bn-tag {
    font: 10px/1 var(--mono);
    color: var(--accent);
    background: rgba(52,225,255,.08);
    border: 1px solid rgba(52,225,255,.2);
    border-radius: 5px;
    padding: 2px 6px;
  }
  .bn-body {
    font: 13px/1.65 var(--ui);
    color: var(--text);
    margin-bottom: 12px;
    overflow-wrap: break-word;
  }
  .bn-body code { font-family: var(--mono); font-size: 11px; background: var(--panel-2); padding: 1px 4px; border-radius: 3px; }
  .bn-body pre  { background: var(--panel-2); border-radius: 6px; padding: 10px; overflow-x: auto; margin: 8px 0; }
  .bn-body pre code { background: none; padding: 0; }
  .bn-section {
    margin-top: 10px;
  }
  .bn-section h4 {
    font: 700 10px/1 var(--mono);
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 6px;
  }
  .bn-link {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 4px 0;
    cursor: pointer;
    font: 12px/1.3 var(--ui);
    color: var(--text);
    border-radius: 5px;
    transition: color .1s;
  }
  .bn-link:hover { color: var(--accent); }
  .bn-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* BOTTOM — vitals charts */
  .bg-vitals {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    height: 120px;
    flex-shrink: 0;
  }
  .bg-chart-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 14px;
    position: relative;
    overflow: hidden;
  }
  .bg-chart-label {
    font: 700 9px/1 var(--mono);
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 6px;
  }
  .bg-chart-wrap {
    height: 70px;
    position: relative;
  }
`;

// ── module-scoped lifecycle vars ──────────────────────────────────────────────

let _cy      = null;   // Cytoscape instance
let _cFires  = null;   // Chart — pattern fires
let _cMemory = null;   // Chart — memory count
let _es      = null;   // EventSource — live pulse

// Close the SSE when the user navigates to another hash
window.addEventListener('hashchange', () => {
  const hash = location.hash.replace(/^#\/?/, '');
  if (hash !== 'brain-graph' && _es) {
    _es.close();
    _es = null;
  }
});

// ── Cytoscape builder ─────────────────────────────────────────────────────────

function buildBrainElements(g) {
  const nodes = (g.nodes || []).map(n => ({
    data: { id: n.id, label: n.label, type: n.type, weight: n.weight },
  }));
  const edges = (g.edges || []).map((e, i) => ({
    data: { id: `be${i}`, source: e.source, target: e.target, kind: e.kind },
  }));
  return [...nodes, ...edges];
}

// ── view ──────────────────────────────────────────────────────────────────────

registerView('brain-graph', async (el) => {

  // Inject scoped styles once
  if (!document.getElementById('bg-styles')) {
    const style = document.createElement('style');
    style.id = 'bg-styles';
    style.textContent = BG_CSS;
    document.head.appendChild(style);
  }

  // ── scaffold ────────────────────────────────────────────────────────────────
  el.innerHTML = `
    <div class="topbar">
      <h1>Brain</h1>
      <span class="crumb">/ brain / graph</span>
    </div>

    <div class="bg-root">

      <!-- toolbar -->
      <div class="bg-toolbar">
        <label>Depth</label>
        <select class="bg-select" id="bg-depth">
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
        </select>
        <button class="bg-btn bg-btn-accent" id="bg-reset">Reset</button>
        <input class="bg-input" id="bg-search" placeholder="Search memory… (Enter)" type="search" autocomplete="off" spellcheck="false" />
        <label><input type="checkbox" id="bg-pulse-toggle" /> <span class="bg-pulse-label">Live pulse</span></label>
        <span class="bg-ticker" id="bg-ticker"></span>
      </div>

      <!-- 3-col body -->
      <div class="bg-body">

        <!-- LEFT: mission + model recs -->
        <div class="bg-left">
          <div class="bg-card">
            <div class="bg-sec">Mission Control</div>
            <div class="bg-mission-strip" id="bg-mission">
              <div class="bg-note-empty">Loading…</div>
            </div>
          </div>
          <div class="bg-card" style="flex:1 1 0;overflow-y:auto">
            <div class="bg-sec">Model Recs</div>
            <table class="bg-rec-table">
              <thead><tr>
                <th>Agent</th><th>Model</th><th>From</th><th></th>
              </tr></thead>
              <tbody id="bg-recs-body">
                <tr><td colspan="4" class="bg-note-empty">Loading…</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- CENTER: Cytoscape graph -->
        <div class="bg-center">
          <div class="bg-graph-el" id="bg-graph"></div>
          <div class="bg-meta" id="bg-meta"></div>
        </div>

        <!-- RIGHT: note pane -->
        <div class="bg-right" id="bg-note">
          <div class="bg-note-empty">Click a node to read its note.</div>
        </div>

      </div>

      <!-- BOTTOM: vitals charts -->
      <div class="bg-vitals">
        <div class="bg-chart-card">
          <div class="bg-chart-label">Pattern Fires</div>
          <div class="bg-chart-wrap"><canvas id="bg-chart-fires"></canvas></div>
        </div>
        <div class="bg-chart-card">
          <div class="bg-chart-label">Memory Count</div>
          <div class="bg-chart-wrap"><canvas id="bg-chart-memory"></canvas></div>
        </div>
      </div>

    </div>`;

  // ── element refs ─────────────────────────────────────────────────────────────
  const depthSel  = el.querySelector('#bg-depth');
  const resetBtn  = el.querySelector('#bg-reset');
  const searchIn  = el.querySelector('#bg-search');
  const pulseChk  = el.querySelector('#bg-pulse-toggle');
  const tickerEl  = el.querySelector('#bg-ticker');
  const graphEl   = el.querySelector('#bg-graph');
  const metaEl    = el.querySelector('#bg-meta');
  const noteEl    = el.querySelector('#bg-note');
  const missionEl = el.querySelector('#bg-mission');
  const recsBody  = el.querySelector('#bg-recs-body');

  // ── module-scoped state for this render cycle ─────────────────────────────
  let brainCurrent = null;   // currently-opened node id

  // ── graph highlight helpers ───────────────────────────────────────────────
  function brainHighlight(id) {
    if (!_cy) return;
    _cy.elements().removeClass('faded hl');
    const n = _cy.getElementById(id);
    if (!n || !n.length) return;
    _cy.elements().addClass('faded');
    n.closedNeighborhood().removeClass('faded');
    n.addClass('hl');
  }

  function brainHoverOn(node) {
    if (!_cy) return;
    _cy.elements().addClass('faded');
    node.closedNeighborhood().removeClass('faded');
    node.addClass('hover');
  }

  function brainHoverOff() {
    if (!_cy) return;
    _cy.nodes().removeClass('hover');
    _cy.elements().removeClass('faded');
    if (brainCurrent) brainHighlight(brainCurrent);
  }

  // ── renderBrain ───────────────────────────────────────────────────────────
  function renderBrain(g) {
    metaEl.textContent =
      `${g.meta?.mode || ''} · ${g.meta?.nodeCount ?? 0} nodes · ${g.meta?.edgeCount ?? 0} edges` +
      (g.meta?.truncated ? ' · truncated' : '');

    // Destroy existing instance before re-create
    if (_cy) { _cy.destroy(); _cy = null; }

    if (!window.cytoscape) {
      graphEl.innerHTML = '<div style="color:var(--muted);padding:16px">Cytoscape not loaded.</div>';
      return;
    }

    _cy = window.cytoscape({
      container: graphEl,
      elements:  buildBrainElements(g),
      style: [
        { selector: 'node', style: {
          'background-color':  (n) => brainColor(n.data('type')),
          'label':             'data(label)',
          'color':             '#cbd5e1',
          'font-size':         9,
          'width':             (n) => 14 + Math.min(34, Math.sqrt(n.data('weight') || 1) * 7),
          'height':            (n) => 14 + Math.min(34, Math.sqrt(n.data('weight') || 1) * 7),
          'border-width':      0,
          'border-color':      '#e8e8f0',
          'text-wrap':         'ellipsis',
          'text-max-width':    90,
          'min-zoomed-font-size': 6,
          'transition-property':  'opacity',
          'transition-duration':  '120ms',
        }},
        { selector: 'edge', style: {
          'width':               1,
          'line-color':          '#34344a',
          'target-arrow-color':  '#34344a',
          'target-arrow-shape':  'triangle',
          'arrow-scale':         0.55,
          'curve-style':         'bezier',
          'opacity':             0.5,
        }},
        { selector: 'node.hl',    style: { 'border-width': 3, 'border-color': '#e8e8f0' } },
        { selector: 'node.hover', style: { 'border-width': 3, 'border-color': '#ffffff' } },
        { selector: '.faded',     style: { 'opacity': 0.12 } },
        { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#ffffff' } },
      ],
      layout: { name: 'cose', animate: false, nodeRepulsion: 9000, idealEdgeLength: 90, padding: 20 },
    });

    _cy.on('tap', 'node',  (evt) => brainExpand(evt.target.id()));
    _cy.on('tap',          (evt) => { if (evt.target === _cy) _cy.elements().removeClass('faded'); });
    _cy.on('mouseover', 'node', (evt) => brainHoverOn(evt.target));
    _cy.on('mouseout',  'node', () => brainHoverOff());

    if (brainCurrent) brainHighlight(brainCurrent);
  }

  // ── brainExpand: re-center graph + open note ──────────────────────────────
  async function brainExpand(nodeId) {
    brainCurrent = nodeId;
    const depth = depthSel.value || 1;
    const g = await api(
      `/api/brain/graph?center=${encodeURIComponent(nodeId)}&depth=${depth}&limit=150`
    ).catch(() => null);
    if (g) renderBrain(g);
    brainHighlight(nodeId);
    brainOpenNote(nodeId);
  }

  // ── brainOpenNote: fetch + render note in right pane ─────────────────────
  async function brainOpenNote(nodeId) {
    noteEl.innerHTML = '<div class="bg-note-empty">Loading…</div>';
    const note = await api(`/api/brain/note?id=${encodeURIComponent(nodeId)}`).catch(() => null);
    if (!note) {
      noteEl.innerHTML = '<div class="bg-note-empty">Could not load note.</div>';
      return;
    }
    const color = brainColor(note.type);

    let html = `<div class="bn-type" style="background:${color}">${esc(note.type)}</div>`;
    html += `<div class="bn-title">${esc(note.title || note.key)}</div>`;

    if (note.meta && note.meta.length) {
      html += `<div class="bn-meta">` +
        note.meta.map(m => `<span>${esc(m.k)}: ${esc(String(m.v))}</span>`).join('') +
        `</div>`;
    }
    if (note.tags && note.tags.length) {
      html += `<div class="bn-tags">` +
        note.tags.map(t => `<span class="bn-tag">#${esc(t)}</span>`).join('') +
        `</div>`;
    }

    html += `<div class="bn-body">${mdToHtml(note.body) || '<span style="opacity:.5">No content.</span>'}</div>`;

    const linkRow = (l) => {
      const dotColor = brainColor(String(l.id || '').split(':')[0]);
      return `<div class="bn-link" data-id="${esc(String(l.id))}">` +
        `<span class="bn-dot" style="background:${dotColor}"></span>` +
        esc(l.title || l.id) +
        `</div>`;
    };

    if (note.backlinks && note.backlinks.length) {
      html += `<div class="bn-section"><h4>&#8627; Linked mentions (${note.backlinks.length})</h4>` +
        note.backlinks.map(linkRow).join('') + `</div>`;
    }
    if (note.outlinks && note.outlinks.length) {
      html += `<div class="bn-section"><h4>&#8594; Links (${note.outlinks.length})</h4>` +
        note.outlinks.map(linkRow).join('') + `</div>`;
    }

    noteEl.innerHTML = html;

    // Delegate link clicks (backlinks, outlinks)
    noteEl.querySelectorAll('.bn-link').forEach(a =>
      a.addEventListener('click', () => brainExpand(a.dataset.id))
    );
    // Wikilink spans produced by mdToHtml/markdownit
    noteEl.querySelectorAll('a[href^="#"]').forEach(a =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const target = a.getAttribute('href').slice(1);
        brainExpand(`memory:${target.toLowerCase()}`);
      })
    );
  }

  // ── loadBrain ─────────────────────────────────────────────────────────────
  async function loadBrain() {
    const depth = depthSel.value || 1;
    const g = await api(`/api/brain/graph?limit=150&depth=${depth}`)
      .catch(() => ({ nodes: [], edges: [], meta: { mode: 'overview', nodeCount: 0, edgeCount: 0 } }));
    brainCurrent = null;
    renderBrain(g);
    loadVitals();
    loadMission();
    if (pulseChk.checked) startPulse();
  }

  // ── loadMission ───────────────────────────────────────────────────────────
  async function loadMission() {
    const mc = await api('/api/brain/mission').catch(() => ({ entries: [], counts: {} }));
    const statusColor = {
      running:   '#22d3ee', zombie: '#fb7185', failed: '#f87171',
      scheduled: '#5b8def', done:   '#34d399', idle:   '#7a818c',
    };
    const counts = mc.counts || {};
    const rows = Object.entries(counts).filter(([, n]) => n > 0);
    missionEl.innerHTML = rows.length
      ? rows.map(([status, n]) =>
          `<div class="bg-stat-row">
            <span class="bg-stat-label" style="color:${statusColor[status] || '#fff'}">${esc(status)}</span>
            <span class="bg-stat-val">${n}</span>
          </div>`
        ).join('')
      : `<div class="bg-stat-row">
          <span class="bg-stat-label" style="color:var(--muted)">idle</span>
          <span class="bg-stat-val">0</span>
         </div>`;
  }

  // ── loadVitals ────────────────────────────────────────────────────────────
  async function loadVitals() {
    const [snaps, recs] = await Promise.all([
      api('/api/brain/snapshots?days=30').catch(() => []),
      api('/api/model/recommendations').catch(() => ({})),
    ]);

    // Group snapshots by metric
    const byMetric = {};
    for (const s of (snaps || [])) {
      (byMetric[s.metric] ||= []).push(s);
    }

    // ── Vitals charts via line() from charts.js ──────────────────────────
    const firesData  = byMetric['patterns.fires.total'] || [];
    const memData    = byMetric['memory.count']          || [];

    const firesCanvas  = document.getElementById('bg-chart-fires');
    const memoryCanvas = document.getElementById('bg-chart-memory');

    if (firesCanvas && firesData.length) {
      if (_cFires) { _cFires.destroy(); _cFires = null; }
      _cFires = line(
        firesCanvas,
        firesData.map(r => r.snapshot_date),
        firesData.map(r => r.value)
      );
    }

    if (memoryCanvas && memData.length) {
      if (_cMemory) { _cMemory.destroy(); _cMemory = null; }
      _cMemory = line(
        memoryCanvas,
        memData.map(r => r.snapshot_date),
        memData.map(r => r.value)
      );
    }

    // ── Model recommendations table ─────────────────────────────────────
    const entries = Object.entries(recs || {});
    recsBody.innerHTML = entries.length
      ? entries.map(([agent, r]) =>
          `<tr>
            <td>${esc(agent)}</td>
            <td class="mono" style="font:11px var(--mono)">${esc(r.model)}</td>
            <td class="mono" style="font:11px var(--mono);opacity:.6">${esc(r.demoted_from || '')}</td>
            <td><button class="bg-accept-btn" data-agent="${esc(agent)}">Accept</button></td>
          </tr>`
        ).join('')
      : '<tr><td colspan="4" style="color:var(--muted);font:12px var(--ui)">None pending</td></tr>';

    recsBody.querySelectorAll('.bg-accept-btn').forEach(btn =>
      btn.addEventListener('click', async () => {
        await fetch('/api/model/recommendations/accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: btn.dataset.agent }),
        }).catch(() => {});
        loadVitals();
      })
    );
  }

  // ── Live pulse (SSE) ──────────────────────────────────────────────────────
  function startPulse() {
    // Close any existing EventSource before opening a new one
    if (_es) { _es.close(); _es = null; }

    _es = new EventSource('/api/brain/events');

    _es.onmessage = (msg) => {
      let e;
      try { e = JSON.parse(msg.data); } catch { return; }

      // Ticker strip
      tickerEl.textContent = `${esc(e.kind)} · ${esc(e.label || '')} · ${String(e.ts || '').slice(11, 19)}`;

      // Pulse referenced nodes on the graph
      if (_cy && Array.isArray(e.refs)) {
        const flashColor = PULSE_KINDS[e.kind] || '#fff';
        for (const id of e.refs) {
          const node = _cy.getElementById(id);
          if (node && node.length) {
            node
              .animate({ style: { 'background-color': flashColor, 'border-width': 4, 'border-color': flashColor } }, { duration: 200 })
              .animate({ style: { 'border-width': 0 } }, { duration: 600 });
          }
        }
      }
    };

    _es.onerror = () => { /* browser auto-reconnects EventSource */ };
  }

  function stopPulse() {
    if (_es) { _es.close(); _es = null; }
  }

  // ── event wiring ─────────────────────────────────────────────────────────
  resetBtn.addEventListener('click',   () => loadBrain());
  depthSel.addEventListener('change',  () => loadBrain());
  pulseChk.addEventListener('change',  (e) => e.target.checked ? startPulse() : stopPulse());

  searchIn.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !e.target.value.trim()) return;
    const hits = await api(`/api/search?q=${encodeURIComponent(e.target.value.trim())}&limit=5`).catch(() => null);
    // /api/search returns { memory, symbols, commits, dictionary, vault_tools }
    // Memory hits map to overview graph nodes (memory:<source>)
    const mem = hits && hits.memory && hits.memory[0];
    if (mem && mem.source) brainExpand(`memory:${mem.source}`);
  });

  // ── initial load ──────────────────────────────────────────────────────────
  await loadBrain();
});
