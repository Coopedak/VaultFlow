#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const TOOL_BINARIES = {
  claude: process.platform === 'win32' ? 'claude.cmd' : 'claude',
  copilot: process.platform === 'win32' ? 'copilot.cmd' : 'copilot',
  codex: process.platform === 'win32' ? 'codex.cmd' : 'codex',
};

function buildSpawnSpec(tool, args) {
  const command = TOOL_BINARIES[tool];
  if (process.platform === 'win32') {
    return {
      file: 'cmd.exe',
      args: ['/d', '/c', command, ...args],
    };
  }

  return {
    file: command,
    args,
  };
}

function usage() {
  process.stdout.write(
    'Usage: node scripts/tracked-cli.mjs <claude|copilot|codex> [--cwd <dir>] [args...]\n'
  );
}

function loadDb() {
  const configPath = require('../config/resolve.cjs');
  const yaml = require('js-yaml');
  const config = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
  const metricsRoot = config?.paths?.metrics_root;
  const dbFile = config?.storage?.db_file || 'vaultflow.db';
  if (!metricsRoot) {
    throw new Error('vaultflow metrics_root is not configured.');
  }

  const db = require('../.claude/helpers/db.cjs');
  db.initialize(metricsRoot, dbFile);
  return db;
}

function loadRouter() {
  return require('../.claude/helpers/router.cjs');
}

function resolveArgs(rawArgs) {
  let cwd = process.cwd();
  const passthrough = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--cwd') {
      cwd = rawArgs[i + 1] ? path.resolve(rawArgs[i + 1]) : cwd;
      i++;
      continue;
    }
    passthrough.push(arg);
  }

  return { cwd, passthrough };
}

function truncate(text, max = 220) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function makeTransportSafe(text) {
  const value = String(text || '');
  if (process.platform !== 'win32') return value;
  return value
    .replace(/[|]/g, '/')
    .replace(/[&]/g, ' and ')
    .replace(/[<>]/g, ' ')
    .replace(/[%]/g, ' pct ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatContextBlock({ project, routing, lastSummary, summaryHits, similarPrompts, memoryHits, toolHits }) {
  const parts = [
    'REFERENCE CONTEXT FROM VAULTFLOW (background only, not a task):',
    `Project=${project}`,
  ];

  if (routing?.skill) {
    parts.push(`LikelySkill=${routing.skill}(${routing.confidence || 0})`);
  }

  if (lastSummary) {
    const files = Array.isArray(lastSummary.top_files) && lastSummary.top_files.length > 0
      ? lastSummary.top_files.slice(0, 3).join(', ')
      : 'none';
    const patterns = Array.isArray(lastSummary.patterns) && lastSummary.patterns.length > 0
      ? lastSummary.patterns.slice(0, 2).join(', ')
      : 'none';
    parts.push(`LastSessionFiles=[${files}]`);
    parts.push(`LastSessionPatterns=[${patterns}]`);
  }

  if (summaryHits.length > 0) {
    for (const summary of summaryHits.slice(0, 2)) {
      const files = Array.isArray(summary.top_files) && summary.top_files.length > 0
        ? summary.top_files.slice(0, 3).join(', ')
        : 'none';
      parts.push(`RelatedSummary=${summary.project || 'unknown'}:[${files}]`);
    }
  }

  if (similarPrompts.length > 0) {
    for (const prompt of similarPrompts.slice(0, 3)) {
      parts.push(`SimilarPrompt=${truncate(prompt.prompt_text, 140)}`);
    }
  }

  if (memoryHits.length > 0) {
    for (const hit of memoryHits.slice(0, 3)) {
      parts.push(`Memory=${truncate(hit.title, 60)}:${truncate(hit.body, 120)}`);
    }
  }

  if (toolHits.length > 0) {
    for (const hit of toolHits.slice(0, 2)) {
      parts.push(`ToolHistory=${hit.tool_name}:${truncate(hit.input_json, 120)}`);
    }
  }

  parts.push('Ignore this context unless it helps with the actual user task.');
  parts.push('END REFERENCE CONTEXT.');
  return `${parts.join(' | ')} `;
}

function buildPromptWithContext(db, cwd, prompt, tool) {
  const project = path.basename(cwd) || 'unknown';
  const router = loadRouter();
  const memoryHits = router.getContext(prompt).slice(0, 3);
  const lastSummary = db.getLatestSessionSummary(project);
  const routing = router.routeTask(prompt);
  const retrievalHits = db.searchRetrievalDocs(prompt, {
    limit: 10,
    project,
    cli: tool,
    sourceTypes: ['session_summary', 'prompt', 'tool_call'],
  });

  const summaryHits = retrievalHits
    .filter((item) => item.source_type === 'session_summary')
    .filter((item) => item.project !== project || item.source_id !== lastSummary?.session_id)
    .map((item) => ({
      ...item,
      session_id: item.source_id,
      top_files: Array.isArray(item.metadata?.top_files) ? item.metadata.top_files : [],
      patterns: Array.isArray(item.metadata?.patterns) ? item.metadata.patterns : [],
    }));
  const similarPrompts = retrievalHits
    .filter((item) => item.source_type === 'prompt')
    .map((item) => ({
      ...item,
      prompt_text: item.body,
    }))
    .filter((item) => item.prompt_text !== prompt);
  const toolHits = retrievalHits
    .filter((item) => item.source_type === 'tool_call')
    .filter((item) => item.title !== 'TrackedCliContextInjected')
    .map((item) => ({
      ...item,
      tool_name: item.title,
      input_json: item.metadata?.raw || item.body,
    }));

  if (!lastSummary && summaryHits.length === 0 && similarPrompts.length === 0 && memoryHits.length === 0 && toolHits.length === 0) {
    return {
      injectedPrompt: prompt,
      contextBlock: '',
      routing,
      retrievalBatchId: null,
      retrievalHits: [],
      selectedDocs: [],
    };
  }

  const selectedDocs = [
    ...summaryHits.slice(0, 2),
    ...similarPrompts.slice(0, 3),
    ...toolHits.slice(0, 2),
  ];
  const selectedDocKeys = new Set(selectedDocs.map((item) => `${item.source_type}:${item.source_id}`));

  const contextBlock = makeTransportSafe(formatContextBlock({
    project,
    routing,
    lastSummary,
    summaryHits,
    similarPrompts,
    memoryHits,
    toolHits,
  }));

  return {
    injectedPrompt: `${contextBlock} ACTUAL USER TASK (perform only this task): ${prompt}`,
    contextBlock,
    routing,
    retrievalBatchId: retrievalHits.length > 0 ? randomUUID() : null,
    retrievalHits,
    selectedDocs: retrievalHits.filter((item) => selectedDocKeys.has(`${item.source_type}:${item.source_id}`)),
  };
}

function replaceArg(args, index, value) {
  const next = [...args];
  next[index] = value;
  return next;
}

function findCopilotPromptArg(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '-p' || arg === '--prompt' || arg === '-i' || arg === '--interactive') && i + 1 < args.length) {
      return { index: i + 1, prompt: args[i + 1] };
    }
    if (arg.startsWith('--prompt=')) {
      return { index: i, prompt: arg.slice('--prompt='.length), inlineFlag: '--prompt=' };
    }
    if (arg.startsWith('--interactive=')) {
      return { index: i, prompt: arg.slice('--interactive='.length), inlineFlag: '--interactive=' };
    }
  }
  return null;
}

function findCodexPromptArg(args) {
  const valueFlags = new Set([
    '-c', '--config', '-i', '--image', '-m', '--model', '-p', '--profile', '-s', '--sandbox',
    '-C', '--cd', '--add-dir', '-a', '--ask-for-approval', '--output-schema', '--color',
    '-o', '--output-last-message', '--local-provider', '--remote', '--remote-auth-token-env',
    '--enable', '--disable',
  ]);

  let start = 0;
  if (args[0] === 'exec') start = 1;
  if (args[0] === 'review' || (args[0] === 'exec' && args[1] === 'review')) return null;

  for (let i = start; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      return { index: i, prompt: arg };
    }
    if (arg === '--') {
      return i + 1 < args.length ? { index: i + 1, prompt: args[i + 1] } : null;
    }
    if (valueFlags.has(arg)) {
      i += 1;
    }
  }
  return null;
}

function injectPromptContext(tool, args, cwd, db) {
  const promptInfo = tool === 'copilot' ? findCopilotPromptArg(args) : (tool === 'codex' ? findCodexPromptArg(args) : null);
  if (!promptInfo?.prompt) {
    return {
      args,
      originalPrompt: null,
      injectedPrompt: null,
      contextBlock: '',
      routing: null,
    };
  }

  const { injectedPrompt, contextBlock, routing, retrievalBatchId, retrievalHits, selectedDocs } = buildPromptWithContext(db, cwd, promptInfo.prompt, tool);
  const nextArgs = promptInfo.inlineFlag
    ? replaceArg(args, promptInfo.index, `${promptInfo.inlineFlag}${injectedPrompt}`)
    : replaceArg(args, promptInfo.index, injectedPrompt);

  return {
    args: nextArgs,
    originalPrompt: promptInfo.prompt,
    injectedPrompt,
    contextBlock,
    routing,
    retrievalBatchId,
    retrievalHits,
    selectedDocs,
  };
}

async function main() {
  const [tool, ...rawArgs] = process.argv.slice(2);
  if (!tool || !(tool in TOOL_BINARIES)) {
    usage();
    process.exit(1);
  }

  const { cwd, passthrough } = resolveArgs(rawArgs);
  const sessionId = randomUUID();
  const startedAt = new Date();
  const project = path.basename(cwd) || 'unknown';
  const db = loadDb();
  const injected = injectPromptContext(tool, passthrough, cwd, db);
  const finalArgs = injected.args;

  db.upsertSession({
    id: sessionId,
    started_at: startedAt.toISOString(),
    platform: `tracked:${tool}`,
    cli: tool,
    cwd,
    edits: 0,
    commands: finalArgs.length > 0 ? 1 : 0,
    tasks: 0,
    errors: 0,
    project,
  });

  db.recordToolCall(sessionId, 'TrackedCliLaunch', JSON.stringify({
    tool,
    cwd,
    args: finalArgs,
  }));

  if (injected.originalPrompt) {
    db.recordPrompt(sessionId, injected.originalPrompt, {
      source: `tracked:${tool}`,
      skillRouted: injected.routing?.skill || null,
    });
    db.recordToolCall(sessionId, 'TrackedCliContextInjected', JSON.stringify({
      tool,
      project,
      routing: injected.routing || null,
      contextPreview: truncate(injected.contextBlock, 500),
    }));
    if (injected.retrievalBatchId && injected.retrievalHits.length > 0) {
      const selectedKeys = new Set(
        injected.selectedDocs.map((item) => `${item.source_type}:${item.source_id}`)
      );
      for (const hit of injected.retrievalHits) {
        db.recordRetrievalFeedback({
          batch_id: injected.retrievalBatchId,
          session_id: sessionId,
          query_text: injected.originalPrompt,
          source_type: hit.source_type,
          source_id: hit.source_id,
          project: hit.project || project,
          cli: hit.cli || tool,
          model: hit.model || null,
          command_family: hit.command_family || null,
          success_state: hit.success_state || null,
          action: selectedKeys.has(`${hit.source_type}:${hit.source_id}`) ? 'injected' : 'ignored',
          rank: hit.rank,
          rerank_score: hit.rerank_score,
          metadata_json: JSON.stringify({
            title: hit.title || null,
            batch_role: selectedKeys.has(`${hit.source_type}:${hit.source_id}`) ? 'selected' : 'candidate',
          }),
        });
      }
    }
    process.stderr.write(`[vaultflow tracked-cli] Injected live context for ${tool} (${project}).\n`);
  } else if (finalArgs.length > 0) {
    db.recordPrompt(sessionId, finalArgs.join(' '), { source: `tracked:${tool}` });
  } else if (tool === 'copilot' || tool === 'codex') {
    process.stderr.write(`[vaultflow tracked-cli] No initial prompt detected for ${tool}; live context injection only applies when a prompt is provided.\n`);
  }

  const spec = buildSpawnSpec(tool, finalArgs);
  const child = spawn(spec.file, spec.args, {
    cwd,
    stdio: 'inherit',
    windowsHide: false,
  });

  let finalized = false;
  const finalize = (exitCode, signal = null) => {
    if (finalized) return;
    finalized = true;

    const endedAt = new Date();
    const errors = exitCode && exitCode !== 0 ? 1 : 0;
    db.recordToolCall(sessionId, 'TrackedCliExit', JSON.stringify({
      tool,
      exitCode,
      signal,
    }));
    if (injected.retrievalBatchId) {
      db.recordRetrievalFeedback({
        batch_id: injected.retrievalBatchId,
        session_id: sessionId,
        query_text: injected.originalPrompt,
        source_type: 'batch',
        source_id: injected.retrievalBatchId,
        project,
        cli: tool,
        action: errors ? 'run_failure' : 'run_success',
        success_state: errors ? 'failure' : 'success',
        useful: errors ? 0 : 1,
        metadata_json: JSON.stringify({
          exitCode,
          signal,
          retrieved: injected.retrievalHits.length,
          injected: injected.selectedDocs.length,
        }),
      });
    }
    db.upsertSession({
      id: sessionId,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_ms: Math.max(0, endedAt.getTime() - startedAt.getTime()),
      platform: `tracked:${tool}`,
      cli: tool,
      cwd,
      edits: 0,
      commands: finalArgs.length > 0 ? 1 : 0,
      tasks: 0,
      errors,
      project,
    });
  };

  child.on('error', (err) => {
    db.recordToolCall(sessionId, 'TrackedCliError', JSON.stringify({
      tool,
      message: err.message,
    }));
    finalize(1);
    process.stderr.write(`[vaultflow tracked-cli] Failed to start ${tool}: ${err.message}\n`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    finalize(code ?? 0, signal ?? null);
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  process.on('SIGINT', () => {
    try { child.kill('SIGINT'); } catch {}
  });

  process.on('SIGTERM', () => {
    try { child.kill('SIGTERM'); } catch {}
  });
}

main().catch((err) => {
  process.stderr.write(`[vaultflow tracked-cli] ${err.message}\n`);
  process.exit(1);
});
