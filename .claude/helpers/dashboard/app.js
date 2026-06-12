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
        'width': (n) => 12 + Math.min(28, Math.sqrt(n.data('weight') || 1) * 6),
        'height': (n) => 12 + Math.min(28, Math.sqrt(n.data('weight') || 1) * 6),
        'text-wrap': 'ellipsis', 'text-max-width': 80, 'min-zoomed-font-size': 6,
      }},
      { selector: 'edge', style: {
        'width': 1, 'line-color': '#3a3a4a', 'target-arrow-color': '#3a3a4a',
        'target-arrow-shape': 'triangle', 'arrow-scale': 0.6, 'curve-style': 'bezier', 'opacity': 0.6,
      }},
      { selector: 'node:selected', style: { 'border-width': 2, 'border-color': '#fff' } },
    ],
    layout: { name: 'cose', animate: false, nodeRepulsion: 8000, idealEdgeLength: 80 },
  });
  brainCy.on('tap', 'node', (evt) => brainExpand(evt.target.id()));
}

async function loadBrain() {
  const depth = document.getElementById('brain-depth').value || 1;
  const g = await api(`/api/brain/graph?limit=150&depth=${depth}`).catch(() => ({ nodes: [], edges: [], meta: { mode: 'overview', nodeCount: 0, edgeCount: 0 } }));
  renderBrain(g);
}

async function brainExpand(nodeId) {
  const depth = document.getElementById('brain-depth').value || 1;
  const g = await api(`/api/brain/graph?center=${encodeURIComponent(nodeId)}&depth=${depth}&limit=150`).catch(() => null);
  if (g) renderBrain(g);
  brainDetail(nodeId);
}

function brainDetail(nodeId) {
  const [type, ...rest] = nodeId.split(':');
  const key = rest.join(':');
  const el = document.getElementById('brain-detail');
  el.innerHTML = `<div class="mono" style="font-size:13px">
    <strong style="color:${BRAIN_COLORS[type] || '#fff'}">${type}</strong> · ${escapeHtml(key)}
  </div>`;
}

document.getElementById('brain-reset')?.addEventListener('click', loadBrain);
document.getElementById('brain-depth')?.addEventListener('change', loadBrain);
document.getElementById('brain-search')?.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  const hits = await api(`/api/search?q=${encodeURIComponent(e.target.value.trim())}&limit=1`).catch(() => null);
  // unified search returns mixed rows; recenter on the first that maps to a graph node id, else no-op
  const first = hits && (hits.results || hits)[0];
  if (first && first.id) brainExpand(String(first.id));
});

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
  control:     loadControl,
};

// ── boot ──────────────────────────────────────────────────────────────────────

(async () => {
  await loadStatus();
  loaded.add('overview');
  loadOverview();
})();
