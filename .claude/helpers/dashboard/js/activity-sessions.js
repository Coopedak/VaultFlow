/**
 * activity-sessions.js — Sessions list view for the Synapse dashboard.
 *
 * Fetches GET /api/sessions and renders all rows in a table.
 *
 * Mirrors v1 loadSessions columns:
 *   Date | Project | Duration | Edits | Commands | Errors | Platform/CLI/Model
 *
 * No chart — this is the warm-up view for Batch 2.
 */

import { api, registerView, F } from './core.js';

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

function fmtDur(ms) {
  if (ms == null || ms === 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

registerView('activity-sessions', async (el) => {
  el.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:16px">Sessions</h3>
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Project</th>
              <th>Duration</th>
              <th>Edits</th>
              <th>Commands</th>
              <th>Errors</th>
              <th>Platform / CLI / Model</th>
            </tr>
          </thead>
          <tbody id="sessions-body">
            <tr><td colspan="7" style="color:var(--muted);padding:20px">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>`;

  const tbody = el.querySelector('#sessions-body');

  try {
    const rows = await api('/api/sessions');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="color:var(--muted);padding:20px">No sessions found.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const proj    = esc(r.project || r.cwd?.split(/[/\\]/).pop() || '—');
      const meta    = [r.platform, r.cli, r.model].filter(Boolean).map(esc).join(' · ') || '—';
      const errCell = r.errors
        ? `<span class="badge badge-yellow">${esc(String(r.errors))}</span>`
        : '—';
      return `<tr>
        <td class="mono">${fmtDate(r.started_at)}</td>
        <td>${proj}</td>
        <td class="mono">${fmtDur(r.duration_ms)}</td>
        <td>${F.fmtNum(r.edits)}</td>
        <td>${F.fmtNum(r.commands)}</td>
        <td>${errCell}</td>
        <td class="mono">${meta}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--err,#f85149);padding:20px">Error: ${esc(e.message)}</td></tr>`;
  }
});
