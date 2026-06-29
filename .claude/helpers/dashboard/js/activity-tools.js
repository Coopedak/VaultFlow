/**
 * activity-tools.js — Tool Calls view for the Synapse dashboard.
 *
 * Fetches GET /api/tool-calls and renders:
 *   • Doughnut chart of tool distribution by call count
 *   • Bar chart of dupe rate per tool (colour-coded: red >50%, yellow >20%, green otherwise)
 *   • Table of recent tool calls (Date | Tool | Input Hash | Session)
 *
 * Mirrors v1 loadTools layout with Synapse CSS vars.
 * Chart lifecycle: TWO module-scope variables + destroy-before-init prevents
 * "Canvas is already in use" on re-navigation.
 */

import { api, registerView, F } from './core.js';
import { doughnut, bar } from './charts.js';

/** Escape HTML special characters in user-controlled strings before innerHTML injection. */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return esc(String(ts)); }
}

// Module-scope chart instances — destroyed before every re-render.
let _chartDoughnut = null;
let _chartDupe     = null;

registerView('activity-tools', async (el) => {
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
      <div class="card">
        <h3 style="margin-bottom:12px">Tool Distribution <span style="color:var(--muted);font-weight:400;font-size:13px">by call count</span></h3>
        <div style="position:relative;height:280px">
          <canvas id="tools-doughnut-chart"></canvas>
        </div>
      </div>
      <div class="card">
        <h3 style="margin-bottom:12px">Dupe Rate <span style="color:var(--muted);font-weight:400;font-size:13px">% duplicate calls</span></h3>
        <div style="position:relative;height:280px">
          <canvas id="tools-dupe-chart"></canvas>
        </div>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:16px">Recent Tool Calls</h3>
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Tool</th>
              <th>Input Hash</th>
              <th>Session</th>
            </tr>
          </thead>
          <tbody id="tools-body">
            <tr><td colspan="4" style="color:var(--muted);padding:20px">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>`;

  const tbody = el.querySelector('#tools-body');

  // Destroy previous charts before re-creating (prevents "canvas already in use").
  if (_chartDoughnut) { _chartDoughnut.destroy(); _chartDoughnut = null; }
  if (_chartDupe)     { _chartDupe.destroy();     _chartDupe     = null; }

  try {
    const data = await api('/api/tool-calls');
    const { summary = [], recent = [] } = data;

    if (summary.length) {
      // Doughnut — tool distribution
      const doughnutCanvas = el.querySelector('#tools-doughnut-chart');
      if (doughnutCanvas) {
        _chartDoughnut = doughnut(doughnutCanvas, summary.map(r => esc(r.tool_name)), summary.map(r => r.call_count));
      }

      // Bar — dupe rate, colour-coded by severity
      const dupeCanvas = el.querySelector('#tools-dupe-chart');
      if (dupeCanvas) {
        const bg     = summary.map(r => r.dupe_rate > 50 ? '#f8717199' : r.dupe_rate > 20 ? '#facc1599' : '#4ade8099');
        const border = summary.map(r => r.dupe_rate > 50 ? '#f87171'   : r.dupe_rate > 20 ? '#facc15'   : '#4ade80');
        _chartDupe = bar(dupeCanvas, summary.map(r => esc(r.tool_name)), summary.map(r => r.dupe_rate), {
          datasets: [{ backgroundColor: bg, borderColor: border }],
        });
      }
    } else {
      // No summary data — hide chart cards
      el.querySelector('#tools-doughnut-chart')?.closest('.card')?.style.setProperty('display', 'none');
      el.querySelector('#tools-dupe-chart')?.closest('.card')?.style.setProperty('display', 'none');
    }

    if (!recent.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted);padding:20px">No tool calls recorded yet.</td></tr>';
      return;
    }

    tbody.innerHTML = recent.map(r => `
      <tr>
        <td class="mono">${fmtDate(r.timestamp)}</td>
        <td><span class="badge badge-blue">${esc(r.tool_name || '—')}</span></td>
        <td class="mono">${r.input_hash ? esc(r.input_hash.slice(0, 12)) + '…' : '—'}</td>
        <td class="mono">${r.session_id ? esc(r.session_id.slice(0, 8)) + '…' : '—'}</td>
      </tr>`).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--err,#f85149);padding:20px">Error: ${esc(e.message)}</td></tr>`;
  }
});
