/**
 * system-health.js — System health table + unified search for the Synapse dashboard.
 *
 * Fetches GET /api/health and renders the checks table with overall status.
 * Also provides a unified search box hitting GET /api/search?q= (FTS) and
 * GET /api/semantic-search?q= (embeddings), rendering results grouped by type.
 *
 * Scoped to health + unified search ONLY — the remaining loadGraph sections
 * (code graph metrics, hubs, focus editor, etc.) belong to future batches.
 *
 * Mirrors v1 health-table and unified-search rendering from loadGraph.
 */

import { api, registerView } from './core.js';

/** Escape HTML special characters in user-controlled strings before innerHTML injection. */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

registerView('system-health', async (el) => {
  el.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <h3 id="health-title" style="margin-bottom:16px">System Health</h3>
      <div style="overflow-x:auto">
        <table class="data-table">
          <thead>
            <tr>
              <th>Check</th>
              <th>Value</th>
              <th>Detail</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="health-body">
            <tr><td colspan="4" style="color:var(--muted);padding:20px">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-bottom:12px">Unified Search</h3>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
        <input id="unified-q" class="search-input" placeholder="Search memory, symbols, commits, dictionary…" style="flex:1" />
        <button id="btn-unified" class="btn">FTS Search</button>
        <button id="btn-semantic" class="btn">Semantic</button>
      </div>
      <div id="unified-results" style="color:var(--muted)">Enter a query above.</div>
    </div>`;

  // ── health table ────────────────────────────────────────────────────────────

  const healthTitle = el.querySelector('#health-title');
  const healthBody  = el.querySelector('#health-body');

  function colorFor(status) {
    if (status === 'ok')   return 'var(--ok, #3fb950)';
    if (status === 'warn') return 'var(--warn, #d29922)';
    return 'var(--err, #f85149)';
  }

  try {
    const h = await api('/api/health');
    healthTitle.innerHTML =
      `System Health — <span style="color:${colorFor(h.overall)}">${esc(h.overall.toUpperCase())}</span>`;
    if (!h.checks || !h.checks.length) {
      healthBody.innerHTML = '<tr><td colspan="4" style="color:var(--muted);padding:20px">No checks returned.</td></tr>';
    } else {
      healthBody.innerHTML = h.checks.map(c => `
        <tr>
          <td>${esc(c.name)}</td>
          <td class="mono">${esc(c.value)}</td>
          <td style="color:var(--muted)">${esc(c.detail)}</td>
          <td style="color:${colorFor(c.status)};font-weight:bold">${esc(c.status.toUpperCase())}</td>
        </tr>`).join('');
    }
  } catch (e) {
    healthTitle.textContent = 'System Health — Error';
    healthBody.innerHTML = `<tr><td colspan="4" style="color:var(--err,#f85149);padding:20px">${esc(e.message)}</td></tr>`;
  }

  // ── unified search ──────────────────────────────────────────────────────────

  const unifiedQ       = el.querySelector('#unified-q');
  const btnUnified     = el.querySelector('#btn-unified');
  const btnSemantic    = el.querySelector('#btn-semantic');
  const unifiedResults = el.querySelector('#unified-results');

  function renderUnified(d) {
    const blocks = [];
    if (d.memory && d.memory.length) {
      blocks.push(
        `<div><strong>Memory (${d.memory.length})</strong></div>` +
        d.memory.map(r =>
          `<div style="margin-left:12px">— <b>${esc(r.title)}</b> — ${esc(r.source || '')}</div>`
        ).join('')
      );
    }
    if (d.symbols && d.symbols.length) {
      blocks.push(
        `<div style="margin-top:8px"><strong>Symbols (${d.symbols.length})</strong></div>` +
        d.symbols.map(s =>
          `<div style="margin-left:12px">— <code>${esc(s.name)}</code> (${esc(s.kind)}) — ${esc(s.file)}:${s.line}</div>`
        ).join('')
      );
    }
    if (d.commits && d.commits.length) {
      blocks.push(
        `<div style="margin-top:8px"><strong>Commits (${d.commits.length})</strong></div>` +
        d.commits.map(c =>
          `<div style="margin-left:12px">— <code>${esc(String(c.sha).slice(0, 7))}</code> [${esc(c.project)}] ${esc(c.subject)}</div>`
        ).join('')
      );
    }
    if (d.dictionary && d.dictionary.length) {
      blocks.push(
        `<div style="margin-top:8px"><strong>Dictionary (${d.dictionary.length})</strong></div>` +
        d.dictionary.map(t =>
          `<div style="margin-left:12px">— <b>${esc(t.term)}</b> — ${esc(String(t.definition || '').slice(0, 160))}</div>`
        ).join('')
      );
    }
    if (d.vault_tools && d.vault_tools.length) {
      blocks.push(
        `<div style="margin-top:8px"><strong>Vault tools (${d.vault_tools.length})</strong></div>` +
        d.vault_tools.map(t =>
          `<div style="margin-left:12px">— <b>${esc(t.name)}</b> — ${esc(t.description || '')}</div>`
        ).join('')
      );
    }
    if (d.rows && d.rows.length) {
      blocks.push(
        `<div><strong>Semantic matches (${d.rows.length})</strong></div>` +
        d.rows.map(r =>
          `<div style="margin-left:12px">— <b>${esc(r.title)}</b> (${Number(r.score).toFixed(3)}) — ${esc(r.source || '')}</div>`
        ).join('')
      );
    }
    unifiedResults.innerHTML = blocks.length
      ? blocks.join('')
      : '<div style="color:var(--muted)">No results.</div>';
  }

  btnUnified.addEventListener('click', async () => {
    const q = unifiedQ.value.trim();
    if (!q) return;
    unifiedResults.innerHTML = '<div style="color:var(--muted)">Searching…</div>';
    try {
      renderUnified(await api(`/api/search?q=${encodeURIComponent(q)}`));
    } catch (e) {
      unifiedResults.innerHTML = `<div style="color:var(--err,#f85149)">${esc(e.message)}</div>`;
    }
  });

  btnSemantic.addEventListener('click', async () => {
    const q = unifiedQ.value.trim();
    if (!q) return;
    unifiedResults.innerHTML = '<div style="color:var(--muted)">Embedding query…</div>';
    try {
      renderUnified(await api(`/api/semantic-search?q=${encodeURIComponent(q)}`));
    } catch (e) {
      unifiedResults.innerHTML =
        `<div style="color:var(--err,#f85149)">${esc(e.message)} (run <code>npm run embeddings:backfill</code> first)</div>`;
    }
  });

  unifiedQ.addEventListener('keydown', e => {
    if (e.key === 'Enter') btnUnified.click();
  });
});
