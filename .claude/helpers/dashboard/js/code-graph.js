/**
 * code-graph.js — Import graph visualisation for the CodeFlow views.
 *
 * Registers the 'code' view (nav data-view="code"). Renders:
 *   • Project selector + colour-mode toggle (Folder | Churn)
 *   • Cytoscape import-dependency graph (layout: cose)
 *   • Legend matching the active colour mode
 *
 * Node size scales with symbol count. Node colour is either folder-stable hsl
 * (Folder mode) or churn-traffic-light (Churn mode). Churn data is matched by
 * matching the repo-relative churn path against the absolute node path via
 * String.endsWith, which is robust to different drive-letter conventions.
 *
 * WHY module-level _cy: Cytoscape instances must be explicitly destroyed on
 * re-render to free WebGL/canvas memory. Storing the reference here follows the
 * same pattern as _ccCleanup in command-center.js.
 */

import { registerView } from './core.js';
import { getProject, setProject, loadProjects, projectSelectorHtml } from './project-store.js';
import { churnColor, folderColor } from './viz-util.js';

// ── scoped styles (injected once) ─────────────────────────────────────────

if (!document.getElementById('code-graph-styles')) {
  const style = document.createElement('style');
  style.id = 'code-graph-styles';
  style.textContent = `
    .cg-toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }
    .cf-proj-sel {
      background: var(--panel-2);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      padding: 5px 10px;
      font: 13px var(--ui);
      cursor: pointer;
      outline: none;
    }
    .cf-proj-sel:focus { border-color: var(--accent); }
    .cg-mode-label {
      font: 600 11px/1 var(--mono);
      letter-spacing: .14em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .cg-mode-btn {
      padding: 4px 12px;
      border-radius: 20px;
      border: 1px solid var(--border);
      background: var(--panel-2);
      color: var(--muted);
      font: 600 11px/1 var(--mono);
      cursor: pointer;
      transition: background .12s, color .12s, border-color .12s;
    }
    .cg-mode-btn.active {
      border-color: var(--accent);
      color: var(--accent);
      background: rgba(52,225,255,.10);
    }
    .cg-mode-btn:disabled {
      opacity: .35;
      cursor: default;
    }
    .cg-unavail {
      font: 11px/1 var(--mono);
      color: var(--amber);
    }
    .cg-legend {
      display: flex;
      gap: 14px;
      flex-wrap: wrap;
      margin-bottom: 12px;
      font: 11px/1 var(--mono);
      color: var(--muted);
    }
    .cg-legend-item {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .cg-legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex: 0 0 auto;
    }
    .cg-container {
      width: 100%;
      height: 580px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--panel-2);
    }
    .cg-empty {
      color: var(--muted);
      font: 13px var(--mono);
      padding: 30px 0;
    }
  `;
  document.head.appendChild(style);
}

// ── module state ───────────────────────────────────────────────────────────

/** Active Cytoscape instance — destroyed before each re-render. */
let _cy = null;

// ── helpers ────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Extract the directory portion of a file path (forward or back slash).
 * e.g. "/abs/path/to/foo.js" → "/abs/path/to"
 */
function dirname(filePath) {
  const s = String(filePath || '').replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(0, i) : s;
}

/**
 * Build a Map<repoRelPath → ratio> from churn data for O(1) lookups.
 * Keys are normalised to forward slashes.
 */
function buildChurnMap(churnArr) {
  const m = new Map();
  for (const c of (churnArr || [])) {
    m.set(String(c.file).replace(/\\/g, '/'), c.ratio ?? 0);
  }
  return m;
}

/**
 * Resolve churn ratio for an absolute node path against the repo-relative
 * churn map. Falls back to 0 (green) when no match is found.
 */
function resolveChurn(absPath, churnMap) {
  const norm = String(absPath || '').replace(/\\/g, '/');
  for (const [rel, ratio] of churnMap) {
    // Require a path separator before the relative portion to prevent
    // 'db.cjs' matching both 'helpers/db.cjs' and 'fakedb.cjs'.
    if (norm.endsWith('/' + rel) || norm === rel) return ratio;
  }
  return 0;
}

/**
 * Build Cytoscape elements array from graph nodes and edges.
 * Node size is clamped between 18 and 54px (by symbols count).
 * @param {Array} nodes
 * @param {Array} edges
 * @param {string} mode  'folder' | 'churn'
 * @param {Map}    churnMap
 */
function buildElements(nodes, edges, mode, churnMap) {
  const maxSym = Math.max(1, ...nodes.map(n => n.symbols || 0));
  const elements = nodes.map(n => {
    const size = 18 + Math.round(((n.symbols || 0) / maxSym) * 36);
    const color = mode === 'churn'
      ? churnColor(resolveChurn(n.file, churnMap))
      : folderColor(dirname(n.file));
    const ratio = mode === 'churn' ? resolveChurn(n.file, churnMap) : null;
    return {
      data: {
        id:     n.id,
        label:  n.label || '',
        file:   n.file || '',
        size,
        color,
        title:  mode === 'churn'
          ? `${n.label}\n${n.file}\nchurn: ${ratio != null ? (ratio * 100).toFixed(0) + '%' : 'n/a'}`
          : `${n.label}\n${n.file}`,
      },
    };
  });
  const edgeEls = (edges || []).map((e, i) => ({
    data: { id: `e${i}`, source: e.source, target: e.target },
  }));
  return [...elements, ...edgeEls];
}

/** Destroy the current Cytoscape instance if one exists. */
function destroyCy() {
  if (_cy) {
    try { _cy.destroy(); } catch (_) {}
    _cy = null;
  }
}

/**
 * Mount a new Cytoscape instance on containerEl with the given elements.
 */
function mountCytoscape(containerEl, elements) {
  destroyCy();
  _cy = window.cytoscape({
    container: containerEl,
    elements,
    style: [
      {
        selector: 'node',
        style: {
          'background-color':      'data(color)',
          'label':                 'data(label)',
          'width':                 'data(size)',
          'height':                'data(size)',
          'font-size':             9,
          'font-family':           'ui-monospace, Consolas, monospace',
          'color':                 '#dce3f2',
          'text-valign':           'bottom',
          'text-margin-y':         4,
          'text-outline-width':    0,
          'text-background-color': 'rgba(11,14,26,0.75)',
          'text-background-opacity': 1,
          'text-background-padding': '2px',
          'text-background-shape': 'roundrectangle',
          'tooltip':               'data(title)',
        },
      },
      {
        selector: 'edge',
        style: {
          'width':               1.2,
          'line-color':          '#2a3a5a',
          'target-arrow-shape':  'triangle',
          'target-arrow-color':  '#2a3a5a',
          'curve-style':         'bezier',
          'opacity':             0.65,
        },
      },
      {
        selector: 'node:selected',
        style: {
          'border-width': 2,
          'border-color': '#34e1ff',
        },
      },
    ],
    layout: {
      name:           'cose',
      animate:        false,
      nodeRepulsion:  9000,
      idealEdgeLength: 90,
      padding:        20,
      randomize:      true,
    },
  });
}

/** Render the legend appropriate for the active colour mode. */
function legendHtml(mode) {
  if (mode === 'churn') {
    return `
      <div class="cg-legend">
        <div class="cg-legend-item"><span class="cg-legend-dot" style="background:#fb7185"></span>High churn (&gt;70% / 7+ commits)</div>
        <div class="cg-legend-item"><span class="cg-legend-dot" style="background:#facc15"></span>Medium (40–70% / 4–6)</div>
        <div class="cg-legend-item"><span class="cg-legend-dot" style="background:#4ade80"></span>Low (&lt;40% / 0–3)</div>
      </div>`;
  }
  return `<div class="cg-legend"><div class="cg-legend-item" style="color:var(--muted)">Colour = folder (hsl stable hash)</div></div>`;
}

// ── view ───────────────────────────────────────────────────────────────────

registerView('code', async (el) => {
  // Destroy any prior Cytoscape instance from a previous visit.
  destroyCy();

  await loadProjects();

  // ── initial scaffold ────────────────────────────────────────────────────
  el.innerHTML = `
    <div class="topbar">
      <h1>Code Graph</h1>
      <span class="crumb">/ import dependencies</span>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="cg-toolbar">
        <span class="cg-mode-label">Project</span>
        ${projectSelectorHtml()}
        <span class="cg-mode-label" style="margin-left:8px">Color by</span>
        <button class="cg-mode-btn active" data-mode="folder">Folder</button>
        <button class="cg-mode-btn"        data-mode="churn">Churn</button>
        <span class="cg-unavail" id="cg-churn-unavail" style="display:none">churn unavailable (no git history)</span>
      </div>
      <div id="cg-legend"></div>
      <div id="cg-graph" class="cg-container">
        <div class="loading" style="padding:30px">Loading graph…</div>
      </div>
    </div>`;

  const projSel      = el.querySelector('#vf-proj-sel');
  const modeBtns     = el.querySelectorAll('.cg-mode-btn');
  const legendEl     = el.querySelector('#cg-legend');
  const graphEl      = el.querySelector('#cg-graph');
  const unavailEl    = el.querySelector('#cg-churn-unavail');

  let _mode     = 'folder';
  let _graphData = null;  // { nodes, edges }
  let _churnMap  = new Map();
  let _churnUnavail = false;

  /** Apply current colour mode to the already-mounted Cytoscape instance. */
  function recolor() {
    if (!_cy || !_graphData) return;
    const maxSym = Math.max(1, ..._graphData.nodes.map(n => n.symbols || 0));
    _cy.nodes().forEach(cyNode => {
      const n = _graphData.nodes.find(x => x.id === cyNode.id());
      if (!n) return;
      const color = _mode === 'churn'
        ? churnColor(resolveChurn(n.file, _churnMap))
        : folderColor(dirname(n.file));
      cyNode.style('background-color', color);
    });
    legendEl.innerHTML = legendHtml(_mode);
  }

  /** Full render: fetch graph + conditionally churn, then mount Cytoscape. */
  async function renderGraph(project) {
    graphEl.innerHTML = '<div class="loading" style="padding:30px">Loading…</div>';
    legendEl.innerHTML = '';
    destroyCy();

    try {
      // Always fetch the import graph.
      const gd = await fetch(`/api/code-graph/import-graph?project=${encodeURIComponent(project)}`).then(r => r.json());
      _graphData = gd;

      if (!gd.nodes || !gd.nodes.length) {
        graphEl.innerHTML = '<div class="cg-empty">No import graph data for this project.</div>';
        return;
      }

      // Fetch churn (non-fatal — mark unavailable if it fails or unavailable flag set).
      try {
        const cd = await fetch(`/api/code-graph/churn?project=${encodeURIComponent(project)}`).then(r => r.json());
        _churnUnavail = !!cd.unavailable;
        _churnMap = _churnUnavail ? new Map() : buildChurnMap(cd.churn);
      } catch (_) {
        _churnUnavail = true;
        _churnMap = new Map();
      }

      // Reflect churn availability on the toggle button.
      const churnBtn = el.querySelector('[data-mode="churn"]');
      if (churnBtn) {
        churnBtn.disabled = _churnUnavail;
        unavailEl.style.display = _churnUnavail ? '' : 'none';
        // If churn was active but became unavailable, fall back to folder.
        if (_churnUnavail && _mode === 'churn') {
          _mode = 'folder';
          modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === _mode));
        }
      }

      // Build elements and mount.
      graphEl.innerHTML = ''; // clear placeholder
      const elements = buildElements(gd.nodes, gd.edges, _mode, _churnMap);
      mountCytoscape(graphEl, elements);
      legendEl.innerHTML = legendHtml(_mode);

    } catch (e) {
      graphEl.innerHTML = `<div style="color:var(--red);padding:20px">Error: ${esc(e.message)}</div>`;
    }
  }

  // ── event wiring ─────────────────────────────────────────────────────────

  projSel.addEventListener('change', async () => {
    setProject(projSel.value);
    await renderGraph(getProject());
  });

  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      _mode = btn.dataset.mode;
      modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === _mode));
      recolor();
      legendEl.innerHTML = legendHtml(_mode);
    });
  });

  // ── initial load ──────────────────────────────────────────────────────────
  await renderGraph(getProject());
});
