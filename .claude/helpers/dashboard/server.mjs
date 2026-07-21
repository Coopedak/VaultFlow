/**
 * dashboard/server.mjs — vaultflow analytics dashboard
 *
 * Express server exposing 24 read-only API endpoints over the vaultflow
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
import os                 from 'node:os';

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
// M1: METRICS is the module-level disk-read path used by every handler that
// touches the metrics directory (rawDb, parquet flush, heartbeat, watcher pid).
//
// It is `let`, not `const`, because startServer({ metricsRoot }) must be able to
// re-point it: previously that option only re-initialized the db.cjs singleton,
// leaving these ~20 disk reads pinned to the config path resolved at import
// time. On a machine with no local config that path is the example file's
// "C:/Users/YOU/…", so rawDb() threw "unable to open database file" and
// /api/overview returned 500 — a fresh clone could not pass its own test suite.
let METRICS       = (cfg.paths   && cfg.paths.metrics_root)   || path.join(process.env.USERPROFILE || os.homedir(), 'vault', 'methodology', '.metrics');
const DB_FILE     = cfg.storage && cfg.storage.db_file      || 'vaultflow.db';
const PARQUET_DIR = cfg.storage && cfg.storage.parquet_dir  || 'parquet';
const PORT        = cfg.dashboard && cfg.dashboard.port     || 7700;
const HOST        = cfg.dashboard && cfg.dashboard.host     || 'localhost';

// ── db helpers ────────────────────────────────────────────────────────────

const db = require('../db.cjs');
const modelRouter = require('../model-router.cjs');
const brainNotes = require('../brain-notes.cjs');
const flowExcalidraw = require('../flow-excalidraw.cjs');
const skillReuse = require('../skill-reuse.cjs');

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

// Serve static dashboard files. index:false — otherwise static serves
// index.html (legacy v1) as the directory index for '/', shadowing the
// explicit '/' route that serves the Synapse v2 shell.
app.use(express.static(__dirname, { index: false }));

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
      for (const t of ['edit_events','sessions','session_summaries','patterns','memory_entries','tool_calls','prompts','dictionary','vault_agents','vault_tools','project_stacks','retrieval_docs','retrieval_feedback']) {
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
             platform, cli, model, cwd, project,
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
        SELECT COUNT(*)            AS total_sessions,
               SUM(CASE WHEN ended_at IS NOT NULL THEN 1 ELSE 0 END) AS closed_sessions,
               SUM(CASE WHEN ended_at IS NULL     THEN 1 ELSE 0 END) AS active_sessions,
               SUM(edits)          AS total_edits,
               SUM(commands)       AS total_commands,
               -- AVG silently skips NULL duration_ms (active sessions). Surfacing
               -- closed_sessions next to it lets the UI show the basis honestly.
               AVG(duration_ms)    AS avg_duration_ms,
               MAX(started_at)     AS last_session
        FROM   sessions
        WHERE  started_at >= datetime('now', '-30 days')
      `).get();
      const byProject = conn.prepare(`
        -- Bucket NULL projects into "(unknown)" so the chart shows them
        -- instead of silently dropping 22% of sessions.
        SELECT COALESCE(NULLIF(project, ''), '(unknown)') AS project,
               COUNT(*) AS sessions,
               SUM(edits) AS edits
        FROM   sessions
        WHERE  started_at >= datetime('now', '-30 days')
        GROUP  BY COALESCE(NULLIF(project, ''), '(unknown)')
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
  // Open a writable connection (rawDb above is read-only) but route through the
  // same try/finally pattern so a thrown apiErr never leaks the handle.
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
               skill_routed, source
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
    // Category counts + sample entries. Default view excludes the auto-detected
    // 'pattern' category — those are token-frequency junk (e.g. "summary",
    // "theoretical") scraped from prompts. Pass ?include=pattern to see them.
    const includePattern = String(req.query.include || '').includes('pattern');
    const result = withRawDb(conn => {
      const counts = conn.prepare(`
        SELECT category, COUNT(*) AS cnt
        FROM   dictionary
        GROUP  BY category
        ORDER  BY cnt DESC
      `).all();
      const recentSql = includePattern
        ? `SELECT term, category, substr(definition, 1, 100) AS definition FROM dictionary ORDER BY id DESC LIMIT 20`
        : `SELECT term, category, substr(definition, 1, 100) AS definition FROM dictionary WHERE category != 'pattern' ORDER BY id DESC LIMIT 20`;
      const recent = conn.prepare(recentSql).all();
      return { counts, recent };
    });
    res.json(result);
  } catch (err) { apiErr(res, err); }
});

// ── Agent Wizard endpoints (11a-11e) ──────────────────────────────────────
// Must be registered BEFORE the existing GET /api/agents (11) so the
// more-specific paths are matched first by Express.

// 11a. GET /api/agents/projects — list C:\GIT project directories
app.get('/api/agents/projects', (_req, res) => {
  try {
    const gitRoot = 'C:\\GIT';
    if (!fs.existsSync(gitRoot)) return res.json([]);
    const entries = fs.readdirSync(gitRoot, { withFileTypes: true });
    const projects = entries
      .filter(e => e.isDirectory())
      .map(e => ({ name: e.name, fullPath: path.join(gitRoot, e.name) }));
    res.json(projects);
  } catch (err) { apiErr(res, err); }
});

// 11b. GET /api/agents/detect-stack?path= — run stack detector on a project path
app.get('/api/agents/detect-stack', async (req, res) => {
  try {
    const projectPath = String(req.query.path || '').trim();
    if (!projectPath) return res.status(400).json({ error: 'path required' });
    const { detectStacks } = await import('../stack-detector.mjs');
    const stacks = await detectStacks(projectPath);
    res.json({ stacks });
  } catch (err) { apiErr(res, err); }
});

// 11c. GET /api/agents/search?q=&limit= — search existing skills via skill-reuse scorer
app.get('/api/agents/search', (req, res) => {
  try {
    const q     = String(req.query.q || '').trim();
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 10), 50);
    if (!q) return res.status(400).json({ error: 'q required' });
    ensureDb();
    const rows = db.searchVaultAgents(q, limit);
    const results = skillReuse.scoreSkillRows(q, rows).map(r => ({
      name:        r.name        || null,
      source:      r.source      || null,
      description: r.description || null,
      confidence:  r.confidence,
      verdict:     r.verdict,
    }));
    res.json({ results });
  } catch (err) { apiErr(res, err); }
});

// 11d. GET /api/agents/existing — list existing agents + skills from ~/.claude
app.get('/api/agents/existing', (_req, res) => {
  try {
    const claudeDir  = os.homedir() ? path.join(os.homedir(), '.claude') : null;
    if (!claudeDir) return res.json({ agents: [], skills: [] });

    const agentsDir  = path.join(claudeDir, 'agents');
    const skillsDir  = path.join(claudeDir, 'skills');

    const agents = fs.existsSync(agentsDir)
      ? fs.readdirSync(agentsDir)
          .filter(f => f.endsWith('.md'))
          .map(f => path.basename(f, '.md'))
      : [];

    const skills = fs.existsSync(skillsDir)
      ? fs.readdirSync(skillsDir, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => e.name)
      : [];

    res.json({ agents, skills });
  } catch (err) { apiErr(res, err); }
});

// 11e. POST /api/agents/create — create or dry-run a new agent
app.post('/api/agents/create', async (req, res) => {
  try {
    const {
      slug, role, description, domain, boundaries, orientation,
      doneCriteria, model = 'sonnet', stack = [], techStackEntry = null,
      dryRun = false, overwrite = false,
    } = req.body || {};

    if (!slug) return res.status(400).json({ error: 'slug required' });

    // Import pure logic lazily (ESM).
    const authoring = await import('../agent-authoring.mjs');

    if (dryRun) {
      // Dry run: render previews + check collision, write nothing.
      const validSlug = authoring.validateSlug(slug);
      if (!validSlug) {
        return res.status(400).json({ error: `Invalid slug "${slug}".` });
      }
      const renderOpts = { name: slug, role, description: description || '', model, domain, boundaries, orientation, doneCriteria };
      const skillMd    = authoring.renderSkillMd(renderOpts);
      const agentMd    = authoring.renderAgentMd({ ...renderOpts, stack });
      const claudeDir  = path.join(os.homedir(), '.claude');
      const agentsDir  = path.join(claudeDir, 'agents');
      const skillsDir  = path.join(claudeDir, 'skills');
      const agentPath  = path.resolve(agentsDir, `${slug}.md`);
      const skillPath  = path.resolve(skillsDir, slug, 'SKILL.md');
      // Defense-in-depth: assert no path traversal even in dry-run, consistent
      // with the trust model in createAgent.
      authoring.assertSafe(agentPath, agentsDir);
      authoring.assertSafe(path.resolve(skillsDir, slug), skillsDir);
      const collision  = {
        agent: fs.existsSync(agentPath) ? agentPath : null,
        skill: fs.existsSync(skillPath) ? skillPath : null,
      };
      return res.json({ preview: { skillMd, agentMd }, collision });
    }

    // Real create.
    const result = await authoring.createAgent({
      slug, role, description, domain, boundaries, orientation,
      doneCriteria, model, stack, techStackEntry, overwrite,
    });

    res.json({
      ok:     true,
      files:  result.files,
      notice: 'Restart Claude Code to use this agent; run `npm run backfill -- --skills-only` for reuse-search to index it.',
    });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ error: err.message, existing: err.existing });
    }
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    apiErr(res, err);
  }
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

// ── 13. POST /api/flush ───────────────────────────────────────────────────

app.post('/api/flush', async (_req, res) => {
  try {
    ensureDb();
    const [main, telemetry] = await Promise.all([
      db.flushToParquet(METRICS, PARQUET_DIR),
      db.flushTelemetryToParquet(METRICS, PARQUET_DIR),
    ]);
    res.json({ ok: true, main, telemetry });
  } catch (err) { apiErr(res, err); }
});

// ── 14. POST /api/learning/run ────────────────────────────────────────────

app.post('/api/learning/run', (_req, res) => {
  try {
    ensureDb();
    const result = db.runRetrievalLearningLoop();
    res.json({ ok: true, ...result });
  } catch (err) { apiErr(res, err); }
});

// ── 15. POST /api/backfill ────────────────────────────────────────────────

app.post('/api/backfill', (req, res) => {
  try {
    const { spawn } = require('child_process');
    const scriptPath = path.resolve(__dirname, '..', 'backfill.mjs');
    const args = ['--no-warnings', scriptPath];
    if (req.body && req.body.skillsOnly) args.push('--skills-only');
    if (req.body && req.body.toolsOnly)  args.push('--tools-only');
    if (req.body && req.body.dryRun)     args.push('--dry-run');

    const child = spawn(process.execPath, args, { stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => {
      res.json({ ok: code === 0, exitCode: code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on('error', err => apiErr(res, err));
  } catch (err) { apiErr(res, err); }
});

// ── 16. GET /api/watcher/status ───────────────────────────────────────────

app.get('/api/watcher/status', (_req, res) => {
  const pidFile = path.join(METRICS, 'watcher.pid');
  if (!fs.existsSync(pidFile)) {
    return res.json({ running: false, pid: null });
  }
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!pid) return res.json({ running: false, pid: null });
    // Check if process is alive (signal 0 = no-op)
    try {
      process.kill(pid, 0);
      res.json({ running: true, pid });
    } catch (_) {
      res.json({ running: false, pid, stale: true });
    }
  } catch (err) { apiErr(res, err); }
});

// ── 17. POST /api/watcher/start ───────────────────────────────────────────

app.post('/api/watcher/start', (_req, res) => {
  try {
    const { spawn } = require('child_process');
    const watcherPath = path.resolve(__dirname, '..', 'watcher.mjs');
    const watchDir    = cfg.paths && cfg.paths.watcher_watch_dir || '';
    if (!watchDir || !fs.existsSync(watchDir)) {
      return res.status(400).json({ error: 'watcher_watch_dir not configured or does not exist' });
    }
    const child = spawn(
      process.execPath,
      ['--no-warnings', watcherPath, '--daemon', watchDir],
      { detached: true, stdio: 'ignore' }
    );
    child.unref();
    res.json({ ok: true, message: `Watcher daemon started for ${watchDir}` });
  } catch (err) { apiErr(res, err); }
});

// ── 18. POST /api/watcher/stop ────────────────────────────────────────────

app.post('/api/watcher/stop', (_req, res) => {
  try {
    const { spawn } = require('child_process');
    const watcherPath = path.resolve(__dirname, '..', 'watcher.mjs');
    const child = spawn(process.execPath, ['--no-warnings', watcherPath, '--stop'], { stdio: ['ignore','pipe','pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => res.json({ ok: code === 0, message: out.trim() }));
    child.on('error', err => apiErr(res, err));
  } catch (err) { apiErr(res, err); }
});

// ── 19. POST /api/dict/import ─────────────────────────────────────────────

app.post('/api/dict/import', async (_req, res) => {
  try {
    const domainDir = cfg.paths && cfg.paths.vault_domain_dir;
    if (!domainDir || !fs.existsSync(domainDir)) {
      return res.status(400).json({ error: 'vault_domain_dir not configured or does not exist' });
    }
    const { importFromDirectory } = await import('../dict.mjs');
    const result = await importFromDirectory(domainDir);
    res.json({ ok: true, ...result });
  } catch (err) { apiErr(res, err); }
});

// ── 20. GET /api/memory ───────────────────────────────────────────────────

app.get('/api/memory', (req, res) => {
  try {
    const query = (req.query.q || '').trim();
    if (!query) return res.status(400).json({ error: 'q parameter required' });
    ensureDb();
    let rows;
    try {
      rows = db.searchMemory(query, 20);
    } catch (ftsErr) {
      return res.status(400).json({ error: `FTS query error: ${ftsErr.message}` });
    }
    res.json({ results: rows });
  } catch (err) { apiErr(res, err); }
});

// ── 21. GET /api/notes (Atlas) ────────────────────────────────────────────

app.get('/api/notes', (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const source = req.query.source || null;
    res.json({ notes: brainNotes.listNotes({ limit, offset, source }) });
  } catch (err) { apiErr(res, err); }
});

app.get('/api/notes/:id', (req, res) => {
  try {
    const id   = Number(req.params.id);
    const note = brainNotes.getNote(id);
    if (!note) return res.status(404).json({ error: 'note not found' });
    res.json({ note, localGraph: brainNotes.getLocalGraph(id) });
  } catch (err) { apiErr(res, err); }
});

// ── 22. GET /api/config ───────────────────────────────────────────────────

app.get('/api/config', (_req, res) => {
  try {
    const safeCfg = {
      paths: {
        vault_root:         cfg.paths && cfg.paths.vault_root,
        metrics_root:       cfg.paths && cfg.paths.metrics_root,
        watcher_watch_dir:  cfg.paths && cfg.paths.watcher_watch_dir,
        wiki_glob:          cfg.paths && cfg.paths.wiki_glob,
      },
      storage: cfg.storage,
      intelligence: cfg.intelligence,
      dashboard: cfg.dashboard,
    };
    res.json(safeCfg);
  } catch (err) { apiErr(res, err); }
});

// ── 21. POST /api/audit ───────────────────────────────────────────────────
// Runs db.cjs health checks: FTS5 integrity, orphaned FTS rows, schema index
// presence, memory duplicate count, and session file vs DB consistency.
// Returns JSON array of {check, status, detail} rows.

app.post('/api/audit', (_req, res) => {
  try {
    ensureDb();
    const results = [];

    // 1. FTS5 integrity checks
    const ftsNames = ['memory_fts', 'prompts_fts', 'dictionary_fts', 'vault_tools_fts', 'tool_calls_fts', 'session_summaries_fts', 'retrieval_docs_fts'];
    for (const fts of ftsNames) {
      try {
        const row = db.raw().prepare(`INSERT INTO ${fts}(${fts}) VALUES('integrity-check')`).run();
        results.push({ check: `FTS5 ${fts}`, status: 'ok', detail: 'integrity-check passed' });
      } catch (e) {
        results.push({ check: `FTS5 ${fts}`, status: 'fail', detail: e.message });
      }
    }

    // 2. memory_entries duplicate count (should be 0 after dedup migration)
    try {
      const { dupes } = db.raw().prepare(
        `SELECT COUNT(*) - COUNT(DISTINCT source || '||' || title) AS dupes FROM memory_entries`
      ).get();
      results.push({ check: 'memory duplicates', status: dupes === 0 ? 'ok' : 'warn',
        detail: `${dupes} duplicate (source,title) pairs` });
    } catch (e) {
      results.push({ check: 'memory duplicates', status: 'fail', detail: e.message });
    }

    // 3. idx_memory_uniq present (dedup migration ran)
    try {
      const idx = db.raw().prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_uniq'`
      ).get();
      results.push({ check: 'idx_memory_uniq', status: idx ? 'ok' : 'warn',
        detail: idx ? 'UNIQUE index present' : 'missing — dedup migration not yet applied' });
    } catch (e) {
      results.push({ check: 'idx_memory_uniq', status: 'fail', detail: e.message });
    }

    // 4. Performance indexes present
    const perfIdxs = [
      'idx_edit_events_session', 'idx_edit_events_timestamp',
      'idx_tool_calls_session', 'idx_prompts_session',
      'idx_memory_source', 'idx_patterns_fire',
    ];
    for (const ix of perfIdxs) {
      const found = db.raw().prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name=?`
      ).get(ix);
      results.push({ check: ix, status: found ? 'ok' : 'warn',
        detail: found ? 'present' : 'missing — schema may need reinitialize()' });
    }

    // 5. Orphaned FTS rows (memory_fts rows whose rowid has no backing row)
    try {
      const { orphans } = db.raw().prepare(`
        SELECT COUNT(*) AS orphans FROM memory_fts f
        WHERE NOT EXISTS (SELECT 1 FROM memory_entries m WHERE m.id = f.rowid)
      `).get();
      results.push({ check: 'memory_fts orphans', status: orphans === 0 ? 'ok' : 'warn',
        detail: `${orphans} orphaned FTS rows` });
    } catch (e) {
      results.push({ check: 'memory_fts orphans', status: 'fail', detail: e.message });
    }

    try {
      const { orphans } = db.raw().prepare(`
        SELECT COUNT(*) AS orphans FROM tool_calls_fts f
        WHERE NOT EXISTS (SELECT 1 FROM tool_calls t WHERE t.id = f.rowid)
      `).get();
      results.push({ check: 'tool_calls_fts orphans', status: orphans === 0 ? 'ok' : 'warn',
        detail: `${orphans} orphaned FTS rows` });
    } catch (e) {
      results.push({ check: 'tool_calls_fts orphans', status: 'fail', detail: e.message });
    }

    try {
      const { orphans } = db.raw().prepare(`
        SELECT COUNT(*) AS orphans FROM session_summaries_fts f
        WHERE NOT EXISTS (SELECT 1 FROM session_summaries s WHERE s.rowid = f.rowid)
      `).get();
      results.push({ check: 'session_summaries_fts orphans', status: orphans === 0 ? 'ok' : 'warn',
        detail: `${orphans} orphaned FTS rows` });
    } catch (e) {
      results.push({ check: 'session_summaries_fts orphans', status: 'fail', detail: e.message });
    }

    try {
      const { orphans } = db.raw().prepare(`
        SELECT COUNT(*) AS orphans FROM retrieval_docs_fts f
        WHERE NOT EXISTS (SELECT 1 FROM retrieval_docs d WHERE d.id = f.rowid)
      `).get();
      results.push({ check: 'retrieval_docs_fts orphans', status: orphans === 0 ? 'ok' : 'warn',
        detail: `${orphans} orphaned FTS rows` });
    } catch (e) {
      results.push({ check: 'retrieval_docs_fts orphans', status: 'fail', detail: e.message });
    }

    // 8. DB file size
    try {
      const dbPath = path.join(METRICS, DB_FILE);
      const { size } = fs.statSync(dbPath);
      const mb = (size / 1024 / 1024).toFixed(2);
      results.push({ check: 'db file size', status: 'ok', detail: `${mb} MB` });
    } catch (e) {
      results.push({ check: 'db file size', status: 'fail', detail: e.message });
    }

    res.json(results);
  } catch (err) { apiErr(res, err); }
});

// ── 22. GET /api/verdicts ─────────────────────────────────────────────────
// Returns voice-of-reason verdict summary grouped by agent_type + verdict.
// Optional ?days=N (default 30, max 365).

app.get('/api/verdicts', (req, res) => {
  try {
    const daysRaw = req.query.days ? parseInt(req.query.days, 10) : 30;
    if (isNaN(daysRaw) || daysRaw < 1 || daysRaw > 365) {
      return res.status(400).json({ error: 'days must be a number between 1 and 365' });
    }
    ensureDb();
    const summary = db.getVerdictSummary(daysRaw);
    const recent  = withRawDb(conn => conn.prepare(`
      SELECT timestamp, session_id, agent_type, verdict, reason, flagged_at
      FROM   agent_verdicts
      WHERE  timestamp >= datetime('now', '-' || :days || ' days')
      ORDER  BY timestamp DESC
      LIMIT  20
    `).all({ days: daysRaw }));
    res.json({ summary, recent, days: daysRaw });
  } catch (err) { apiErr(res, err); }
});

// ── health (anomaly checks, not just counts) ─────────────────────────────

/**
 * computeHealthChecks(conn) — runs all DB-backed health checks against an
 * already-open read-only SQLite connection and returns the full checks array.
 * Extracted so /api/health and /api/overview can share the same logic without
 * duplicating the queries.
 */
function computeHealthChecks(conn) {
  const checks = [];

  // 1. session_summary fill rate (last 7d)
  const sess7  = conn.prepare("SELECT COUNT(*) AS n FROM sessions WHERE started_at > date('now','-7 days') AND ended_at IS NOT NULL").get().n;
  const sum7   = conn.prepare("SELECT COUNT(*) AS n FROM session_summaries WHERE summary_at > date('now','-7 days')").get().n;
  const fillPct = sess7 ? Math.round(100 * sum7 / sess7) : 100;
  checks.push({
    name: 'session_summary_fill_rate',
    value: `${fillPct}%`,
    detail: `${sum7}/${sess7} closed sessions in last 7d have summaries`,
    status: fillPct >= 80 ? 'ok' : fillPct >= 50 ? 'warn' : 'fail',
  });

  // 2. pattern noise ratio
  const topPattern = conn.prepare('SELECT pattern_key, fire_count FROM patterns ORDER BY fire_count DESC LIMIT 1').get();
  const isNoise = topPattern && /^(wal|shm|lock|tmp|cache|pyc)::|::(cache|\.cache|node_modules|dist|build|bin|obj|\.vscode|\.idea)$/.test(topPattern.pattern_key);
  checks.push({
    name: 'pattern_signal_quality',
    value: topPattern ? topPattern.pattern_key : '—',
    detail: topPattern ? `top pattern fired ${topPattern.fire_count}x — ${isNoise ? 'infrastructure noise' : 'real signal'}` : 'no patterns yet',
    status: !topPattern ? 'ok' : isNoise ? 'fail' : 'ok',
  });

  // 3. vault_tool promotion backlog
  const eligible = conn.prepare('SELECT COUNT(*) AS n FROM vault_tools WHERE use_count >= 5 AND (promoted = 0 OR promoted IS NULL)').get().n;
  checks.push({
    name: 'vault_tool_promotion_backlog',
    value: String(eligible),
    detail: `${eligible} tools eligible (use_count >= 5) but not promoted`,
    status: eligible === 0 ? 'ok' : eligible <= 5 ? 'warn' : 'fail',
  });

  // 4. retrieval activity (use retrieval_docs growth — populates organically;
  // retrieval_feedback requires explicit thumbs-up/down which rarely happens)
  const docs7 = conn.prepare("SELECT COUNT(*) AS n FROM retrieval_docs WHERE timestamp > date('now','-7 days')").get().n;
  checks.push({
    name: 'retrieval_activity',
    value: String(docs7),
    detail: `${docs7} retrieval docs indexed in last 7d`,
    status: docs7 > 0 ? 'ok' : 'warn',
  });

  // 4b. code-graph MCP adoption (last 14d). If the LLM never calls the
  // MCP code-graph tools, the integration is wasted — surface that.
  const adoption = conn.prepare(`
    SELECT SUM(CASE WHEN tool_name LIKE 'mcp__%blast_radius%' OR
                         tool_name LIKE 'mcp__%find_symbol%'  OR
                         tool_name LIKE 'mcp__%file_symbols%'
                    THEN 1 ELSE 0 END) AS graph,
           SUM(CASE WHEN tool_name IN ('Read','Glob','Grep') THEN 1 ELSE 0 END) AS explore
      FROM tool_calls WHERE timestamp > date('now','-14 days')
  `).get();
  const total = (adoption.graph || 0) + (adoption.explore || 0);
  const pct = total > 0 ? Math.round(100 * (adoption.graph || 0) / total) : 0;
  checks.push({
    name: 'code_graph_adoption',
    value: total === 0 ? 'no data' : `${pct}%`,
    detail: total === 0
      ? 'no Read/Glob/Grep or MCP graph calls recorded in last 14d — nothing to measure'
      : `${adoption.graph || 0} MCP graph calls vs ${adoption.explore || 0} Read/Glob/Grep in last 14d`,
    // 0/0 is absence of telemetry, not evidence of poor adoption — don't warn.
    status: total === 0 ? 'ok' : (adoption.graph || 0) === 0 ? 'warn' : pct >= 5 ? 'ok' : 'warn',
  });

  // 5. stale sessions (ended_at null > 12h)
  const stale = conn.prepare("SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL AND started_at < datetime('now','-12 hours')").get().n;
  checks.push({
    name: 'stale_sessions',
    value: String(stale),
    detail: `${stale} sessions still open beyond 12h`,
    status: stale === 0 ? 'ok' : stale <= 3 ? 'warn' : 'fail',
  });

  // 6. config-path existence (parity with `vaultflow doctor`). A config copied
  // from another machine leaves every vault path dangling while all DB-only
  // checks stay green — this ran silently broken for weeks once. Half-or-more
  // missing is that migration signature.
  try {
    const cfg = fs.existsSync(CONFIG_PATH) ? yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {} : {};
    const missing = [];
    let checked = 0;
    for (const [key, value] of Object.entries(cfg.paths || {})) {
      if (typeof value !== 'string' || !value.trim()) continue;
      if (key.startsWith('exclude')) continue; // exclusion prefixes may reference retired drives
      const wild = value.search(/[*?]/);
      const probe = wild === -1 ? value : path.dirname(value.slice(0, wild) + '_');
      checked++;
      if (!fs.existsSync(probe)) missing.push(key);
    }
    checks.push({
      name: 'config_paths',
      value: missing.length === 0 ? `${checked} paths exist` : `${missing.length}/${checked} missing`,
      detail: missing.length === 0
        ? 'every paths.* config entry points at a real location'
        : `dead config paths: ${missing.join(', ')}`,
      status: missing.length === 0 ? 'ok' : missing.length * 2 >= checked ? 'fail' : 'warn',
    });
  } catch (err) {
    checks.push({ name: 'config_paths', value: 'err', detail: err.message, status: 'warn' });
  }

  return checks;
}

/**
 * computeHealthTally(conn) — convenience wrapper for /api/overview.
 * Returns {ok, warn, fail} counts derived from computeHealthChecks.
 */
function computeHealthTally(conn) {
  const checks = computeHealthChecks(conn);
  return checks.reduce(
    (t, c) => { t[c.status] = (t[c.status] || 0) + 1; return t; },
    { ok: 0, warn: 0, fail: 0 },
  );
}

app.get('/api/health', (_req, res) => {
  try {
    const checks = [];
    withRawDb(conn => {
      checks.push(...computeHealthChecks(conn));
    });

    // nightly heartbeat freshness (disk-based, not DB)
    try {
      const hbPath = path.join(METRICS, 'nightly-heartbeat.json');
      if (fs.existsSync(hbPath)) {
        const hb = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
        const ageH = (Date.now() - new Date(hb.last_run_at).getTime()) / 3_600_000;
        checks.push({
          name: 'nightly_maintenance',
          value: hb.last_run_at,
          detail: `${ageH.toFixed(1)}h since last nightly run`,
          status: ageH < 30 ? 'ok' : ageH < 72 ? 'warn' : 'fail',
        });
      } else {
        checks.push({
          name: 'nightly_maintenance',
          value: 'never',
          detail: 'nightly.mjs has never run — install the scheduled task',
          status: 'fail',
        });
      }
    } catch (e) {
      checks.push({ name: 'nightly_maintenance', value: 'error', detail: e.message, status: 'fail' });
    }

    const overall = checks.some(c => c.status === 'fail') ? 'fail'
                  : checks.some(c => c.status === 'warn') ? 'warn'
                  : 'ok';
    res.json({ overall, checks, generated_at: new Date().toISOString() });
  } catch (err) { apiErr(res, err); }
});

// ── code graph ────────────────────────────────────────────────────────────

app.get('/api/code-graph/stats', (req, res) => {
  try {
    const project = req.query.project || null;
    const codeGraph = require('../code-graph.cjs');
    res.json(codeGraph.getGraphStats(db, project));
  } catch (err) { apiErr(res, err); }
});

app.get('/api/code-graph/symbols', (req, res) => {
  try {
    const codeGraph = require('../code-graph.cjs');
    if (req.query.file) {
      return res.json({ symbols: codeGraph.getSymbols(db, req.query.file) });
    }
    if (req.query.q) {
      return res.json({ symbols: codeGraph.searchSymbols(db, req.query.q, Number(req.query.limit) || 50) });
    }
    res.json({ symbols: [] });
  } catch (err) { apiErr(res, err); }
});

app.get('/api/code-graph/blast-radius', (req, res) => {
  try {
    if (!req.query.file) return res.status(400).json({ error: 'file required' });
    const codeGraph = require('../code-graph.cjs');
    const dependents = codeGraph.getBlastRadius(db, req.query.file, req.query.project || null);
    res.json({ file: req.query.file, dependents });
  } catch (err) { apiErr(res, err); }
});

// Most-imported files = "hubs" with highest blast-radius. Editing these
// without checking dependents is the most likely way to break things.
// Excludes framework BCL imports (System.*, React, etc.) which are noise.
app.get('/api/code-graph/hubs', (req, res) => {
  try {
    const limit = Number(req.query.limit) || 25;
    const project = req.query.project || null;
    const whereParts = [
      "ci.target NOT LIKE 'System%'",
      "ci.target NOT LIKE 'Microsoft.%'",
      "ci.target NOT LIKE 'java.%'",
      "ci.target NOT LIKE 'javax.%'",
      "ci.target NOT IN ('react','react-dom','vue','express','lodash','axios','os','fs','path','crypto','util','events','stream','http','https','child_process','url','node:fs','node:path','node:os','node:crypto','node:url','node:child_process','node:module','node:sqlite','node:events','node:stream','node:http','node:https')",
    ];
    if (project) whereParts.push('ci.project = ?');
    const where = 'WHERE ' + whereParts.join(' AND ');
    const args  = project ? [project, limit] : [limit];
    const rows = withRawDb(conn => conn.prepare(`
      SELECT ci.target AS target,
             COUNT(*)  AS dependents,
             COUNT(DISTINCT ci.file) AS distinct_files
        FROM code_imports ci
        ${where}
       GROUP BY ci.target
       ORDER BY dependents DESC
       LIMIT ?
    `).all(...args));
    res.json({ rows });
  } catch (err) { apiErr(res, err); }
});

// Measure code-graph adoption: per session, count Explore tool calls
// (Read/Glob/Grep) vs MCP code-graph tool calls. Lower exploration with
// higher MCP adoption = the integration is working.
app.get('/api/code-graph/savings', (req, res) => {
  try {
    const days = Number(req.query.days) || 14;
    const rows = withRawDb(conn => conn.prepare(`
      SELECT tc.session_id,
             s.project,
             s.started_at,
             SUM(CASE WHEN tc.tool_name IN ('Read','Glob','Grep') THEN 1 ELSE 0 END) AS explore_calls,
             SUM(CASE WHEN tc.tool_name LIKE 'mcp__vaultflow__blast_radius' OR
                           tc.tool_name LIKE 'mcp__vaultflow__find_symbol'  OR
                           tc.tool_name LIKE 'mcp__vaultflow__file_symbols' OR
                           tc.tool_name LIKE 'mcp__%blast_radius%'          OR
                           tc.tool_name LIKE 'mcp__%find_symbol%'           OR
                           tc.tool_name LIKE 'mcp__%file_symbols%'
                       THEN 1 ELSE 0 END) AS mcp_graph_calls,
             COUNT(*) AS total_calls
        FROM tool_calls tc
        LEFT JOIN sessions s ON s.id = tc.session_id
       WHERE tc.timestamp > date('now','-' || ? || ' days')
       GROUP BY tc.session_id
       HAVING explore_calls + mcp_graph_calls > 0
       ORDER BY s.started_at DESC
       LIMIT 100
    `).all(days));

    const totals = rows.reduce((a, r) => ({
      explore: a.explore + r.explore_calls,
      graph:   a.graph   + r.mcp_graph_calls,
      sessions: a.sessions + 1,
    }), { explore: 0, graph: 0, sessions: 0 });

    const adoptionPct = (totals.explore + totals.graph) > 0
      ? Math.round(100 * totals.graph / (totals.explore + totals.graph))
      : 0;

    res.json({ days, totals, adoption_pct: adoptionPct, sessions: rows });
  } catch (err) { apiErr(res, err); }
});

app.get('/api/code-graph/callers', (req, res) => {
  try {
    if (!req.query.name) return res.status(400).json({ error: 'name required' });
    const codeGraph = require('../code-graph.cjs');
    const rows = codeGraph.getCallers(db, req.query.name, req.query.project || null);
    res.json({ name: req.query.name, callers: rows });
  } catch (err) { apiErr(res, err); }
});

app.get('/api/memory/stale', (req, res) => {
  try {
    const limit = Number(req.query.limit) || 100;
    res.json({ rows: db.getStaleMemory(limit) });
  } catch (err) { apiErr(res, err); }
});

app.get('/api/vault-tools/stale', (req, res) => {
  try {
    const limit = Number(req.query.limit) || 100;
    res.json({ rows: db.getStaleVaultTools(limit) });
  } catch (err) { apiErr(res, err); }
});

// Git context for the current cwd (or ?cwd= override). Returns the same shape
// session-start injects: branch, head, ahead/behind, dirty list, recent commits, open PRs.
// Walk a session's events as a single chronological timeline. Merges
// edit_events + tool_calls + prompts so you can reconstruct "what happened".
app.get('/api/sessions/:id/timeline', (req, res) => {
  try {
    const sid = req.params.id;
    const rows = withRawDb(conn => {
      const edits = conn.prepare(`
        SELECT timestamp AS ts, 'edit' AS kind, file_path AS detail, change_type AS sub
          FROM edit_events WHERE session_id = ?
      `).all(sid);
      const tools = conn.prepare(`
        SELECT timestamp AS ts, 'tool' AS kind, tool_name AS detail, substr(input, 1, 200) AS sub
          FROM tool_calls WHERE session_id = ?
      `).all(sid);
      const prompts = conn.prepare(`
        SELECT timestamp AS ts, 'prompt' AS kind, substr(prompt_text, 1, 200) AS detail, source AS sub
          FROM prompts WHERE session_id = ?
      `).all(sid);
      return [...edits, ...tools, ...prompts].sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    });

    const session = withRawDb(conn =>
      conn.prepare('SELECT id, project, started_at, ended_at, duration_ms FROM sessions WHERE id = ?').get(sid)
    );
    res.json({ session, count: rows.length, events: rows });
  } catch (err) { apiErr(res, err); }
});

app.get('/api/commits', (req, res) => {
  try {
    if (!req.query.q) return res.status(400).json({ error: 'q required' });
    const ci = require('../commit-indexer.cjs');
    const rows = ci.searchCommits(db, req.query.q, Number(req.query.limit) || 20);
    res.json({ query: req.query.q, rows });
  } catch (err) { apiErr(res, err); }
});

app.get('/api/search', (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 5), 20);
    if (!q) return res.status(400).json({ error: 'q required' });
    const out = { query: q };
    try { out.memory = db.searchMemory(q, limit); } catch (_) { out.memory = []; }
    try { const cg = require('../code-graph.cjs'); out.symbols = cg.searchSymbols(db, q, limit); } catch (_) { out.symbols = []; }
    try { const ci = require('../commit-indexer.cjs'); out.commits = ci.searchCommits(db, q, limit); } catch (_) { out.commits = []; }
    try { out.dictionary = (db.searchDictionary ? db.searchDictionary(q, limit) : []).filter(d => d.category !== 'pattern'); } catch (_) { out.dictionary = []; }
    try { out.vault_tools = db.searchVaultTools ? db.searchVaultTools(q, limit) : []; } catch (_) { out.vault_tools = []; }
    res.json(out);
  } catch (err) { apiErr(res, err); }
});

app.get('/api/embeddings/stats', async (_req, res) => {
  try {
    const m = await import('../embeddings.mjs');
    res.json(await m.stats());
  } catch (err) { apiErr(res, err); }
});

app.post('/api/embeddings/backfill', async (_req, res) => {
  try {
    const m = await import('../embeddings.mjs');
    res.json(await m.backfillEmbeddings());
  } catch (err) { apiErr(res, err); }
});

app.get('/api/semantic-search', async (req, res) => {
  try {
    if (!req.query.q) return res.status(400).json({ error: 'q required' });
    const m = await import('../embeddings.mjs');
    const rows = await m.semanticSearch(req.query.q, Number(req.query.limit) || 5);
    res.json({ query: req.query.q, rows });
  } catch (err) { apiErr(res, err); }
});

app.get('/api/git-context', (req, res) => {
  try {
    const gitCtx = require('../git-context.cjs');
    const cwd = req.query.cwd || process.cwd();
    res.json(gitCtx.getContext(cwd) || { not_a_repo: true, cwd });
  } catch (err) { apiErr(res, err); }
});

app.get('/api/code-graph/top-files', (req, res) => {
  try {
    const limit = Number(req.query.limit) || 20;
    const rows = withRawDb(conn => conn.prepare(`
      SELECT file, project, lang, COUNT(*) AS symbols
        FROM code_symbols
       GROUP BY file
       ORDER BY symbols DESC
       LIMIT ?
    `).all(limit));
    res.json({ rows });
  } catch (err) { apiErr(res, err); }
});

// ── projects list ─────────────────────────────────────────────────────────

// GET /api/projects → {projects:[{project,files,symbols}], mostActive}
// WHY: The frontend code-graph views need a project picker. Rather than
// assembling this on the client from /api/code-graph/stats, we expose a
// dedicated endpoint so the view can populate a <select> without knowing the
// DB schema. mostActive is the project with the most sessions in the last 30
// days (falls back to the top-symbols project when sessions data is sparse).
app.get('/api/projects', (req, res) => {
  try {
    const projects = withRawDb(conn => conn.prepare(`
      SELECT   project,
               COUNT(DISTINCT file) AS files,
               COUNT(*)             AS symbols
        FROM   code_symbols
       WHERE   project IS NOT NULL AND project != ''
       GROUP   BY project
       ORDER   BY files DESC
    `).all());

    // Determine mostActive: the project with the highest session count in the
    // last 30 days. Falls back to the top-symbols project (index 0) when no
    // sessions exist.
    const sessionRow = withRawDb(conn => {
      try {
        return conn.prepare(`
          SELECT   COALESCE(NULLIF(project,''),'(unknown)') AS project,
                   COUNT(*) AS n
            FROM   sessions
           WHERE   started_at >= datetime('now','-30 days')
             AND   project IS NOT NULL AND project != ''
           GROUP   BY project
           ORDER   BY n DESC
           LIMIT   1
        `).get();
      } catch (_) { return null; }
    });

    const mostActive = (sessionRow && sessionRow.project)
      || (projects.length > 0 ? projects[0].project : null);

    res.json({ projects, mostActive });
  } catch (err) { apiErr(res, err); }
});

// ── code-graph extended endpoints ─────────────────────────────────────────

// GET /api/code-graph/import-graph?project=
// Returns the internal import graph for a project: nodes (files + symbol
// counts) and edges (file-to-file import relationships). Edges are resolved
// by basename/suffix heuristic — external packages are dropped.
app.get('/api/code-graph/import-graph', (req, res) => {
  try {
    const project = req.query.project || '';
    if (!project) return res.status(400).json({ error: 'project required' });
    const codeGraph = require('../code-graph.cjs');
    res.json(codeGraph.getImportGraph(db, project));
  } catch (err) { apiErr(res, err); }
});

// GET /api/code-graph/churn?project=
// Returns per-file commit frequency using git log (primary) or edit_events
// (fallback). Never 500s — degrades to {unavailable:true,churn:[]} when
// neither source is available. repoDir is resolved as C:/GIT/<project>.
app.get('/api/code-graph/churn', async (req, res) => {
  try {
    const project = req.query.project || '';
    if (!project) return res.status(400).json({ error: 'project required' });
    if (!/^[\w.-]+$/.test(project)) return res.status(400).json({ error: 'invalid project name' });

    const churn = require('../churn.cjs');
    // Conventional repo location. Missing dirs are handled inside getChurn
    // (existence check before spawnSync) so no 500 on unknown projects.
    const repoDir = `C:/GIT/${project}`;
    const result  = await churn.getChurn(project, repoDir, db, METRICS, PARQUET_DIR);
    res.json(result);
  } catch (err) {
    // Defense-in-depth: getChurn already swallows errors, but if somehow it
    // throws, degrade gracefully rather than returning a 500.
    res.json({ source: 'edits', unavailable: true, maxCommits: 0, churn: [] });
  }
});

// GET /api/code-graph/treemap?project=
// Returns per-file LOC + churn data for a treemap visualization. Merges
// code_symbols.line_count with churn.getChurn() for a heat-map signal.
app.get('/api/code-graph/treemap', async (req, res) => {
  try {
    const project = req.query.project || '';
    if (!project) return res.status(400).json({ error: 'project required' });
    if (!/^[\w.-]+$/.test(project)) return res.status(400).json({ error: 'invalid project name' });

    const codeGraph = require('../code-graph.cjs');
    const churn     = require('../churn.cjs');
    const repoDir   = `C:/GIT/${project}`;
    const churnData = await churn.getChurn(project, repoDir, db, METRICS, PARQUET_DIR);
    res.json(codeGraph.getTreemapData(db, project, churnData));
  } catch (err) { apiErr(res, err); }
});

// GET /api/projects/health-score?project=
// Returns a deterministic code-health score (A–F) for a project.
// Inputs: code_symbols, code_imports, code_calls (populated by code-graph.cjs).
// On compute failure, catches the error and returns a controlled 500 with an {error} body (never an unhandled crash); the dashboard api() helper surfaces it as a friendly message.
app.get('/api/projects/health-score', (req, res) => {
  try {
    const project = req.query.project || '';
    if (!project) return res.status(400).json({ error: 'project required' });
    // Reject path-traversal / injection attempts — same guard as churn + treemap.
    if (!/^[\w.-]+$/.test(project)) return res.status(400).json({ error: 'invalid project name' });

    const healthScore = require('../health-score.cjs');
    const result = healthScore.computeHealthScore(db, project);
    res.json(result);
  } catch (err) {
    // Degrade gracefully: bad data (e.g. project not in DB) should not 500.
    // Return the error in the payload so the FE can show a friendly message.
    console.error('[dashboard] health-score error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── project focus ─────────────────────────────────────────────────────────

app.get('/api/focus', (req, res) => {
  try {
    const project = req.query.project;
    if (!project) return res.status(400).json({ error: 'project required' });
    const focus = require('../focus.cjs');
    const data = focus.load(project);
    res.json(data || { project, body: null });
  } catch (err) { apiErr(res, err); }
});

app.post('/api/focus', (req, res) => {
  try {
    const { project, body } = req.body || {};
    if (!project || typeof body !== 'string') {
      return res.status(400).json({ error: 'project + body required' });
    }
    const focus = require('../focus.cjs');
    const fp = focus.save(project, body);
    res.json({ ok: true, path: fp });
  } catch (err) { apiErr(res, err); }
});

// ── memory backlinks ──────────────────────────────────────────────────────

app.get('/api/backlinks', (req, res) => {
  try {
    if (req.query.to) {
      return res.json({ rows: db.searchMemoryBacklinks(req.query.to, Number(req.query.limit) || 50) });
    }
    res.json({ rows: db.getMemoryLinkGraph(Number(req.query.limit) || 500) });
  } catch (err) { apiErr(res, err); }
});

// ── GET /api/brain/graph ────────────────────────────────────────────────

app.get('/api/brain/graph', (req, res) => {
  try {
    const center = req.query.center || null;
    const depth  = Number(req.query.depth) || 1;
    const limit  = Number(req.query.limit) || 150;
    const types  = req.query.types ? String(req.query.types).split(',').filter(Boolean) : null;
    res.json(db.getBrainGraph({ center, depth, types, limit }));
  } catch (err) { apiErr(res, err); }
});

// ── GET /api/brain/note?id=<type:key> ─────────────────────────────────────
// One node's readable note (body + meta + tags + backlinks/outlinks) for the
// Obsidian-style reader pane.
app.get('/api/brain/note', (req, res) => {
  try { res.json(db.getBrainNote(String(req.query.id || ''))); } catch (err) { apiErr(res, err); }
});

// ── GET /api/brain/mission ───────────────────────────────────────────────
app.get('/api/brain/mission', (_req, res) => {
  try { res.json(db.getMissionControl()); } catch (err) { apiErr(res, err); }
});

// ── GET /api/brain/events (Server-Sent Events) ────────────────────────────
app.get('/api/brain/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write(': connected\n\n');

  let wm = {};
  let alive = true;
  const tick = () => {
    if (!alive) return;
    try {
      ensureDb();
      const { events, watermarks } = db.getEventsSince(wm);
      wm = watermarks;
      for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
    } catch (_) { /* DB locked — skip a beat, never error the stream */ }
  };
  // first call fast-forwards watermarks without replaying history
  try { ensureDb(); wm = db.getEventsSince({}).watermarks; } catch (_) {}
  const poll = setInterval(tick, 1500);
  const keepAlive = setInterval(() => { if (alive) res.write(': ping\n\n'); }, 15000);

  req.on('close', () => { alive = false; clearInterval(poll); clearInterval(keepAlive); });
});

// ── GET /api/brain/snapshots?metric=&scope=&days= ─────────────────────────

app.get('/api/brain/snapshots', (req, res) => {
  try {
    res.json(db.getBrainSnapshots({ metric: req.query.metric || null, scope: req.query.scope || '', days: Number(req.query.days) || 30 }));
  } catch (err) { apiErr(res, err); }
});

// ── flows: catalog (read) + annotation (the dashboard's first write path) ──
// Flows are APPROXIMATE (bare-name call graph). Reads use db.listFlows/getFlow
// over the module-level read-write handle opened by ensureDb() in the /api
// middleware — getFlow returns the PRE-STORED graph (no on-demand re-walk).

// GET /api/flows[?project=] — list cataloged flows (header + node_count).
app.get('/api/flows', (req, res) => {
  try {
    res.json({ flows: db.listFlows(req.query.project || null), approximate: true });
  } catch (err) { apiErr(res, err); }
});

// GET /api/flows/declared[?project=] — list user-declared entry points (recall
// floor). MUST be registered before GET /api/flows/:id or ":id" captures
// "declared".
app.get('/api/flows/declared', (req, res) => {
  try {
    res.json({ declared: db.listDeclaredEntries(req.query.project || null) });
  } catch (err) { apiErr(res, err); }
});

// POST /api/flows/declare — declare an entry point auto-detection misses (HTTP
// routes in monolithic files, C# attribute routes), then trace it. Body:
// { file, symbol, name?, project? }. Registers the declaration (the RECALL
// FLOOR, re-traced every nightly run) and stores the traced flow with
// source='declared' (prune-exempt). Uses the read-write handle (ensureDb()/
// db.raw()), like POST /api/flows/:id. MUST be registered before POST
// /api/flows/:id or ":id" captures "declare".
app.post('/api/flows/declare', (req, res) => {
  try {
    const body = req.body || {};
    const file = body.file;
    const symbol = body.symbol;
    if (typeof file !== 'string' || !file.trim()) {
      return res.status(400).json({ error: 'file is required (string)' });
    }
    if (typeof symbol !== 'string' || !symbol.trim()) {
      return res.status(400).json({ error: 'symbol is required (string)' });
    }
    if (body.name !== undefined && body.name !== null && typeof body.name !== 'string') {
      return res.status(400).json({ error: 'name must be a string or null' });
    }
    if (body.project !== undefined && body.project !== null && typeof body.project !== 'string') {
      return res.status(400).json({ error: 'project must be a string or null' });
    }
    const project = (body.project && body.project.trim()) || path.basename(process.cwd());
    const fc = require('../flow-catalog.cjs');

    const reg = db.addDeclaredEntry({
      project, file: file.trim(), symbol: symbol.trim(),
      name: (body.name && body.name.trim()) || null,
    });
    // discoverFlows auto-loads declared entries from the DB and traces them.
    fc.discoverFlows(db, project, {});
    const flowId = fc.flowIdFor(project, { file: file.trim(), name: symbol.trim() });
    const full = db.getFlow(flowId);
    res.json({ ok: true, declared: reg, flow: full ? full.flow : null, approximate: true });
  } catch (err) { apiErr(res, err); }
});

// GET /api/flows/:id — one flow's header + stored nodes + edges. 404 if absent.
app.get('/api/flows/:id', (req, res) => {
  try {
    const full = db.getFlow(req.params.id);
    if (!full) return res.status(404).json({ error: 'flow not found' });
    res.json({ ...full, approximate: true });
  } catch (err) { apiErr(res, err); }
});

// GET /api/flows/:id/impact — convenience: change-impact for the flow's entry
// point (so the UI can show "what touching this flow's entry reaches").
app.get('/api/flows/:id/impact', (req, res) => {
  try {
    const full = db.getFlow(req.params.id);
    if (!full) return res.status(404).json({ error: 'flow not found' });
    const fi = require('../flow-impact.cjs');
    // entry_point is stored as "file::symbol"; split on the LAST '::' so paths
    // containing '::' (none on Windows, but be safe) don't mis-split.
    const ep = String(full.flow.entry_point || '');
    const idx = ep.lastIndexOf('::');
    const file = idx >= 0 ? ep.slice(0, idx) : (ep || null);
    const symbol = idx >= 0 ? ep.slice(idx + 2) : null;
    res.json(fi.analyzeImpact(db, { file, symbol, project: full.flow.project || null }));
  } catch (err) { apiErr(res, err); }
});

// GET /api/flows/:id/excalidraw — on-the-fly Excalidraw doc for the Flows preview.
// Converts the stored flow graph (nodes + edges from db.getFlow) into a
// deterministic Excalidraw document via flow-excalidraw.toExcalidraw — same
// output as flows:draw, but served live without touching the filesystem.
app.get('/api/flows/:id/excalidraw', (req, res) => {
  try {
    const full = db.getFlow(req.params.id);
    if (!full) return res.status(404).json({ error: 'flow not found' });
    res.json(flowExcalidraw.toExcalidraw(full));
  } catch (err) { apiErr(res, err); }
});

// POST /api/flows/:id — ANNOTATION WRITE (the dashboard's first write endpoint).
// Body: { name?, description?, user_notes?, status? }. Routes through
// db.updateFlowAnnotation (sets source='manual' + updated_at, preserving the
// auto-traced graph). Only the annotation fields are accepted — no arbitrary
// column writes. Uses the read-write handle (ensureDb()/db.raw()), NOT the
// read-only withRawDb. Localhost-only by deployment.
const FLOW_ANNOTATION_FIELDS = ['name', 'description', 'user_notes', 'status'];
const FLOW_STATUSES = new Set(['active', 'archived', 'deprecated']);

app.post('/api/flows/:id', (req, res) => {
  try {
    const body = req.body || {};
    // Reject any field outside the allowlist — no column injection.
    const unknown = Object.keys(body).filter(k => !FLOW_ANNOTATION_FIELDS.includes(k));
    if (unknown.length) {
      return res.status(400).json({ error: `unsupported field(s): ${unknown.join(', ')}` });
    }
    // Each provided field must be a string (or null to clear). status is enum-checked.
    const patch = {};
    for (const f of ['name', 'description', 'user_notes']) {
      if (body[f] === undefined) continue;
      if (body[f] !== null && typeof body[f] !== 'string') {
        return res.status(400).json({ error: `${f} must be a string or null` });
      }
      patch[f] = body[f];
    }
    if (Object.keys(patch).length === 0 && body.status === undefined) {
      return res.status(400).json({ error: 'no annotation fields supplied' });
    }

    const updated = db.updateFlowAnnotation(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'flow not found' });

    // status is not part of updateFlowAnnotation (which only handles the curated
    // text fields). Apply it separately, guarded by the enum, on the same handle.
    if (body.status !== undefined) {
      if (!FLOW_STATUSES.has(body.status)) {
        return res.status(400).json({ error: `status must be one of: ${[...FLOW_STATUSES].join(', ')}` });
      }
      db.raw().prepare("UPDATE flows SET status = ?, source = 'manual', updated_at = ? WHERE id = ?")
        .run(body.status, new Date().toISOString(), req.params.id);
    }

    const full = db.getFlow(req.params.id);
    res.json({ ok: true, flow: full ? full.flow : null });
  } catch (err) { apiErr(res, err); }
});

// ── GET /api/model/recommendations ────────────────────────────────────────

app.get('/api/model/recommendations', (_req, res) => {
  try {
    const p = path.join(METRICS, 'model-recommendations.json');
    res.json(fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {});
  } catch (err) { apiErr(res, err); }
});

// ── POST /api/model/recommendations/accept { agent } ──────────────────────

app.post('/api/model/recommendations/accept', (req, res) => {
  try {
    const agent = req.body && req.body.agent;
    if (!agent) return res.status(400).json({ error: 'agent required' });
    const p = path.join(METRICS, 'model-recommendations.json');
    const recs = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    const rec = recs[agent];
    if (!rec) return res.status(404).json({ error: 'no recommendation for agent' });
    const applied = modelRouter.applyRecommendation(agent, rec.model);
    if (applied) { delete recs[agent]; fs.writeFileSync(p, JSON.stringify(recs, null, 2)); }
    res.json({ ok: !!applied, applied });
  } catch (err) { apiErr(res, err); }
});

// ── GET /api/overview — composed Command Center payload (read-only) ──────────
//
// Aggregates data from the individual endpoints the dashboard already exposes
// so the Command Center home can render all its vitals in a single round-trip.
// Reuses:
//   • computeHealthTally(conn)    — from /api/health (DB checks only)
//   • discoveries dir scan        — from /api/discoveries (count unreviewed .md files)
//   • watcher.pid detection       — from /api/watcher/status

app.get('/api/overview', (_req, res) => {
  try {
    const out = withRawDb((c) => {
      const one = (sql) => { try { return c.prepare(sql).get(); } catch { return {}; } };

      const mem  = one("SELECT (SELECT COUNT(*) FROM memory_entries) AS total, (SELECT COUNT(*) FROM memory_embeddings me JOIN memory_entries m ON m.id=me.memory_id) AS embedded");
      const cg   = one("SELECT (SELECT COUNT(DISTINCT file) FROM code_symbols) AS files, (SELECT COUNT(*) FROM code_symbols) AS symbols, (SELECT COUNT(*) FROM code_calls) AS edges");
      const ses  = one("SELECT COUNT(*) AS total FROM sessions");
      const sum7 = one("SELECT COUNT(*) AS n FROM session_summaries WHERE summary_at > date('now','-7 days')");
      const ses7 = one("SELECT COUNT(*) AS n FROM sessions WHERE started_at > date('now','-7 days') AND ended_at IS NOT NULL");
      const ret  = one("SELECT COUNT(*) AS n FROM retrieval_docs WHERE timestamp > date('now','-7 days')");
      const eq   = one("SELECT COUNT(*) AS depth, MIN(queued_at) AS oldest FROM embed_queue");
      const staleRow = one("SELECT COUNT(*) AS n FROM memory_stale");

      const recent = (() => {
        try {
          return c.prepare(`
            SELECT s.id, s.project, s.started_at AS startedAt,
                   s.duration_ms AS durationMs,
                   (SELECT COUNT(*) FROM edit_events e WHERE e.session_id = s.id) AS edits
              FROM sessions s
             ORDER BY s.started_at DESC
             LIMIT 5
          `).all();
        } catch { return []; }
      })();

      const health = computeHealthTally(c);

      const memTotal = mem.total || 0;
      const emb      = mem.embedded || 0;
      return {
        health,
        memory:   { total: memTotal, embedded: emb, pct: memTotal ? Math.round(100 * emb / memTotal) : 0 },
        codeGraph: { files: cg.files || 0, symbols: cg.symbols || 0, edges: cg.edges || 0 },
        sessions: { total: ses.total || 0, summarizedPct: ses7.n ? Math.round(100 * (sum7.n || 0) / ses7.n) : 100 },
        retrieval7d: ret.n || 0,
        embedQueue:  { depth: eq.depth || 0, oldestHours: eq.oldest ? +((Date.now() - new Date(eq.oldest).getTime()) / 3.6e6).toFixed(1) : null },
        staleMemory: staleRow.n || 0,
        recentSessions: recent,
      };
    });

    // ── disk-based fields (mirror /api/health + /api/watcher/status logic) ─

    // DB file size — use METRICS (module-level config); safe-fallback if absent
    const dbPath = path.join(METRICS, DB_FILE);
    try {
      out.db = { sizeMb: +(fs.statSync(dbPath).size / 1_048_576).toFixed(2), integrity: 'ok' };
    } catch { out.db = { sizeMb: 0, integrity: 'ok' }; }

    // Nightly heartbeat age
    try {
      const hb = JSON.parse(fs.readFileSync(path.join(METRICS, 'nightly-heartbeat.json'), 'utf8'));
      out.nightly = { ageHours: +((Date.now() - new Date(hb.last_run_at).getTime()) / 3.6e6).toFixed(1) };
    } catch { out.nightly = { ageHours: null }; }

    // Discoveries unreviewed — reuse /api/discoveries dir scan
    try {
      const cfg2    = loadConfig();
      const discDir = path.join(
        (cfg2.paths && cfg2.paths.metrics_root) || METRICS,
        (cfg2.storage && cfg2.storage.discoveries_dir) || 'discoveries',
      );
      if (fs.existsSync(discDir)) {
        const unreviewed = fs.readdirSync(discDir)
          .filter(f => f.endsWith('.md'))
          .reduce((n, f) => {
            try {
              const content = fs.readFileSync(path.join(discDir, f), 'utf8');
              const lines   = content.split('\n');
              if (lines[0] !== '---') return n + 1;
              const end = lines.indexOf('---', 1);
              if (end === -1) return n + 1;
              const meta = yaml.load(lines.slice(1, end).join('\n')) || {};
              return meta.promoted ? n : n + 1;
            } catch { return n + 1; }
          }, 0);
        out.discoveriesUnreviewed = unreviewed;
      } else {
        out.discoveriesUnreviewed = 0;
      }
    } catch { out.discoveriesUnreviewed = 0; }

    // Watcher running — reuse /api/watcher/status logic
    try {
      const pidFile = path.join(METRICS, 'watcher.pid');
      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        let running = false;
        if (pid) { try { process.kill(pid, 0); running = true; } catch { running = false; } }
        out.watcher = { running };
      } else {
        out.watcher = { running: false };
      }
    } catch { out.watcher = { running: false }; }

    res.json(out);
  } catch (err) { apiErr(res, err); }
});

// ── root → dashboard ──────────────────────────────────────────────────────

// Synapse v2 is the default UI. The legacy v1 SPA stays reachable at /v1;
// /v2 is kept so existing bookmarks and the desktop launcher keep working.
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index-v2.html'));
});

app.get('/v1', (_req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

app.get('/v2', (_req, res) => { res.sendFile(path.join(__dirname, 'index-v2.html')); });

// ── start ─────────────────────────────────────────────────────────────────

// Boot the server on a (possibly ephemeral) port and return the http.Server so
// tests can listen on port 0 and close it. Importing this module no longer
// auto-listens — only a direct `node server.mjs` invocation does (below).
export function startServer(opts = {}) {
  if (opts.metricsRoot) {
    // Test override: re-point BOTH the shared db singleton and the module-level
    // metrics path. Re-pointing only the singleton left every raw disk read
    // (rawDb, heartbeat, watcher pid, parquet) aimed at the configured root, so
    // fixtures silently read the developer's real metrics dir — or, with no
    // local config, a nonexistent "C:/Users/YOU/…" path that 500s.
    METRICS = opts.metricsRoot;
    db.close?.();
    db.initialize(opts.metricsRoot, DB_FILE);
  }
  // When a caller passes an explicit port (e.g. tests using port 0), bind
  // without the configured HOST. Binding to a hostname like 'localhost'
  // triggers an async DNS lookup, leaving server.address() null until the
  // 'listening' event — which breaks callers that read the ephemeral port
  // synchronously. Omitting the host binds all interfaces synchronously
  // (reachable via 127.0.0.1). Direct runs keep the configured HOST.
  if (opts.port != null) return app.listen(opts.port);
  return app.listen(PORT, HOST);
}

// Auto-start only when run directly (node server.mjs), not when imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const srv = startServer();
  srv.on('listening', () => {
    const url = `http://${HOST}:${PORT}`;
    console.log(`[vaultflow dashboard] ${url}`);
    console.log(`[vaultflow dashboard] DB: ${path.join(METRICS, DB_FILE)}`);
    // `--open` launches the default browser once the server is listening.
    // Replaces the old static generator's open behavior now that this is the
    // single dashboard.
    if (process.argv.includes('--open')) {
      const { execSync } = require('node:child_process');
      const cmd = process.platform === 'win32' ? `start "" "${url}"`
                : process.platform === 'darwin' ? `open "${url}"`
                : `xdg-open "${url}"`;
      try { execSync(cmd, { stdio: 'ignore' }); } catch (_) {}
    }
  });
}

export default app;
