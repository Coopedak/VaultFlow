/**
 * activity-prompts.js — Recent prompts + skill routing view for the Synapse dashboard.
 *
 * Fetches GET /api/prompts/recent and renders:
 *   • Horizontal bar chart of skill routing counts
 *   • Table of recent prompts (Date | Preview | Source | Skill Routed)
 *
 * Mirrors v1 loadPrompts columns with Synapse CSS vars.
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

registerView('activity-prompts', async (el) => {
  el.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <h3 style="margin-bottom:12px">Skill Routing <span style="color:var(--muted);font-weight:400;font-size:13px">by count</span></h3>
      <div style="position:relative;height:220px">
        <canvas id="prompts-bar-chart"></canvas>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:16px">Recent Prompts</h3>
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Preview</th>
              <th>Source</th>
              <th>Skill Routed</th>
            </tr>
          </thead>
          <tbody id="prompts-body">
            <tr><td colspan="4" style="color:var(--muted);padding:20px">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>`;

  const tbody = el.querySelector('#prompts-body');

  // Destroy previous chart before re-creating (prevents "canvas already in use").
  if (_chart) { _chart.destroy(); _chart = null; }

  try {
    const data = await api('/api/prompts/recent');
    const { recent = [], routing = [] } = data;

    // Chart — only drawn when routing data exists
    if (routing.length) {
      const canvas = el.querySelector('#prompts-bar-chart');
      if (canvas) {
        _chart = bar(canvas, routing.map(r => esc(r.skill_routed)), routing.map(r => r.cnt));
      }
    } else {
      const chartCard = el.querySelector('#prompts-bar-chart')?.closest('.card');
      if (chartCard) chartCard.style.display = 'none';
    }

    // Table
    if (!recent.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted);padding:20px">No prompts recorded yet.</td></tr>';
      return;
    }
    tbody.innerHTML = recent.map(r => {
      const srcCell   = r.source
        ? `<span class="badge badge-blue">${esc(r.source)}</span>`
        : '—';
      const skillCell = r.skill_routed
        ? `<span class="badge badge-purple">${esc(r.skill_routed)}</span>`
        : '—';
      return `<tr>
        <td class="mono">${fmtDate(r.timestamp)}</td>
        <td>${trunc(r.prompt_preview, 100)}</td>
        <td>${srcCell}</td>
        <td>${skillCell}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--err,#f85149);padding:20px">Error: ${esc(e.message)}</td></tr>`;
  }
});
