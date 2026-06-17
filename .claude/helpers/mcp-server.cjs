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

// ── search helpers ────────────────────────────────────────────────────────

/**
 * Reciprocal Rank Fusion across heterogeneous ranked source lists.
 * Each source provides its own top-N (already sorted, best first). RRF only
 * uses rank position — score scales across sources are incomparable in raw form.
 *
 *   rrf(doc) = Σ over sources where doc appears of 1 / (k + rank_in_source)
 *
 * k=60 is the standard from Cormack & Buettcher (2009) — prevents the top
 * result of any single source from dominating, while still rewarding cross-
 * source agreement strongly. Higher rrf score = more relevant.
 *
 * @param {Array<Array<{_docId:string}>>} sourceLists  per-source results, sorted best-first
 * @param {number} k  RRF constant (default 60)
 * @returns merged list of {…originalFields, _rrfScore} sorted by _rrfScore desc
 */
function mergeRRF(sourceLists, k = 60) {
  const scores = new Map(); // docId -> { score, item }
  for (const list of sourceLists) {
    if (!Array.isArray(list)) continue;
    list.forEach((item, idx) => {
      if (!item || !item._docId) return;
      const contribution = 1 / (k + idx + 1);
      const existing = scores.get(item._docId);
      if (existing) {
        existing.score += contribution;
      } else {
        scores.set(item._docId, { score: contribution, item });
      }
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ score, item }) => ({ ...item, _rrfScore: score }));
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
    name: 'search_skills',
    description:
      'Search existing skills before authoring a NEW skill. ALWAYS call this ' +
      'before creating a new skill — reuse or modify an existing one rather than ' +
      'building from scratch. Skills are the skill-equivalent of vault tools: ' +
      'agents, pipelines, and procedures registered in vault_agents. Returns ' +
      'ranked matches with an advisory REUSE / MODIFY / BUILD-NEW-OK verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the new skill would do (task, capability, or description fragment)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
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
    name: 'unified_search',
    description:
      'One search across memory, code symbols, git commits, prompts, and the ' +
      'dictionary — returned as a single ranked list. Use this FIRST when you ' +
      'are not sure where the answer lives. Saves multiple round-trips.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results per source (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_commits',
    description:
      'Full-text search over indexed git commit messages across all projects. ' +
      'Use when you want to know "why did we do X?" — commit messages are the ' +
      'densest record of intent.',
    inputSchema: {
      type: 'object',
      properties: {
        query:   { type: 'string', description: 'FTS5 query' },
        limit:   { type: 'number', description: 'Max results (default 10)' },
        project: { type: 'string', description: 'Optional project filter' },
      },
      required: ['query'],
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
  {
    name: 'impact',
    description:
      'Change-impact report for a file or symbol: DOWNSTREAM consumers a change ' +
      'could break, UPSTREAM dependencies a root cause could come from, and which ' +
      'cataloged FLOWS the change reaches (classified affected / handoff / verify, ' +
      'with the human-curated user_notes surfaced). Use BEFORE editing to see what ' +
      'breaks, or in debug mode to point root-cause investigation upstream. ' +
      'APPROXIMATE — bare-name call graph; curated flows/user_notes are more trustworthy.',
    inputSchema: {
      type: 'object',
      properties: {
        file:    { type: 'string', description: 'Path to the changed file (file-level impact)' },
        symbol:  { type: 'string', description: 'Symbol name (function/class) — finer-grained impact' },
        project: { type: 'string', description: 'Optional project filter (auto-scoped from the symbol/file)' },
        mode:    { type: 'string', enum: ['impact', 'debug'], description: "'impact' (default) or 'debug' (emphasize root-cause direction)" },
      },
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

    case 'search_skills': {
      const skillReuse = require('./skill-reuse.cjs');
      const query = String(args.query || '').trim();
      if (!query) return { content: [{ type: 'text', text: 'Missing required arg: query' }] };
      const limit = Math.min(Math.max(1, Math.floor(args.limit || 10)), 25);

      const rows   = db.searchVaultAgents(query, limit) || [];
      const scored = skillReuse.scoreSkillRows(query, rows);

      // BM25 ranks; overlap only buckets. Render in BM25 order with the verdict.
      const lines = scored.map(r =>
        `[${r.verdict}] ${r.name} (${r.source})${r.description ? ` — ${String(r.description).slice(0, 200)}` : ''}`
      );

      const noStrongMatch = scored.length === 0 || scored.every(r => r.verdict === 'BUILD-NEW-OK');
      const thin = scored.length > 0 && scored.length < 3;

      const header = scored.length
        ? `**Existing skills for "${query}"** (${scored.length}, verdict is advisory — BM25-ranked):`
        : `No existing skills matched "${query}".`;

      const footer = [];
      if (thin) footer.push('_Note: few results — the registry may be thin for this query._');
      if (noStrongMatch) footer.push('No strong match — OK to build new.');

      const text = [header, ...lines, ...(footer.length ? ['', ...footer] : [])].join('\n');
      return { content: [{ type: 'text', text }] };
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

    case 'unified_search': {
      const q = String(args.query || '').trim();
      const limit = Math.min(Math.max(1, Math.floor(args.limit || 5)), 20);
      if (!q) return { content: [{ type: 'text', text: 'Empty query' }] };

      // Fetch each source's top-N independently. RRF only needs rank position.
      const sourceLists = [];
      const fetchedAt = Date.now();
      try {
        const mem = db.searchMemory(q, limit) || [];
        sourceLists.push(mem.map(r => ({
          _source: 'memory',
          _docId: `memory:${r.id || r.title}`,
          _render: `- **${r.title}** — ${r.source}\n  ${String(r.body || '').slice(0, 200)}`,
        })));
      } catch (_) {}
      try {
        const cg = require('./code-graph.cjs');
        const syms = cg.searchSymbols(db, q, limit) || [];
        sourceLists.push(syms.map(s => ({
          _source: 'symbol',
          _docId: `symbol:${s.file}:${s.name}`,
          _render: `- \`${s.name}\` (${s.kind}) — ${s.file}:${s.line}`,
        })));
      } catch (_) {}
      try {
        const ci = require('./commit-indexer.cjs');
        const cm = ci.searchCommits(db, q, limit) || [];
        sourceLists.push(cm.map(c => ({
          _source: 'commit',
          _docId: `commit:${c.sha}`,
          _render: `- \`${c.sha.slice(0, 7)}\` [${c.project}] ${c.subject}`,
        })));
      } catch (_) {}
      try {
        const dict = db.searchDictionary ? (db.searchDictionary(q, limit) || []).filter(d => d.category !== 'pattern') : [];
        sourceLists.push(dict.map(d => ({
          _source: 'dictionary',
          _docId: `dict:${d.id || d.term}`,
          _render: `- **${d.term}** (${d.category}) — ${String(d.definition || '').slice(0, 160)}`,
        })));
      } catch (_) {}
      try {
        const tools = db.searchVaultTools ? (db.searchVaultTools(q, limit) || []) : [];
        sourceLists.push(tools.map(t => ({
          _source: 'tool',
          _docId: `tool:${t.id || t.name}`,
          _render: `- **${t.name}** — ${t.description || ''}`,
        })));
      } catch (_) {}
      try {
        const skills = db.searchVaultAgents ? (db.searchVaultAgents(q, limit) || []) : [];
        sourceLists.push(skills.map(r => ({
          _source: 'skill',
          _docId: `skill:${r.agent_id}`,
          _render: `- **${r.name}** — ${r.description || ''}`,
        })));
      } catch (_) {}

      // 6th source: semantic symbol search. Cosine over symbol_embeddings —
      // finds code whose intent matches the query even without keyword overlap.
      // Heavier than the other sources (one embed call + N cosines), so the
      // _await_ here adds latency but it's parallelizable in a future refactor.
      try {
        const emb = await import('./embeddings.mjs');
        const syms = await emb.semanticSymbolSearch(q, { limit, threshold: 0.25 });
        sourceLists.push(syms.map(s => ({
          _source: 'symbol-semantic',
          _docId: `symbol-sem:${s.file}:${s.name}`,
          _render: `- 🧠 \`${s.name}\` (${s.kind}) — ${s.file} (cos=${s.score.toFixed(2)})`,
        })));
      } catch (_) { /* silent — emb may be unavailable */ }

      // RRF merge: rrf(d) = Σ over sources where d appears of 1 / (k + rank_in_source)
      // k=60 is the standard, prevents top-1 items from dominating.
      const merged = mergeRRF(sourceLists, 60);

      // Diagnostics — log to stderr; also attach as trailing metadata
      const top5 = merged.slice(0, 5);
      const sourcesInTop5 = new Set(top5.map(r => r._source)).size;
      const mergeMs = Date.now() - fetchedAt;
      process.stderr.write(
        `[vaultflow-mcp] unified_search rrf q="${q.slice(0,60)}" ` +
        `sources=${sourceLists.length} merged=${merged.length} ` +
        `sources_in_top5=${sourcesInTop5} ms=${mergeMs}\n`
      );

      if (!merged.length) {
        return { content: [{ type: 'text', text: `No results across memory, symbols, commits, dictionary, or vault tools for "${q}".` }] };
      }

      const body = merged.slice(0, limit).map((r, i) => {
        const tag = `[${r._source}]`;
        return r._render.replace(/^- /, `- ${tag} `);
      }).join('\n');
      const text = `# Unified search: "${q}" (RRF, ${sourcesInTop5} sources in top 5)\n\n${body}`;
      return { content: [{ type: 'text', text }] };
    }

    case 'search_commits': {
      const ci = require('./commit-indexer.cjs');
      const q = String(args.query || '');
      if (!q) return { content: [{ type: 'text', text: 'Missing required arg: query' }] };
      const limit = Math.min(Math.max(1, Math.floor(args.limit || 10)), 50);
      const rows = ci.searchCommits(db, q, limit);
      const filtered = args.project ? rows.filter(r => r.project === args.project) : rows;
      if (filtered.length === 0) {
        return { content: [{ type: 'text', text: `No commit matches for "${q}".` }] };
      }
      const lines = filtered.map(c => `- \`${c.sha.slice(0,7)}\` [${c.project}] ${c.committed_at ? c.committed_at.slice(0,10) + ' ' : ''}${c.subject}${c.body_preview ? '\n    ' + c.body_preview.split('\n')[0].slice(0,140) : ''}`);
      return { content: [{ type: 'text', text: `**Commits matching "${q}"** (${filtered.length}):\n\n${lines.join('\n')}` }] };
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

    case 'impact': {
      const fi = require('./flow-impact.cjs');
      const file = args.file ? String(args.file) : null;
      const symbol = args.symbol ? String(args.symbol) : null;
      if (!file && !symbol) {
        return { content: [{ type: 'text', text: 'Missing required arg: provide file and/or symbol.' }] };
      }
      const rep = fi.analyzeImpact(db, {
        file,
        symbol,
        project: args.project || null,
        mode: args.mode === 'debug' ? 'debug' : 'impact',
      });
      return { content: [{ type: 'text', text: fi.renderImpact(rep) }] };
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
