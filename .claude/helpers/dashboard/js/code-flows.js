/**
 * code-flows.js — Flows view for the Synapse v2 dashboard.
 *
 * Ports v1 Flows tab behavior to the v2 module pattern.
 *
 * Layout: two-pane split
 *   LEFT  — scrollable flow list from GET /api/flows (sorted confidence desc)
 *   RIGHT — selected flow:
 *             · Cytoscape graph (cose layout) from GET /api/flows/:id
 *             · Annotate form that POSTs to /api/flows/:id
 *             · Excalidraw toggle from GET /api/flows/:id/excalidraw
 *
 * Declare panel (below list): POST /api/flows/declare → refreshes list + opens new flow.
 *
 * Cytoscape lifecycle: module-scoped `_cy` is destroyed before every re-create.
 * window.cytoscape is the UMD global loaded by index-v2.html — never imported.
 */

import { registerView } from './core.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── flow kind → node color (mirrors v1 FLOW_KINDS) ───────────────────────────

const FLOW_KINDS = {
  function: '#6366f1', method: '#818cf8', class: '#a78bfa', route: '#22d3ee',
  handler:  '#34d399', service: '#facc15', module:  '#fb923c', entry:   '#f472b6',
};
function flowKindColor(kind) { return FLOW_KINDS[String(kind || '').toLowerCase()] || '#94a3b8'; }

// ── confidence helpers ────────────────────────────────────────────────────────

function confBgColor(c) {
  if (c == null) return 'var(--panel-2)';
  if (c >= 0.66) return 'rgba(20,83,45,.6)';
  if (c >= 0.33) return 'rgba(120,53,15,.6)';
  return 'rgba(127,29,29,.6)';
}
function confTextColor(c) {
  if (c == null) return 'var(--muted)';
  if (c >= 0.66) return 'var(--green)';
  if (c >= 0.33) return 'var(--amber,#facc15)';
  return 'var(--red)';
}
function confPct(c) { return c == null ? 'n/a' : `${Math.round(c * 100)}%`; }

// ── source / status badges ────────────────────────────────────────────────────

function sourceBadge(source) {
  if (source === 'manual')
    return `<span style="font:600 9px/1 var(--mono);padding:2px 7px;border-radius:10px;background:rgba(168,139,250,.18);color:#a78bfa;border:1px solid rgba(168,139,250,.3)">manual</span>`;
  if (source === 'declared')
    return `<span style="font:600 9px/1 var(--mono);padding:2px 7px;border-radius:10px;background:rgba(34,211,238,.12);color:#22d3ee;border:1px solid rgba(34,211,238,.3)">declared</span>`;
  return `<span style="font:600 9px/1 var(--mono);padding:2px 7px;border-radius:10px;background:var(--panel-2);color:var(--muted);border:1px solid var(--border)">auto</span>`;
}

function statusBadge(status) {
  if (status === 'active')
    return `<span style="font:600 9px/1 var(--mono);padding:2px 7px;border-radius:10px;background:rgba(74,222,128,.12);color:var(--green);border:1px solid rgba(74,222,128,.3)">${esc(status)}</span>`;
  if (status === 'deprecated')
    return `<span style="font:600 9px/1 var(--mono);padding:2px 7px;border-radius:10px;background:rgba(250,204,21,.12);color:#facc15;border:1px solid rgba(250,204,21,.3)">${esc(status)}</span>`;
  return `<span style="font:600 9px/1 var(--mono);padding:2px 7px;border-radius:10px;background:var(--panel-2);color:var(--muted);border:1px solid var(--border)">${esc(status || 'active')}</span>`;
}

function confBadge(c) {
  return `<span style="font:600 9px/1 var(--mono);padding:2px 7px;border-radius:10px;background:${confBgColor(c)};color:${confTextColor(c)}">${confPct(c)}</span>`;
}

// ── derive module label from entry_point ──────────────────────────────────────

function flowModule(entryPoint) {
  if (!entryPoint) return '—';
  const ep = String(entryPoint);
  const idx = ep.lastIndexOf('::');
  const file = idx >= 0 ? ep.slice(0, idx) : ep;
  return file.split(/[\\/]/).pop() || ep;
}

// ── Cytoscape elements builder ────────────────────────────────────────────────

function buildElements(full) {
  const nodes = (full.nodes || []).map(n => ({
    data: { id: n.node_id, label: n.label || n.node_id, kind: n.kind,
            terminal: n.terminal ? 1 : 0, ambiguous: n.ambiguous ? 1 : 0 },
    classes: [n.terminal ? 'terminal' : '', n.ambiguous ? 'ambiguous' : ''].filter(Boolean).join(' '),
  }));
  const edges = (full.edges || []).map((e, i) => ({
    data: { id: `fe${i}`, source: e.source, target: e.target, kind: e.kind },
  }));
  return [...nodes, ...edges];
}

// ── read-only Excalidraw SVG renderer (mirrors v1 renderExcalidrawSvg) ────────

function renderExcalidrawSvg(container, doc) {
  const els = (doc.elements || []).filter(e => !e.isDeleted);
  if (!els.length) { container.innerHTML = '<div style="color:var(--muted);padding:16px">No diagram elements</div>'; return; }
  const minX = Math.min(...els.map(e => e.x));
  const minY = Math.min(...els.map(e => e.y));
  const maxX = Math.max(...els.map(e => e.x + (e.width || 0)));
  const maxY = Math.max(...els.map(e => e.y + (e.height || 0)));
  const parts = [];
  for (const e of els) {
    if (e.type === 'rectangle') {
      parts.push(`<rect x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" rx="8" fill="${esc(e.backgroundColor)}" stroke="${esc(e.strokeColor)}" stroke-width="1.5"/>`);
    } else if (e.type === 'text') {
      parts.push(`<text x="${e.x + e.width / 2}" y="${e.y + e.height / 2}" text-anchor="middle" dominant-baseline="middle" font-family="monospace" font-size="${esc(String(e.fontSize))}" fill="${esc(e.strokeColor)}">${esc(e.text)}</text>`);
    } else if (e.type === 'arrow' && e.points && e.points.length >= 2) {
      const [p0, p1] = [e.points[0], e.points[e.points.length - 1]];
      parts.push(`<line x1="${e.x + p0[0]}" y1="${e.y + p0[1]}" x2="${e.x + p1[0]}" y2="${e.y + p1[1]}" stroke="${esc(e.strokeColor)}" stroke-width="1.5" marker-end="url(#vf-arrow)"/>`);
    }
  }
  container.innerHTML =
    `<svg viewBox="${minX - 20} ${minY - 20} ${maxX - minX + 40} ${maxY - minY + 40}" width="100%" height="100%" style="background:#fff">` +
    `<defs><marker id="vf-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#1e1e1e"/></marker></defs>` +
    parts.join('') + `</svg>`;
}

// ── scoped CSS (injected once) ────────────────────────────────────────────────

const FLOWS_CSS = `
  .cf-root {
    display: grid;
    grid-template-columns: 280px 1fr;
    grid-template-rows: 1fr;
    gap: 12px;
    height: calc(100vh - 90px);
    min-height: 480px;
  }
  .cf-left {
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow: hidden;
  }
  .cf-list-card {
    flex: 1 1 0;
    overflow-y: auto;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 0;
  }
  .cf-flow-row {
    padding: 9px 14px;
    cursor: pointer;
    border-left: 3px solid transparent;
    transition: background .1s, border-color .1s;
  }
  .cf-flow-row:hover  { background: var(--panel-2); }
  .cf-flow-row.active { background: var(--panel-2); border-left-color: var(--accent); }
  .cf-row-name {
    font: 600 12px/1.35 var(--ui);
    color: var(--text);
    margin-bottom: 3px;
    word-break: break-all;
  }
  .cf-row-module {
    font: 11px/1 var(--mono);
    color: var(--muted);
    margin-bottom: 5px;
  }
  .cf-row-badges { display: flex; flex-wrap: wrap; gap: 4px; }
  .cf-list-empty {
    padding: 16px 14px;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
  }
  .cf-right {
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow: hidden;
  }
  .cf-graph-card {
    flex: 1 1 0;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    position: relative;
    min-height: 220px;
  }
  .cf-graph-container {
    width: 100%;
    height: 100%;
  }
  .cf-graph-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--muted);
    font-size: 13px;
  }
  .cf-graph-toolbar {
    position: absolute;
    top: 10px;
    right: 10px;
    z-index: 10;
    display: flex;
    gap: 6px;
  }
  .cf-excalidraw-container {
    width: 100%;
    height: 100%;
    overflow: auto;
  }
  .cf-detail-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px;
    overflow-y: auto;
    max-height: 340px;
  }
  .cf-field {
    margin-bottom: 12px;
  }
  .cf-label {
    display: block;
    font: 600 10px/1 var(--mono);
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 5px;
  }
  .cf-input, .cf-textarea, .cf-select {
    width: 100%;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    padding: 6px 10px;
    font: 12px var(--ui);
    outline: none;
    resize: vertical;
    box-sizing: border-box;
  }
  .cf-input:focus, .cf-textarea:focus, .cf-select:focus { border-color: var(--accent); }
  .cf-hint {
    font: 11px/1.5 var(--mono);
    color: var(--muted);
    margin: 8px 0 10px;
  }
  .cf-btn {
    padding: 6px 14px;
    border-radius: 7px;
    border: 1px solid var(--border);
    background: var(--panel-2);
    color: var(--text);
    font: 600 11px/1 var(--ui);
    cursor: pointer;
    transition: background .12s, border-color .12s;
  }
  .cf-btn:hover { background: var(--panel); }
  .cf-btn:disabled { opacity: .4; cursor: not-allowed; }
  .cf-btn-primary {
    background: rgba(52,225,255,.1);
    border-color: rgba(52,225,255,.35);
    color: var(--accent);
  }
  .cf-btn-primary:hover { background: rgba(52,225,255,.18); }
  .cf-status { font: 11px/1.5 var(--mono); color: var(--muted); margin-top: 6px; min-height: 14px; }
  .cf-status.ok  { color: var(--green); }
  .cf-status.err { color: var(--red); }
  .cf-note-badges { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
  .cf-note-ep {
    font: 11px/1.4 var(--mono);
    color: var(--muted);
    word-break: break-all;
    margin-bottom: 10px;
  }
  .cf-note-md { font: 13px/1.6 var(--ui); color: var(--text); margin-bottom: 10px; }
  .cf-declare-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 14px;
  }
  .cf-declare-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 8px;
  }
  .cf-declare-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .cf-sec {
    font: 700 10px/1 var(--mono);
    letter-spacing: .12em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 8px;
  }
  .cf-toggle-active {
    background: rgba(52,225,255,.15) !important;
    border-color: rgba(52,225,255,.5) !important;
    color: var(--accent) !important;
  }
`;

// ── module-scoped Cytoscape instance ─────────────────────────────────────────

let _cy = null;

// ── view ──────────────────────────────────────────────────────────────────────

registerView('code-flows', async (el) => {
  // Inject scoped styles once
  if (!document.getElementById('cf-styles')) {
    const style = document.createElement('style');
    style.id = 'cf-styles';
    style.textContent = FLOWS_CSS;
    document.head.appendChild(style);
  }

  // ── state ─────────────────────────────────────────────────────────────────
  let flowList  = [];
  let currentId = null;
  let showingEx = false;    // true = excalidraw pane visible

  // ── scaffold ──────────────────────────────────────────────────────────────
  el.innerHTML = `
    <div class="topbar">
      <h1>Flows</h1>
      <span class="crumb">/ code / flows</span>
    </div>
    <div class="cf-root">

      <!-- LEFT: list + declare -->
      <div class="cf-left">

        <div class="cf-list-card" id="cf-list">
          <div class="cf-list-empty">Loading flows…</div>
        </div>

        <!-- Declare form -->
        <div class="cf-declare-card">
          <div class="cf-sec">Declare entry point</div>
          <div class="cf-declare-grid">
            <div>
              <label class="cf-label">File path</label>
              <input class="cf-input" id="cf-fd-file" placeholder=".claude/helpers/db.cjs" autocomplete="off" spellcheck="false" />
            </div>
            <div>
              <label class="cf-label">Symbol</label>
              <input class="cf-input" id="cf-fd-symbol" placeholder="initialize" autocomplete="off" spellcheck="false" />
            </div>
            <div>
              <label class="cf-label">Name (optional)</label>
              <input class="cf-input" id="cf-fd-name" placeholder="Human label" autocomplete="off" />
            </div>
            <div>
              <label class="cf-label">Project (optional)</label>
              <input class="cf-input" id="cf-fd-project" placeholder="vaultflow" autocomplete="off" />
            </div>
          </div>
          <div class="cf-declare-row">
            <button class="cf-btn cf-btn-primary" id="cf-fd-declare">Declare &amp; trace</button>
            <span class="cf-status" id="cf-fd-msg"></span>
          </div>
        </div>

      </div>

      <!-- RIGHT: graph + detail -->
      <div class="cf-right">

        <div class="cf-graph-card" id="cf-graph-card">
          <div class="cf-graph-placeholder" id="cf-graph-placeholder">
            Select a flow to view its graph
          </div>
          <div class="cf-graph-container" id="cf-graph" style="display:none"></div>
          <div class="cf-excalidraw-container" id="cf-excalidraw" style="display:none"></div>
          <div class="cf-graph-toolbar" id="cf-graph-toolbar" style="display:none">
            <button class="cf-btn" id="cf-toggle-ex" title="Toggle Excalidraw preview">Excalidraw</button>
          </div>
        </div>

        <div class="cf-detail-card" id="cf-detail">
          <div style="color:var(--muted);font-size:13px">Select a flow to see details and annotate.</div>
        </div>

      </div>

    </div>`;

  // ── refs ──────────────────────────────────────────────────────────────────
  const listEl    = el.querySelector('#cf-list');
  const graphEl   = el.querySelector('#cf-graph');
  const exEl      = el.querySelector('#cf-excalidraw');
  const phEl      = el.querySelector('#cf-graph-placeholder');
  const toolbarEl = el.querySelector('#cf-graph-toolbar');
  const toggleBtn = el.querySelector('#cf-toggle-ex');
  const detailEl  = el.querySelector('#cf-detail');

  // ── Cytoscape render ──────────────────────────────────────────────────────
  function renderGraph(full) {
    // Always destroy before re-create — prevent memory leak on re-route or flow change.
    if (_cy) { _cy.destroy(); _cy = null; }
    graphEl.innerHTML = '';
    _cy = window.cytoscape({
      container: graphEl,
      elements: buildElements(full),
      style: [
        { selector: 'node', style: {
          'background-color': (n) => flowKindColor(n.data('kind')),
          'label': 'data(label)', 'color': '#cbd5e1', 'font-size': 9,
          'width': 22, 'height': 22, 'border-width': 0, 'border-color': '#e8e8f0',
          'text-wrap': 'ellipsis', 'text-max-width': 100, 'min-zoomed-font-size': 6,
          'text-valign': 'bottom', 'text-margin-y': 3,
        }},
        { selector: 'edge', style: {
          'width': 1.4, 'line-color': '#34344a', 'target-arrow-color': '#5b5b7a',
          'target-arrow-shape': 'triangle', 'arrow-scale': 0.9,
          'curve-style': 'bezier', 'opacity': 0.7,
        }},
        // terminal: dashed border + dimmed — exits indexed graph
        { selector: 'node.terminal', style: {
          'border-width': 2, 'border-style': 'dashed',
          'border-color': '#94a3b8', 'opacity': 0.55,
        }},
        // ambiguous: dotted yellow marker — bare name resolved to >1 target
        { selector: 'node.ambiguous', style: {
          'border-width': 3, 'border-style': 'dotted', 'border-color': '#facc15',
        }},
      ],
      layout: { name: 'cose', animate: false, nodeRepulsion: 9000, idealEdgeLength: 95, padding: 24 },
    });
  }

  // ── flow list ─────────────────────────────────────────────────────────────
  function markActive(id) {
    listEl.querySelectorAll('.cf-flow-row').forEach(r =>
      r.classList.toggle('active', r.dataset.id === String(id)));
  }

  function renderFlowList() {
    if (!flowList.length) {
      listEl.innerHTML = `<div class="cf-list-empty">
        <strong>No flows discovered yet.</strong><br><br>
        Auto-detection finds CLI/route entry points. Declare an entry point below to trace one manually.
      </div>`;
      return;
    }
    const sorted = [...flowList].sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));
    listEl.innerHTML = sorted.map(f => {
      const trunc = f.truncated
        ? `<span title="graph truncated" style="color:var(--amber,#facc15)">&#9651;</span>`
        : '';
      return `<div class="cf-flow-row" data-id="${esc(String(f.id))}">
        <div class="cf-row-name">${esc(f.name || '(unnamed flow)')} ${trunc}</div>
        <div class="cf-row-module">${esc(flowModule(f.entry_point))}</div>
        <div class="cf-row-badges">
          ${confBadge(f.confidence)}
          ${sourceBadge(f.source)}
          ${statusBadge(f.status)}
          <span style="font:600 9px/1 var(--mono);padding:2px 7px;border-radius:10px;background:rgba(34,211,238,.1);color:#22d3ee;border:1px solid rgba(34,211,238,.25)">${Number(f.node_count ?? 0)} nodes</span>
        </div>
      </div>`;
    }).join('');
    if (currentId) markActive(currentId);
  }

  async function loadFlowList() {
    listEl.innerHTML = '<div class="cf-list-empty">Loading flows…</div>';
    try {
      const r = await fetch('/api/flows');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      flowList = Array.isArray(data) ? data : (data.flows || []);
    } catch (e) {
      listEl.innerHTML = `<div class="cf-list-empty" style="color:var(--red)">Failed to load flows: ${esc(e.message)}</div>`;
      return;
    }
    renderFlowList();
  }

  // ── open flow ─────────────────────────────────────────────────────────────
  async function openFlow(id) {
    currentId = String(id);
    markActive(currentId);

    // Reset graph pane to Cytoscape view
    showingEx = false;
    phEl.style.display = 'flex';
    graphEl.style.display = 'none';
    exEl.style.display = 'none';
    exEl.innerHTML = '';
    toolbarEl.style.display = 'none';
    toggleBtn.classList.remove('cf-toggle-active');
    detailEl.innerHTML = '<div style="color:var(--muted);font-size:12px">Loading…</div>';

    let full;
    try {
      const r = await fetch(`/api/flows/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      full = await r.json();
    } catch (e) {
      phEl.style.display = 'flex';
      phEl.textContent = `Could not load flow: ${e.message}`;
      detailEl.innerHTML = '';
      return;
    }

    // Show graph
    phEl.style.display = 'none';
    graphEl.style.display = 'block';
    toolbarEl.style.display = 'flex';
    renderGraph(full);
    renderDetail(full.flow || full);
  }

  // ── detail / annotate panel ───────────────────────────────────────────────
  function renderDetail(flow) {
    if (!flow) { detailEl.innerHTML = ''; return; }

    // Markdown render for user_notes if markdownit is available
    let mdHtml = '';
    if (flow.user_notes) {
      try {
        const md = window.markdownit({ html: false, linkify: true });
        mdHtml = md.render(flow.user_notes);
      } catch {
        mdHtml = `<pre style="white-space:pre-wrap">${esc(flow.user_notes)}</pre>`;
      }
    }

    const statusOpt = (v) =>
      `<option value="${esc(v)}"${flow.status === v ? ' selected' : ''}>${esc(v)}</option>`;

    detailEl.innerHTML = `
      <div class="cf-note-badges">
        <span style="font:600 9px/1 var(--mono);padding:3px 7px;border-radius:5px;background:${flowKindColor('entry')};color:#0e0e16">flow</span>
        ${sourceBadge(flow.source)}
        ${statusBadge(flow.status)}
        ${confBadge(flow.confidence)}
      </div>
      <div class="cf-note-ep">entry: ${esc(flow.entry_point || '—')}</div>

      ${mdHtml ? `<div class="cf-note-md">${mdHtml}</div>` : ''}

      <div class="cf-field">
        <label class="cf-label">Name</label>
        <input class="cf-input" id="cf-fn-name" type="text" value="${esc(flow.name || '')}" />
      </div>
      <div class="cf-field">
        <label class="cf-label">Description</label>
        <textarea class="cf-textarea" id="cf-fn-desc" rows="2"></textarea>
      </div>
      <div class="cf-field">
        <label class="cf-label">Your notes</label>
        <textarea class="cf-textarea" id="cf-fn-notes" rows="3"></textarea>
      </div>
      <div class="cf-field">
        <label class="cf-label">Status</label>
        <select class="cf-select" id="cf-fn-status">
          ${statusOpt('active')}${statusOpt('archived')}${statusOpt('deprecated')}
        </select>
      </div>
      <p class="cf-hint">Annotating claims this flow — it becomes <strong>manual</strong> and won't be overwritten by auto-discovery.</p>
      <button class="cf-btn cf-btn-primary" id="cf-fn-save">Save annotation</button>
      <div class="cf-status" id="cf-fn-msg"></div>`;

    // Set textarea content via .value (safe — not XSS vector)
    detailEl.querySelector('#cf-fn-desc').value  = flow.description || '';
    detailEl.querySelector('#cf-fn-notes').value = flow.user_notes  || '';
  }

  // ── save annotation ───────────────────────────────────────────────────────
  async function saveAnnotation(id) {
    const btn = detailEl.querySelector('#cf-fn-save');
    const msg = detailEl.querySelector('#cf-fn-msg');
    if (!btn || !msg) return;

    const body = {
      name:        detailEl.querySelector('#cf-fn-name')?.value  ?? '',
      description: detailEl.querySelector('#cf-fn-desc')?.value  ?? '',
      user_notes:  detailEl.querySelector('#cf-fn-notes')?.value ?? '',
      status:      detailEl.querySelector('#cf-fn-status')?.value ?? 'active',
    };

    btn.disabled  = true;
    msg.className = 'cf-status';
    msg.textContent = 'Saving…';

    try {
      const r = await fetch(`/api/flows/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);

      // Patch cached list row so source flips to "manual" live
      const updated = data.flow || {};
      const idx = flowList.findIndex(f => String(f.id) === String(id));
      if (idx >= 0) flowList[idx] = { ...flowList[idx], ...updated };
      renderFlowList();
      renderDetail({ ...updated, id });

      const m2 = detailEl.querySelector('#cf-fn-msg');
      if (m2) { m2.className = 'cf-status ok'; m2.textContent = 'Saved — flow claimed as manual.'; }
    } catch (e) {
      msg.className = 'cf-status err';
      msg.textContent = `Save failed: ${e.message}`;
      btn.disabled = false;
    }
  }

  // ── excalidraw toggle ─────────────────────────────────────────────────────
  toggleBtn.addEventListener('click', async () => {
    if (showingEx) {
      // Back to Cytoscape
      exEl.style.display  = 'none';
      graphEl.style.display = 'block';
      showingEx = false;
      toggleBtn.classList.remove('cf-toggle-active');
      return;
    }
    if (!currentId) return;
    try {
      const r = await fetch(`/api/flows/${encodeURIComponent(currentId)}/excalidraw`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const doc = await r.json();
      renderExcalidrawSvg(exEl, doc);
    } catch (e) {
      exEl.innerHTML = `<div style="color:var(--red);padding:16px;font-size:13px">Could not load preview: ${esc(e.message)}</div>`;
    }
    graphEl.style.display = 'none';
    exEl.style.display = 'block';
    showingEx = true;
    toggleBtn.classList.add('cf-toggle-active');
  });

  // ── declare entry point ───────────────────────────────────────────────────
  async function declareFlow() {
    const btn  = el.querySelector('#cf-fd-declare');
    const msg  = el.querySelector('#cf-fd-msg');
    const file    = el.querySelector('#cf-fd-file')?.value.trim()    ?? '';
    const symbol  = el.querySelector('#cf-fd-symbol')?.value.trim()  ?? '';
    const name    = el.querySelector('#cf-fd-name')?.value.trim()    ?? '';
    const project = el.querySelector('#cf-fd-project')?.value.trim() ?? '';

    if (!file || !symbol) {
      msg.className = 'cf-status err';
      msg.textContent = 'File and symbol are required.';
      return;
    }

    const body = { file, symbol };
    if (name)    body.name    = name;
    if (project) body.project = project;

    btn.disabled    = true;
    msg.className   = 'cf-status';
    msg.textContent = 'Declaring & tracing…';

    try {
      const r = await fetch('/api/flows/declare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);

      msg.className = 'cf-status ok';
      if (data.flow) {
        msg.textContent = `Declared "${esc(data.flow.name)}". It is the recall floor and re-traces nightly.`;
      } else {
        msg.textContent = 'Declared. Trace resolved to nothing yet — will re-trace nightly.';
      }

      // Clear symbol + name but keep file/project for declaring siblings
      el.querySelector('#cf-fd-symbol').value = '';
      el.querySelector('#cf-fd-name').value   = '';

      await loadFlowList();
      if (data.flow && data.flow.id) openFlow(data.flow.id);
    } catch (e) {
      msg.className   = 'cf-status err';
      msg.textContent = `Declare failed: ${e.message}`;
    } finally {
      btn.disabled = false;
    }
  }

  // ── delegated event handlers ──────────────────────────────────────────────

  // Flow list click → open flow
  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.cf-flow-row');
    if (row) openFlow(row.dataset.id);
  });

  // Detail save button (delegated from detailEl — content rerenders)
  detailEl.addEventListener('click', (e) => {
    if (e.target.closest('#cf-fn-save') && currentId) {
      saveAnnotation(currentId);
    }
  });

  // Declare button
  el.querySelector('#cf-fd-declare').addEventListener('click', declareFlow);

  // ── initial load ──────────────────────────────────────────────────────────
  await loadFlowList();
});
