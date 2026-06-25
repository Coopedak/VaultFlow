/**
 * atlas.js — Quartz-style knowledge view for the Synapse dashboard.
 *
 * Renders a master-detail layout over brain_notes (memory_entries):
 *   • Left column  — scrollable note list + FTS search box
 *   • Center column — reading pane (markdown rendered via window.markdownit)
 *   • Right column  — backlinks panel + local Cytoscape graph
 *
 * Note selection is internal state only; wikilink navigation loads notes
 * in-place without touching the top-level hash router.
 *
 * Consumes: GET /api/notes, GET /api/notes/:id, GET /api/memory?q=
 * Globals:  window.markdownit (vendored UMD), window.cytoscape (vendored UMD)
 */

import { api, registerView } from './core.js';

const md = window.markdownit({ html: false, linkify: true, breaks: false });

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Replace [[Name]] tokens in a note body with markdown links that target
 * #note-<id> anchors for resolved links; dangling links become plain text.
 */
function preprocessWikilinks(body, links) {
  const map = new Map((links || []).map(l => [l.name.toLowerCase(), l]));
  return String(body || '').replace(/\[\[([^\]]+)\]\]/g, (_, raw) => {
    const name = raw.trim();
    const l = map.get(name.toLowerCase());
    return (l && !l.dangling) ? `[${name}](#note-${l.id})` : name;
  });
}

/**
 * Mount a Cytoscape graph into container using the localGraph shape
 * returned by GET /api/notes/:id  { nodes:[{id,label,center}], edges:[{source,target}] }.
 */
function renderGraph(container, graph) {
  if (!graph || !graph.nodes.length || !window.cytoscape) {
    container.innerHTML = '';
    return;
  }
  window.cytoscape({
    container,
    elements: [
      ...graph.nodes.map(n => ({
        data: { id: n.id, label: n.label },
        classes: n.center ? 'center' : '',
      })),
      ...graph.edges.map(e => ({
        data: { source: e.source, target: e.target },
      })),
    ],
    style: [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          'font-size': 9,
          'background-color': '#888',
          color: '#ccc',
        },
      },
      {
        selector: 'node.center',
        style: { 'background-color': '#6ab' },
      },
      {
        selector: 'edge',
        style: {
          width: 1,
          'line-color': '#555',
          'target-arrow-shape': 'triangle',
          'target-arrow-color': '#555',
          'curve-style': 'bezier',
        },
      },
    ],
    layout: { name: 'cose', animate: false },
  });
}

// ── view ──────────────────────────────────────────────────────────────────

registerView('atlas', async (el) => {
  const { notes } = await api('/api/notes?limit=300');

  el.innerHTML = `
    <div class="atlas">
      <div class="atlas-list">
        <input class="atlas-search" placeholder="Search notes…" />
        <div class="atlas-list-items"></div>
      </div>
      <article class="atlas-read"><p class="loading">Select a note.</p></article>
      <div class="atlas-side">
        <div class="atlas-backlinks"><h4>Backlinks</h4><div class="bl"></div></div>
        <div class="atlas-graph"></div>
      </div>
    </div>`;

  const listEl  = el.querySelector('.atlas-list-items');
  const readEl  = el.querySelector('.atlas-read');
  const blEl    = el.querySelector('.bl');
  const graphEl = el.querySelector('.atlas-graph');
  const search  = el.querySelector('.atlas-search');

  /** Render the note list from an array of {id, title} objects. */
  function renderList(items) {
    listEl.innerHTML = items
      .map(n => `<a href="#" data-id="${n.id}">${n.title}</a>`)
      .join('');
  }
  renderList(notes);

  /** Fetch and display a single note by id. */
  async function loadNote(id) {
    const { note, localGraph } = await api('/api/notes/' + id);

    // Render markdown with wikilinks resolved to in-view anchors.
    readEl.innerHTML =
      `<h1>${note.title}</h1>` +
      md.render(preprocessWikilinks(note.body, note.links));

    // Tag resolved wikilink anchors so CSS can style them.
    readEl.querySelectorAll('a[href^="#note-"]').forEach(a =>
      a.classList.add('wikilink')
    );

    // Backlinks panel.
    blEl.innerHTML = note.backlinks.length
      ? note.backlinks
          .map(b => `<a href="#" data-id="${b.id}">${b.title}</a>`)
          .join('<br>')
      : '<span class="loading">None</span>';

    // Local graph.
    renderGraph(graphEl, localGraph);

    // Highlight the active list item.
    listEl.querySelectorAll('a').forEach(a =>
      a.classList.toggle('active', a.dataset.id === String(id))
    );
  }

  // Delegate clicks: list items, backlinks panel, and in-body wikilinks.
  el.addEventListener('click', (e) => {
    const byId = e.target.closest('a[data-id]');
    if (byId) {
      e.preventDefault();
      loadNote(Number(byId.dataset.id));
      return;
    }
    const wl = e.target.closest('a[href^="#note-"]');
    if (wl) {
      e.preventDefault();
      loadNote(Number(wl.getAttribute('href').slice('#note-'.length)));
    }
  });

  // Debounced search via the existing FTS memory endpoint.
  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      const q = search.value.trim();
      if (!q) return renderList(notes);
      const { results } = await api('/api/memory?q=' + encodeURIComponent(q));
      renderList(results.map(r => ({ id: r.id, title: r.title })));
    }, 250);
  });

  // Auto-load the first note if the list is non-empty.
  if (notes.length) loadNote(notes[0].id);
});
