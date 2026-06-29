/**
 * activity-edits.js — Hot files (most edited) view for the Synapse dashboard.
 *
 * Fetches GET /api/edits/hot and renders:
 *   • Horizontal bar chart of the top edited files
 *   • Table listing file path + edit count
 *
 * Mirrors v1 loadEdits layout with Synapse CSS vars.
 * Chart lifecycle: module-scope variable + destroy-before-init prevents
 * "Canvas is already in use" on re-navigation.
 */

import { api, registerView, F } from './core.js';
import { bar } from './charts.js';

/** Escape HTML special characters in user-controlled strings before innerHTML injection. */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shortPath(p) {
  if (!p) return '—';
  const parts = String(p).split(/[/\\]/);
  return parts.slice(-2).join('/');
}

// Module-scope chart instance — destroyed before every re-render.
let _chart = null;

registerView('activity-edits', async (el) => {
  el.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <h3 style="margin-bottom:12px">Hot Files <span style="color:var(--muted);font-weight:400;font-size:13px">most edited</span></h3>
      <div style="position:relative;height:260px">
        <canvas id="edits-bar-chart"></canvas>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:16px">Edit Counts</h3>
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Edits</th>
            </tr>
          </thead>
          <tbody id="edits-body">
            <tr><td colspan="2" style="color:var(--muted);padding:20px">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>`;

  const tbody = el.querySelector('#edits-body');

  // Destroy previous chart before re-creating (prevents "canvas already in use").
  if (_chart) { _chart.destroy(); _chart = null; }

  try {
    const rows = await api('/api/edits/hot');

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="2" style="color:var(--muted);padding:20px">No edit data yet.</td></tr>';
      return;
    }

    // Chart
    const canvas = el.querySelector('#edits-bar-chart');
    if (canvas) {
      const labels = rows.map(r => shortPath(r.file_path));
      const data   = rows.map(r => r.edit_count);
      _chart = bar(canvas, labels, data);
    }

    // Table
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td class="mono">${esc(r.file_path || '—')}</td>
        <td><strong>${F.fmtNum(r.edit_count)}</strong></td>
      </tr>`).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="2" style="color:var(--err,#f85149);padding:20px">Error: ${esc(e.message)}</td></tr>`;
  }
});
