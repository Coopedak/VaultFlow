/**
 * project-store.js — Shared project selection state for the CodeFlow views.
 *
 * Holds the active project name in localStorage (key 'vf_project') and
 * provides the project list fetched from /api/projects. Both code-graph.js
 * and treemap.js import from here so the selector stays in sync across views.
 *
 * WHY a module-level cache: the project list doesn't change during a dashboard
 * session and is requested by multiple views. One fetch + shared array avoids
 * duplicate round-trips and keeps view mount times fast.
 */

let _project = localStorage.getItem('vf_project') || 'vaultflow';
let _projects = [];

/** Return the currently-selected project name. */
export const getProject = () => _project;

/** Persist the selected project and update the in-memory value. */
export const setProject = (p) => {
  _project = p;
  localStorage.setItem('vf_project', p);
};

/**
 * Ensure the project list is loaded (fetched at most once per page load).
 * Also seeds the default project from mostActive when localStorage has no
 * prior selection.
 * @returns {Promise<Array<{project:string, files:number, symbols:number}>>}
 */
export async function loadProjects() {
  if (!_projects.length) {
    const r = await fetch('/api/projects');
    const j = await r.json();
    _projects = j.projects || [];
    // Seed default only when the user has never explicitly picked one.
    if (!localStorage.getItem('vf_project') && j.mostActive) {
      setProject(j.mostActive);
    }
  }
  return _projects;
}

/**
 * Render a <select> element HTML string for the loaded project list.
 * Caller must have called loadProjects() first.
 * @returns {string} HTML fragment — a <select id="vf-proj-sel"> element.
 */
export function projectSelectorHtml() {
  const options = _projects.map(p => {
    const sel = p.project === _project ? ' selected' : '';
    const label = p.project + (p.files ? ` (${p.files} files)` : '');
    return `<option value="${escAttr(p.project)}"${sel}>${escHtml(label)}</option>`;
  }).join('');
  return `<select id="vf-proj-sel" class="cf-proj-sel">${options}</select>`;
}

// ── internal helpers ───────────────────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s) {
  return String(s ?? '').replace(/"/g, '&quot;');
}
