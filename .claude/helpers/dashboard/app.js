/**
 * dashboard/app.js — vaultflow analytics SPA
 * Chart.js + vanilla JS, talks to /api/* endpoints from server.mjs
 */

'use strict';

// ── palette ──────────────────────────────────────────────────────────────────

const COLORS = [
  '#6366f1','#22d3ee','#4ade80','#facc15','#f87171',
  '#a78bfa','#fb923c','#34d399','#60a5fa','#e879f9',
  '#f472b6','#2dd4bf','#818cf8','#fbbf24','#86efac',
];

function colorAt(i) { return COLORS[i % COLORS.length]; }

const CHART_DEFAULTS = {
  animation: false,
  plugins: {
    legend: { labels: { color: '#8892a4', font: { size: 12 } } },
    tooltip: { backgroundColor: '#1a1d27', borderColor: '#2a2d3a', borderWidth: 1,
                titleColor: '#e2e8f0', bodyColor: '#8892a4' },
  },
  scales: {
    x: { ticks: { color: '#8892a4' }, grid: { color: '#2a2d3a' } },
    y: { ticks: { color: '#8892a4' }, grid: { color: '#2a2d3a' } },
  },
};

Chart.defaults.color = '#8892a4';

// ── utilities ────────────────────────────────────────────────────────────────

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit' });
}

function fmtDur(ms) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), sec = s % 60;
  if (m < 60) return `${m}m ${sec}s`;
  return `${Math.floor(m/60)}h ${m%60}m`;
}

function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString();
}

function trunc(s, len = 80) {
  if (!s) return '—';
  return s.length > len ? s.slice(0, len) + '…' : s;
}

const charts = {};

function makeChart(id, type, data, options = {}) {
  if (charts[id]) charts[id].destroy();
  const ctx = document.getElementById(id);
  if (!ctx) return;
  charts[id] = new Chart(ctx, {
    type,
    data,
    options: Object.assign({}, CHART_DEFAULTS, options),
  });
  return charts[id];
}

// ── tab routing ──────────────────────────────────────────────────────────────

const tabs = document.querySelectorAll('nav button');
const sections = document.querySelectorAll('.section');
const loaded = new Set();

function showTab(name) {
  tabs.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  sections.forEach(s => s.classList.toggle('active', s.id === `tab-${name}`));
  if (!loaded.has(name)) {
    loaded.add(name);
    LOADERS[name]?.();
  }
}

tabs.forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ── status badge ─────────────────────────────────────────────────────────────

async function loadStatus() {
  const badge = document.getElementById('status-badge');
  try {
    const s = await api('/api/status');
    badge.textContent = `DB ok · ${fmtNum(s.counts.edit_events)} edits · uptime ${fmtDur(s.uptime_s * 1000)}`;
    badge.className = 'ok';
    return s;
  } catch (e) {
    badge.textContent = 'DB error';
    badge.className = 'err';
    return null;
  }
}

// ── Overview ─────────────────────────────────────────────────────────────────

async function loadOverview() {
  const [status, summary] = await Promise.all([
    api('/api/status').catch(() => null),
    api('/api/sessions/summary').catch(() => null),
  ]);

  // stat cards
  const row = document.getElementById('stat-row');
  const stats = status ? [
    { label: 'Edit Events',   value: fmtNum(status.counts.edit_events) },
    { label: 'Sessions',      value: fmtNum(status.counts.sessions) },
    { label: 'Summaries',     value: fmtNum(status.counts.session_summaries) },
    { label: 'Patterns',      value: fmtNum(status.counts.patterns) },
    { label: 'Memory Entries',value: fmtNum(status.counts.memory_entries) },
    { label: 'Tool Calls',    value: fmtNum(status.counts.tool_calls) },
    { label: 'Prompts',       value: fmtNum(status.counts.prompts) },
    { label: 'Retrieval Docs',value: fmtNum(status.counts.retrieval_docs) },
    { label: 'Feedback Rows', value: fmtNum(status.counts.retrieval_feedback) },
    { label: 'Dict Terms',    value: fmtNum(status.counts.dictionary) },
    { label: 'Agents',        value: fmtNum(status.counts.vault_agents) },
  ] : [];
  row.innerHTML = stats.map(s =>
    `<div class="stat-card"><div class="label">${s.label}</div><div class="value">${s.value}</div></div>`
  ).join('');

  // daily sessions chart
  if (summary?.daily?.length) {
    makeChart('chart-sessions-daily', 'bar', {
      labels: summary.daily.map(r => r.day),
      datasets: [
        { label: 'Sessions', data: summary.daily.map(r => r.sessions), backgroundColor: '#6366f180', borderColor: '#6366f1', borderWidth: 1 },
        { label: 'Edits',    data: summary.daily.map(r => r.edits || 0),    backgroundColor: '#22d3ee40', borderColor: '#22d3ee', borderWidth: 1 },
      ],
    }, {
      ...CHART_DEFAULTS,
      scales: { ...CHART_DEFAULTS.scales,
        x: { ...CHART_DEFAULTS.scales.x, ticks: { ...CHART_DEFAULTS.scales.x.ticks, maxTicksLimit: 10 } },
      },
    });
  }

  // by project
  if (summary?.byProject?.length) {
    makeChart('chart-by-project', 'bar', {
      labels: summary.byProject.map(r => r.project || '(unknown)'),
      datasets: [{
        label: 'Sessions',
        data: summary.byProject.map(r => r.sessions),
        backgroundColor: summary.byProject.map((_, i) => colorAt(i) + '99'),
        borderColor: summary.byProject.map((_, i) => colorAt(i)),
        borderWidth: 1,
      }],
    }, {
      ...CHART_DEFAULTS,
      indexAxis: 'y',
      plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } },
    });
  }

  // table counts
  if (status?.counts) {
    const c = status.counts;
    const labels = Object.keys(c);
    const vals   = Object.values(c);
    makeChart('chart-table-counts', 'bar', {
      labels,
      datasets: [{
        data: vals,
        backgroundColor: labels.map((_, i) => colorAt(i) + '99'),
        borderColor:     labels.map((_, i) => colorAt(i)),
        borderWidth: 1,
      }],
    }, {
      ...CHART_DEFAULTS,
      indexAxis: 'y',
      plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } },
    });
  }
}

// ── Sessions ──────────────────────────────────────────────────────────────────

async function loadSessions() {
  const rows = await api('/api/sessions').catch(() => []);
  const body = document.getElementById('sessions-body');
  if (!rows.length) { body.innerHTML = '<tr><td colspan="7" class="loading">No sessions found</td></tr>'; return; }
  body.innerHTML = rows.map(r => `
    <tr>
      <td class="mono">${fmtDate(r.started_at)}</td>
      <td>${r.project || r.cwd?.split(/[/\\]/).pop() || '—'}</td>
      <td>${fmtDur(r.duration_ms)}</td>
      <td>${fmtNum(r.edits)}</td>
      <td>${fmtNum(r.commands)}</td>
      <td>${r.errors ? `<span class="badge badge-yellow">${r.errors}</span>` : '—'}</td>
      <td class="mono">${[r.platform, r.cli, r.model].filter(Boolean).join(' · ') || '—'}</td>
    </tr>
  `).join('');
}

// ── Edits ─────────────────────────────────────────────────────────────────────

async function loadEdits() {
  const rows = await api('/api/edits/hot').catch(() => []);
  if (!rows.length) return;
  makeChart('chart-hot-files', 'bar', {
    labels: rows.map(r => r.file_path?.split(/[/\\]/).slice(-2).join('/') || r.file_path),
    datasets: [{
      label: 'Edits',
      data: rows.map(r => r.edit_count),
      backgroundColor: rows.map((_, i) => colorAt(i) + '99'),
      borderColor:     rows.map((_, i) => colorAt(i)),
      borderWidth: 1,
    }],
  }, {
    ...CHART_DEFAULTS,
    indexAxis: 'y',
    plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } },
  });
}

// ── Patterns ──────────────────────────────────────────────────────────────────

async function loadPatterns() {
  const rows = await api('/api/patterns').catch(() => []);
  const body = document.getElementById('patterns-body');

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" class="loading">No patterns yet</td></tr>';
    return;
  }

  // chart — top 20
  const top = rows.slice(0, 20);
  makeChart('chart-patterns', 'bar', {
    labels: top.map(r => trunc(r.pattern_key, 40)),
    datasets: [{
      label: 'Fire Count',
      data: top.map(r => r.fire_count),
      backgroundColor: top.map((_, i) => colorAt(i) + '99'),
      borderColor:     top.map((_, i) => colorAt(i)),
      borderWidth: 1,
    }],
  }, {
    ...CHART_DEFAULTS,
    indexAxis: 'y',
    plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } },
  });

  // table
  body.innerHTML = rows.map(r => `
    <tr>
      <td class="mono">${trunc(r.pattern_key, 60)}</td>
      <td>${r.agent || '—'}</td>
      <td><strong>${r.fire_count}</strong></td>
      <td>${r.confidence != null ? (r.confidence * 100).toFixed(0) + '%' : '—'}</td>
      <td class="mono">${fmtDate(r.last_fired)}</td>
      <td>${r.promoted ? '<span class="badge badge-green">yes</span>' : '<span class="badge badge-gray">no</span>'}</td>
      <td>
        <button class="btn-promote" data-id="${r.id}" ${r.promoted ? 'disabled' : ''}>
          ${r.promoted ? 'promoted' : 'promote'}
        </button>
      </td>
    </tr>
  `).join('');

  // promote button handlers
  body.querySelectorAll('.btn-promote').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const id = btn.dataset.id;
      try {
        const r = await fetch(`/api/patterns/${id}/promote`, { method: 'POST' });
        if (r.ok) {
          btn.textContent = 'promoted';
          btn.closest('tr').querySelector('td:nth-child(6)').innerHTML =
            '<span class="badge badge-green">yes</span>';
        } else {
          btn.disabled = false;
        }
      } catch { btn.disabled = false; }
    });
  });
}

// ── Tool Calls ────────────────────────────────────────────────────────────────

async function loadTools() {
  const data = await api('/api/tool-calls').catch(() => ({ summary: [], recent: [] }));
  const { summary = [], recent = [] } = data;

  // doughnut
  if (summary.length) {
    makeChart('chart-tools-doughnut', 'doughnut', {
      labels: summary.map(r => r.tool_name),
      datasets: [{
        data: summary.map(r => r.call_count),
        backgroundColor: summary.map((_, i) => colorAt(i) + 'cc'),
        borderColor: summary.map((_, i) => colorAt(i)),
        borderWidth: 1,
      }],
    }, {
      ...CHART_DEFAULTS,
      scales: {},
      plugins: { ...CHART_DEFAULTS.plugins, legend: { display: true, position: 'right', labels: { color: '#8892a4', boxWidth: 12, font: { size: 11 } } } },
    });

    // dupe rate bar
    makeChart('chart-dupe-rate', 'bar', {
      labels: summary.map(r => r.tool_name),
      datasets: [{
        label: 'Dupe %',
        data: summary.map(r => r.dupe_rate),
        backgroundColor: summary.map(r => r.dupe_rate > 50 ? '#f8717199' : r.dupe_rate > 20 ? '#facc1599' : '#4ade8099'),
        borderColor:     summary.map(r => r.dupe_rate > 50 ? '#f87171'   : r.dupe_rate > 20 ? '#facc15'   : '#4ade80'),
        borderWidth: 1,
      }],
    }, {
      ...CHART_DEFAULTS,
      plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } },
    });
  }

  // recent table
  const body = document.getElementById('toolcalls-body');
  if (!recent.length) { body.innerHTML = '<tr><td colspan="4" class="loading">No tool calls yet</td></tr>'; return; }
  body.innerHTML = recent.map(r => `
    <tr>
      <td class="mono">${fmtDate(r.timestamp)}</td>
      <td><span class="badge badge-blue">${r.tool_name}</span></td>
      <td class="mono">${r.input_hash?.slice(0, 12)}…</td>
      <td class="mono">${r.session_id?.slice(0, 8)}…</td>
    </tr>
  `).join('');
}

// ── Prompts ───────────────────────────────────────────────────────────────────

async function loadPrompts() {
  const data = await api('/api/prompts/recent').catch(() => ({ recent: [], routing: [] }));
  const { recent = [], routing = [] } = data;

  if (routing.length) {
    makeChart('chart-routing', 'bar', {
      labels: routing.map(r => r.skill_routed),
      datasets: [{
        label: 'Prompts Routed',
        data: routing.map(r => r.cnt),
        backgroundColor: routing.map((_, i) => colorAt(i) + '99'),
        borderColor:     routing.map((_, i) => colorAt(i)),
        borderWidth: 1,
      }],
    }, {
      ...CHART_DEFAULTS,
      indexAxis: 'y',
      plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } },
    });
  }

  const body = document.getElementById('prompts-body');
  if (!recent.length) { body.innerHTML = '<tr><td colspan="4" class="loading">No prompts yet</td></tr>'; return; }
  body.innerHTML = recent.map(r => `
    <tr>
      <td class="mono">${fmtDate(r.timestamp)}</td>
      <td>${trunc(r.prompt_preview, 100)}</td>
      <td>${r.source ? `<span class="badge badge-blue">${r.source}</span>` : '—'}</td>
      <td>${r.skill_routed ? `<span class="badge badge-purple">${r.skill_routed}</span>` : '—'}</td>
    </tr>
  `).join('');
}

// ── Stacks ────────────────────────────────────────────────────────────────────

async function loadStacks() {
  const data = await api('/api/stacks').catch(() => ({ byProject: {} }));
  const { byProject = {} } = data;
  const grid = document.getElementById('stacks-grid');
  const projects = Object.entries(byProject);
  if (!projects.length) { grid.innerHTML = '<div class="loading">No stacks detected yet</div>'; return; }
  grid.innerHTML = projects.map(([proj, stacks]) => `
    <div class="stack-project-card">
      <div class="stack-project-name">${proj}</div>
      <div class="stack-tags">
        ${stacks.map(s =>
          `<span class="stack-tag ${s.confidence >= 0.9 ? 'hi' : ''}" title="confidence: ${(s.confidence*100).toFixed(0)}%">${s.stack}</span>`
        ).join('')}
      </div>
    </div>
  `).join('');
}

// ── Dictionary ────────────────────────────────────────────────────────────────

let dictChartLoaded = false;

async function loadDictionary() {
  const data = await api('/api/dictionary').catch(() => ({ counts: [], recent: [] }));
  const { counts = [], recent = [] } = data;

  if (counts.length && !dictChartLoaded) {
    dictChartLoaded = true;
    makeChart('chart-dict-categories', 'bar', {
      labels: counts.map(r => r.category),
      datasets: [{
        label: 'Terms',
        data: counts.map(r => r.cnt),
        backgroundColor: counts.map((_, i) => colorAt(i) + '99'),
        borderColor:     counts.map((_, i) => colorAt(i)),
        borderWidth: 1,
      }],
    }, {
      ...CHART_DEFAULTS,
      plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } },
    });
  }

  renderDictTable(recent, 'Recent Terms');
}

function renderDictTable(rows, title) {
  document.getElementById('dict-table-title').textContent = title;
  const body = document.getElementById('dict-body');
  if (!rows.length) { body.innerHTML = '<tr><td colspan="3" class="loading">No results</td></tr>'; return; }
  body.innerHTML = rows.map(r => `
    <tr>
      <td><strong>${r.term}</strong></td>
      <td><span class="badge badge-gray">${r.category || '—'}</span></td>
      <td>${trunc(r.definition, 120)}</td>
    </tr>
  `).join('');
}

document.getElementById('dict-search-btn').addEventListener('click', async () => {
  const q = document.getElementById('dict-search-input').value.trim();
  if (!q) { loadDictionary(); return; }
  const data = await api(`/api/dictionary?q=${encodeURIComponent(q)}`).catch(() => ({ results: [] }));
  const rows = (data.results || []).map(r => ({
    term: r.term, category: r.category, definition: r.definition || r.snippet,
  }));
  document.getElementById('dict-chart-wrap').style.display = 'none';
  renderDictTable(rows, `Search: "${q}" — ${rows.length} result${rows.length !== 1 ? 's' : ''}`);
});

document.getElementById('dict-search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('dict-search-btn').click();
});

// ── Agents ────────────────────────────────────────────────────────────────────

async function loadAgents() {
  const rows = await api('/api/agents').catch(() => []);

  if (rows.length) {
    const top = rows.slice(0, 20);
    makeChart('chart-agents', 'bar', {
      labels: top.map(r => r.name),
      datasets: [{
        label: 'Uses',
        data: top.map(r => r.use_count),
        backgroundColor: top.map((_, i) => colorAt(i) + '99'),
        borderColor:     top.map((_, i) => colorAt(i)),
        borderWidth: 1,
      }],
    }, {
      ...CHART_DEFAULTS,
      indexAxis: 'y',
      plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } },
    });
  }

  const body = document.getElementById('agents-body');
  if (!rows.length) { body.innerHTML = '<tr><td colspan="5" class="loading">No agents registered yet</td></tr>'; return; }
  body.innerHTML = rows.map(r => `
    <tr>
      <td><strong>${r.name}</strong></td>
      <td><span class="badge ${r.source === 'codex' ? 'badge-yellow' : 'badge-blue'}">${r.source || '—'}</span></td>
      <td><strong>${r.use_count ?? 0}</strong></td>
      <td class="mono">${fmtDate(r.last_used)}</td>
      <td class="mono">${trunc(r.trigger_pattern, 60)}</td>
    </tr>
  `).join('');
}

// ── Discoveries ───────────────────────────────────────────────────────────────

async function loadDiscoveries() {
  const rows = await api('/api/discoveries').catch(() => []);
  const body = document.getElementById('discoveries-body');
  if (!rows.length) { body.innerHTML = '<tr><td colspan="7" class="loading">No discoveries found</td></tr>'; return; }
  body.innerHTML = rows.map(r => `
    <tr>
      <td class="mono">${r.file}</td>
      <td>${trunc(r.pattern, 50)}</td>
      <td>${r.agent ? `<span class="badge badge-blue">${r.agent}</span>` : '—'}</td>
      <td class="mono">${r.date || '—'}</td>
      <td>${r.fire_count ?? '—'}</td>
      <td>${r.promoted ? '<span class="badge badge-green">yes</span>' : '<span class="badge badge-gray">no</span>'}</td>
      <td><pre style="white-space:pre-wrap;font-size:11px;color:#8892a4;margin:0">${trunc(r.preview, 120)}</pre></td>
    </tr>
  `).join('');
}

// ── Memory ────────────────────────────────────────────────────────────────────

function renderMemoryResults(rows) {
  const body = document.getElementById('memory-body');
  const title = document.getElementById('memory-table-title');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5" style="color:var(--muted);padding:20px">No results.</td></tr>';
    title.textContent = 'Memory Search Results';
    return;
  }
  title.textContent = `${rows.length} result${rows.length !== 1 ? 's' : ''}`;
  body.innerHTML = rows.map(r => `
    <tr>
      <td><strong>${r.title || '—'}</strong></td>
      <td class="mono">${r.source || '—'}</td>
      <td>${trunc(r.body, 140)}</td>
      <td>${r.tags ? `<span class="badge badge-gray">${r.tags}</span>` : '—'}</td>
      <td class="mono">${r.rank != null ? r.rank.toFixed(3) : '—'}</td>
    </tr>
  `).join('');
}

async function doMemorySearch() {
  const q = document.getElementById('memory-search-input').value.trim();
  if (!q) { renderMemoryResults([]); return; }
  const data = await api(`/api/memory?q=${encodeURIComponent(q)}`).catch(() => ({ results: [] }));
  renderMemoryResults(data.results || []);
}

document.getElementById('memory-search-btn').addEventListener('click', doMemorySearch);
document.getElementById('memory-search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doMemorySearch();
});

function loadMemory() { /* no-op: memory is search-driven */ }

// ── Control Panel ─────────────────────────────────────────────────────────────

function ctrlStatus(id, html, cls = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = html;
  el.className = `ctrl-status${cls ? ' ' + cls : ''}`;
}

function setWatcherBadge(running) {
  const badge = document.getElementById('watcher-badge');
  if (!badge) return;
  badge.textContent = running ? 'running' : 'stopped';
  badge.className = `watcher-badge ${running ? 'running' : 'stopped'}`;
}

async function refreshWatcherStatus() {
  try {
    const data = await api('/api/watcher/status');
    setWatcherBadge(data.running);
    if (data.pid) ctrlStatus('status-watcher', `PID ${data.pid}`);
  } catch (_) {
    setWatcherBadge(false);
  }
}

async function loadControl() {
  await refreshWatcherStatus();
}

// Parquet flush
document.getElementById('btn-flush').addEventListener('click', async () => {
  const btn = document.getElementById('btn-flush');
  btn.disabled = true;
  ctrlStatus('status-flush', 'Flushing…');
  try {
    const r = await fetch('/api/flush', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    const lines = [];
    if (data.parquet) lines.push(`parquet: ${JSON.stringify(data.parquet)}`);
    if (data.telemetry) lines.push(`telemetry: ${JSON.stringify(data.telemetry)}`);
    ctrlStatus('status-flush', lines.join('\n') || 'Done', 'ok');
  } catch (e) {
    ctrlStatus('status-flush', `Error: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
});

// Retrieval learning loop
document.getElementById('btn-learning').addEventListener('click', async () => {
  const btn = document.getElementById('btn-learning');
  btn.disabled = true;
  ctrlStatus('status-learning', 'Running retrieval learning loop…');
  try {
    const r = await fetch('/api/learning/run', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);

    const lines = [
      `batches reviewed: ${data.batchesReviewed ?? 0}`,
      `strategies reviewed: ${data.strategiesReviewed ?? 0}`,
      `patterns promoted: ${(data.promotedPatterns || []).length}`,
    ];

    if (Array.isArray(data.promotedPatterns) && data.promotedPatterns.length) {
      lines.push('', 'promoted patterns:');
      for (const pattern of data.promotedPatterns.slice(0, 8)) {
        lines.push(`- ${pattern}`);
      }
    }

    if (Array.isArray(data.topStrategies) && data.topStrategies.length) {
      lines.push('', 'top strategies:');
      for (const row of data.topStrategies.slice(0, 5)) {
        lines.push(`- ${row.project} / ${row.cli} / ${row.source_type} / ${row.command_family} => ${(row.success_rate * 100).toFixed(0)}% (${row.success_count}/${row.sample_count})`);
      }
    }

    if (Array.isArray(data.topFailures) && data.topFailures.length) {
      lines.push('', 'failure hotspots:');
      for (const row of data.topFailures.slice(0, 3)) {
        lines.push(`- ${row.project} / ${row.cli} (${row.failure_count}) ${trunc(row.query_text, 90)}`);
      }
    }

    ctrlStatus('status-learning', lines.join('\n') || 'Done', 'ok');
  } catch (e) {
    ctrlStatus('status-learning', `Error: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
});

// Full backfill
document.getElementById('btn-backfill').addEventListener('click', async () => {
  const btn = document.getElementById('btn-backfill');
  btn.disabled = true;
  document.getElementById('btn-backfill-skills').disabled = true;
  ctrlStatus('status-backfill', 'Running full backfill… (this may take 30-60s)');
  try {
    const r = await fetch('/api/backfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    const out = data.stdout ? data.stdout.slice(-800) : '';
    ctrlStatus('status-backfill', `Exit ${data.exitCode ?? 0}\n${out}`, data.exitCode === 0 ? 'ok' : 'err');
  } catch (e) {
    ctrlStatus('status-backfill', `Error: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    document.getElementById('btn-backfill-skills').disabled = false;
  }
});

// Skills-only backfill
document.getElementById('btn-backfill-skills').addEventListener('click', async () => {
  const btn = document.getElementById('btn-backfill-skills');
  btn.disabled = true;
  document.getElementById('btn-backfill').disabled = true;
  ctrlStatus('status-backfill', 'Running skills backfill…');
  try {
    const r = await fetch('/api/backfill', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillsOnly: true }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    const out = data.stdout ? data.stdout.slice(-800) : '';
    ctrlStatus('status-backfill', `Exit ${data.exitCode ?? 0}\n${out}`, data.exitCode === 0 ? 'ok' : 'err');
  } catch (e) {
    ctrlStatus('status-backfill', `Error: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    document.getElementById('btn-backfill').disabled = false;
  }
});

// Dictionary import
document.getElementById('btn-dict-import').addEventListener('click', async () => {
  const btn = document.getElementById('btn-dict-import');
  btn.disabled = true;
  ctrlStatus('status-dict', 'Importing…');
  try {
    const r = await fetch('/api/dict/import', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    ctrlStatus('status-dict', data.message || JSON.stringify(data), 'ok');
  } catch (e) {
    ctrlStatus('status-dict', `Error: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
});

// Watcher start
document.getElementById('btn-watcher-start').addEventListener('click', async () => {
  ctrlStatus('status-watcher', 'Starting…');
  try {
    const r = await fetch('/api/watcher/start', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    setWatcherBadge(true);
    ctrlStatus('status-watcher', data.message || 'Started', 'ok');
  } catch (e) {
    ctrlStatus('status-watcher', `Error: ${e.message}`, 'err');
  }
});

// Watcher stop
document.getElementById('btn-watcher-stop').addEventListener('click', async () => {
  ctrlStatus('status-watcher', 'Stopping…');
  try {
    const r = await fetch('/api/watcher/stop', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    setWatcherBadge(false);
    ctrlStatus('status-watcher', data.message || 'Stopped', 'ok');
  } catch (e) {
    ctrlStatus('status-watcher', `Error: ${e.message}`, 'err');
  }
});

// Config viewer
document.getElementById('btn-load-config').addEventListener('click', async () => {
  const el = document.getElementById('status-config');
  el.textContent = 'Loading…';
  try {
    const data = await api('/api/config');
    el.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    el.textContent = `Error: ${e.message}`;
  }
});

// Health audit
document.getElementById('btn-audit').addEventListener('click', async () => {
  const btn = document.getElementById('btn-audit');
  btn.disabled = true;
  const el = document.getElementById('status-audit');
  el.textContent = 'Running…';
  try {
    const r = await fetch('/api/audit', { method: 'POST' });
    const rows = await r.json();
    if (!r.ok) throw new Error(rows.error || r.statusText);
    el.textContent = rows.map(row => {
      const icon = row.status === 'ok' ? '✓' : row.status === 'warn' ? '⚠' : '✗';
      return `${icon} [${row.status.toUpperCase().padEnd(4)}] ${row.check.padEnd(35)} ${row.detail}`;
    }).join('\n');
  } catch (e) {
    el.textContent = `Error: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ── Graph (code graph + focus + backlinks) ──────────────────────────────────

async function loadGraph() {
  // Unified search handlers
  function renderUnified(d) {
    const el = document.getElementById('unified-results');
    const blocks = [];
    if (d.memory && d.memory.length) blocks.push(`<div><strong>Memory (${d.memory.length})</strong></div>` + d.memory.map(r => `<div style="margin-left:12px">- <b>${escapeHtml(r.title)}</b> — ${escapeHtml(r.source || '')}</div>`).join(''));
    if (d.symbols && d.symbols.length) blocks.push(`<div style="margin-top:8px"><strong>Symbols (${d.symbols.length})</strong></div>` + d.symbols.map(s => `<div style="margin-left:12px">- <code>${escapeHtml(s.name)}</code> (${escapeHtml(s.kind)}) — ${escapeHtml(s.file)}:${s.line}</div>`).join(''));
    if (d.commits && d.commits.length) blocks.push(`<div style="margin-top:8px"><strong>Commits (${d.commits.length})</strong></div>` + d.commits.map(c => `<div style="margin-left:12px">- <code>${c.sha.slice(0,7)}</code> [${escapeHtml(c.project)}] ${escapeHtml(c.subject)}</div>`).join(''));
    if (d.dictionary && d.dictionary.length) blocks.push(`<div style="margin-top:8px"><strong>Dictionary (${d.dictionary.length})</strong></div>` + d.dictionary.map(t => `<div style="margin-left:12px">- <b>${escapeHtml(t.term)}</b> — ${escapeHtml((t.definition||'').slice(0,160))}</div>`).join(''));
    if (d.vault_tools && d.vault_tools.length) blocks.push(`<div style="margin-top:8px"><strong>Vault tools (${d.vault_tools.length})</strong></div>` + d.vault_tools.map(t => `<div style="margin-left:12px">- <b>${escapeHtml(t.name)}</b> — ${escapeHtml(t.description || '')}</div>`).join(''));
    if (d.rows && d.rows.length) blocks.push(`<div><strong>Semantic matches (${d.rows.length})</strong></div>` + d.rows.map(r => `<div style="margin-left:12px">- <b>${escapeHtml(r.title)}</b> (${r.score.toFixed(3)}) — ${escapeHtml(r.source || '')}</div>`).join(''));
    el.innerHTML = blocks.length ? blocks.join('') : '<div style="color:var(--muted)">No results.</div>';
  }
  document.getElementById('btn-unified').onclick = async () => {
    const q = document.getElementById('unified-q').value.trim();
    if (!q) return;
    document.getElementById('unified-results').innerHTML = '<div style="color:var(--muted)">Searching…</div>';
    try { renderUnified(await api(`/api/search?q=${encodeURIComponent(q)}`)); }
    catch (e) { document.getElementById('unified-results').innerHTML = `<div style="color:var(--err)">${escapeHtml(e.message)}</div>`; }
  };
  document.getElementById('btn-semantic').onclick = async () => {
    const q = document.getElementById('unified-q').value.trim();
    if (!q) return;
    document.getElementById('unified-results').innerHTML = '<div style="color:var(--muted)">Embedding query…</div>';
    try { renderUnified(await api(`/api/semantic-search?q=${encodeURIComponent(q)}`)); }
    catch (e) { document.getElementById('unified-results').innerHTML = `<div style="color:var(--err)">${escapeHtml(e.message)} (run \`npm run embeddings:backfill\` first)</div>`; }
  };

  // health checks
  try {
    const h = await api('/api/health');
    const colorFor = s => s === 'ok' ? 'var(--ok,#3fb950)' : s === 'warn' ? 'var(--warn,#d29922)' : 'var(--err,#f85149)';
    document.getElementById('health-title').innerHTML = `System Health — <span style="color:${colorFor(h.overall)}">${h.overall.toUpperCase()}</span>`;
    document.getElementById('health-body').innerHTML = h.checks.map(c =>
      `<tr><td>${escapeHtml(c.name)}</td><td class="mono">${escapeHtml(c.value)}</td><td style="color:var(--muted)">${escapeHtml(c.detail)}</td><td style="color:${colorFor(c.status)};font-weight:bold">${c.status.toUpperCase()}</td></tr>`
    ).join('');
  } catch (_) {}

  // stats row
  try {
    const stats = await api('/api/code-graph/stats');
    const row = document.getElementById('graph-stat-row');
    const cards = [
      { label: 'Indexed Files', value: fmtNum(stats.files) },
      { label: 'Symbols',       value: fmtNum(stats.symbols) },
      { label: 'Imports',       value: fmtNum(stats.imports) },
      { label: 'Languages',     value: (stats.by_lang || []).map(l => `${l.lang}:${l.n}`).join('  ') || '—' },
    ];
    row.innerHTML = cards.map(c =>
      `<div class="stat-card"><div class="stat-value">${c.value}</div><div class="stat-label">${c.label}</div></div>`
    ).join('');
  } catch (_) {}

  // MCP adoption / savings
  try {
    const s = await api('/api/code-graph/savings?days=14');
    document.getElementById('savings-stats').innerHTML = [
      { l: 'Adoption',         v: `${s.adoption_pct}%` },
      { l: 'MCP Graph Calls',  v: fmtNum(s.totals.graph) },
      { l: 'Explore Calls',    v: fmtNum(s.totals.explore) },
      { l: 'Sessions Sampled', v: fmtNum(s.totals.sessions) },
    ].map(c => `<div class="stat-card"><div class="stat-value">${c.v}</div><div class="stat-label">${c.l}</div></div>`).join('');
    const body = document.getElementById('savings-body');
    body.innerHTML = s.sessions.length
      ? s.sessions.slice(0, 25).map(r => {
          const tot = r.explore_calls + r.mcp_graph_calls;
          const pct = tot > 0 ? Math.round(100 * r.mcp_graph_calls / tot) : 0;
          const when = (r.started_at || '').slice(0,10);
          return `<tr><td class="mono">${escapeHtml((r.session_id||'').slice(0,8))}</td><td>${escapeHtml(r.project || '—')}</td><td>${when}</td><td>${r.explore_calls}</td><td>${r.mcp_graph_calls}</td><td>${pct}%</td></tr>`;
        }).join('')
      : `<tr><td colspan="6" style="color:var(--muted);padding:20px">No exploration calls yet in this window.</td></tr>`;
  } catch (_) {}

  // hubs
  try {
    const { rows } = await api('/api/code-graph/hubs?limit=25');
    const body = document.getElementById('hubs-body');
    body.innerHTML = rows.length
      ? rows.map(r => `<tr><td class="mono">${escapeHtml(r.target)}</td><td>${r.distinct_files}</td><td>${r.dependents}</td></tr>`).join('')
      : `<tr><td colspan="3" style="color:var(--muted);padding:20px">No imports indexed yet.</td></tr>`;
  } catch (_) {}

  // top files
  try {
    const { rows } = await api('/api/code-graph/top-files?limit=25');
    const body = document.getElementById('graph-top-body');
    body.innerHTML = rows.length
      ? rows.map(r => `<tr><td class="mono">${escapeHtml(r.file)}</td><td>${escapeHtml(r.project || '—')}</td><td>${escapeHtml(r.lang || '')}</td><td>${r.symbols}</td></tr>`).join('')
      : `<tr><td colspan="4" style="color:var(--muted);padding:20px">No symbols indexed yet — edit a .ts/.cs/.py file.</td></tr>`;
  } catch (_) {}

  // Focus handlers
  document.getElementById('btn-focus-load').onclick = async () => {
    const proj = document.getElementById('focus-project').value.trim();
    if (!proj) return;
    try {
      const d = await api(`/api/focus?project=${encodeURIComponent(proj)}`);
      document.getElementById('focus-body').value = d.body || '';
      document.getElementById('focus-status').textContent = d.path
        ? `Loaded ${d.path}${d.updated_at ? ' · updated ' + d.updated_at : ''}`
        : `No focus file yet for ${proj}.`;
    } catch (e) {
      document.getElementById('focus-status').textContent = `Error: ${e.message}`;
    }
  };
  document.getElementById('btn-focus-save').onclick = async () => {
    const project = document.getElementById('focus-project').value.trim();
    const body    = document.getElementById('focus-body').value;
    if (!project) return;
    try {
      const r = await fetch('/api/focus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, body }),
      }).then(x => x.json());
      document.getElementById('focus-status').textContent = r.ok ? `Saved to ${r.path}` : `Error: ${r.error}`;
    } catch (e) {
      document.getElementById('focus-status').textContent = `Error: ${e.message}`;
    }
  };

  // Blast radius
  document.getElementById('btn-blast').onclick = async () => {
    const file = document.getElementById('blast-file').value.trim();
    if (!file) return;
    const body = document.getElementById('blast-body');
    body.innerHTML = `<tr><td colspan="4" style="color:var(--muted);padding:20px">Searching…</td></tr>`;
    try {
      const r = await api(`/api/code-graph/blast-radius?file=${encodeURIComponent(file)}`);
      body.innerHTML = r.dependents.length
        ? r.dependents.map(d => `<tr><td class="mono">${escapeHtml(d.file)}</td><td>${escapeHtml(d.lang || '')}</td><td class="mono">${escapeHtml(d.target)}</td><td>${d.line}</td></tr>`).join('')
        : `<tr><td colspan="4" style="color:var(--muted);padding:20px">No dependents found.</td></tr>`;
    } catch (e) {
      body.innerHTML = `<tr><td colspan="4" style="color:var(--err);padding:20px">${escapeHtml(e.message)}</td></tr>`;
    }
  };

  // Session replay
  document.getElementById('btn-replay').onclick = async () => {
    const sid = document.getElementById('replay-sid').value.trim();
    if (!sid) return;
    const body = document.getElementById('replay-body');
    const meta = document.getElementById('replay-meta');
    body.innerHTML = `<tr><td colspan="4" style="color:var(--muted);padding:20px">Loading…</td></tr>`;
    meta.textContent = '';
    try {
      // If user pasted a short prefix, expand it
      let realSid = sid;
      if (sid.length <= 12) {
        const list = await api(`/api/sessions`);
        const match = (list.rows || list).find(s => (s.id || '').startsWith(sid));
        if (match) realSid = match.id;
      }
      const r = await api(`/api/sessions/${encodeURIComponent(realSid)}/timeline`);
      if (r.session) meta.textContent = `${realSid} · ${r.session.project || '—'} · ${r.session.started_at} → ${r.session.ended_at || '(open)'} · ${r.count} events`;
      body.innerHTML = r.events.length
        ? r.events.map(e => `<tr><td class="mono">${escapeHtml((e.ts||'').slice(11,19))}</td><td>${escapeHtml(e.kind)}</td><td class="mono">${escapeHtml(String(e.detail||'').slice(0,80))}</td><td>${escapeHtml(String(e.sub||'').slice(0,40))}</td></tr>`).join('')
        : `<tr><td colspan="4" style="color:var(--muted);padding:20px">No events for that session.</td></tr>`;
    } catch (e) {
      body.innerHTML = `<tr><td colspan="4" style="color:var(--err);padding:20px">${escapeHtml(e.message)}</td></tr>`;
    }
  };

  // Symbol search
  document.getElementById('btn-symsearch').onclick = async () => {
    const q = document.getElementById('symsearch-q').value.trim();
    const body = document.getElementById('symsearch-body');
    if (!q) return;
    body.innerHTML = `<tr><td colspan="5" style="color:var(--muted);padding:20px">Searching…</td></tr>`;
    try {
      const r = await api(`/api/code-graph/symbols?q=${encodeURIComponent(q)}&limit=50`);
      body.innerHTML = r.symbols.length
        ? r.symbols.map(s => `<tr><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.kind)}</td><td class="mono">${escapeHtml(s.file)}</td><td>${s.line}</td><td>${escapeHtml(s.lang || '')}</td></tr>`).join('')
        : `<tr><td colspan="5" style="color:var(--muted);padding:20px">No matches.</td></tr>`;
    } catch (e) {
      body.innerHTML = `<tr><td colspan="5" style="color:var(--err);padding:20px">${escapeHtml(e.message)}</td></tr>`;
    }
  };

  // Git context
  try {
    const g = await api('/api/git-context');
    const el = document.getElementById('git-context-display');
    if (g.not_a_repo) {
      el.textContent = '(not in a git repo: ' + g.cwd + ')';
    } else {
      const lines = [];
      lines.push(`Branch:     ${g.branch} @ ${g.head}`);
      if (g.upstream) lines.push(`Upstream:   ${g.upstream} (${g.ahead}↑/${g.behind}↓)`);
      lines.push(`Dirty:      ${g.dirty_count} file(s)`);
      if (g.status && g.status.length) {
        lines.push('');
        for (const s of g.status.slice(0, 10)) lines.push('  ' + s);
      }
      lines.push('');
      lines.push('Recent commits:');
      for (const c of g.commits || []) lines.push(`  ${c.hash}  ${c.subject}`);
      if (g.open_prs && g.open_prs.length) {
        lines.push('');
        lines.push(`Open PRs (${g.open_prs.length}):`);
        for (const p of g.open_prs) lines.push(`  #${p.number} ${p.draft?'[draft] ':''}${p.title}`);
      }
      el.textContent = lines.join('\n');
    }
  } catch (e) { document.getElementById('git-context-display').textContent = '(error: ' + e.message + ')'; }

  // Stale vault tools
  try {
    const { rows } = await api('/api/vault-tools/stale?limit=100');
    const body = document.getElementById('stale-tools-body');
    body.innerHTML = rows.length
      ? rows.map(r => `<tr><td>${escapeHtml(r.name)}</td><td class="mono">${escapeHtml(r.path || '')}</td><td>${escapeHtml(r.stale_reason || '')}</td></tr>`).join('')
      : `<tr><td colspan="3" style="color:var(--muted);padding:20px">No stale tools — all paths resolve.</td></tr>`;
  } catch (_) {}

  // Callers (call graph)
  document.getElementById('btn-callers').onclick = async () => {
    const name    = document.getElementById('callers-name').value.trim();
    const project = document.getElementById('callers-project').value.trim();
    if (!name) return;
    const body = document.getElementById('callers-body');
    body.innerHTML = `<tr><td colspan="4" style="color:var(--muted);padding:20px">Searching…</td></tr>`;
    try {
      const url = `/api/code-graph/callers?name=${encodeURIComponent(name)}${project ? '&project=' + encodeURIComponent(project) : ''}`;
      const r = await api(url);
      body.innerHTML = r.callers.length
        ? r.callers.map(c => `<tr><td class="mono">${escapeHtml(c.caller_file)}</td><td>${escapeHtml(c.caller_name)}</td><td>${c.line}</td><td>${escapeHtml(c.lang || '')}</td></tr>`).join('')
        : `<tr><td colspan="4" style="color:var(--muted);padding:20px">No callers found.</td></tr>`;
    } catch (e) {
      body.innerHTML = `<tr><td colspan="4" style="color:var(--err);padding:20px">${escapeHtml(e.message)}</td></tr>`;
    }
  };

  // Stale memory
  try {
    const { rows } = await api('/api/memory/stale?limit=100');
    const body = document.getElementById('stale-body');
    body.innerHTML = rows.length
      ? rows.map(r => `<tr><td>${escapeHtml(r.title || '')}</td><td class="mono">${escapeHtml(r.source || '')}</td><td>${escapeHtml(r.reason || '')}</td><td>${(r.flagged_at||'').slice(0,10)}</td></tr>`).join('')
      : `<tr><td colspan="4" style="color:var(--muted);padding:20px">No stale memory detected. Nightly run will populate.</td></tr>`;
  } catch (_) {}

  // Backlinks
  document.getElementById('btn-backlinks').onclick = async () => {
    const to = document.getElementById('backlink-target').value.trim();
    const url = to ? `/api/backlinks?to=${encodeURIComponent(to)}` : '/api/backlinks?limit=200';
    const body = document.getElementById('backlinks-body');
    body.innerHTML = `<tr><td colspan="3" style="color:var(--muted);padding:20px">Loading…</td></tr>`;
    try {
      const r = await api(url);
      body.innerHTML = r.rows.length
        ? r.rows.map(x => `<tr><td class="mono">${escapeHtml(x.source)}</td><td>${escapeHtml(x.title || '')}</td><td class="mono">${escapeHtml(x.target)}</td></tr>`).join('')
        : `<tr><td colspan="3" style="color:var(--muted);padding:20px">No backlinks yet — they populate as memory files get [[wikilinks]].</td></tr>`;
    } catch (e) {
      body.innerHTML = `<tr><td colspan="3" style="color:var(--err);padding:20px">${escapeHtml(e.message)}</td></tr>`;
    }
  };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Brain graph ─────────────────────────────────────────────────────────
const BRAIN_COLORS = {
  project: '#f59e0b', session: '#6366f1', file: '#22d3ee', symbol: '#a78bfa',
  memory:  '#34d399', skill:   '#f472b6', pattern: '#fb7185', prompt: '#94a3b8',
  commit:  '#facc15',
};
let brainCy = null;
let brainCurrent = null;  // currently-opened node id (so re-renders can restore the local-graph highlight)

function brainElements(g) {
  const nodes = g.nodes.map(n => ({ data: { id: n.id, label: n.label, type: n.type, weight: n.weight } }));
  const edges = g.edges.map((e, i) => ({ data: { id: `e${i}`, source: e.source, target: e.target, kind: e.kind } }));
  return [...nodes, ...edges];
}

function renderBrain(g) {
  document.getElementById('brain-meta').textContent =
    `${g.meta.mode} · ${g.meta.nodeCount} nodes · ${g.meta.edgeCount} edges${g.meta.truncated ? ' · truncated' : ''}`;
  if (brainCy) brainCy.destroy();
  brainCy = cytoscape({
    container: document.getElementById('brain-graph'),
    elements: brainElements(g),
    style: [
      { selector: 'node', style: {
        'background-color': (n) => BRAIN_COLORS[n.data('type')] || '#888',
        'label': 'data(label)', 'color': '#cbd5e1', 'font-size': 9,
        // size by connection weight (degree-ish) — hubs read bigger, like Obsidian
        'width': (n) => 14 + Math.min(34, Math.sqrt(n.data('weight') || 1) * 7),
        'height': (n) => 14 + Math.min(34, Math.sqrt(n.data('weight') || 1) * 7),
        'border-width': 0, 'border-color': '#e8e8f0',
        'text-wrap': 'ellipsis', 'text-max-width': 90, 'min-zoomed-font-size': 6,
        'transition-property': 'opacity', 'transition-duration': '120ms',
      }},
      { selector: 'edge', style: {
        'width': 1, 'line-color': '#34344a', 'target-arrow-color': '#34344a',
        'target-arrow-shape': 'triangle', 'arrow-scale': 0.55, 'curve-style': 'bezier', 'opacity': 0.5,
      }},
      { selector: 'node.hl',    style: { 'border-width': 3, 'border-color': '#e8e8f0' } },
      { selector: 'node.hover', style: { 'border-width': 3, 'border-color': '#ffffff' } },
      { selector: '.faded',     style: { 'opacity': 0.12 } },
      { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#ffffff' } },
    ],
    layout: { name: 'cose', animate: false, nodeRepulsion: 9000, idealEdgeLength: 90, padding: 20 },
  });
  // single click = open the note + focus its local graph (Obsidian feel)
  brainCy.on('tap', 'node', (evt) => brainExpand(evt.target.id()));
  brainCy.on('tap', (evt) => { if (evt.target === brainCy) brainCy.elements().removeClass('faded'); });
  brainCy.on('mouseover', 'node', (evt) => brainHoverOn(evt.target));
  brainCy.on('mouseout', 'node', () => brainHoverOff());
  if (brainCurrent) brainHighlight(brainCurrent);
}

// Dim everything except a node and its direct neighbors — the "local graph".
function brainHighlight(id) {
  if (!brainCy) return;
  brainCy.elements().removeClass('faded hl');
  const n = brainCy.getElementById(id);
  if (!n || !n.length) return;
  brainCy.elements().addClass('faded');
  n.closedNeighborhood().removeClass('faded');
  n.addClass('hl');
}
function brainHoverOn(node) {
  if (!brainCy) return;
  brainCy.elements().addClass('faded');
  node.closedNeighborhood().removeClass('faded');
  node.addClass('hover');
}
function brainHoverOff() {
  if (!brainCy) return;
  brainCy.nodes().removeClass('hover');
  brainCy.elements().removeClass('faded');
  if (brainCurrent) brainHighlight(brainCurrent);
}

// ── Live pulse (SSE) + Mission Control ──────────────────────────────────
let pulseSource = null; // EventSource handle
const PULSE_KINDS = { edit: '#22d3ee', prompt: '#94a3b8', tool: '#a78bfa', inject: '#f472b6', route: '#64748b' };

function startPulse() {
  if (pulseSource) return;
  pulseSource = new EventSource('/api/brain/events');
  pulseSource.onmessage = (msg) => {
    let e; try { e = JSON.parse(msg.data); } catch { return; }
    // ticker line
    const ticker = document.getElementById('pulse-ticker');
    if (ticker) ticker.textContent = `${e.kind} · ${e.label || ''} · ${(e.ts || '').slice(11, 19)}`;
    // pulse referenced nodes on the graph
    if (brainCy && Array.isArray(e.refs)) {
      for (const id of e.refs) {
        const node = brainCy.getElementById(id);
        if (node && node.length) {
          node.animate({ style: { 'background-color': PULSE_KINDS[e.kind] || '#fff', 'border-width': 4, 'border-color': PULSE_KINDS[e.kind] || '#fff' } }, { duration: 200 })
              .animate({ style: { 'border-width': 0 } }, { duration: 600 });
        }
      }
    }
  };
  pulseSource.onerror = () => { /* browser auto-reconnects EventSource */ };
}
function stopPulse() { if (pulseSource) { pulseSource.close(); pulseSource = null; } }

async function loadMission() {
  const mc = await api('/api/brain/mission').catch(() => ({ entries: [], counts: {} }));
  const color = { running: '#22d3ee', zombie: '#fb7185', failed: '#f87171', scheduled: '#5b8def', done: '#34d399', idle: '#7a818c' };
  const strip = document.getElementById('mission-strip');
  strip.innerHTML = Object.entries(mc.counts).filter(([, n]) => n > 0)
    .map(([status, n]) => `<div class="stat-card"><div class="label" style="color:${color[status]||'#fff'}">${status}</div><div class="value">${n}</div></div>`)
    .join('') || '<div class="stat-card"><div class="label">idle</div><div class="value">0</div></div>';
}

async function loadBrain() {
  const depth = document.getElementById('brain-depth').value || 1;
  const g = await api(`/api/brain/graph?limit=150&depth=${depth}`).catch(() => ({ nodes: [], edges: [], meta: { mode: 'overview', nodeCount: 0, edgeCount: 0 } }));
  renderBrain(g);
  loadVitals();
  loadMission();
  if (document.getElementById('pulse-toggle')?.checked) startPulse();
}

async function loadVitals() {
  const [snaps, recs] = await Promise.all([
    api('/api/brain/snapshots?days=30').catch(() => []),
    api('/api/model/recommendations').catch(() => ({})),
  ]);
  // group snapshots by metric
  const byMetric = {};
  for (const s of snaps) (byMetric[s.metric] ||= []).push(s);
  const latest = (m) => { const a = byMetric[m] || []; return a.length ? a[a.length - 1].value : 0; };
  const delta  = (m) => { const a = byMetric[m] || []; return a.length > 1 ? a[a.length - 1].value - a[0].value : 0; };
  const card = (label, m) => { const d = delta(m); const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '·';
    return `<div class="stat-card"><div class="label">${label}</div><div class="value">${fmtNum(latest(m))}</div><div class="mono" style="font-size:11px;opacity:.6">${arrow} ${d>=0?'+':''}${fmtNum(d)}</div></div>`; };
  document.getElementById('brain-vitals').innerHTML =
    card('Patterns', 'patterns.count') + card('Pattern fires', 'patterns.fires.total') +
    card('Memory', 'memory.count') + card('Stale memory', 'memory.stale.count') +
    card('Verdicts', 'verdicts.total');

  const line = (id, m, color) => { const a = byMetric[m] || [];
    if (!a.length) return;
    makeChart(id, 'line', { labels: a.map(r => r.snapshot_date), datasets: [{ label: m, data: a.map(r => r.value), borderColor: color, backgroundColor: color + '33', tension: .3, fill: true }] }, CHART_DEFAULTS); };
  line('chart-vital-fires', 'patterns.fires.total', '#fb7185');
  line('chart-vital-memory', 'memory.count', '#34d399');

  const body = document.getElementById('model-recs-body');
  const entries = Object.entries(recs);
  body.innerHTML = entries.length
    ? entries.map(([agent, r]) => `<tr><td>${escapeHtml(agent)}</td><td class="mono">${escapeHtml(r.model)}</td><td class="mono" style="opacity:.6">${escapeHtml(r.demoted_from||'')}</td>
        <td><button class="rec-accept" data-agent="${escapeHtml(agent)}">Accept</button></td></tr>`).join('')
    : '<tr><td colspan="4" class="loading">None pending</td></tr>';
  document.querySelectorAll('.rec-accept').forEach(b => b.addEventListener('click', async () => {
    await fetch('/api/model/recommendations/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: b.dataset.agent }) });
    loadVitals();
  }));
}

async function brainExpand(nodeId) {
  brainCurrent = nodeId;
  const depth = document.getElementById('brain-depth').value || 1;
  const g = await api(`/api/brain/graph?center=${encodeURIComponent(nodeId)}&depth=${depth}&limit=150`).catch(() => null);
  if (g) renderBrain(g);
  brainHighlight(nodeId);
  brainOpenNote(nodeId);
}

// Minimal markdown → HTML for note bodies (no external dependency). Escapes
// first, then re-introduces only the tags we emit — safe against HTML in data.
// Handles fenced code, headings, bold/italic/inline-code, bullet lists,
// [[wikilinks]] (clickable), and [text](url) links.
function mdToHtml(src) {
  if (!src) return '';
  return String(src).split('```').map((blk, i) => {
    if (i % 2 === 1) return `<pre><code>${escapeHtml(blk.replace(/^\w*\n/, ''))}</code></pre>`;
    let h = escapeHtml(blk);
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h2>$1</h2>');
    h = h.replace(/\[\[([^\]]+)\]\]/g, (_, t) => `<span class="wikilink" data-link="${escapeHtml(t)}">${escapeHtml(t)}</span>`);
    h = h.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    h = h.replace(/(?:^|\n)((?:- .+(?:\n|$))+)/g, (m, items) =>
      `<ul>${items.trim().split('\n').map(l => `<li>${l.replace(/^- /, '')}</li>`).join('')}</ul>`);
    return h.replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
  }).join('');
}

// Render one brain node as a note in the right-hand pane, Obsidian-style:
// type chip, title, frontmatter meta, #tags, markdown body, and the linked
// mentions (backlinks) + outgoing links — all clickable to walk the graph.
async function brainOpenNote(nodeId) {
  const pane = document.getElementById('brain-note');
  if (!pane) return;
  pane.innerHTML = '<div class="brain-note-empty">Loading…</div>';
  const note = await api(`/api/brain/note?id=${encodeURIComponent(nodeId)}`).catch(() => null);
  if (!note) { pane.innerHTML = '<div class="brain-note-empty">Could not load note.</div>'; return; }
  const color = BRAIN_COLORS[note.type] || '#888';
  const linkRow = (l) => `<div class="bn-link" data-id="${escapeHtml(l.id)}"><span class="dot" style="background:${BRAIN_COLORS[String(l.id).split(':')[0]] || '#888'}"></span>${escapeHtml(l.title || l.id)}</div>`;
  let html = `<div class="bn-type" style="background:${color}">${escapeHtml(note.type)}</div>`;
  html += `<div class="bn-title">${escapeHtml(note.title || note.key)}</div>`;
  if (note.meta && note.meta.length)  html += `<div class="bn-meta">${note.meta.map(m => `<span>${escapeHtml(m.k)}: ${escapeHtml(String(m.v))}</span>`).join('')}</div>`;
  if (note.tags && note.tags.length)  html += `<div class="bn-tags">${note.tags.map(t => `<span class="bn-tag">#${escapeHtml(t)}</span>`).join('')}</div>`;
  html += `<div class="bn-body">${mdToHtml(note.body) || '<span style="opacity:.5">No content.</span>'}</div>`;
  if (note.backlinks && note.backlinks.length) html += `<div class="bn-section"><h4>&#8627; Linked mentions (${note.backlinks.length})</h4>${note.backlinks.map(linkRow).join('')}</div>`;
  if (note.outlinks && note.outlinks.length)   html += `<div class="bn-section"><h4>&#8594; Links (${note.outlinks.length})</h4>${note.outlinks.map(linkRow).join('')}</div>`;
  pane.innerHTML = html;
  pane.querySelectorAll('.bn-link').forEach(el => el.onclick = () => brainExpand(el.dataset.id));
  pane.querySelectorAll('.wikilink').forEach(el => el.onclick = () => brainExpand(`memory:${String(el.dataset.link).toLowerCase()}`));
}

document.getElementById('brain-reset')?.addEventListener('click', loadBrain);
document.getElementById('brain-depth')?.addEventListener('change', loadBrain);
document.getElementById('pulse-toggle')?.addEventListener('change', (e) => e.target.checked ? startPulse() : stopPulse());
document.getElementById('brain-search')?.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  const hits = await api(`/api/search?q=${encodeURIComponent(e.target.value.trim())}&limit=5`).catch(() => null);
  // /api/search returns { memory, symbols, commits, dictionary, vault_tools }.
  // Only memory hits map to overview graph nodes (memory:<source>), so prefer those.
  const mem = hits && hits.memory && hits.memory[0];
  if (mem && mem.source) brainExpand(`memory:${mem.source}`);
});

// ── Flows ─────────────────────────────────────────────────────────────────
// Auto-discovered call-graph flows. Left pane lists flows (sorted by confidence);
// clicking one renders a cose flowchart in #flow-graph and an annotate panel in
// #flow-note. Annotating POSTs back and "claims" the flow as source='manual'.
//
// Node colors are keyed by `kind` (same spirit as BRAIN_COLORS). Terminal nodes
// (exit the indexed graph) get a dashed, dimmed border; ambiguous nodes (a
// bare name resolved to >1 target) get a dotted yellow marker. cose layout is
// used (NOT breadthfirst) so cyclic "full-circle" flows render correctly.

const FLOW_KINDS = {
  function: '#6366f1', method: '#818cf8', class: '#a78bfa', route: '#22d3ee',
  handler:  '#34d399', service: '#facc15', module:  '#fb923c', entry:   '#f472b6',
};
function flowKindColor(kind) { return FLOW_KINDS[String(kind || '').toLowerCase()] || '#94a3b8'; }

let flowCy = null;
let flowList = [];           // cached list rows (so we can patch a row after a save)
let flowCurrentId = null;    // currently-opened flow id

// Derive a human module label from "file::symbol" (or a bare path) entry point.
function flowModule(entryPoint) {
  if (!entryPoint) return '—';
  const ep = String(entryPoint);
  const idx = ep.lastIndexOf('::');
  const file = idx >= 0 ? ep.slice(0, idx) : ep;
  return file.split(/[\\/]/).pop() || ep;
}

function confColor(c) {
  if (c == null) return 'var(--border)';
  if (c >= 0.66) return '#14532d';   // green-ish bg
  if (c >= 0.33) return '#78350f';   // amber bg
  return '#7f1d1d';                  // red bg
}
function confText(c) {
  if (c == null) return 'var(--muted)';
  if (c >= 0.66) return 'var(--green)';
  if (c >= 0.33) return 'var(--yellow)';
  return 'var(--red)';
}

function flowConfPct(c) { return c == null ? 'n/a' : `${Math.round(c * 100)}%`; }

function flowElements(full) {
  const nodes = (full.nodes || []).map(n => ({
    data: { id: n.node_id, label: n.label || n.node_id, kind: n.kind,
            terminal: n.terminal ? 1 : 0, ambiguous: n.ambiguous ? 1 : 0 },
    classes: [n.terminal ? 'terminal' : '', n.ambiguous ? 'ambiguous' : ''].filter(Boolean).join(' '),
  }));
  const edges = (full.edges || []).map((e, i) => ({
    data: { id: `fe${i}`, source: e.source, target: e.target, kind: e.kind },
  }));
  return [...nodes, ...edges];
}

// Read-only SVG render of an Excalidraw doc (rectangles, text, arrows). No editor,
// no external lib — the doc's deterministic x/y/width/height are drawn directly.
function renderExcalidrawSvg(container, doc) {
  const els = (doc.elements || []).filter(e => !e.isDeleted);
  if (!els.length) { container.innerHTML = '<div class="muted">No diagram</div>'; return; }
  const minX = Math.min(...els.map(e => e.x));
  const minY = Math.min(...els.map(e => e.y));
  const maxX = Math.max(...els.map(e => e.x + (e.width || 0)));
  const maxY = Math.max(...els.map(e => e.y + (e.height || 0)));
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const parts = [];
  for (const e of els) {
    if (e.type === 'rectangle') {
      parts.push(`<rect x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" rx="8" fill="${esc(e.backgroundColor)}" stroke="${esc(e.strokeColor)}" stroke-width="1.5"/>`);
    } else if (e.type === 'text') {
      parts.push(`<text x="${e.x + e.width / 2}" y="${e.y + e.height / 2}" text-anchor="middle" dominant-baseline="middle" font-family="monospace" font-size="${e.fontSize}" fill="${esc(e.strokeColor)}">${esc(e.text)}</text>`);
    } else if (e.type === 'arrow' && e.points && e.points.length >= 2) {
      const [p0, p1] = [e.points[0], e.points[e.points.length - 1]];
      parts.push(`<line x1="${e.x + p0[0]}" y1="${e.y + p0[1]}" x2="${e.x + p1[0]}" y2="${e.y + p1[1]}" stroke="${esc(e.strokeColor)}" stroke-width="1.5" marker-end="url(#vf-arrow)"/>`);
    }
  }
  container.innerHTML =
    `<svg viewBox="${minX - 20} ${minY - 20} ${maxX - minX + 40} ${maxY - minY + 40}" width="100%" height="100%" style="background:#fff">` +
    `<defs><marker id="vf-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#1e1e1e"/></marker></defs>` +
    parts.join('') + `</svg>`;
}

function renderFlowGraph(full) {
  if (flowCy) { flowCy.destroy(); flowCy = null; }
  flowCy = cytoscape({
    container: document.getElementById('flow-graph'),
    elements: flowElements(full),
    style: [
      { selector: 'node', style: {
        'background-color': (n) => flowKindColor(n.data('kind')),
        'label': 'data(label)', 'color': '#cbd5e1', 'font-size': 9,
        'width': 22, 'height': 22, 'border-width': 0, 'border-color': '#e8e8f0',
        'text-wrap': 'ellipsis', 'text-max-width': 100, 'min-zoomed-font-size': 6,
        'text-valign': 'bottom', 'text-margin-y': 3,
      }},
      { selector: 'edge', style: {
        'width': 1.4, 'line-color': '#34344a', 'target-arrow-color': '#5b5b7a',
        'target-arrow-shape': 'triangle', 'arrow-scale': 0.9, 'curve-style': 'bezier', 'opacity': 0.7,
      }},
      // terminal: dashed border + dimmed — "exits indexed graph (may continue via DB/event)"
      { selector: 'node.terminal', style: {
        'border-width': 2, 'border-style': 'dashed', 'border-color': '#94a3b8', 'opacity': 0.55,
      }},
      // ambiguous: dotted yellow marker tint — a bare name resolved to >1 target
      { selector: 'node.ambiguous', style: {
        'border-width': 3, 'border-style': 'dotted', 'border-color': '#facc15',
      }},
    ],
    // cose (force-directed) — renders cyclic flows correctly, unlike breadthfirst.
    layout: { name: 'cose', animate: false, nodeRepulsion: 9000, idealEdgeLength: 95, padding: 24 },
  });
}

async function loadFlows() {
  const listEl = document.getElementById('flow-list');
  try {
    const r = await api('/api/flows');
    flowList = Array.isArray(r) ? r : (r.flows || []);
  } catch (e) {
    listEl.innerHTML = `<div class="flow-list-empty" style="color:var(--red)">Failed to load flows: ${escapeHtml(e.message)}</div>`;
    return;
  }
  renderFlowList();
}

function renderFlowList() {
  const listEl = document.getElementById('flow-list');
  if (!flowList.length) {
    listEl.innerHTML = `<div class="flow-list-empty">
      <strong>No flows discovered yet.</strong><br><br>
      Auto-detection finds CLI/route flows but misses HTTP routes in monolithic files
      and C# attribute routes — declare an entry point above to trace one.
    </div>`;
    return;
  }
  // sort by confidence desc (null confidence sinks to the bottom)
  const rows = [...flowList].sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));
  listEl.innerHTML = rows.map(f => flowRowHtml(f)).join('');
  listEl.querySelectorAll('.flow-row').forEach(el =>
    el.addEventListener('click', () => openFlow(el.dataset.id)));
  if (flowCurrentId) markActiveFlowRow(flowCurrentId);
}

function sourceBadge(source) {
  if (source === 'manual')   return '<span class="badge badge-purple">manual</span>';
  if (source === 'declared') return '<span class="badge badge-blue">declared</span>';
  return '<span class="badge badge-gray">auto</span>';
}
function statusBadgeHtml(status) {
  const cls = status === 'active' ? 'badge-green' : status === 'deprecated' ? 'badge-yellow' : 'badge-gray';
  return `<span class="badge ${cls}">${escapeHtml(status || 'active')}</span>`;
}

function flowRowHtml(f) {
  const c = f.confidence;
  const conf = `<span class="conf-badge" style="background:${confColor(c)};color:${confText(c)}">${flowConfPct(c)}</span>`;
  const trunc = f.truncated ? '<span title="graph truncated — flow may be larger than indexed" style="color:var(--yellow)">⚠</span>' : '';
  return `<div class="flow-row" data-id="${escapeHtml(String(f.id))}">
    <div class="fr-name">${escapeHtml(f.name || '(unnamed flow)')} ${trunc}</div>
    <div class="fr-module">${escapeHtml(flowModule(f.entry_point))}</div>
    <div class="fr-badges">
      ${conf}
      ${sourceBadge(f.source)}
      ${statusBadgeHtml(f.status)}
      <span class="badge badge-blue">${fmtNum(f.node_count ?? 0)} nodes</span>
    </div>
  </div>`;
}

function markActiveFlowRow(id) {
  document.querySelectorAll('#flow-list .flow-row').forEach(el =>
    el.classList.toggle('active', el.dataset.id === String(id)));
}

async function openFlow(id) {
  flowCurrentId = id;
  markActiveFlowRow(id);
  const note = document.getElementById('flow-note');
  note.innerHTML = '<div class="fn-note-empty">Loading…</div>';
  let full;
  try {
    full = await api(`/api/flows/${encodeURIComponent(id)}`);
  } catch (e) {
    note.innerHTML = `<div class="fn-note-empty" style="color:var(--red)">Could not load flow: ${escapeHtml(e.message)}</div>`;
    return;
  }
  // Reset to Cytoscape view when opening a new flow (clear any prior SVG preview).
  document.getElementById('flow-graph').style.display = '';
  document.getElementById('flow-excalidraw').style.display = 'none';
  renderFlowGraph(full);
  renderFlowNote(full.flow);
}

// Toggle between Cytoscape flowchart and read-only Excalidraw SVG preview.
// Fetches /api/flows/:id/excalidraw on first open; subsequent toggles swap
// without re-fetching (the SVG stays in #flow-excalidraw until next openFlow).
document.getElementById('flow-view-toggle').addEventListener('click', async () => {
  const graph = document.getElementById('flow-graph');
  const ex = document.getElementById('flow-excalidraw');
  const showingEx = ex.style.display !== 'none';
  if (showingEx) {
    ex.style.display = 'none';
    graph.style.display = '';
    return;
  }
  if (!flowCurrentId) return;
  try {
    const doc = await api(`/api/flows/${encodeURIComponent(flowCurrentId)}/excalidraw`);
    renderExcalidrawSvg(ex, doc);
  } catch (e) {
    ex.innerHTML = `<div class="fn-note-empty" style="color:var(--red);padding:16px">Could not load preview: ${escapeHtml(e.message)}</div>`;
  }
  graph.style.display = 'none';
  ex.style.display = '';
});

// Annotate panel: editable name / description / user_notes / status + Save.
// Saving POSTs the changed fields and flips the flow to source='manual'.
function renderFlowNote(flow) {
  const note = document.getElementById('flow-note');
  const statusOpt = (v) => `<option value="${v}"${flow.status === v ? ' selected' : ''}>${v}</option>`;
  note.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
      <span class="bn-type" style="background:${flowKindColor('entry')};font:600 10px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em;padding:3px 7px;border-radius:5px;color:#0e0e16">flow</span>
      ${sourceBadge(flow.source)}
      ${statusBadgeHtml(flow.status)}
      <span class="conf-badge" style="background:${confColor(flow.confidence)};color:${confText(flow.confidence)}">${flowConfPct(flow.confidence)} confidence</span>
    </div>
    <div class="fr-module" style="margin-bottom:10px">entry: ${escapeHtml(flow.entry_point || '—')}</div>

    <div class="fn-field">
      <label for="fn-name">Name</label>
      <input id="fn-name" type="text" value="${escapeHtml(flow.name || '')}" />
    </div>
    <div class="fn-field">
      <label for="fn-desc">Description</label>
      <textarea id="fn-desc"></textarea>
    </div>
    <div class="fn-field">
      <label for="fn-notes">Your notes</label>
      <textarea id="fn-notes"></textarea>
    </div>
    <div class="fn-field">
      <label for="fn-status">Status</label>
      <select id="fn-status">${statusOpt('active')}${statusOpt('archived')}${statusOpt('deprecated')}</select>
    </div>
    <p class="fn-hint">Annotating claims this flow — it becomes <strong>manual</strong> and won't be overwritten by
      auto-discovery; use your notes to add couplings the static graph can't see (DB tables, events).</p>
    <button class="btn-action" id="fn-save">Save</button>
    <div class="ctrl-status" id="fn-status-msg"></div>`;

  // Set textarea content via .value (not innerHTML) so raw text containing & or <
  // displays literally instead of as HTML entities. .value is not an XSS vector.
  document.getElementById('fn-desc').value  = flow.description || '';
  document.getElementById('fn-notes').value = flow.user_notes || '';

  document.getElementById('fn-save').addEventListener('click', () => saveFlowAnnotation(flow.id));
}

async function saveFlowAnnotation(id) {
  const btn = document.getElementById('fn-save');
  const msg = document.getElementById('fn-status-msg');
  const body = {
    name:        document.getElementById('fn-name').value,
    description: document.getElementById('fn-desc').value,
    user_notes:  document.getElementById('fn-notes').value,
    status:      document.getElementById('fn-status').value,
  };
  btn.disabled = true;
  msg.className = 'ctrl-status';
  msg.textContent = 'Saving…';
  try {
    const r = await fetch(`/api/flows/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
    const updated = data.flow || {};
    // patch the cached list row + re-render so the source flips to "manual".
    const i = flowList.findIndex(f => String(f.id) === String(id));
    if (i >= 0) flowList[i] = { ...flowList[i], ...updated };
    renderFlowList();
    renderFlowNote({ ...updated, id });
    const m2 = document.getElementById('fn-status-msg');
    m2.className = 'ctrl-status ok';
    m2.textContent = 'Saved — flow claimed (manual). Auto-discovery will no longer overwrite it.';
  } catch (e) {
    msg.className = 'ctrl-status err';
    msg.textContent = `Save failed: ${e.message}`;
    btn.disabled = false;
  }
}

// Declare an entry point auto-detection misses (the RECALL FLOOR). POSTs to
// /api/flows/declare, which registers the declaration + traces it (stored as
// source='declared', prune-exempt). On success, refresh the list and open the
// new flow so the user immediately sees what was traced.
async function declareFlow() {
  const btn = document.getElementById('fd-declare');
  const msg = document.getElementById('fd-msg');
  const file    = document.getElementById('fd-file').value.trim();
  const symbol  = document.getElementById('fd-symbol').value.trim();
  const name    = document.getElementById('fd-name').value.trim();
  const project = document.getElementById('fd-project').value.trim();
  if (!file || !symbol) {
    msg.className = 'ctrl-status err';
    msg.textContent = 'file and symbol are required.';
    return;
  }
  const body = { file, symbol };
  if (name) body.name = name;
  if (project) body.project = project;

  btn.disabled = true;
  msg.className = 'ctrl-status';
  msg.textContent = 'Declaring & tracing…';
  try {
    const r = await fetch('/api/flows/declare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
    msg.className = 'ctrl-status ok';
    if (data.flow) {
      msg.textContent = `Declared and traced "${data.flow.name}". It is the recall floor — it won't be pruned and re-traces nightly.`;
    } else {
      msg.textContent = 'Declared. The trace resolved to nothing for now — the declaration persists and will re-trace nightly.';
    }
    // Clear the symbol/name inputs (keep file+project for declaring siblings).
    document.getElementById('fd-symbol').value = '';
    document.getElementById('fd-name').value = '';
    await loadFlows();
    if (data.flow && data.flow.id) openFlow(data.flow.id);
  } catch (e) {
    msg.className = 'ctrl-status err';
    msg.textContent = `Declare failed: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('fd-declare')?.addEventListener('click', declareFlow);

// ── loader map ────────────────────────────────────────────────────────────────

const LOADERS = {
  overview:    loadOverview,
  sessions:    loadSessions,
  edits:       loadEdits,
  patterns:    loadPatterns,
  tools:       loadTools,
  prompts:     loadPrompts,
  stacks:      loadStacks,
  dictionary:  loadDictionary,
  agents:      loadAgents,
  discoveries: loadDiscoveries,
  memory:      loadMemory,
  graph:       loadGraph,
  brain:       loadBrain,
  flows:       loadFlows,
  control:     loadControl,
};

// ── boot ──────────────────────────────────────────────────────────────────────

(async () => {
  await loadStatus();
  loaded.add('overview');
  loadOverview();
})();
