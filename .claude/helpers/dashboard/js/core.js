import * as fmt from './format.js';
export const F = fmt;
export async function api(p) { const r = await fetch(p); if (!r.ok) throw new Error(p + ' → ' + r.status); return r.json(); }
const views = new Map();
export function registerView(key, render) { views.set(key, render); }
const mount = () => document.getElementById('view');
async function route() {
  const key = (location.hash.replace(/^#\/?/, '') || 'command-center');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === key));
  const render = views.get(key) || views.get('__placeholder');
  const el = mount(); el.innerHTML = '<div class="loading">Loading…</div>';
  try { await render(el); } catch (e) { el.innerHTML = `<div class="loading">Error: ${e.message}</div>`; }
}
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);
// Phase-2 stub for sections not yet migrated
registerView('__placeholder', (el) => { el.innerHTML = '<div class="card"><h3>Coming in the migration</h3><p style="color:var(--muted)">This section moves into the Synapse shell in Phase 2.</p></div>'; });
