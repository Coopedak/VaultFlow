'use strict';
/**
 * mcp-server.cjs — vaultflow MCP (Model Context Protocol) server
 *
 * Exposes vaultflow's memory, context, skills, model routing, and vault tools
 * as callable MCP tools. Any MCP-capable AI sees these tools automatically:
 *   - Claude Code (via mcpServers in ~/.claude/settings.json)
 *   - GitHub Copilot in VS Code (via .vscode/mcp.json)
 *   - Cursor, Windsurf, etc.
 *
 * As the vaultflow DB grows (more memory, patterns, sessions), tool responses
 * get richer with zero maintenance.
 *
 * Transport: stdio — line-delimited JSON-RPC 2.0
 */

const readline = require('readline');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');

// ── config + DB (lazy, initialized once) ─────────────────────────────────

let _cfg = null;
let _db  = null;

function getCfg() {
  if (_cfg) return _cfg;
  try {
    const yaml       = require('js-yaml');
    const configPath = require('../../config/resolve.cjs');
    if (fs.existsSync(configPath)) {
      _cfg = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
    }
  } catch (_) {}
  _cfg = _cfg || {};
  return _cfg;
}

function getDb() {
  if (_db) return _db;
  _db = require('./db.cjs');
  const cfg = getCfg();
  _db.initialize(
    (cfg.paths   && cfg.paths.metrics_root) || null,
    (cfg.storage && cfg.storage.db_file)    || null
  );
  return _db;
}

// ── tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search_memory',
    description:
      'Search vaultflow memory using BM25 full-text search across vault notes, ' +
      'project wikis, CLAUDE.md files, and session learnings. Returns the most ' +
      'relevant entries. Use this to find prior decisions, patterns, and domain knowledge.',
    inputSchema: {
      type: 'object',
      properties: {
        query:     { type: 'string', description: 'Search query' },
        limit:     { type: 'number', description: 'Max results (1–20, default 5)' },
        bodyChars: { type: 'number', description: 'Cap per-entry body chars (80–4000, default 400). Lower = fewer tokens.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_context',
    description:
      'Get ranked context entries for a prompt. Applies token budgeting and ' +
      'returns the most relevant memory entries for the current or named project. ' +
      'Use before starting work on a task to load relevant background.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt:  { type: 'string', description: 'The task or question to get context for' },
        project: { type: 'string', description: 'Project name override (default: cwd basename)' },
        limit:   { type: 'number', description: 'Max entries (default 5)' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'list_skills',
    description:
      'List all available Claude Code skills with names and descriptions. ' +
      'Skills are invoked with /skill-name in Claude Code. Returns the full ' +
      'list so you know what pipelines and agents are available.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'model_status',
    description:
      'Get current model routing status — which AI model each agent runs on, ' +
      'approval rates, demotion eligibility, and which agents are pinned to top tier. ' +
      'Use this to understand the current capability/cost trade-off per agent.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_session_summary',
    description:
      'Get the most recent session summary for a project — files edited, ' +
      'patterns fired, and session duration. Use to resume context from the last session.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (default: cwd basename)' },
      },
    },
  },
  {
    name: 'search_vault_tools',
    description:
      'Search the vault tools index for reusable utilities and scripts. ' +
      'ALWAYS call this before implementing any new utility, script, or helper. ' +
      '30+ tools registered: logging, DB connectors, retry patterns, parsers, ' +
      'ML pipelines, API wrappers, and more.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Tool name, category, or description fragment' },
      },
      required: ['query'],
    },
  },
  {
    name: 'blast_radius',
    description:
      'Find every file that imports a target file. Use this BEFORE editing any ' +
      'source file to understand what depends on it — prevents breaking changes. ' +
      'Returns dependent file paths with import line numbers. ' +
      'Faster and more accurate than grepping for callers.',
    inputSchema: {
      type: 'object',
      properties: {
        file:    { type: 'string', description: 'Absolute path to the target file' },
        project: { type: 'string', description: 'Optional project filter' },
      },
      required: ['file'],
    },
  },
  {
    name: 'find_symbol',
    description:
      'Locate where a function, class, type, or other symbol is exported. ' +
      'Returns file path + line number + kind (function/class/interface/etc). ' +
      'Faster than grep when looking for the definition of a known name.',
    inputSchema: {
      type: 'object',
      properties: {
        name:  { type: 'string', description: 'Symbol name (exact or substring)' },
        limit: { type: 'integer', description: 'Max results (default 20)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'file_symbols',
    description:
      'List every exported symbol in a file: functions, classes, interfaces, ' +
      'types, enums, constants. Use to understand a file\'s surface area ' +
      'without reading the whole thing.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Absolute path to the file' },
      },
      required: ['file'],
    },
  },
  {
    name: 'get_symbol_body',
    description:
      'Return just the lines that define a single function/class instead of ' +
      'reading the whole file. Use INSTEAD of Read when you only need to ' +
      'understand one symbol. Massive token savings on large files. ' +
      'Returns null if the symbol is not indexed.',
    inputSchema: {
      type: 'object',
      properties: {
        file:      { type: 'string', description: 'Absolute path to the file' },
        name:      { type: 'string', description: 'Symbol name (exact)' },
        max_lines: { type: 'integer', description: 'Cap (default 200)' },
      },
      required: ['file', 'name'],
    },
  },
  {
    name: 'find_callers',
    description:
      'Find every function that calls a given function by name. Function-level ' +
      'blast-radius. Use BEFORE renaming or changing the signature of a function ' +
      'to find all callsites.',
    inputSchema: {
      type: 'object',
      properties: {
        name:    { type: 'string', description: 'Function/method name (exact)' },
        project: { type: 'string', description: 'Optional project filter' },
      },
      required: ['name'],
    },
  },
];

// ── tool handlers ─────────────────────────────────────────────────────────

async function callTool(name, args) {
  const db  = getDb();
  const cfg = getCfg();

  switch (name) {

    case 'search_memory': {
      const limit   = Math.min(Math.max(1, Math.floor(args.limit || 5)), 20);
      // Body cap: default 400 chars — most memory entries have a high-signal
      // first paragraph; the rest is decoration that wastes tokens. Override
      // with bodyChars when the LLM needs full context.
      const bodyCap = Math.min(Math.max(80, Math.floor(args.bodyChars || 400)), 4000);
      const results = db.searchMemory(String(args.query || ''), limit);
      if (!results || results.length === 0) {
        return { content: [{ type: 'text', text: 'No memory entries found.' }] };
      }
      const text = results
        .map(r => {
          const body = String(r.body || '');
          const slim = body.length > bodyCap ? body.slice(0, bodyCap) + '…' : body;
          return `### ${r.title}\n*Source: ${r.source}*\n\n${slim}`;
        })
        .join('\n\n---\n\n');
      return { content: [{ type: 'text', text }] };
    }

    case 'get_context': {
      const project = String(args.project || path.basename(process.cwd()));
      const limit   = Math.min(Math.max(1, Math.floor(args.limit || 5)), 10);
      const prompt  = String(args.prompt || '');

      // Last-session summary prepend
      const parts = [];
      try {
        const summary = db.getLatestSessionSummary(project);
        const ONE_DAY = 24 * 60 * 60 * 1000;
        if (summary && (Date.now() - new Date(summary.summary_at).getTime()) < ONE_DAY) {
          const h      = Math.round((Date.now() - new Date(summary.summary_at).getTime()) / 3600000);
          const files  = (summary.top_files || []).slice(0, 3).join(', ') || 'none';
          const pats   = (summary.patterns  || []).slice(0, 2).join(', ') || 'none';
          const durMin = Math.round((summary.duration_ms || 0) / 60000);
          parts.push(`**Last session** (${h}h ago, ${durMin}m): edited [${files}], patterns: [${pats}]`);
        }
      } catch (_) {}

      // BM25 search
      const results = db.searchMemory(prompt, limit);
      for (const r of results) {
        parts.push(`### ${r.title}\n${(r.body || '').slice(0, 480)}`);
      }

      return {
        content: [{
          type: 'text',
          text: parts.length > 0 ? parts.join('\n\n---\n\n') : 'No context found.',
        }],
      };
    }

    case 'list_skills': {
      const skillsDir = (cfg.paths && cfg.paths.user_skills_dir)
        ? cfg.paths.user_skills_dir.replace(/\//g, path.sep)
        : path.join(os.homedir(), '.claude', 'skills');

      let dirs = [];
      try {
        dirs = fs.readdirSync(skillsDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name)
          .sort();
      } catch (err) {
        return { content: [{ type: 'text', text: `Skills dir unavailable: ${err.message}` }] };
      }

      const skills = dirs.map(sName => {
        let desc = '';
        for (const fname of ['SKILL.md', 'skill.md', 'README.md']) {
          const fpath = path.join(skillsDir, sName, fname);
          if (!fs.existsSync(fpath)) continue;
          try {
            const content = fs.readFileSync(fpath, 'utf8').slice(0, 1000);
            const m = content.match(/^description:\s*(.+)$/m);
            if (m) { desc = m[1].trim(); break; }
            const lines = content.split('\n')
              .filter(l => l.trim() && !l.startsWith('---') && !l.startsWith('#'));
            if (lines.length) { desc = lines[0].slice(0, 120); break; }
          } catch (_) {}
        }
        return `**/${sName}**${desc ? ` — ${desc}` : ''}`;
      });

      return { content: [{ type: 'text', text: skills.join('\n') || 'No skills found.' }] };
    }

    case 'model_status': {
      const router = require('./model-router.cjs');
      const rows   = router.getStatusTable();
      if (!rows || rows.length === 0) {
        return { content: [{ type: 'text', text: 'No model performance data yet.' }] };
      }
      const lines = rows.map(r => {
        const pin     = r.pinned  ? ' 🔒' : '';
        const cur     = r.current ? ' ◀ active' : '';
        const rate    = r.verdicts_total > 0
          ? ` | ${r.approval_rate}% approval over ${r.verdicts_total} verdicts`
          : '';
        return `**${r.agent}${pin}** — ${r.model}${cur}${rate}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    case 'get_session_summary': {
      const project = String(args.project || path.basename(process.cwd()));
      const summary = db.getLatestSessionSummary(project);
      if (!summary) {
        return { content: [{ type: 'text', text: `No session summary for "${project}".` }] };
      }
      const h      = Math.round((Date.now() - new Date(summary.summary_at).getTime()) / 3600000);
      const files  = (summary.top_files || []).join(', ') || 'none';
      const pats   = (summary.patterns  || []).join(', ') || 'none';
      const dur    = Math.round((summary.duration_ms || 0) / 60000);
      const text   = [
        `**Project:** ${project}`,
        `**Last session:** ${h}h ago (${dur}m)`,
        `**Top files:** ${files}`,
        `**Patterns fired:** ${pats}`,
      ].join('\n');
      return { content: [{ type: 'text', text }] };
    }

    case 'search_vault_tools': {
      const toolsIndex = (cfg.paths && cfg.paths.vault_tools_index)
        ? cfg.paths.vault_tools_index.replace(/\//g, path.sep)
        : path.join(os.homedir(), 'vault', 'tools', 'index.md');

      if (!fs.existsSync(toolsIndex)) {
        return { content: [{ type: 'text', text: `Vault tools index not found: ${toolsIndex}` }] };
      }

      const content = fs.readFileSync(toolsIndex, 'utf8');
      const query   = String(args.query || '').toLowerCase();
      const terms   = query.split(/\s+/).filter(Boolean);

      const matches = content.split('\n').filter(line => {
        const lower = line.toLowerCase();
        return terms.length > 0 && terms.every(t => lower.includes(t));
      });

      return {
        content: [{
          type: 'text',
          text: matches.length > 0
            ? matches.slice(0, 25).join('\n')
            : `No tools matching "${args.query}".\nFull index: ${toolsIndex}`,
        }],
      };
    }

    case 'blast_radius': {
      const codeGraph = require('./code-graph.cjs');
      const file = String(args.file || '');
      if (!file) return { content: [{ type: 'text', text: 'Missing required arg: file' }] };
      const dependents = codeGraph.getBlastRadius(db, file, args.project || null);
      if (dependents.length === 0) {
        return { content: [{ type: 'text', text: `No dependents found for ${file}. Either it's not imported elsewhere or it hasn't been indexed (.cs/.ts/.tsx/.js/.jsx/.mjs/.cjs/.py only).` }] };
      }
      const lines = dependents.slice(0, 50).map(d => `- ${d.file}:${d.line} → "${d.target}"`);
      const more = dependents.length > 50 ? `\n…and ${dependents.length - 50} more` : '';
      return { content: [{ type: 'text', text: `**Blast radius for ${file}** (${dependents.length} dependents):\n\n${lines.join('\n')}${more}` }] };
    }

    case 'find_symbol': {
      const codeGraph = require('./code-graph.cjs');
      const query = String(args.name || '');
      if (!query) return { content: [{ type: 'text', text: 'Missing required arg: name' }] };
      const limit = Math.min(Math.max(1, Math.floor(args.limit || 20)), 100);
      const rows = codeGraph.searchSymbols(db, query, limit);
      if (rows.length === 0) {
        return { content: [{ type: 'text', text: `No symbol matches for "${query}".` }] };
      }
      const lines = rows.map(r => `- **${r.name}** (${r.kind}) — ${r.file}:${r.line} [${r.lang}]`);
      return { content: [{ type: 'text', text: `**Symbols matching "${query}"** (${rows.length}):\n\n${lines.join('\n')}` }] };
    }

    case 'file_symbols': {
      const codeGraph = require('./code-graph.cjs');
      const file = String(args.file || '');
      if (!file) return { content: [{ type: 'text', text: 'Missing required arg: file' }] };
      const rows = codeGraph.getSymbols(db, file);
      if (rows.length === 0) {
        return { content: [{ type: 'text', text: `No symbols indexed for ${file}. Edit it once or run npm run nightly to index.` }] };
      }
      const lines = rows.map(r => `- L${String(r.line).padStart(5)}  ${r.kind.padEnd(10)} ${r.name}`);
      return { content: [{ type: 'text', text: `**Symbols in ${file}** (${rows.length}):\n\n${lines.join('\n')}` }] };
    }

    case 'get_symbol_body': {
      const codeGraph = require('./code-graph.cjs');
      const file = String(args.file || '');
      const name = String(args.name || '');
      if (!file || !name) return { content: [{ type: 'text', text: 'Missing required args: file, name' }] };
      const maxLines = Math.min(Math.max(10, Math.floor(args.max_lines || 200)), 1000);
      const r = codeGraph.getSymbolBody(db, file, name, maxLines);
      if (!r) {
        return { content: [{ type: 'text', text: `Symbol "${name}" not found in ${file}. Run file_symbols to see what's indexed.` }] };
      }
      return { content: [{ type: 'text', text: `**${r.name}** in ${r.file} (lines ${r.start_line}-${r.end_line}):\n\n\`\`\`\n${r.body}\n\`\`\`` }] };
    }

    case 'find_callers': {
      const codeGraph = require('./code-graph.cjs');
      const name = String(args.name || '');
      if (!name) return { content: [{ type: 'text', text: 'Missing required arg: name' }] };
      const rows = codeGraph.getCallers(db, name, args.project || null);
      if (rows.length === 0) {
        return { content: [{ type: 'text', text: `No callers found for "${name}". Either it's unused or callsites haven't been indexed.` }] };
      }
      const lines = rows.slice(0, 50).map(r => `- ${r.caller_file}:${r.line} — in \`${r.caller_name}\` [${r.lang}]`);
      const more = rows.length > 50 ? `\n…and ${rows.length - 50} more` : '';
      return { content: [{ type: 'text', text: `**Callers of "${name}"** (${rows.length}):\n\n${lines.join('\n')}${more}` }] };
    }

    default:
      throw { code: -32601, message: `Unknown tool: ${name}` };
  }
}

// ── JSON-RPC 2.0 handler ──────────────────────────────────────────────────

async function handleMessage(msg) {
  const { jsonrpc, id, method, params } = msg;

  if (jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: id ?? null,
      error: { code: -32600, message: 'Invalid Request' } };
  }

  try {
    switch (method) {

      case 'initialize':
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'vaultflow', version: '1.3.0' },
          },
        };

      case 'initialized':
        return undefined; // notification — no response

      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

      case 'tools/call': {
        const toolName = (params && params.name)      || '';
        const toolArgs = (params && params.arguments) || {};
        const result   = await callTool(toolName, toolArgs);
        return { jsonrpc: '2.0', id, result };
      }

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      default:
        if (id !== undefined && id !== null) {
          return { jsonrpc: '2.0', id,
            error: { code: -32601, message: `Method not found: ${method}` } };
        }
        return undefined; // unknown notification — no response
    }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code: err.code || -32603, message: err.message || 'Internal error' },
    };
  }
}

// ── stdio transport ───────────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const response = await handleMessage(msg);
  if (response !== undefined) send(response);
});

rl.on('close', () => process.exit(0));

process.stderr.write('[vaultflow-mcp] server started\n');
