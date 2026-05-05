'use strict';

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
      const cmd = (input.tool_input && input.tool_input.command) || '';

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
      const prompt = (input.tool_input && input.tool_input.prompt) || '';

      const router      = require('./router.cjs');
      const intelligence = require('./intelligence.cjs');
      const routing     = router.routeTask(prompt);
      const context     = intelligence.getContext(prompt);
      const entries     = Array.isArray(context) ? context.slice(0, 5) : [];

      // ── record prompt in DB ─────────────────────────────────────────────
      let sessionId  = null;
      let toolSummary = [];
      try {
        const db      = require('./db.cjs');
        const session = require('./session.cjs');
        db.initialize(null, null);
        const sess = session.get();
        if (sess) {
          sessionId = sess.id;
          db.recordPrompt(sessionId, prompt, routing.skill);
          toolSummary = db.getSessionToolSummary(sessionId);
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
      // Modifies prompt content if confidence meets threshold and the same
      // skill hasn't been injected recently in this session.
      let injectionContent = null;
      try {
        const { buildInjection } = await import('./skill-loader.mjs');
        const session            = require('./session.cjs');
        const { skill, at }      = session.getInjectedSkill();
        const inj = buildInjection(routing.skill, routing.confidence, skill, at);
        if (inj) {
          injectionContent = prompt + inj.text;
          session.setInjectedSkill(routing.skill);
          process.stderr.write(
            `[vaultflow] route: injecting ${routing.skill} (${inj.tier}, confidence ${routing.confidence})\n`
          );
        }
      } catch (err) {
        process.stderr.write(`[vaultflow] route: skill-loader error — ${err.message}\n`);
      }

      // Only decision + optional content are valid UserPromptSubmit output fields.
      // routing/context/tool_summary are internal — log to stderr for diagnostics.
      process.stderr.write(
        `[vaultflow] route: skill=${routing.skill} conf=${routing.confidence} ` +
        `entries=${entries.length} tools=${toolSummary.length}\n`
      );

      const response = {};
      if (injectionContent) {
        response.hookSpecificOutput = {
          hookEventName: 'UserPromptSubmit',
          additionalContext: injectionContent,
        };
      }

      if (Object.keys(response).length > 0) {
        process.stdout.write(JSON.stringify(response));
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
        const cfgPath    = require('path').resolve(__dirname, '../../config/vaultflow.yaml');
        const cfg        = fs.existsSync(cfgPath) ? yaml.load(fs.readFileSync(cfgPath, 'utf8')) : {};
        const doDetect   = cfg.intelligence && cfg.intelligence.stack_detect_on_session_start !== false;

        if (doDetect && sess && sess.cwd) {
          const { detectAndStore } = await import('./stack-detector.mjs');
          const stacks = await detectAndStore(sess.cwd, sess.project || require('path').basename(sess.cwd));
          if (stacks.length > 0) {
            process.stderr.write(`[vaultflow] session-start: stacks detected — ${stacks.join(', ')}\n`);
          }
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

        const cfgPath     = path.resolve(__dirname, '../../config/vaultflow.yaml');
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

        // ── dictionary term frequency ─────────────────────────────────
        // Terms appearing >= 3 times in session prompts get auto-added.
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
            process.stderr.write(`[vaultflow] session-end: auto-added dictionary term "${term}" (${count}x in prompts)\n`);
          }
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
        '  • Check C:\\Users\\YOU\\vault\\methodology\\.metrics\\discoveries\\ for pending promotions\n' +
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
      const intelligence = require('./intelligence.cjs');
      const result = await intelligence.feedback(true);
      const promoted = (result && result.promoted) || 0;
      if (promoted > 0) {
        process.stderr.write(`[vaultflow] post-subagent: ${promoted} entries promoted\n`);
      }
      break;
    }

    case 'copilot-prompt': {
      const raw  = await readStdin();
      let payload = {};
      try { payload = JSON.parse(raw); } catch (_) {}

      const promptText = payload.prompt || '';
      const subcommand = payload.subcommand || '';
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
    process.stderr.write(`[vaultflow] hook-handler error (${event}): ${err.message}\n`);
  }
  process.exit(0);
})();
