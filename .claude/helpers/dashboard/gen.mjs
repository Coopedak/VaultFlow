/**
 * dashboard/gen.mjs — generate a self-contained HTML dashboard
 *
 * Reads the vaultflow SQLite DB and writes a single standalone HTML file
 * with all data embedded. No server required — just open the file.
 *
 * Usage:
 *   node .claude/helpers/dashboard/gen.mjs [--open]
 *   npm run dashboard
 *
 * Flags:
 *   --open   Open the generated file in the default browser after writing
 *   --out    Output path (default: .claude/helpers/dashboard/dashboard.html)
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path              from 'node:path';
import fs                from 'node:fs';
import { execSync }      from 'node:child_process';

const require   = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const yaml = require('js-yaml');

// ── config ────────────────────────────────────────────────────────────────

const CONFIG_PATH = require('../../../config/resolve.cjs');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try { return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; }
  catch (_) { return {}; }
}

const cfg         = loadConfig();
const METRICS     = cfg?.paths?.metrics_root     || path.join(process.env.USERPROFILE || require('node:os').homedir(), 'vault', 'methodology', '.metrics');
const DB_FILE     = cfg?.storage?.db_file        || 'vaultflow.db';
const PARQUET_DIR = cfg?.storage?.parquet_dir    || 'parquet';

const DB_PATH = path.join(METRICS, DB_FILE);

// ── CLI args ──────────────────────────────────────────────────────────────

const args     = process.argv.slice(2);
const doOpen   = args.includes('--open');
const outIdx   = args.indexOf('--out');
const OUT_PATH = outIdx !== -1 ? args[outIdx + 1] : path.join(__dirname, 'dashboard.html');

// ── SQLite helpers ────────────────────────────────────────────────────────

function openDb() {
  const { emitWarning } = process;
  process.emitWarning = (msg, ...rest) => {
    if (typeof msg === 'string' && msg.includes('SQLite')) return;
    emitWarning.call(process, msg, ...rest);
  };
  const { DatabaseSync } = require('node:sqlite');
  process.emitWarning = emitWarning;
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

function safeQuery(conn, sql, defaultVal = []) {
  try { return conn.prepare(sql).all(); }
  catch (_) { return defaultVal; }
}

function safeGet(conn, sql, defaultVal = {}) {
  try { return conn.prepare(sql).get() || defaultVal; }
  catch (_) { return defaultVal; }
}

// ── data collection ───────────────────────────────────────────────────────

function collectData(conn) {
  const tables = safeQuery(conn,
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).map(r => r.name);

  const counts = {};
  for (const t of ['edit_events','sessions','session_summaries','patterns','memory_entries','tool_calls','prompts','dictionary','vault_agents','vault_tools','project_stacks','retrieval_docs','retrieval_feedback']) {
    try { counts[t] = conn.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; }
    catch (_) { counts[t] = 0; }
  }

  const totals = safeGet(conn, `
    SELECT COUNT(*) AS total_sessions,
           COALESCE(SUM(edits), 0) AS total_edits,
           COALESCE(SUM(commands), 0) AS total_commands,
           COALESCE(AVG(duration_ms), 0) AS avg_duration_ms,
           MAX(started_at) AS last_session
    FROM sessions
    WHERE started_at >= datetime('now', '-30 days')
  `);

  const recentSessions = safeQuery(conn, `
    SELECT id, started_at, ended_at, duration_ms,
           platform, cli, model, cwd, project, edits, commands, tasks, errors
    FROM   sessions
    ORDER  BY started_at DESC
    LIMIT  20
  `);

  const dailySessions = safeQuery(conn, `
    SELECT date(started_at) AS day,
           COUNT(*) AS sessions,
           COALESCE(SUM(edits), 0) AS edits,
           COALESCE(SUM(commands), 0) AS commands
    FROM   sessions
    WHERE  started_at >= datetime('now', '-30 days')
    GROUP  BY day
    ORDER  BY day ASC
  `);

  const byProject = safeQuery(conn, `
    SELECT project, COUNT(*) AS sessions,
           COALESCE(SUM(edits), 0) AS edits
    FROM   sessions
    WHERE  started_at >= datetime('now', '-30 days')
      AND  project IS NOT NULL
    GROUP  BY project
    ORDER  BY sessions DESC
    LIMIT  10
  `);

  const hotFiles = safeQuery(conn, `
    SELECT file_path,
           COUNT(*) AS edit_count,
           MAX(timestamp) AS last_edit,
           project
    FROM   edit_events
    WHERE  timestamp >= datetime('now', '-30 days')
    GROUP  BY file_path
    ORDER  BY edit_count DESC
    LIMIT  25
  `);

  const toolCalls = safeQuery(conn, `
    SELECT   tool_name,
             COUNT(*) AS call_count,
             COUNT(DISTINCT input_hash) AS unique_calls,
             MAX(timestamp) AS last_called
    FROM     tool_calls
    WHERE    timestamp >= datetime('now', '-30 days')
    GROUP BY tool_name
    ORDER BY call_count DESC
  `).map(r => ({
    ...r,
    dupe_rate: r.call_count > 0
      ? Math.round((1 - r.unique_calls / r.call_count) * 100)
      : 0,
  }));

  const patterns = safeQuery(conn, `
    SELECT id, pattern_key, agent, confidence,
           fire_count, last_fired, promoted
    FROM   patterns
    ORDER  BY fire_count DESC, last_fired DESC
    LIMIT  30
  `);

  const recentPrompts = safeQuery(conn, `
    SELECT id, timestamp, session_id,
           substr(prompt_text, 1, 120) AS prompt_preview,
           skill_routed, source
    FROM   prompts
    ORDER  BY timestamp DESC
    LIMIT  20
  `);

  const skillRouting = safeQuery(conn, `
    SELECT   skill_routed, COUNT(*) AS cnt
    FROM     prompts
    WHERE    skill_routed IS NOT NULL
      AND    timestamp >= datetime('now', '-7 days')
    GROUP BY skill_routed
    ORDER BY cnt DESC
    LIMIT  10
  `);

  const stacks = safeQuery(conn, `
    SELECT project, stack_key, confidence, detected_at
    FROM   project_stacks
    ORDER  BY project, confidence DESC
  `);

  const dictCounts = safeQuery(conn, `
    SELECT category, COUNT(*) AS cnt
    FROM   dictionary
    GROUP  BY category
    ORDER  BY cnt DESC
  `);

  const agents = safeQuery(conn, `
    SELECT agent_id, name, source, description,
           trigger_pattern, use_count, last_used
    FROM   vault_agents
    ORDER  BY use_count DESC, name ASC
    LIMIT  20
  `);

  return {
    meta: {
      db:        DB_PATH,
      tables,
      counts,
      generated: new Date().toISOString(),
    },
    totals,
    recentSessions,
    dailySessions,
    byProject,
    hotFiles,
    toolCalls,
    patterns,
    recentPrompts,
    skillRouting,
    stacks,
    dictCounts,
    agents,
  };
}

// ── HTML builder ──────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 16);
}

function fmtDur(ms) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function buildHtml(data) {
  const d = data;
  const ts = new Date(d.meta.generated).toLocaleString();

  function row(...cells) {
    return `<tr>${cells.map(c => `<td>${c ?? '—'}</td>`).join('')}</tr>`;
  }

  function tableHtml(headers, rows) {
    if (!rows.length) return '<p class="empty">No data</p>';
    return `<div class="tbl-wrap"><table>
      <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table></div>`;
  }

  const summaryCards = [
    ['Sessions (30d)',  d.totals.total_sessions || 0],
    ['Edits (30d)',     d.totals.total_edits || 0],
    ['Commands (30d)',  d.totals.total_commands || 0],
    ['Avg Duration',   fmtDur(d.totals.avg_duration_ms)],
    ['Last Session',   fmtDate(d.totals.last_session)],
    ['DB Tables',      d.meta.tables.length],
  ].map(([label, val]) =>
    `<div class="card"><div class="card-val">${val}</div><div class="card-lbl">${label}</div></div>`
  ).join('');

  const tableCount = Object.entries(d.meta.counts)
    .map(([t, n]) => `<tr><td>${t}</td><td class="num">${n.toLocaleString()}</td></tr>`)
    .join('');

  const sessionRows = d.recentSessions.map(s => row(
    fmtDate(s.started_at),
    s.project || '—',
    s.platform || '—',
    s.edits || 0,
    s.commands || 0,
    fmtDur(s.duration_ms)
  ));

  const byProjectRows = d.byProject.map(p => row(
    p.project,
    p.sessions,
    p.edits || 0
  ));

  const hotFileRows = d.hotFiles.map(f => row(
    `<span title="${(f.file_path || '').replace(/"/g, '&quot;').replace(/</g, '&lt;')}">${(f.file_path || '').replace(/\\/g, '/').split('/').pop().replace(/</g, '&lt;')}</span>`,
    f.project || '—',
    f.edit_count,
    fmtDate(f.last_edit)
  ));

  const toolRows = d.toolCalls.map(t => row(
    t.tool_name,
    t.call_count,
    t.unique_calls,
    `${t.dupe_rate}%`,
    fmtDate(t.last_called)
  ));

  const patternRows = d.patterns.map(p => row(
    p.pattern_key,
    p.agent || '—',
    p.fire_count,
    p.promoted ? '✓' : '',
    fmtDate(p.last_fired)
  ));

  const promptRows = d.recentPrompts.map(p => row(
    fmtDate(p.timestamp),
    p.source || '—',
    p.skill_routed || '—',
    `<span title="${(p.prompt_preview || '').replace(/"/g, '&quot;')}">${
      (p.prompt_preview || '').slice(0, 60).replace(/</g, '&lt;')}…</span>`
  ));

  const routingRows = d.skillRouting.map(r => row(r.skill_routed, r.cnt));

  const agentRows = d.agents.map(a => row(
    a.name || a.agent_id,
    a.source || '—',
    a.use_count || 0,
    fmtDate(a.last_used)
  ));

  const dictRows = d.dictCounts.map(c => row(c.category, c.cnt));

  // Group stacks by project
  const stackMap = {};
  for (const s of d.stacks) {
    if (!stackMap[s.project]) stackMap[s.project] = [];
    stackMap[s.project].push(s.stack_key);
  }
  const stackRows = Object.entries(stackMap).map(([proj, stacks]) =>
    row(proj, stacks.join(', '))
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vaultflow dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:    #0f1117;
    --bg2:   #1a1d26;
    --bg3:   #22263a;
    --border:#2e3347;
    --text:  #e2e8f0;
    --muted: #8892a4;
    --accent:#6366f1;
    --green: #22c55e;
    --amber: #f59e0b;
    --red:   #ef4444;
  }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 'Segoe UI', system-ui, sans-serif; }
  header { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 16px 24px; display:flex; align-items:center; justify-content:space-between; }
  header h1 { font-size:18px; font-weight:700; color:#fff; letter-spacing:-.5px; }
  header h1 span { color: var(--accent); }
  header .meta { font-size:12px; color:var(--muted); }
  nav { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 0 24px; display:flex; gap:2px; overflow-x:auto; }
  nav button { background:none; border:none; color:var(--muted); padding:10px 14px; cursor:pointer; font-size:13px; border-bottom:2px solid transparent; white-space:nowrap; }
  nav button.active, nav button:hover { color:var(--text); border-bottom-color:var(--accent); }
  main { padding: 24px; max-width:1400px; margin:0 auto; }
  section { display:none; }
  section.active { display:block; }
  h2 { font-size:15px; font-weight:600; color:#fff; margin-bottom:16px; }
  h3 { font-size:13px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; margin:20px 0 10px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:12px; margin-bottom:24px; }
  .card { background:var(--bg2); border:1px solid var(--border); border-radius:8px; padding:16px; }
  .card-val { font-size:22px; font-weight:700; color:#fff; }
  .card-lbl { font-size:12px; color:var(--muted); margin-top:4px; }
  .tbl-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; padding:8px 12px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.5px; color:var(--muted); border-bottom:1px solid var(--border); white-space:nowrap; }
  td { padding:8px 12px; border-bottom:1px solid var(--border); color:var(--text); }
  tr:last-child td { border-bottom:none; }
  tr:hover td { background:var(--bg3); }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
  @media(max-width:700px) { .grid2 { grid-template-columns:1fr; } }
  .panel { background:var(--bg2); border:1px solid var(--border); border-radius:8px; padding:16px; }
  .empty { color:var(--muted); font-style:italic; font-size:13px; padding:8px 0; }
  .badge { display:inline-block; padding:1px 6px; border-radius:4px; font-size:11px; font-weight:600; background:var(--bg3); color:var(--muted); }
  .badge.promoted { background:#1a3d2b; color:var(--green); }
</style>
</head>
<body>
<header>
  <h1>vault<span>flow</span></h1>
  <div class="meta">Generated ${ts} &nbsp;·&nbsp; ${d.meta.db}</div>
</header>
<nav>
  <button class="active" onclick="show('overview',this)">Overview</button>
  <button onclick="show('sessions',this)">Sessions</button>
  <button onclick="show('files',this)">Hot Files</button>
  <button onclick="show('tools',this)">Tool Calls</button>
  <button onclick="show('patterns',this)">Patterns</button>
  <button onclick="show('prompts',this)">Prompts</button>
  <button onclick="show('stacks',this)">Stacks</button>
  <button onclick="show('agents',this)">Agents</button>
  <button onclick="show('dict',this)">Dictionary</button>
</nav>
<main>

<!-- OVERVIEW -->
<section id="overview" class="active">
  <h2>Overview</h2>
  <div class="cards">${summaryCards}</div>
  <div class="grid2">
    <div class="panel">
      <h3>Table Counts</h3>
      <div class="tbl-wrap"><table>
        <thead><tr><th>Table</th><th>Rows</th></tr></thead>
        <tbody>${tableCount}</tbody>
      </table></div>
    </div>
    <div class="panel">
      <h3>Projects (30d)</h3>
      ${tableHtml(['Project','Sessions','Edits'], byProjectRows)}
    </div>
  </div>
</section>

<!-- SESSIONS -->
<section id="sessions">
  <h2>Recent Sessions</h2>
  ${tableHtml(['Started','Project','Platform','Edits','Commands','Duration'], sessionRows)}
</section>

<!-- HOT FILES -->
<section id="files">
  <h2>Most Edited Files (30d)</h2>
  ${tableHtml(['File','Project','Edits','Last Edit'], hotFileRows)}
</section>

<!-- TOOL CALLS -->
<section id="tools">
  <h2>Tool Call Frequency (30d)</h2>
  ${tableHtml(['Tool','Calls','Unique','Dupe Rate','Last Called'], toolRows)}
</section>

<!-- PATTERNS -->
<section id="patterns">
  <h2>Top Patterns</h2>
  ${tableHtml(['Pattern Key','Agent','Fire Count','Promoted','Last Fired'], patternRows)}
</section>

<!-- PROMPTS -->
<section id="prompts">
  <h2>Recent Prompts</h2>
  <div class="grid2">
    <div class="panel">
      <h3>Skill Routing (7d)</h3>
      ${tableHtml(['Skill','Count'], routingRows)}
    </div>
    <div class="panel" style="grid-column:1/-1">
      <h3>Recent Prompts</h3>
      ${tableHtml(['Timestamp','Source','Skill Routed','Preview'], promptRows)}
    </div>
  </div>
</section>

<!-- STACKS -->
<section id="stacks">
  <h2>Detected Project Stacks</h2>
  ${tableHtml(['Project','Stacks'], stackRows)}
</section>

<!-- AGENTS -->
<section id="agents">
  <h2>Vault Agents</h2>
  ${tableHtml(['Name','Source','Use Count','Last Used'], agentRows)}
</section>

<!-- DICTIONARY -->
<section id="dict">
  <h2>Dictionary</h2>
  ${tableHtml(['Category','Count'], dictRows)}
</section>

</main>
<script>
function show(id, btn) {
  document.querySelectorAll('section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  btn.classList.add('active');
}
</script>
</body>
</html>`;
}

// ── main ──────────────────────────────────────────────────────────────────

if (!fs.existsSync(DB_PATH)) {
  console.error(`[dashboard] DB not found: ${DB_PATH}`);
  console.error('[dashboard] Run vaultflow hooks at least once to initialize the DB.');
  process.exit(1);
}

let conn;
try {
  conn = openDb();
} catch (err) {
  console.error(`[dashboard] Cannot open DB: ${err.message}`);
  process.exit(1);
}

let data;
try {
  data = collectData(conn);
} finally {
  try { conn.close(); } catch (_) {}
}

const html = buildHtml(data);
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, html, 'utf8');
console.log(`[dashboard] Written → ${OUT_PATH}`);

if (doOpen) {
  const cmd = process.platform === 'win32'
    ? `start "" "${OUT_PATH}"`
    : process.platform === 'darwin'
      ? `open "${OUT_PATH}"`
      : `xdg-open "${OUT_PATH}"`;
  try { execSync(cmd, { stdio: 'ignore' }); }
  catch (_) { console.log(`[dashboard] Open manually: ${OUT_PATH}`); }
}
