/**
 * brain-discoveries.js — Code pattern discoveries view for the Synapse dashboard.
 *
 * Fetches GET /api/discoveries and renders all rows in a table.
 *
 * Mirrors v1 loadDiscoveries columns:
 *   File | Pattern | Agent | Date | Fires | Promoted | Preview
 */

import { api, registerView } from './core.js';

/** Escape HTML special characters in user-controlled strings before innerHTML injection. */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function trunc(s, n) {
  const str = String(s ?? '');
  return str.length > n ? esc(str.slice(0, n)) + '…' : esc(str);
}

registerView('brain-discoveries', async (el) => {
  el.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:16px">Discoveries</h3>
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Pattern</th>
              <th>Agent</th>
              <th>Date</th>
              <th>Fires</th>
              <th>Promoted</th>
              <th>Preview</th>
            </tr>
          </thead>
          <tbody id="disc-body">
            <tr><td colspan="7" style="color:var(--muted);padding:20px">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>`;

  const tbody = el.querySelector('#disc-body');

  try {
    const rows = await api('/api/discoveries');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="color:var(--muted);padding:20px">No discoveries found.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td class="mono">${esc(r.file)}</td>
        <td>${trunc(r.pattern, 50)}</td>
        <td>${r.agent ? `<span class="badge badge-blue">${esc(r.agent)}</span>` : '—'}</td>
        <td class="mono">${esc(r.date || '—')}</td>
        <td>${r.fire_count ?? '—'}</td>
        <td>${r.promoted
          ? '<span class="badge badge-green">yes</span>'
          : '<span class="badge badge-gray">no</span>'}</td>
        <td><pre style="white-space:pre-wrap;font-size:11px;color:var(--muted);margin:0">${trunc(r.preview, 120)}</pre></td>
      </tr>`).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--err,#f85149);padding:20px">Error: ${esc(e.message)}</td></tr>`;
  }
});
