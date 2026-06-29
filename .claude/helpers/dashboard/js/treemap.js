/**
 * treemap.js — Squarified treemap of project file sizes / churn.
 *
 * Registers the 'treemap' view (nav data-view="treemap"). Renders:
 *   • Project selector + Folder | Churn toggle
 *   • Inline SVG treemap: leaf area ∝ loc, colour by folder or churn
 *   • Tooltip (<title>) per rect with path, loc, commits
 *   • File labels for cells wide enough (≥45px) and tall enough (≥22px)
 *
 * The squarified layout is a PURE exported function so tests can import it
 * without a DOM. Input: [{value, ...meta}], containerWidth, containerHeight.
 * Output: [{x, y, w, h, ...meta}] — guaranteed within [0,0,W,H].
 *
 * Reference: Bruls et al. "Squarified Treemaps" (2000).
 */

import { registerView } from './core.js';
import { getProject, setProject, loadProjects, projectSelectorHtml } from './project-store.js';
import { churnColor, folderColor, squarify } from './viz-util.js';

// Re-export squarify so callers that import from treemap.js still work.
// The implementation lives in viz-util.js (DOM-free) for testability.
export { squarify };

// ── scoped styles (injected once) ─────────────────────────────────────────

if (!document.getElementById('treemap-styles')) {
  const style = document.createElement('style');
  style.id = 'treemap-styles';
  style.textContent = `
    .tm-toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }
    .tm-legend {
      display: flex;
      gap: 14px;
      flex-wrap: wrap;
      margin-bottom: 10px;
      font: 11px/1 var(--mono);
      color: var(--muted);
    }
    .tm-legend-item {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .tm-legend-dot {
      width: 10px;
      height: 10px;
      border-radius: 3px;
      flex: 0 0 auto;
    }
    .tm-svg-wrap {
      width: 100%;
      overflow-x: auto; /* spec: wide content scrolls in its own container */
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--panel-2);
    }
    .tm-svg-wrap svg {
      display: block;
    }
    .tm-svg-wrap text {
      pointer-events: none;
      user-select: none;
    }
    .tm-empty {
      color: var(--muted);
      font: 13px var(--mono);
      padding: 30px 0;
    }
    /* reuse .cf-proj-sel + .cg-mode-btn + .cg-mode-label from code-graph-styles
       (both views are loaded on the same page) */
  `;
  document.head.appendChild(style);
}

// ── helpers ────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build SVG rect + text markup for a single treemap cell. */
function cellSvg(tile, mode) {
  const fill  = mode === 'churn'
    ? churnColor(tile.ratio ?? 0)
    : folderColor(tile.folder || '');

  // Darken stroke slightly relative to fill for separation without borders.
  const label = tile.name || '';
  const showLabel = tile.w >= 45 && tile.h >= 22;

  const titleText = `${esc(tile.path || tile.name || '')}\nloc: ${tile.loc ?? '?'} · commits: ${tile.commits ?? '?'}`;

  // Clip path per-cell so text never overflows the rect.
  const clipId = `tm-clip-${tile._idx}`;

  return `
    <clipPath id="${clipId}">
      <rect x="${tile.x}" y="${tile.y}" width="${tile.w}" height="${tile.h}" rx="0"/>
    </clipPath>
    <rect
      x="${tile.x.toFixed(1)}" y="${tile.y.toFixed(1)}"
      width="${Math.max(0, tile.w - 0.5).toFixed(1)}"
      height="${Math.max(0, tile.h - 0.5).toFixed(1)}"
      rx="3"
      fill="${esc(fill)}"
      stroke="rgba(0,0,0,0.35)"
      stroke-width="0.5"
    >
      <title>${titleText}</title>
    </rect>
    ${showLabel ? `
    <text
      x="${(tile.x + tile.w / 2).toFixed(1)}"
      y="${(tile.y + tile.h / 2 + 4).toFixed(1)}"
      text-anchor="middle"
      font-size="10"
      font-family="ui-monospace, Consolas, monospace"
      fill="rgba(0,0,0,0.75)"
      clip-path="url(#${clipId})"
    >${esc(label)}</text>` : ''}
  `;
}

function legendHtml(mode) {
  if (mode === 'churn') {
    return `
      <div class="tm-legend">
        <div class="tm-legend-item"><span class="tm-legend-dot" style="background:#fb7185"></span>High churn (&gt;70%)</div>
        <div class="tm-legend-item"><span class="tm-legend-dot" style="background:#facc15"></span>Medium (40–70%)</div>
        <div class="tm-legend-item"><span class="tm-legend-dot" style="background:#4ade80"></span>Low (&lt;40%)</div>
      </div>`;
  }
  return `<div class="tm-legend"><div class="tm-legend-item" style="color:var(--muted)">Cell area ∝ lines of code · colour = folder</div></div>`;
}

/** Sort nodes by value descending (squarify works best with sorted input). */
function sortNodes(nodes) {
  return [...nodes].sort((a, b) => (b.value || 0) - (a.value || 0));
}

// ── module state ──────────────────────────────────────────────────────────

// Mirrors the _ccCleanup pattern in command-center.js — module-level so the
// cleanup survives view teardown and runs on the NEXT mount, not the old el.
let _tmCleanup = null;

// ── view ───────────────────────────────────────────────────────────────────

registerView('treemap', async (el) => {
  // Tear down the previous resize listener before rendering the new view.
  if (_tmCleanup) {
    _tmCleanup();
    _tmCleanup = null;
  }

  await loadProjects();

  el.innerHTML = `
    <div class="topbar">
      <h1>Treemap</h1>
      <span class="crumb">/ file size &amp; churn</span>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="tm-toolbar">
        <span class="cg-mode-label">Project</span>
        ${projectSelectorHtml()}
        <span class="cg-mode-label" style="margin-left:8px">Color by</span>
        <button class="cg-mode-btn active" data-mode="folder">Folder</button>
        <button class="cg-mode-btn"        data-mode="churn">Churn</button>
      </div>
      <div id="tm-legend"></div>
      <div id="tm-svg-wrap" class="tm-svg-wrap">
        <div class="loading" style="padding:30px">Loading…</div>
      </div>
    </div>`;

  const projSel  = el.querySelector('#vf-proj-sel');
  const modeBtns = el.querySelectorAll('.cg-mode-btn');
  const legendEl = el.querySelector('#tm-legend');
  const svgWrap  = el.querySelector('#tm-svg-wrap');

  let _mode  = 'folder';
  let _nodes = []; // raw API nodes

  function containerWidth() {
    // Use the card's available width; fall back to 960.
    return svgWrap.parentElement?.clientWidth
      ? svgWrap.parentElement.clientWidth - 48
      : 960;
  }

  /** Re-render the SVG from cached _nodes (no refetch). */
  function renderSvg() {
    if (!_nodes.length) {
      svgWrap.innerHTML = '<div class="tm-empty">No treemap data for this project.</div>';
      return;
    }

    const W = Math.max(400, containerWidth());
    const H = Math.round(W * 0.55); // ~16:9 ish

    // Map API nodes to {value, ...meta} for the layout.
    const items = _nodes.map(n => ({
      value:   n.loc || 1, // avoid zero-area tiles
      path:    n.path,
      name:    n.name,
      folder:  n.folder,
      loc:     n.loc,
      commits: n.commits,
      ratio:   n.ratio,
    }));

    const sorted = sortNodes(items);
    const tiles  = squarify(sorted, W, H);

    // Tag each tile with a unique index for clip-path IDs.
    tiles.forEach((t, i) => { t._idx = i; });

    const svgContent = tiles.map(t => cellSvg(t, _mode)).join('');
    svgWrap.innerHTML = `
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="${W}" height="${H}"
        viewBox="0 0 ${W} ${H}"
        style="max-width:100%"
      >
        <defs></defs>
        ${svgContent}
      </svg>`;

    legendEl.innerHTML = legendHtml(_mode);
  }

  async function loadAndRender(project) {
    svgWrap.innerHTML = '<div class="loading" style="padding:30px">Loading…</div>';
    legendEl.innerHTML = '';
    try {
      const d = await fetch(`/api/code-graph/treemap?project=${encodeURIComponent(project)}`).then(r => r.json());
      _nodes = d.nodes || [];
      renderSvg();
    } catch (e) {
      svgWrap.innerHTML = `<div style="color:var(--red);padding:20px">Error: ${esc(e.message)}</div>`;
    }
  }

  // ── event wiring ──────────────────────────────────────────────────────────

  projSel.addEventListener('change', () => {
    setProject(projSel.value);
    loadAndRender(getProject());
  });

  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      _mode = btn.dataset.mode;
      modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === _mode));
      renderSvg();
    });
  });

  // Re-render on window resize so the SVG tracks container width.
  // WHY: inline SVG width is computed from container at render time; a resize
  // listener keeps it responsive without a ResizeObserver dependency.
  let _resizeTimer = null;
  const onResize = () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      if (_nodes.length) renderSvg();
    }, 180);
  };
  window.addEventListener('resize', onResize);
  // Assign to module-level var so the NEXT mount can clean this up.
  _tmCleanup = () => {
    window.removeEventListener('resize', onResize);
    clearTimeout(_resizeTimer);
  };

  // ── initial load ──────────────────────────────────────────────────────────
  await loadAndRender(getProject());
});
