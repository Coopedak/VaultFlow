/**
 * brain-dictionary.js — Dictionary browser view for the Synapse dashboard.
 *
 * Fetches GET /api/dictionary (+ ?q= for search) and renders:
 *   • Horizontal bar chart of term counts by category
 *   • Search input (clears chart, shows filtered table on query)
 *   • Table of terms (Term | Category | Definition)
 *
 * Mirrors v1 loadDictionary / renderDictTable columns with Synapse CSS vars.
 * Chart lifecycle: module-scope variable + destroy-before-init prevents
 * "Canvas is already in use" on re-navigation.
 */

import { api, registerView } from './core.js';
import { bar } from './charts.js';

/** Escape HTML special characters in user-controlled strings before innerHTML injection. */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function trunc(s, n) {
  const str = String(s ?? '');
  return str.length > n ? esc(str.slice(0, n)) + '…' : esc(str);
}

// Module-scope chart instance — destroyed before every re-render.
let _chart = null;

registerView('brain-dictionary', async (el) => {
  el.innerHTML = `
    <div id="dict-chart-wrap" class="card" style="margin-bottom:16px">
      <h3 style="margin-bottom:12px">Terms by Category</h3>
      <div style="position:relative;height:220px">
        <canvas id="dict-bar-chart"></canvas>
      </div>
    </div>
    <div class="card">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px">
        <input id="dict-search-input" class="search-input" placeholder="Search dictionary…" style="flex:1" />
        <button id="dict-search-btn" class="btn">Search</button>
      </div>
      <div id="dict-table-title" style="color:var(--muted);margin-bottom:8px">Recent Terms</div>
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead>
            <tr>
              <th>Term</th>
              <th>Category</th>
              <th>Definition</th>
            </tr>
          </thead>
          <tbody id="dict-body">
            <tr><td colspan="3" style="color:var(--muted);padding:20px">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>`;

  const searchInput  = el.querySelector('#dict-search-input');
  const searchBtn    = el.querySelector('#dict-search-btn');
  const tableTitle   = el.querySelector('#dict-table-title');
  const tbody        = el.querySelector('#dict-body');
  const chartWrap    = el.querySelector('#dict-chart-wrap');

  function renderTable(rows, title) {
    tableTitle.textContent = title;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="color:var(--muted);padding:20px">No results.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td><strong>${esc(r.term || '—')}</strong></td>
        <td>${r.category ? `<span class="badge badge-gray">${esc(r.category)}</span>` : '—'}</td>
        <td>${trunc(r.definition || r.snippet || '', 120)}</td>
      </tr>`).join('');
  }

  // Destroy previous chart before re-creating (prevents "canvas already in use").
  if (_chart) { _chart.destroy(); _chart = null; }

  // Initial load
  try {
    const data = await api('/api/dictionary');
    const { counts = [], recent = [] } = data;

    if (counts.length) {
      const canvas = el.querySelector('#dict-bar-chart');
      if (canvas) {
        _chart = bar(canvas, counts.map(r => esc(r.category)), counts.map(r => r.cnt));
      }
    } else {
      chartWrap.style.display = 'none';
    }

    renderTable(recent, 'Recent Terms');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="3" style="color:var(--err,#f85149);padding:20px">Error: ${esc(e.message)}</td></tr>`;
  }

  // Search handler
  async function doSearch() {
    const q = searchInput.value.trim();
    if (!q) {
      // Reset: show chart + reload recent
      chartWrap.style.display = '';
      try {
        const data = await api('/api/dictionary');
        renderTable(data.recent || [], 'Recent Terms');
      } catch (e) {
        renderTable([], 'Recent Terms');
      }
      return;
    }
    chartWrap.style.display = 'none';
    try {
      const data = await api(`/api/dictionary?q=${encodeURIComponent(q)}`);
      const rows = (data.results || []).map(r => ({
        term: r.term, category: r.category, definition: r.definition || r.snippet,
      }));
      renderTable(rows, `Search: "${esc(q)}" — ${rows.length} result${rows.length !== 1 ? 's' : ''}`);
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="3" style="color:var(--err,#f85149);padding:20px">Error: ${esc(e.message)}</td></tr>`;
    }
  }

  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
});
