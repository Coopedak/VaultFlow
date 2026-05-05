/**
 * dashboard/server.mjs — vaultflow analytics dashboard
 *
 * Express server exposing 12 read-only API endpoints over the vaultflow
 * SQLite DB + Parquet archive, plus static file serving for the SPA.
 *
 * Usage:
 *   node .claude/helpers/dashboard/server.mjs
 *   npm run dashboard
 *
 * Config: reads port/host from config/vaultflow.yaml → dashboard section.
 * Default: http://localhost:7700
 */

import { createRequire }  from 'node:module';
import { fileURLToPath }  from 'node:url';
import path               from 'node:path';
import fs                 from 'node:fs';

const require    = createRequire(import.meta.url);
const __dirname  = path.dirname(fileURLToPath(import.meta.url));

const express    = require('express');
const yaml       = require('js-yaml');

// ── config ────────────────────────────────────────────────────────────────

const CONFIG_PATH = require('../../../config/resolve.cjs');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try { return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; }
  catch (_) { return {}; }
}

const cfg         = loadConfig();
const METRICS     = cfg.paths   && cfg.paths.metrics_root   || path.join(process.env.USERPROFILE || '', 'vault', 'methodology', '.metrics');
const DB_FILE     = cfg.storage && cfg.storage.db_file      || 'vaultflow.db';
const PARQUET_DIR = cfg.storage && cfg.storage.parquet_dir  || 'parquet';
const PORT        = cfg.dashboard && cfg.dashboard.port     || 7700;
const HOST        = cfg.dashboard && cfg.dashboard.host     || 'localhost';

// ── db helpers ────────────────────────────────────────────────────────────

const db = require('../db.cjs');

function ensureDb() {
  db.initialize(METRICS, DB_FILE);
}

function rawDb() {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(path.join(METRICS, DB_FILE), { readOnly: true });
}

// Ensures rawDb connection is always closed, even on exception.
function withRawDb(fn) {
  const conn = rawDb();
  try {
    return fn(conn);
  } finally {
    try { conn.close(); } catch (_) {}
  }
}

// ── Express app ───────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '1mb' }));

// Serve static dashboard files
app.use(express.static(__dirname));

// ── middleware: ensure DB open ────────────────────────────────────────────

app.use('/api', (_req, _res, next) => {
  try { ensureDb(); next(); }
  catch (err) { next(err); }
});

// ── error helper ──────────────────────────────────────────────────────────

function apiErr(res, err) {
  console.error('[dashboard]', err.message);
  res.status(500).json({ error: err.message });
}

// ── 1. GET /api/status ────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
  try {
    const { tables, counts } = withRawDb(conn => {
      const tables = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all().map(r => r.name);
      const counts = {};
      for (const t of ['edit_events','sessions','patterns','memory_entries','tool_calls','prompts','dictionary','vault_agents','vault_tools','project_stacks']) {
        try { counts[t] = conn.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; }
        catch (_) { counts[t] = 0; }
      }
      return { tables, counts };
    });
    res.json({
      status:    'ok',
      db:        path.join(METRICS, DB_FILE),
      tables,
      counts,
      uptime_s:  Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  } catch (err) { apiErr(res, err); }
});

// ── 2. GET /api/sessions ──────────────────────────────────────────────────

app.get('/api/sessions', (_req, res) => {
  try {
    const rows = withRawDb(conn => conn.prepare(`
      SELECT id, started_at, ended_at, duration_ms,
             platform, cwd, project,
             edits, commands, tasks, errors
      FROM   sessions
      ORDER  BY started_at DESC
      LIMIT  50
    `).all());
    res.json(rows);
  } catch (err) { apiErr(res, err); }
});

// ── 3. GET /api/sessions/summary ─────────────────────────────────────────

app.get('/api/sessions/summary', (_req, res) => {
  try {
    const result = withRawDb(conn => {
      const daily = conn.prepare(`
        SELECT date(started_at) AS day,
               COUNT(*)          AS sessions,
               SUM(edits)        AS edits,
               SUM(commands)     AS commands
        FROM   sessions
        WHERE  started_at >= datetime('now', '-30 days')
        GROUP  BY day
        ORDER  BY day ASC
      `).all();
      const totals = conn.prepare(`
        SELECT COUNT(*)         AS total_sessions,
               SUM(edits)       AS total_edits,
               SUM(commands)    AS total_commands,
               AVG(duration_ms) AS avg_duration_ms,
               MAX(started_at)  AS last_session
        FROM   sessions
        WHERE  started_at >= datetime('now', '-30 days')
      `).get();
      const byProject = conn.prepare(`
        SELECT project, COUNT(*) AS sessions, SUM(edits) AS edits
        FROM   sessions
        WHERE  started_at >= datetime('now', '-30 days')
          AND  project IS NOT NULL
        GROUP  BY project
        ORDER  BY sessions DESC
        LIMIT  10
      `).all();
      return { daily, totals, byProject };
    });
    res.json(result);
  } catch (err) { apiErr(res, err); }
});

// ── 4. GET /api/edits/hot ─────────────────────────────────────────────────

app.get('/api/edits/hot', async (req, res) => {
  try {
    const daysRaw = req.query.days ? parseInt(req.query.days, 10) : 30;
    if (isNaN(daysRaw) || daysRaw < 1 || daysRaw > 365) {
      return res.status(400).json({ error: 'days must be a number between 1 and 365' });
    }
    const rows = await db.queryEditFrequency(METRICS, PARQUET_DIR, daysRaw);
    res.json(rows.slice(0, 30));
  } catch (err) { apiErr(res, err); }
});

// ── 5. GET /api/patterns ──────────────────────────────────────────────────

app.get('/api/patterns', (_req, res) => {
  try {
    const rows = withRawDb(conn => conn.prepare(`
      SELECT id, pattern_key, agent, confidence,
             fire_count, last_fired, promoted
      FROM   patterns
      ORDER  BY fire_count DESC, last_fired DESC
      LIMIT  50
    `).all());
    res.json(rows);
  } catch (err) { apiErr(res, err); }
});

// ── 6. POST /api/patterns/:id/promote ────────────────────────────────────

app.post('/api/patterns/:id/promote', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id < 1) {
    return res.status(400).json({ error: 'id must be a positive integer' });
  }
  const { DatabaseSync } = require('node:sqlite');
  const conn = new DatabaseSync(path.join(METRICS, DB_FILE));
  try {
    const result = conn.prepare(
      'UPDATE patterns SET promoted = 1 WHERE id = :id'
    ).run({ id });
    if (result.changes === 0) {
      res.status(404).json({ error: 'Pattern not found' });
    } else {
      res.json({ promoted: true, id });
    }
  } catch (err) {
    apiErr(res, err);
  } finally {
    try { conn.close(); } catch (_) {}
  }
});

// ── 7. GET /api/tool-calls ────────────────────────────────────────────────

app.get('/api/tool-calls', (_req, res) => {
  try {
    const result = withRawDb(conn => {
      const summary = conn.prepare(`
        SELECT   tool_name,
                 COUNT(*)                   AS call_count,
                 COUNT(DISTINCT input_hash) AS unique_calls,
                 MAX(timestamp)             AS last_called
        FROM     tool_calls
        WHERE    timestamp >= datetime('now', '-30 days')
        GROUP BY tool_name
        ORDER BY call_count DESC
      `).all();
      const dupeRate = summary.map(r => ({
        ...r,
        dupe_rate: r.call_count > 0
          ? Math.round((1 - r.unique_calls / r.call_count) * 100)
          : 0,
      }));
      const recent = conn.prepare(`
        SELECT tool_name, input_hash, timestamp, session_id
        FROM   tool_calls
        ORDER  BY timestamp DESC
        LIMIT  20
      `).all();
      return { summary: dupeRate, recent };
    });
    res.json(result);
  } catch (err) { apiErr(res, err); }
});

// ── 8. GET /api/prompts/recent ────────────────────────────────────────────

app.get('/api/prompts/recent', (_req, res) => {
  try {
    const result = withRawDb(conn => {
      const recent = conn.prepare(`
        SELECT id, timestamp, session_id,
               substr(prompt_text, 1, 120) AS prompt_preview,
               skill_routed
        FROM   prompts
        ORDER  BY timestamp DESC
        LIMIT  30
      `).all();
      const routing = conn.prepare(`
        SELECT   skill_routed, COUNT(*) AS cnt
        FROM     prompts
        WHERE    skill_routed IS NOT NULL
          AND    timestamp >= datetime('now', '-7 days')
        GROUP BY skill_routed
        ORDER BY cnt DESC
        LIMIT  10
      `).all();
      return { recent, routing };
    });
    res.json(result);
  } catch (err) { apiErr(res, err); }
});

// ── 9. GET /api/stacks ────────────────────────────────────────────────────

app.get('/api/stacks', (_req, res) => {
  try {
    const result = withRawDb(conn => {
      const flat = conn.prepare(`
        SELECT project, stack_key, confidence, detected_at
        FROM   project_stacks
        ORDER  BY project, confidence DESC
      `).all();
      const byProject = {};
      for (const r of flat) {
        if (!byProject[r.project]) byProject[r.project] = [];
        byProject[r.project].push({ stack: r.stack_key, confidence: r.confidence, detected_at: r.detected_at });
      }
      return { byProject, flat };
    });
    res.json(result);
  } catch (err) { apiErr(res, err); }
});

// ── 10. GET /api/dictionary ───────────────────────────────────────────────

app.get('/api/dictionary', (req, res) => {
  try {
    const query = req.query.q;
    if (query) {
      // FTS search — uses main db connection internally
      let rows;
      try {
        rows = db.searchDictionary(query, 20);
      } catch (ftsErr) {
        return res.status(400).json({ error: `FTS query error: ${ftsErr.message}` });
      }
      return res.json({ results: rows });
    }
    // Category counts + sample entries
    const result = withRawDb(conn => {
      const counts = conn.prepare(`
        SELECT category, COUNT(*) AS cnt
        FROM   dictionary
        GROUP  BY category
        ORDER  BY cnt DESC
      `).all();
      const recent = conn.prepare(`
        SELECT term, category, substr(definition, 1, 100) AS definition
        FROM   dictionary
        ORDER  BY id DESC
        LIMIT  20
      `).all();
      return { counts, recent };
    });
    res.json(result);
  } catch (err) { apiErr(res, err); }
});

// ── 11. GET /api/agents ───────────────────────────────────────────────────

app.get('/api/agents', (_req, res) => {
  try {
    const rows = withRawDb(conn => conn.prepare(`
      SELECT agent_id, name, source, description,
             trigger_pattern, use_count, last_used
      FROM   vault_agents
      ORDER  BY use_count DESC, name ASC
    `).all());
    res.json(rows);
  } catch (err) { apiErr(res, err); }
});

// ── 12. GET /api/discoveries ──────────────────────────────────────────────

app.get('/api/discoveries', (_req, res) => {
  try {
    const cfg2         = loadConfig();
    const discDir      = path.join(
      cfg2.paths && cfg2.paths.metrics_root || METRICS,
      cfg2.storage && cfg2.storage.discoveries_dir || 'discoveries'
    );

    if (!fs.existsSync(discDir)) return res.json([]);

    const files = fs.readdirSync(discDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, 20);

    const discoveries = files.map(f => {
      const fPath   = path.join(discDir, f);
      const content = fs.readFileSync(fPath, 'utf8');
      const lines   = content.split('\n');

      // Parse YAML frontmatter
      let meta = {};
      if (lines[0] === '---') {
        const end = lines.indexOf('---', 1);
        if (end !== -1) {
          try {
            meta = yaml.load(lines.slice(1, end).join('\n')) || {};
          } catch (_) {}
        }
      }

      return {
        file:      f,
        pattern:   meta.pattern   || f,
        agent:     meta.agent     || null,
        date:      meta.date      || null,
        fire_count: meta.fire_count || null,
        promoted:  meta.promoted  || false,
        preview:   lines.slice(0, 6).join('\n'),
      };
    });

    res.json(discoveries);
  } catch (err) { apiErr(res, err); }
});

// ── root → dashboard ──────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── start ─────────────────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  console.log(`[vaultflow dashboard] http://${HOST}:${PORT}`);
  console.log(`[vaultflow dashboard] DB: ${path.join(METRICS, DB_FILE)}`);
});

export default app;
