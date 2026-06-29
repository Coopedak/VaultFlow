/**
 * brain-memory.js — FTS memory search view for the Synapse dashboard.
 *
 * Search-driven: shows a prompt until the user types a query, then hits
 * GET /api/memory?q=<query> and renders results in a table.
 *
 * Mirrors v1 doMemorySearch / renderMemoryResults columns:
 *   Title | Source | Body (truncated) | Tags | Rank
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

registerView('brain-memory', async (el) => {
  el.innerHTML = `
    <div class="card">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px">
        <input id="bm-input" class="search-input" placeholder="Search memory…" style="flex:1" />
        <button id="bm-btn" class="btn">Search</button>
      </div>
      <div id="bm-title" style="color:var(--muted);margin-bottom:8px">Enter a query to search memory.</div>
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Source</th>
              <th>Body</th>
              <th>Tags</th>
              <th>Rank</th>
            </tr>
          </thead>
          <tbody id="bm-body">
            <tr><td colspan="5" style="color:var(--muted);padding:20px">No results.</td></tr>
          </tbody>
        </table>
      </div>
    </div>`;

  const input  = el.querySelector('#bm-input');
  const btn    = el.querySelector('#bm-btn');
  const title  = el.querySelector('#bm-title');
  const tbody  = el.querySelector('#bm-body');

  function renderRows(rows) {
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted);padding:20px">No results.</td></tr>';
      title.textContent = 'Memory Search Results';
      title.style.color = 'var(--muted)';
      return;
    }
    title.textContent = `${rows.length} result${rows.length !== 1 ? 's' : ''}`;
    title.style.color = 'var(--fg)';
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td><strong>${esc(r.title || '—')}</strong></td>
        <td class="mono">${esc(r.source || '—')}</td>
        <td>${trunc(r.body, 140)}</td>
        <td>${r.tags ? `<span class="badge badge-gray">${esc(r.tags)}</span>` : '—'}</td>
        <td class="mono">${r.rank != null ? Number(r.rank).toFixed(3) : '—'}</td>
      </tr>`).join('');
  }

  async function doSearch() {
    const q = input.value.trim();
    if (!q) { renderRows([]); return; }
    title.textContent = 'Searching…';
    title.style.color = 'var(--muted)';
    try {
      const data = await api(`/api/memory?q=${encodeURIComponent(q)}`);
      renderRows(data.results || []);
    } catch (e) {
      title.textContent = `Error: ${e.message}`;
      title.style.color = 'var(--err, #f85149)';
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted);padding:20px">Search failed.</td></tr>';
    }
  }

  btn.addEventListener('click', doSearch);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
});
