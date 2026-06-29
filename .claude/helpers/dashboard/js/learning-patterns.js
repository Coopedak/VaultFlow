/**
 * learning-patterns.js — Learning patterns view for the Synapse dashboard.
 *
 * Fetches GET /api/patterns and renders:
 *   • Horizontal bar chart of top 20 patterns by fire count
 *   • Table listing Pattern Key | Agent | Fire Count | Confidence | Last Fired | Promoted | Action
 *     — Promote button per eligible row: POST /api/patterns/:id/promote
 *       Optimistic update: marks row promoted immediately; button disabled during POST.
 *
 * Mirrors v1 loadPatterns layout with Synapse CSS vars.
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

function fmtPct(v) {
  return v != null ? (Number(v) * 100).toFixed(0) + '%' : '—';
}

// Module-scope chart instance — destroyed before every re-render.
let _chart = null;

registerView('learning-patterns', async (el) => {
  el.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <h3 style="margin-bottom:12px">Top Patterns by Fire Count <span style="color:var(--muted);font-weight:400;font-size:13px">top 20</span></h3>
      <div style="position:relative;height:280px">
        <canvas id="patterns-bar-chart"></canvas>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:16px">Pattern Registry</h3>
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead>
            <tr>
              <th>Pattern Key</th>
              <th>Agent</th>
              <th>Fires</th>
              <th>Confidence</th>
              <th>Last Fired</th>
              <th>Promoted</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="patterns-body">
            <tr><td colspan="7" style="color:var(--muted);padding:20px">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>`;

  const tbody = el.querySelector('#patterns-body');

  // Destroy previous chart before re-creating (prevents "canvas already in use").
  if (_chart) { _chart.destroy(); _chart = null; }

  try {
    const rows = await api('/api/patterns');

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="color:var(--muted);padding:20px">No patterns yet.</td></tr>';
      el.querySelector('#patterns-bar-chart')?.closest('.card')?.remove();
      return;
    }

    // Chart — top 20 by fire_count
    const top    = rows.slice(0, 20);
    const canvas = el.querySelector('#patterns-bar-chart');
    if (canvas) {
      _chart = bar(canvas, top.map(r => trunc(r.pattern_key, 40)), top.map(r => r.fire_count ?? 0));
    }

    // Table — all rows
    tbody.innerHTML = rows.map(r => {
      const promoted = !!r.promoted;
      return `<tr data-pattern-id="${esc(String(r.id))}">
        <td class="mono">${trunc(r.pattern_key, 60)}</td>
        <td>${esc(r.agent || '—')}</td>
        <td><strong>${r.fire_count ?? 0}</strong></td>
        <td>${fmtPct(r.confidence)}</td>
        <td class="mono">${fmtDate(r.last_fired)}</td>
        <td class="promoted-cell">${promoted
          ? '<span class="badge badge-green">yes</span>'
          : '<span class="badge badge-gray">no</span>'}</td>
        <td><button class="btn btn-promote" data-id="${esc(String(r.id))}" ${promoted ? 'disabled' : ''}>${promoted ? 'promoted' : 'promote'}</button></td>
      </tr>`;
    }).join('');

    // Promote button handlers — disable during POST, optimistically update on success
    tbody.querySelectorAll('.btn-promote').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        btn.disabled = true;
        try {
          const r = await fetch(`/api/patterns/${encodeURIComponent(id)}/promote`, { method: 'POST' });
          if (r.ok) {
            // Optimistic update — mark row as promoted without re-fetching
            btn.textContent = 'promoted';
            const row = tbody.querySelector(`tr[data-pattern-id="${CSS.escape(id)}"]`);
            if (row) {
              row.querySelector('.promoted-cell').innerHTML = '<span class="badge badge-green">yes</span>';
            }
          } else {
            btn.disabled = false;
          }
        } catch {
          btn.disabled = false;
        }
      });
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--err,#f85149);padding:20px">Error: ${esc(e.message)}</td></tr>`;
  }
});
