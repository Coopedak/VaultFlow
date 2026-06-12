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

function writeReviewFlag(agentInfo, extra) {
  const p = reviewFlagPath();
  if (!p || !getMetricsRoot()) return;
  try {
    _fs.writeFileSync(p, JSON.stringify({
      flagged_at:  new Date().toISOString(),
      agent:       agentInfo || 'unknown',
      cleared:     false,
      ...(extra || {}),
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

function parseReviewVerdict(verdict) {
  const text = String(verdict || '').trim().toLowerCase();
  if (!text) return { approved: null, normalized: 'unknown' };

  if (/\b(approved|approve|pass|passed|accepted|success|okay|ok)\b/.test(text)) {
    return { approved: true, normalized: 'approved' };
  }

  if (/\b(rejected|reject|fail|failed|denied|deny|blocked|block|not approved|changes requested)\b/.test(text)) {
    return { approved: false, normalized: 'rejected' };
  }

  return { approved: null, normalized: 'neutral' };
}

function resolveModelForAgent(agentType, explicitModel) {
  const TIER_MAP = {
    'opus': 'claude-opus-4-7',   'Top': 'claude-opus-4-7',
    'sonnet': 'claude-sonnet-4-6', 'Mid': 'claude-sonnet-4-6',
    'haiku': 'claude-haiku-4-5-20251001', 'Low': 'claude-haiku-4-5-20251001',
  };
  const MODEL_LADDER_SET = new Set([
    'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
  ]);

  let model = sanitizeString(explicitModel || '', 100);
  if (!model && agentType) {
    try {
      const _os     = require('os');
      const _dtPath = _path.join(_os.homedir(), '.claude', 'devteam-config.json');
      const _dtCfg  = _fs.existsSync(_dtPath) ? JSON.parse(_fs.readFileSync(_dtPath, 'utf8')) : {};
      const _tier   = (_dtCfg.agent_models && _dtCfg.agent_models[agentType]) || 'sonnet';
      const _resolved = TIER_MAP[_tier] || _tier;
      model = MODEL_LADDER_SET.has(_resolved) ? _resolved : 'claude-sonnet-4-6';
    } catch (_) { model = 'claude-sonnet-4-6'; }
  }
  return model || 'unknown';
}

function resolveSubagentRoutingContext(subagentPayload, agentDesc) {
  const agentType = sanitizeString(
    (subagentPayload.tool_input && subagentPayload.tool_input.subagent_type) ||
    subagentPayload.subagent_type || '', 100
  );
  const agent = agentType || sanitizeString(agentDesc || 'unknown', 100);
  const model = resolveModelForAgent(
    agentType,
    (subagentPayload.tool_input && subagentPayload.tool_input.model) || subagentPayload.model || ''
  );
  const taskType = sanitizeString(
    (subagentPayload.tool_input && subagentPayload.tool_input.task_type) ||
    subagentPayload.task_type || 'general', 100
  );
  return { agentType, agent, model, taskType };
}

function writeModelRecommendation(metricsRoot, agent, demotion) {
  if (!metricsRoot || !demotion) return;
  const recPath = _path.join(metricsRoot, 'model-recommendations.json');
  let recs = {};
  try { recs = JSON.parse(_fs.readFileSync(recPath, 'utf8')); } catch (_) {}
  recs[agent] = {
    model:        demotion.to,
    demoted_from: demotion.from,
    updated_at:   new Date().toISOString(),
  };
  _fs.writeFileSync(recPath, JSON.stringify(recs, null, 2), 'utf8');
}

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
    case 'pre-skill': {
      // PreToolUse:Skill — Claude Code is about to dispatch a Skill. Record
      // the invocation in tool_calls and credit the agent's use_count.
      // Without this, vault_agents.use_count only reflects auto-injection
      // hits and misses the most important signal: what Claude actually ran.
      const raw = await readStdin();
      let input = {};
      try { input = JSON.parse(raw); } catch (_) {}
      const skillName = sanitizeString(
        (input.tool_input && (input.tool_input.skill || input.tool_input.skill_name || input.tool_input.name)) || '',
        200
      );
      const args = sanitizeString(
        (input.tool_input && (input.tool_input.args || input.tool_input.arguments || input.tool_input.prompt)) || '',
        1000
      );
      try {
        const db      = require('./db.cjs');
        const session = require('./session.cjs');
        db.initialize(null, null);
        const sess = session.get();
        if (sess) {
          db.recordToolCall(sess.id, 'Skill', JSON.stringify({ skill: skillName, args }));
          if (skillName) db.incrementAgentUse(skillName);
        }
        process.stderr.write(`[vaultflow] pre-skill: recorded "${skillName}"\n`);
      } catch (err) {
        process.stderr.write(`[vaultflow] pre-skill: ${err.message}\n`);
      }
      break;
    }

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
          db.recordPrompt(sessionId, prompt, { skillRouted: routing.skill, source: 'claude' });
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
      let injectionDecision = {
        chosenSkill: routing.skill || null,
        confidence: Number(routing.confidence) || 0,
        injected: false,
        tier: null,
        reason: 'no-skill',
      };
      try {
        const { buildInjection } = await import('./skill-loader.mjs');
        const session            = require('./session.cjs');
        const { skill, at }      = session.getInjectedSkill();
        const inj = buildInjection(routing.skill, routing.confidence, skill, at);
        if (inj) {
          additionalContext = inj.text;  // just the skill content, NOT the full prompt
          session.setInjectedSkill(routing.skill);
          injectionDecision.injected = true;
          injectionDecision.tier     = inj.tier;
          injectionDecision.reason   = 'threshold-met';
          process.stderr.write(
            `[vaultflow] route: injecting ${routing.skill} (${inj.tier}, confidence ${routing.confidence})\n`
          );
        } else if (routing.skill && skill === routing.skill) {
          injectionDecision.reason = 'recently-injected';
        } else if (routing.skill) {
          injectionDecision.reason = 'below-threshold';
        }
      } catch (err) {
        injectionDecision.reason = 'error:' + err.message.slice(0, 80);
        process.stderr.write(`[vaultflow] route: skill-loader error — ${err.message}\n`);
      }

      // ── log the decision for nightly routing-coverage audit ────────────
      try {
        const db = require('./db.cjs');
        // sessionId was set above when the prompt was recorded; fall through if null
        db.recordSkillInjectionDecision({
          sessionId,
          promptId: null, // recordPrompt doesn't return id today; nightly joins by timestamp
          chosenSkill: injectionDecision.chosenSkill,
          confidence:  injectionDecision.confidence,
          injected:    injectionDecision.injected,
          tier:        injectionDecision.tier,
          reason:      injectionDecision.reason,
          candidates:  null, // future: log the top-N BM25 candidates here
        });
      } catch (err) {
        process.stderr.write(`[vaultflow] route: decision-log error — ${err.message}\n`);
      }

      process.stderr.write(
        `[vaultflow] route: skill=${routing.skill} conf=${routing.confidence} ` +
        `entries=${entries.length}\n`
      );

      // ── similar-prompt dedup: "you've asked this before" ───────────────
      // If the user's current prompt is ≥0.85 cosine-similar to a past prompt,
      // surface the past prompts so they can avoid re-running the same work.
      try {
        if (prompt && prompt.trim().length >= 12) {
          const m = await import('./embeddings.mjs');
          const sim = await m.findSimilarPrompts(prompt, { limit: 3, threshold: 0.85 });
          if (sim && sim.length) {
            const lines = ['## You have asked something similar before:', ''];
            for (const s of sim) {
              const when = (s.timestamp || '').slice(0, 10);
              const text = String(s.prompt_text || '').replace(/\s+/g, ' ').slice(0, 120);
              const sid  = (s.session_id || '').slice(0, 8);
              lines.push(`- **${when}** (sim ${s.score.toFixed(2)}, session ${sid}): "${text}"`);
            }
            lines.push('');
            lines.push('Consider checking what happened then via `mcp__vaultflow__search_memory` or `get_session_summary`.');
            additionalContext = (additionalContext || '') + (additionalContext ? '\n\n' : '') + lines.join('\n');
          }
        }
      } catch (_) { /* embeddings not available */ }

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
            `  node ${__filename} clear-review\n`;
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
      // Foreground work, kept tight (~250ms): register the session, build a
      // small "what happened recently in this project" context block, and
      // emit it as additionalContext so the new conversation starts with
      // prior-session awareness (claude-mem-style memory injection without
      // the worker service).
      //
      // Heavy indexing (doImport, stack-detect, gen-context, watcher daemon)
      // is detached to session-start-bg.mjs — it would otherwise add 30-50s
      // of blocking latency for work the model never reads.
      const session = require('./session.cjs');
      const sess    = await session.start();

      // ── detach the heavy work ──────────────────────────────────────────
      try {
        const { spawn } = require('child_process');
        const bgPath    = _path.resolve(__dirname, 'session-start-bg.mjs');
        const cwd       = (sess && sess.cwd) || process.cwd();
        const project   = (sess && sess.project) || _path.basename(cwd);

        const child = spawn(
          process.execPath,
          ['--no-warnings', bgPath, cwd, project],
          { detached: true, stdio: 'ignore' }
        );
        child.unref();
      } catch (err) {
        process.stderr.write(`[vaultflow] session-start: bg spawn error — ${err.message}\n`);
      }

      // ── inject recent-session context ──────────────────────────────────
      // Pull the last 3 non-empty summaries for this project plus the top
      // few memory hits keyed off the cwd. Format as a compact bulleted
      // block — terse on purpose, since every line costs context tokens.
      try {
        const project = (sess && sess.project) || _path.basename(sess && sess.cwd || '');
        if (project) {
          const db = require('./db.cjs');
          db.initialize(null, null);

          const summaries = db.getRecentSessionSummaries(project, 3);

          // Build a richer query than project alone — pull focus headline and
          // the most-recent session's pattern keys / top files so memory hits
          // are actually relevant to current work, not always the same top-5.
          let focusHeadline = '';
          try {
            const focusMod = require('./focus.cjs');
            const f = focusMod.load(project);
            if (f && f.headline) focusHeadline = f.headline;
          } catch (_) {}
          const recentBits = summaries.length
            ? [...(summaries[0].patterns || []), ...(summaries[0].top_files || [])].slice(0, 8).join(' ')
            : '';
          const memQuery = [project, focusHeadline, recentBits].filter(Boolean).join(' ').slice(0, 400);

          const memoryHits = (() => {
            try { return db.searchMemory(memQuery, 5) || []; } catch (_) { return []; }
          })();

          const lines = [];

          // Git context block — surfaced first because it's the freshest
          // signal about the user's current intent. Branch + last 5 commits
          // + uncommitted file count + dirty file list (capped).
          try {
            const gitCtx = require('./git-context.cjs');
            const g = gitCtx.getContext(sess && sess.cwd);
            if (g) {
              const tracking = g.upstream
                ? ` (${g.ahead}↑/${g.behind}↓ vs ${g.upstream})`
                : ' (no upstream)';
              lines.push(`## Git — ${project}`);
              lines.push('');
              lines.push(`**Branch:** \`${g.branch}\` @ ${g.head}${tracking}`);
              if (g.dirty_count > 0) {
                lines.push(`**Uncommitted:** ${g.dirty_count} file(s)`);
                for (const s of g.status.slice(0, 10)) lines.push(`  \`${s}\``);
              } else {
                lines.push(`**Working tree:** clean`);
              }
              if (g.commits.length) {
                lines.push('**Recent commits:**');
                for (const c of g.commits) lines.push(`- \`${c.hash}\` ${c.subject}`);
              }
              if (g.open_prs && g.open_prs.length) {
                lines.push(`**Open PRs:** ${g.open_prs.length}`);
                for (const p of g.open_prs) {
                  const tag = p.draft ? '[draft] ' : '';
                  lines.push(`- #${p.number} ${tag}${p.title}${p.author ? ' (@' + p.author + ')' : ''}`);
                }
              }
              lines.push('');
            }
          } catch (_) {}

          if (summaries.length) {
            lines.push(`## vaultflow — recent activity in ${project}`);
            lines.push('');
            for (const s of summaries) {
              const when = (s.summary_at || '').slice(0, 10);
              const dur  = s.duration_ms ? `${Math.round(s.duration_ms / 60000)}m` : '?';
              const files = (s.top_files || []).slice(0, 5).join(', ');
              const pats  = (s.patterns  || []).slice(0, 3).join(', ');
              lines.push(`- **${when}** (${dur}) — files: ${files || '—'}${pats ? `; patterns: ${pats}` : ''}`);
            }
          }
          // Focus block: surfaces vault/projects/{project}/focus.md so the
          // model sees current intent at the top of every session, not just
          // in agent-context.json for subagents.
          if (focusHeadline) {
            if (lines.length) lines.push('');
            lines.push(`## Current focus — ${project}`);
            lines.push('');
            try {
              const focusMod = require('./focus.cjs');
              const f = focusMod.load(project);
              if (f && f.body) {
                lines.push(f.body.trim().slice(0, 1200));
              } else {
                lines.push(`_${focusHeadline}_`);
              }
            } catch (_) { lines.push(`_${focusHeadline}_`); }
          }

          if (memoryHits.length) {
            if (lines.length) lines.push('');
            lines.push(`## Top memory matches for "${project}"`);
            lines.push('');
            for (const m of memoryHits.slice(0, 5)) {
              const title  = (m.title  || '').slice(0, 80);
              const source = (m.source || '').slice(0, 60);
              lines.push(`- **${title}** — ${source}`);
            }
          }

          // MCP cheat-sheet — surface the available code-graph + memory tools
          // up front so the LLM knows to prefer them over Read/Grep/Glob. The
          // descriptions in the MCP schema aren't visible until the model
          // calls tools/list; this injection forces awareness at start.
          lines.push('');
          lines.push('## vaultflow MCP — prefer over Read/Grep when possible');
          lines.push('');
          lines.push('- `mcp__vaultflow__find_symbol(name)` instead of grep-for-definition');
          lines.push('- `mcp__vaultflow__file_symbols(file)` instead of Read for file structure');
          lines.push('- `mcp__vaultflow__get_symbol_body(file,name)` instead of Read for one function (98% fewer tokens)');
          lines.push('- `mcp__vaultflow__blast_radius(file)` before editing — every importer of a file');
          lines.push('- `mcp__vaultflow__find_callers(name)` before renaming — every callsite of a function');
          lines.push('- `mcp__vaultflow__search_memory(query)` for prior decisions / patterns');

          // Code-graph hint: top 5 most-symbol-dense files in this project so
          // the model has an immediate map of the project's active surface.
          try {
            const hotFiles = db.raw().prepare(`
              SELECT file, COUNT(*) AS syms FROM code_symbols
               WHERE project = ?
               GROUP BY file ORDER BY syms DESC LIMIT 5
            `).all(project);
            if (hotFiles.length > 0) {
              if (lines.length) lines.push('');
              lines.push(`## Code graph — top files in ${project}`);
              lines.push('');
              for (const f of hotFiles) {
                const base = f.file.split(/[\\\/]/).slice(-3).join('/');
                lines.push(`- ${base} — ${f.syms} symbols`);
              }
            }
          } catch (_) {}

          if (lines.length) {
            const additionalContext = lines.join('\n');
            // SessionStart hook spec: hookSpecificOutput wrapper.
            process.stdout.write(JSON.stringify({
              hookSpecificOutput: {
                hookEventName:    'SessionStart',
                additionalContext,
              },
            }));
          }
        }
      } catch (err) {
        process.stderr.write(`[vaultflow] session-start: context inject error — ${err.message}\n`);
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
        const decisionId = db.getLatestDecisionId(sess ? sess.id : null);
        db.recordVerdict(sess ? sess.id : null, agentType, verdict, reason, flaggedAt, decisionId);
        process.stderr.write(`[vaultflow] clear-review: verdict recorded — ${verdict} (${agentType})\n`);
      } catch (err) {
        process.stderr.write(`[vaultflow] clear-review: verdict record error — ${err.message}\n`);
      }

      try {
        const router = require('./model-router.cjs');
        const flagAgent = sanitizeString(flag && flag.agent_type || agentType, 100) || agentType;
        const flagModel = sanitizeString(flag && flag.model || '', 100);
        const flagTaskType = sanitizeString(flag && flag.task_type || 'general', 100);
        const verdictInfo = parseReviewVerdict(verdict);
        if (flagAgent && flagModel && verdictInfo.approved !== null) {
          router.recordVerdict(flagAgent, flagModel, flagTaskType, verdictInfo.approved);
          const demotion = router.checkAndDemote(flagAgent, flagTaskType);
          if (demotion) {
            writeModelRecommendation(getMetricsRoot(), flagAgent, demotion);
            process.stderr.write(
              `[vaultflow] clear-review: model-router wrote recommendation for "${flagAgent}": ${demotion.from} → ${demotion.to}\n`
            );
          }
        } else if (flagAgent && flagModel) {
          process.stderr.write(
            `[vaultflow] clear-review: model-router skipped non-binary verdict "${verdict}" for "${flagAgent}"\n`
          );
        }
      } catch (err) {
        process.stderr.write(`[vaultflow] clear-review: model-router error — ${err.message}\n`);
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
      // Stop hook payload: { session_id, transcript_path, stop_hook_active, ... }
      // We need transcript_path to harvest AI assistant terms (Claude only — other
      // tools have their own Stop equivalents that don't pass through here).
      const stopRaw = await readStdin();
      let stopPayload = {};
      try { stopPayload = JSON.parse(stopRaw); } catch (_) {}

      const intelligence = require('./intelligence.cjs');
      const result = await intelligence.feedback(true);
      const promoted = (result && result.promoted) || 0;
      if (promoted > 0) {
        process.stderr.write(`[vaultflow] post-task: ${promoted} entries promoted\n`);
      }

      // ── dictionary term frequency ─────────────────────────────────────────
      // Terms appearing >= 3 times get auto-added. Each entry is tagged with
      // `session-auto:<origin>:<tool>` so the dashboard can show whether a
      // word came from a USER prompt or an AI response, and which model
      // (claude / copilot / codex) the term originated under.
      try {
        const db = require('./db.cjs');
        db.initialize(null, null);
        const STOP_WORDS = new Set(['this','that','with','from','have','been','will','when','then','what','into','over','also','some','they','them','than','each','more','like','just','even','most','such','only','both','very','here','where','which','your','their','there','these','those','about','after','before','between','should','could','would','other','first','second','third']);
        const knownTerms = db.getDictionaryTermSet();

        const tokenize = (text) => (text || '').toLowerCase().match(/\b[a-z][a-z0-9_-]{3,}\b/g) || [];

        // Bucket by tool so user-prompt terms are tagged with the tool that
        // received them (claude, copilot, codex). Empty source defaults to claude.
        const byTool = new Map();
        for (const row of db.getLastSessionPrompts()) {
          const tool = (row.source || 'claude').replace(/^tracked:/, '');
          if (!byTool.has(tool)) byTool.set(tool, {});
          const freq = byTool.get(tool);
          for (const w of tokenize(row.prompt_text)) {
            freq[w] = (freq[w] || 0) + 1;
          }
        }

        const upsertFromFreq = (freq, originLabel, sourceTag) => {
          let added = 0;
          for (const [term, count] of Object.entries(freq)) {
            if (count >= 3 && !knownTerms.has(term) && !STOP_WORDS.has(term) && term.length >= 5) {
              db.upsertDictionaryEntry(
                term,
                'pattern',
                `Auto-detected: appeared ${count}x in ${originLabel}. Review and update definition.`,
                sourceTag
              );
              knownTerms.add(term);
              added++;
            }
          }
          return added;
        };

        for (const [tool, freq] of byTool) {
          const n = upsertFromFreq(freq, `${tool} user prompts`, `session-auto:user:${tool}`);
          if (n > 0) process.stderr.write(`[vaultflow] post-task: ${n} user-prompt terms (${tool})\n`);
        }

        // ── AI side: parse the Claude transcript for assistant turn text ────
        // The Stop hook only fires for Claude Code, so AI-derived terms are
        // tagged `session-auto:ai:claude`. Other tools would need their own
        // integration to seed the AI dictionary under their own model tag.
        const transcriptPath = stopPayload && stopPayload.transcript_path;
        if (transcriptPath) {
          try {
            const fsLocal = require('fs');
            if (fsLocal.existsSync(transcriptPath)) {
              const raw = fsLocal.readFileSync(transcriptPath, 'utf8');
              const aiFreq = {};
              for (const line of raw.split('\n')) {
                if (!line.trim()) continue;
                let turn;
                try { turn = JSON.parse(line); } catch (_) { continue; }
                if (!turn || turn.type !== 'assistant') continue;
                const content = turn.message && turn.message.content;
                if (!Array.isArray(content)) continue;
                for (const block of content) {
                  if (block && block.type === 'text' && typeof block.text === 'string') {
                    for (const w of tokenize(block.text)) {
                      aiFreq[w] = (aiFreq[w] || 0) + 1;
                    }
                  }
                }
              }
              const n = upsertFromFreq(aiFreq, 'claude AI responses', 'session-auto:ai:claude');
              if (n > 0) process.stderr.write(`[vaultflow] post-task: ${n} AI-output terms (claude)\n`);
            }
          } catch (err) {
            process.stderr.write(`[vaultflow] post-task: transcript parse error — ${err.message}\n`);
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

    case 'pre-subagent': {
      // Fired by PreToolUse:Task. Stash the active subagent's identity in a
      // small JSON file so post-edit.cjs can attribute pattern fires to the
      // right agent (developer-backend, researcher, etc.) instead of writing
      // null. SubagentStop clears the file in post-subagent.
      const raw = await readStdin();
      let payload = {};
      try { payload = JSON.parse(raw); } catch (_) {}

      const agentType = sanitizeString(
        (payload.tool_input && payload.tool_input.subagent_type) || '', 100
      );
      if (!agentType) break;

      // Credit use_count on every Task dispatch — not just router-picked ones.
      // Before this, only router.cjs incremented, so 99/120 agents showed zero
      // use even when actively invoked via the Skill/Task tool.
      try {
        const _db = require('./db.cjs');
        _db.initialize(null, null);
        _db.incrementAgentUse(agentType);

        // Gap 3: record the Task dispatch in tool_calls so subagent activity
        // is visible to nightly analytics. The subagent's *internal* tool
        // calls still aren't captured (parent's session doesn't see them),
        // but the dispatch itself + description + prompt is now logged.
        const _session = require('./session.cjs');
        const sess = _session.get();
        if (sess) {
          const desc   = sanitizeString((payload.tool_input && payload.tool_input.description) || '', 300);
          const prompt = sanitizeString((payload.tool_input && payload.tool_input.prompt) || '', 2000);
          _db.recordToolCall(sess.id, 'Task', JSON.stringify({
            subagent_type: agentType,
            description: desc,
            prompt_excerpt: prompt.slice(0, 500),
            dispatched_at: new Date().toISOString(),
          }));
        }
      } catch (_) {}

      try {
        const _yaml    = require('js-yaml');
        const _cfgPath = require('../../config/resolve.cjs');
        const _cfg     = _fs.existsSync(_cfgPath) ? _yaml.load(_fs.readFileSync(_cfgPath, 'utf8')) : {};
        const _metrics = (_cfg.paths && _cfg.paths.metrics_root) || '';
        if (_metrics) {
          _fs.writeFileSync(
            _path.join(_metrics, 'active-subagent.json'),
            JSON.stringify({
              agent: agentType,
              started_at: new Date().toISOString(),
              session_id: (payload.session_id) || null,
            }, null, 2),
            'utf8'
          );
        }
      } catch (err) {
        process.stderr.write(`[vaultflow] pre-subagent: write failed — ${err.message}\n`);
      }
      break;
    }

    case 'post-subagent': {
      const raw = await readStdin();
      let subagentPayload = {};
      try { subagentPayload = JSON.parse(raw); } catch (_) {}

      // Clear the active-subagent tracker so subsequent edits attribute back
      // to the parent session, not the just-finished subagent.
      try {
        const _yaml    = require('js-yaml');
        const _cfgPath = require('../../config/resolve.cjs');
        const _cfg     = _fs.existsSync(_cfgPath) ? _yaml.load(_fs.readFileSync(_cfgPath, 'utf8')) : {};
        const _metrics = (_cfg.paths && _cfg.paths.metrics_root) || '';
        if (_metrics) {
          const trackerPath = _path.join(_metrics, 'active-subagent.json');
          if (_fs.existsSync(trackerPath)) _fs.unlinkSync(trackerPath);
        }
      } catch (_) { /* best-effort cleanup */ }

      // Write review flag unless this was voice-of-reason itself completing
      const agentDesc = (
        (subagentPayload.tool_input && subagentPayload.tool_input.description) ||
        (subagentPayload.subagent_type) ||
        ''
      ).toLowerCase();
      const routingCtx = resolveSubagentRoutingContext(subagentPayload, agentDesc);
      if (!agentDesc.includes('voice-of-reason') && !agentDesc.includes('clear-review')) {
        const agentLabel = sanitizeString(agentDesc || 'sub-agent', 200);
        writeReviewFlag(agentLabel, {
          agent_type: routingCtx.agent,
          model: routingCtx.model,
          task_type: routingCtx.taskType,
        });
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

        let _focus = null;
        try {
          const _focusMod = require('./focus.cjs');
          if (_sess && _sess.project) _focus = _focusMod.load(_sess.project);
        } catch (_) {}

        // Build a context-aware memory query from the actual subagent task,
        // not a hardcoded string. Order: subagent description > focus headline
        // > most recent prompt > project name. This is what made every
        // subagent see the same five stale memories before.
        const _queryParts = [];
        if (agentDesc && agentDesc.length > 3) _queryParts.push(agentDesc.slice(0, 200));
        if (_focus && _focus.headline)         _queryParts.push(_focus.headline.slice(0, 150));
        if (_sess && _sess.project)            _queryParts.push(_sess.project);
        try {
          const lastPrompts = _db.getLastSessionPrompts() || [];
          if (lastPrompts.length > 0 && lastPrompts[0].prompt_text) {
            _queryParts.push(String(lastPrompts[0].prompt_text).slice(0, 200));
          }
        } catch (_) {}
        const _memQuery = _queryParts.join(' ').trim() || (_sess && _sess.project) || 'recent activity';

        let topMemory = [];
        try { topMemory = _db.searchMemory(_memQuery, 5); } catch (_) {}

        const agentCtx = {
          db_path:     _path.join(_metrics, _dbFile),
          session_id:  _sess ? _sess.id      : null,
          project:     _sess ? _sess.project : null,
          helpers_dir: __dirname,
          top_memory:  topMemory.map(m => ({ title: m.title, source: m.source })),
          focus:       _focus ? { headline: _focus.headline, body: _focus.body, path: _focus.path, updated_at: _focus.updated_at } : null,
          updated_at:  new Date().toISOString(),
        };

        _fs.writeFileSync(_path.join(_metrics, 'agent-context.json'), JSON.stringify(agentCtx, null, 2), 'utf8');
        process.stderr.write(`[vaultflow] post-subagent: agent-context.json updated\n`);
      } catch (err) {
        process.stderr.write(`[vaultflow] post-subagent: agent-context error — ${err.message}\n`);
      }

      // ── model routing — record session usage for the actual worker agent ───
      try {
        const router  = require('./model-router.cjs');
        const { agentType, agent, model, taskType } = routingCtx;

        // Skip routing if we have no meaningful agent identity — avoids polluting
        // model_performance with anonymous 'unknown' rows from parse failures.
        if (!agentType && !agentDesc) break;
        if (agentDesc.includes('voice-of-reason') || agentDesc.includes('clear-review')) break;

        router.recordSession(agent, model, taskType);
        process.stderr.write(
          `[vaultflow] post-subagent: model-router recorded session for "${agent}" on ${model} (${taskType})\n`
        );
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

      const routing = router.routeTask(promptText);
      db.recordPrompt(sess.id, promptText, { skillRouted: routing.skill, source: 'copilot' });

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
