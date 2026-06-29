/**
 * learning-agents.js — Agent usage list view for the Synapse dashboard.
 *
 * Fetches GET /api/agents (the DB-backed agent registry with use_count etc.)
 * and renders:
 *   • Horizontal bar chart of the top 20 agents by use_count
 *   • Table listing Name | Source | Uses | Last Used | Trigger Pattern
 *
 * This is the READ-ONLY agent list. The Create Agent wizard lives at key
 * 'agents' (js/agents.js) and is NOT touched here.
 *
 * Mirrors v1 loadAgents columns with Synapse CSS vars.
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

function fmtDate(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return esc(String(ts)); }
}

// Module-scope chart instance — destroyed before every re-render.
let _chart = null;

registerView('learning-agents', async (el) => {
  el.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <h3 style="margin-bottom:12px">Top Agents by Use <span style="color:var(--muted);font-weight:400;font-size:13px">top 20</span></h3>
      <div style="position:relative;height:280px">
        <canvas id="agents-bar-chart"></canvas>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:16px">Agent Registry</h3>
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Source</th>
              <th>Uses</th>
              <th>Last Used</th>
              <th>Trigger Pattern</th>
            </tr>
          </thead>
          <tbody id="agents-list-body">
            <tr><td colspan="5" style="color:var(--muted);padding:20px">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>`;

  const tbody = el.querySelector('#agents-list-body');

  // Destroy previous chart before re-creating (prevents "canvas already in use").
  if (_chart) { _chart.destroy(); _chart = null; }

  try {
    const rows = await api('/api/agents');

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted);padding:20px">No agents registered yet.</td></tr>';
      // hide chart card when empty
      el.querySelector('#agents-bar-chart')?.closest('.card')?.remove();
      return;
    }

    // Chart — top 20 by use_count
    const top    = rows.slice(0, 20);
    const canvas = el.querySelector('#agents-bar-chart');
    if (canvas) {
      _chart = bar(canvas, top.map(r => esc(r.name)), top.map(r => r.use_count ?? 0));
    }

    // Table — all rows
    tbody.innerHTML = rows.map(r => {
      const srcBadge = r.source === 'codex'
        ? `<span class="badge badge-yellow">${esc(r.source)}</span>`
        : `<span class="badge badge-blue">${esc(r.source || '—')}</span>`;
      return `<tr>
        <td><strong>${esc(r.name || '—')}</strong></td>
        <td>${srcBadge}</td>
        <td><strong>${r.use_count ?? 0}</strong></td>
        <td class="mono">${fmtDate(r.last_used)}</td>
        <td class="mono">${trunc(r.trigger_pattern, 60)}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--err,#f85149);padding:20px">Error: ${esc(e.message)}</td></tr>`;
  }
});
