/**
 * code-stacks.js — Tech stack detection card grid for the Synapse dashboard.
 *
 * Fetches GET /api/stacks and renders one card per project showing detected
 * stack tags. Tags with confidence >= 0.9 receive a highlight style.
 *
 * Mirrors v1 loadStacks layout.
 */

import { api, registerView } from './core.js';

/** Escape HTML special characters in user-controlled strings before innerHTML injection. */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Inject scoped styles once.
if (!document.getElementById('code-stacks-styles')) {
  const style = document.createElement('style');
  style.id = 'code-stacks-styles';
  style.textContent = `
    .stacks-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 12px;
    }
    .stack-project-card {
      background: var(--surface, #1e2130);
      border: 1px solid var(--border, #2a2d3e);
      border-radius: 6px;
      padding: 12px 14px;
    }
    .stack-project-name {
      font-weight: 600;
      margin-bottom: 8px;
      word-break: break-all;
    }
    .stack-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .stack-tag {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 10px;
      background: var(--border, #2a2d3e);
      color: var(--muted, #8892a4);
      cursor: default;
    }
    .stack-tag.hi {
      background: var(--accent, #6ab);
      color: var(--bg, #141520);
      font-weight: 600;
    }
  `;
  document.head.appendChild(style);
}

registerView('code-stacks', async (el) => {
  el.innerHTML = `
    <div class="card">
      <h3 style="margin-bottom:16px">Tech Stacks</h3>
      <div id="stacks-grid" class="stacks-grid">
        <div style="color:var(--muted)">Loading…</div>
      </div>
    </div>`;

  const grid = el.querySelector('#stacks-grid');

  try {
    const data = await api('/api/stacks');
    const { byProject = {} } = data;
    const projects = Object.entries(byProject);
    if (!projects.length) {
      grid.innerHTML = '<div style="color:var(--muted)">No stacks detected yet.</div>';
      return;
    }
    grid.innerHTML = projects.map(([proj, stacks]) => `
      <div class="stack-project-card">
        <div class="stack-project-name">${esc(proj)}</div>
        <div class="stack-tags">
          ${stacks.map(s =>
            `<span class="stack-tag ${s.confidence >= 0.9 ? 'hi' : ''}" title="confidence: ${(Number(s.confidence) * 100).toFixed(0)}%">${esc(s.stack)}</span>`
          ).join('')}
        </div>
      </div>`).join('');
  } catch (e) {
    grid.innerHTML = `<div style="color:var(--err,#f85149)">Error: ${esc(e.message)}</div>`;
  }
});
