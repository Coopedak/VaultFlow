'use strict';

// ── debug logging ─────────────────────────────────────────────────────────
// Captures errors that escape the main try/catch (module load failures,
// unhandled rejections) to a log file so the full error is visible.
const _fs   = require('fs');
const _path = require('path');
const DEBUG_LOG = _path.join(__dirname, '..', '..', '.debug-hook.log');

function _debugLog(label, err) {
  const line = `${new Date().toISOString()} [${label}] ${err && err.stack ? err.stack : err}\n`;
  try { _fs.appendFileSync(DEBUG_LOG, line); } catch (_) {}
  process.stderr.write(`[vaultflow] ${label}: ${err && err.message ? err.message : err}\n`);
}

process.on('uncaughtException', (err) => {
  _debugLog('uncaughtException', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  _debugLog('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  process.exit(1);
});

// ── review flag helpers ───────────────────────────────────────────────────
// When a sub-agent completes, a pending-review.json flag is written to
// METRICS. The route hook reads it and injects a blocking notice into every
// UserPromptSubmit until the PM calls clear-review (after voice-of-reason
// returns its verdict). Voice-of-reason is excluded from triggering a new
// flag (detected by presence of 'voice-of-reason' in the payload description).

function getMetricsRoot() {
  try {
    const yaml    = require('js-yaml');
    const cfgPath = require('../../config/resolve.cjs');
    const cfg     = yaml.load(_fs.readFileSync(cfgPath, 'utf8'));
    return (cfg.paths && cfg.paths.metrics_root) || '';
  } catch (_) { return ''; }
}

function reviewFlagPath() {
  return _path.join(getMetricsRoot(), 'pending-review.json');
}

function writeReviewFlag(agentInfo) {
  const p = reviewFlagPath();
  if (!p || !getMetricsRoot()) return;
  try {
    _fs.writeFileSync(p, JSON.stringify({
      flagged_at:  new Date().toISOString(),
      agent:       agentInfo || 'unknown',
      cleared:     false,
    }, null, 2), 'utf8');
  } catch (_) {}
}

function clearReviewFlag() {
  try { _fs.unlinkSync(reviewFlagPath()); } catch (_) {}
}

function readReviewFlag() {
  try {
    const p = reviewFlagPath();
    if (!_fs.existsSync(p)) return null;
    return JSON.parse(_fs.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}

// ── input sanitization ───────────────────────────────────────────────────
function sanitizeString(val, maxLen) {
  return String(val == null ? '' : val).trim().slice(0, maxLen);
}

function sanitizeFilePath(val) {
  const s = sanitizeString(val, 2000);
  if (/(\.\.[/\\])|(^\.\.)/.test(s)) return null;
  return s || null;
}

function sanitizeSessionId(val) {
  return sanitizeString(val, 100).replace(/[^a-zA-Z0-9_\-]/g, '');
}

function sanitizeToolName(val) {
  return sanitizeString(val, 100);
}

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\/(?:\s|$)/,
  /rm\s+-rf\s+\/\*/,
  /format\s+c:/i,
  /del\s+\/s\s+\/q\s+c:\\/i,
];

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

async function dispatch(event) {
  switch (event) {
    case 'pre-bash': {
      const raw = await readStdin();
      let input = {};
      try { input = JSON.parse(raw); } catch (_) {}
      const cmd = sanitizeString((input.tool_input && input.tool_input.command) || '', 1000);

      // Safety check — block destructive patterns
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(cmd)) {
          process.stdout.write(JSON.stringify({
            decision: 'block',
            reason: 'Dangerous command blocked by vaultflow',
          }));
          return;
        }
      }

      // Record as tool call for deduplication telemetry
      try {
        const db      = require('./db.cjs');
        const session = require('./session.cjs');
        db.initialize(null, null);
        const sess = session.get();
        if (sess) {
          db.recordToolCall(sess.id, 'Bash', JSON.stringify({ command: cmd }));
        }
      } catch (_) {}

      break;
    }

    case 'route': {
      const raw = await readStdin();
      let input = {};
      try { input = JSON.parse(raw); } catch (_) {}
      const prompt = sanitizeString(input.prompt || (input.tool_input && input.tool_input.prompt) || '', 8000);

      const router      = require('./router.cjs');
      const intelligence = require('./intelligence.cjs');
      const routing     = router.routeTask(prompt);
      const context     = intelligence.getContext(prompt);
      const entries     = Array.isArray(context) ? context.slice(0, 5) : [];

      // ── record prompt in DB ─────────────────────────────────────────────
      let sessionId  = null;
      try {
        const db      = require('./db.cjs');
        const session = require('./session.cjs');
        db.initialize(null, null);
        const sess = session.get();
        if (sess) {
          sessionId = sess.id;
          db.recordPrompt(sessionId, prompt, routing.skill);
        }

        // ── vault tool usage tracking ───────────────────────────────────
        // FTS search the prompt against registered vault tools. Any match
        // (above a BM25 rank threshold) increments that tool's use_count
        // so the auto-promotion pipeline can surface frequently-needed tools.
        try {
          const matches = db.searchVaultTools(prompt, 3);
          for (const t of matches) {
            // bm25() returns negative values; closer to 0 = better match
            if (t.rank < -0.5) {
              db.incrementVaultToolUse(t.tool_id);
              process.stderr.write(`[vaultflow] route: tool match "${t.name}" (rank ${t.rank.toFixed(2)})\n`);
            }
          }
        } catch (_) {}
      } catch (_) {}

      // ── skill auto-injection ────────────────────────────────────────────
      // Injects skill instructions into the system context via additionalContext.
      // Only fires if confidence >= threshold and the skill wasn't recently injected.
      let additionalContext = null;
      try {
        const { buildInjection } = await import('./skill-loader.mjs');
        const session            = require('./session.cjs');
        const { skill, at }      = session.getInjectedSkill();
        const inj = buildInjection(routing.skill, routing.confidence, skill, at);
        if (inj) {
          additionalContext = inj.text;  // just the skill content, NOT the full prompt
          session.setInjectedSkill(routing.skill);
          process.stderr.write(
            `[vaultflow] route: injecting ${routing.skill} (${inj.tier}, confidence ${routing.confidence})\n`
          );
        }
      } catch (err) {
        process.stderr.write(`[vaultflow] route: skill-loader error — ${err.message}\n`);
      }

      process.stderr.write(
        `[vaultflow] route: skill=${routing.skill} conf=${routing.confidence} ` +
        `entries=${entries.length}\n`
      );

      // ── review gate injection ───────────────────────────────────────────
      // If a sub-agent completed without voice-of-reason review, prepend a
      // blocking notice to every prompt until the PM clears the flag.
      // Flags older than 2 hours are auto-expired to avoid blocking forever.
      const pendingReview = readReviewFlag();
      if (pendingReview) {
        const ageMs = pendingReview.flagged_at
          ? Date.now() - new Date(pendingReview.flagged_at).getTime()
          : 0;
        if (ageMs > 2 * 3600 * 1000) {
          clearReviewFlag(); // stale — auto-expire, don't block
        } else {
          const reviewNotice =
            `\n\n⚠️ PIPELINE GATE — VOICE OF REASON REQUIRED\n` +
            `A sub-agent ("${pendingReview.agent}") completed at ${pendingReview.flagged_at} ` +
            `without a voice-of-reason review.\n` +
            `You MUST dispatch the voice-of-reason agent before responding or continuing the pipeline.\n` +
            `After voice-of-reason returns its verdict, run:\n` +
            `  node C:/GIT/vaultflow/.claude/helpers/hook-handler.cjs clear-review\n`;
          additionalContext = reviewNotice + (additionalContext || '');
        }
      }

      // UserPromptSubmit hook output: {"additionalContext": "..."} at top level.
      // The hookSpecificOutput wrapper is NOT the correct format for this hook.
      if (additionalContext) {
        process.stdout.write(JSON.stringify({ additionalContext }));
      }
      break;
    }

    case 'session-start': {
      const session = require('./session.cjs');
      const sess    = await session.start();

      // ── memory import ───────────────────────────────────────────────────
      try {
        const { doImport } = await import('./auto-memory-hook.mjs');
        const result = await doImport();
        process.stderr.write(`[vaultflow] session-start: doImport complete — ${JSON.stringify(result)}\n`);
      } catch (err) {
        process.stderr.write(`[vaultflow] session-start: doImport error — ${err.message}\n`);
      }

      // ── tech stack detection ────────────────────────────────────────────
      try {
        const yaml       = require('js-yaml');
        const fs         = require('fs');
        const cfgPath    = require('../../config/resolve.cjs');
        const cfg        = fs.existsSync(cfgPath) ? yaml.load(fs.readFileSync(cfgPath, 'utf8')) : {};
        const doDetect   = cfg.intelligence && cfg.intelligence.stack_detect_on_session_start !== false;

        if (doDetect && sess && sess.cwd) {
          const { detectAndStore } = await import('./stack-detector.mjs');
          const stacks = await detectAndStore(sess.cwd, sess.project || require('path').basename(sess.cwd));
          if (stacks.length > 0) {
            process.stderr.write(`[vaultflow] session-start: stacks detected — ${stacks.join(', ')}\n`);
          }
        }

        // ── watcher daemon auto-start ─────────────────────────────────────
        // Start the file-system watcher daemon if not already running.
        // This captures edits from background agents, Copilot, Cursor, and
        // any other tool that doesn't fire Claude Code hooks directly.
        try {
          const watchDir = (cfg.paths && cfg.paths.watcher_watch_dir)
            || (() => {
                 // Derive from wiki_glob: C:/GIT/*/wiki/... → C:/GIT
                 const g = cfg.paths && cfg.paths.wiki_glob;
                 if (g) return g.replace(/\\/g, '/').split('/').slice(0, -3).join('/');
                 return null;
               })();

          if (watchDir && fs.existsSync(watchDir)) {
            const { spawn } = require('child_process');
            const watcherPath = require('path').resolve(__dirname, 'watcher.mjs');
            const child = spawn(
              process.execPath,
              ['--no-warnings', watcherPath, '--daemon', watchDir],
              { detached: true, stdio: 'ignore' }
            );
            child.unref();
            process.stderr.write(`[vaultflow] session-start: watcher daemon ensured (${watchDir})\n`);
          }
        } catch (err) {
          process.stderr.write(`[vaultflow] session-start: watcher start error — ${err.message}\n`);
        }
      } catch (err) {
        process.stderr.write(`[vaultflow] session-start: stack-detector error — ${err.message}\n`);
      }

      break;
    }

    case 'session-restore': {
      const session = require('./session.cjs');
      await session.restore();
      break;
    }

    case 'clear-review': {
      const verdict   = sanitizeString(process.argv[3] || '', 50)  || 'UNSPECIFIED';
      const agentType = sanitizeString(process.argv[4] || '', 100) || 'unknown';
      const reason    = sanitizeString(process.argv[5] || '', 500);
      const flag      = readReviewFlag();
      const flaggedAt = flag ? flag.flagged_at : null;

      try {
        const db      = require('./db.cjs');
        const session = require('./session.cjs');
        db.initialize(null, null);
        const sess = session.get();
        db.recordVerdict(sess ? sess.id : null, agentType, verdict, reason, flaggedAt);
        process.stderr.write(`[vaultflow] clear-review: verdict recorded — ${verdict} (${agentType})\n`);
      } catch (err) {
        process.stderr.write(`[vaultflow] clear-review: verdict record error — ${err.message}\n`);
      }

      clearReviewFlag();
      process.stderr.write('[vaultflow] clear-review: pending review flag cleared\n');
      break;
    }

    case 'session-end': {
      const session = require('./session.cjs');
      await session.end();

      // ── vault_tools auto-promotion ──────────────────────────────────────
      // Any vault tool with use_count >= 5 that hasn't been promoted yet
      // gets promoted and a DISCOVERY.md is written to the metrics dir.
      try {
        const db   = require('./db.cjs');
        const fs   = require('fs');
        const path = require('path');
        const yaml = require('js-yaml');
        db.initialize(null, null);

        const cfgPath     = require('../../config/resolve.cjs');
        const cfg         = fs.existsSync(cfgPath) ? yaml.load(fs.readFileSync(cfgPath, 'utf8')) : {};
        const metricsRoot = cfg.paths && cfg.paths.metrics_root || '';
        const discDir     = path.join(metricsRoot, cfg.storage && cfg.storage.discoveries_dir || 'discoveries');

        const eligible = db.getUnpromotedVaultTools(5);
        for (const tool of eligible) {
          db.promoteVaultTool(tool.id);

          try { fs.mkdirSync(discDir, { recursive: true }); } catch (_) {}
          const slug    = tool.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
          const dateStr = new Date().toISOString().slice(0, 10);
          const content = [
            '---',
            `pattern: vault-tool-auto-promotion`,
            `agent: hook-handler`,
            `date: ${dateStr}`,
            `fire_count: ${tool.use_count}`,
            `promoted: true`,
            '---',
            '',
            `# Auto-Promoted Tool: ${tool.name}`,
            '',
            `Promoted after reaching use_count=${tool.use_count} (threshold: 5).`,
            '',
            tool.description ? `**Description:** ${tool.description}` : '',
          ].join('\n');
          fs.writeFileSync(path.join(discDir, `${dateStr}-auto-promoted-tool-${slug}.md`), content, 'utf8');
          process.stderr.write(`[vaultflow] session-end: auto-promoted vault_tool "${tool.name}" (use_count=${tool.use_count})\n`);
        }

      } catch (err) {
        process.stderr.write(`[vaultflow] session-end: auto-promotion error — ${err.message}\n`);
      }

      break;
    }

    case 'post-task': {
      const intelligence = require('./intelligence.cjs');
      const result = await intelligence.feedback(true);
      const promoted = (result && result.promoted) || 0;
      if (promoted > 0) {
        process.stderr.write(`[vaultflow] post-task: ${promoted} entries promoted\n`);
      }

      // ── dictionary term frequency ─────────────────────────────────────────
      // Terms appearing >= 3 times in session prompts get auto-added.
      // Runs after the model responds (Stop hook) rather than at session shutdown
      // to avoid heavy synchronous I/O during process exit.
      try {
        const db = require('./db.cjs');
        db.initialize(null, null);
        const STOP_WORDS = new Set(['this','that','with','from','have','been','will','when','then','what','into','over','also','some','they','them','than','each','more','like','just','even','most','such','only','both','very','here','where','which','your','their','there','these','those','about','after','before','between','should','could','would','other','first','second','third']);
        const termFreq   = {};
        for (const row of db.getLastSessionPrompts()) {
          const words = (row.prompt_text || '').toLowerCase().match(/\b[a-z][a-z0-9_-]{3,}\b/g) || [];
          for (const w of words) { termFreq[w] = (termFreq[w] || 0) + 1; }
        }
        const knownTerms = db.getDictionaryTermSet();
        for (const [term, count] of Object.entries(termFreq)) {
          if (count >= 3 && !knownTerms.has(term) && !STOP_WORDS.has(term) && term.length >= 5) {
            db.upsertDictionaryEntry(term, 'pattern', `Auto-detected: appeared ${count}x in session prompts. Review and update definition.`, 'session-auto');
            process.stderr.write(`[vaultflow] post-task: auto-added dictionary term "${term}" (${count}x in prompts)\n`);
          }
        }
      } catch (err) {
        process.stderr.write(`[vaultflow] post-task: dict term freq error — ${err.message}\n`);
      }

      try {
        const { doSync } = await import('./auto-memory-hook.mjs');
        const syncResult = await doSync();
        process.stderr.write(`[vaultflow] post-task: doSync complete — ${JSON.stringify(syncResult)}\n`);
      } catch (err) {
        process.stderr.write(`[vaultflow] post-task: doSync error — ${err.message}\n`);
      }
      break;
    }

    case 'compact-manual': {
      process.stderr.write(
        '[vaultflow] Pre-compact checkpoint\n' +
        'Review what\'s in context before compacting:\n' +
        '  • Run /session-reviewer to capture learnings first\n' +
        '  • Check metrics_root/discoveries/ for pending promotions\n' +
        '  • Use /compact only after session-reviewer completes\n'
      );
      // Flush telemetry so tool_calls + prompts are in Parquet before context clears
      try {
        const db  = require('./db.cjs');
        db.initialize(null, null);
        const result = await db.flushTelemetryToParquet(null, null);
        process.stderr.write(`[vaultflow] compact-manual: telemetry flushed — ${JSON.stringify(result)}\n`);
      } catch (err) {
        process.stderr.write(`[vaultflow] compact-manual: telemetry flush error — ${err.message}\n`);
      }
      break;
    }

    case 'compact-auto': {
      process.stderr.write(
        '[vaultflow] Auto-compact triggered — context window near limit\n' +
        'Session data is being preserved in SQLite. Continuing...\n'
      );
      // Flush telemetry on auto-compact too — context may be lost
      try {
        const db  = require('./db.cjs');
        db.initialize(null, null);
        await db.flushTelemetryToParquet(null, null);
      } catch (_) {}
      break;
    }

    case 'post-subagent': {
      const raw = await readStdin();
      let subagentPayload = {};
      try { subagentPayload = JSON.parse(raw); } catch (_) {}

      // Write review flag unless this was voice-of-reason itself completing
      const agentDesc = (
        (subagentPayload.tool_input && subagentPayload.tool_input.description) ||
        (subagentPayload.subagent_type) ||
        ''
      ).toLowerCase();
      if (!agentDesc.includes('voice-of-reason') && !agentDesc.includes('clear-review')) {
        const agentLabel = sanitizeString(agentDesc || 'sub-agent', 200);
        writeReviewFlag(agentLabel);
        process.stderr.write(`[vaultflow] post-subagent: review flag set for "${agentLabel}"\n`);
      } else {
        clearReviewFlag();
        process.stderr.write(`[vaultflow] post-subagent: voice-of-reason completed — review flag cleared\n`);
      }

      const intelligence = require('./intelligence.cjs');
      const result = await intelligence.feedback(true);
      const promoted = (result && result.promoted) || 0;
      if (promoted > 0) {
        process.stderr.write(`[vaultflow] post-subagent: ${promoted} entries promoted\n`);
      }

      // ── write agent-context.json ──────────────────────────────────────
      // Background agents read this file to get the vaultflow DB path,
      // session ID, and top memory context so they can use FTS5 search
      // and record their own tool calls without needing hook injection.
      try {
        const _fs      = require('fs');
        const _path    = require('path');
        const _yaml    = require('js-yaml');
        const _db      = require('./db.cjs');
        const _session = require('./session.cjs');
        const _cfgPath = require('../../config/resolve.cjs');
        const _cfg     = _fs.existsSync(_cfgPath) ? _yaml.load(_fs.readFileSync(_cfgPath, 'utf8')) : {};
        const _metrics = (_cfg.paths && _cfg.paths.metrics_root) || '';
        const _dbFile  = (_cfg.storage && _cfg.storage.db_file) || 'vaultflow.db';

        _db.initialize(null, null);
        const _sess = _session.get();

        let topMemory = [];
        try { topMemory = _db.searchMemory('agent task context project', 5); } catch (_) {}

        const agentCtx = {
          db_path:     _path.join(_metrics, _dbFile),
          session_id:  _sess ? _sess.id      : null,
          project:     _sess ? _sess.project : null,
          helpers_dir: __dirname,
          top_memory:  topMemory.map(m => ({ title: m.title, source: m.source })),
          updated_at:  new Date().toISOString(),
        };

        _fs.writeFileSync(_path.join(_metrics, 'agent-context.json'), JSON.stringify(agentCtx, null, 2), 'utf8');
        process.stderr.write(`[vaultflow] post-subagent: agent-context.json updated\n`);
      } catch (err) {
        process.stderr.write(`[vaultflow] post-subagent: agent-context error — ${err.message}\n`);
      }

      // ── model routing — record verdict and check for demotion ─────────────
      try {
        const router  = require('./model-router.cjs');
        const _yaml2  = require('js-yaml');
        const _cfgP2  = require('../../config/resolve.cjs');
        const _cfg2   = _fs.existsSync(_cfgP2) ? _yaml2.load(_fs.readFileSync(_cfgP2, 'utf8')) : {};
        const _metrics2 = (_cfg2.paths && _cfg2.paths.metrics_root) || '';

        // subagent_type is the reliable agent identifier (e.g. "reviewer-code",
        // "developer-fullstack"). It lives at tool_input.subagent_type in the
        // Claude Code SubagentStop payload.
        const agentType = sanitizeString(
          (subagentPayload.tool_input && subagentPayload.tool_input.subagent_type) ||
          subagentPayload.subagent_type || '', 100);
        const agent = agentType || sanitizeString(agentDesc || 'unknown', 100);

        // model is not in the hook payload when the Agent tool is called without
        // an explicit model override. Resolve it from devteam-config agent_models.
        const TIER_MAP = {
          'opus': 'claude-opus-4-7',   'Top': 'claude-opus-4-7',
          'sonnet': 'claude-sonnet-4-6', 'Mid': 'claude-sonnet-4-6',
          'haiku': 'claude-haiku-4-5-20251001', 'Low': 'claude-haiku-4-5-20251001',
        };
        let model = sanitizeString(
          (subagentPayload.tool_input && subagentPayload.tool_input.model) ||
          subagentPayload.model || '', 100);
        if (!model && agentType) {
          try {
            const _os      = require('os');
            const _dtPath  = _path.join(_os.homedir(), '.claude', 'devteam-config.json');
            const _dtCfg   = _fs.existsSync(_dtPath) ? JSON.parse(_fs.readFileSync(_dtPath, 'utf8')) : {};
            const _tier    = (_dtCfg.agent_models && _dtCfg.agent_models[agentType]) || 'sonnet';
            model = TIER_MAP[_tier] || _tier;
          } catch (_) { model = 'claude-sonnet-4-6'; }
        }
        if (!model) model = 'unknown';

        const type    = sanitizeString(
          (subagentPayload.tool_input && subagentPayload.tool_input.task_type) ||
          subagentPayload.task_type || 'general', 100);
        const approved = true; // SubagentStop fires on completion — treat as success

        router.recordVerdict(agent, model, type, approved);

        const demotion = router.checkAndDemote(agent, type);
        if (demotion && _metrics2) {
          const recPath = _path.join(_metrics2, 'model-recommendations.json');
          let recs = {};
          try { recs = JSON.parse(_fs.readFileSync(recPath, 'utf8')); } catch (_) {}
          recs[agent] = {
            model:        demotion.to,
            demoted_from: demotion.from,
            updated_at:   new Date().toISOString(),
          };
          _fs.writeFileSync(recPath, JSON.stringify(recs, null, 2), 'utf8');
          process.stderr.write(
            `[vaultflow] post-subagent: model-router wrote recommendation for "${agent}": ${demotion.from} → ${demotion.to}\n`
          );
        }
      } catch (err) {
        process.stderr.write(`[vaultflow] post-subagent: model-router error — ${err.message}\n`);
      }

      break;
    }

    case 'copilot-prompt': {
      const raw  = await readStdin();
      let payload = {};
      try { payload = JSON.parse(raw); } catch (_) {}

      const promptText = sanitizeString(payload.prompt || '', 8000);
      const subcommand = sanitizeString(payload.subcommand || '', 200);
      if (!promptText) break;

      const db      = require('./db.cjs');
      const session = require('./session.cjs');
      const router  = require('./router.cjs');

      db.initialize(null, null);
      const sess = session.restore();
      if (!sess || !sess.id) break;

      const routing  = router.routeTask(promptText);
      const skillTag = routing.skill ? `[copilot:${routing.skill}]` : '[copilot]';
      db.recordPrompt(sess.id, promptText, skillTag);

      if (routing.skill) {
        process.stderr.write(`[vaultflow] copilot-prompt: routed to ${routing.skill} (${(routing.confidence || 0).toFixed(2)})\n`);
      } else {
        process.stderr.write(`[vaultflow] copilot-prompt: logged "${subcommand}" prompt (${promptText.length} chars)\n`);
      }
      break;
    }

    default:
      process.stderr.write(`[vaultflow] Unknown event: ${event}\n`);
      break;
  }
}

(async () => {
  const event = process.argv[2] || '';
  try {
    await dispatch(event);
  } catch (err) {
    _debugLog(`hook-handler error (${event})`, err);
  }
  process.exit(0);
})();
