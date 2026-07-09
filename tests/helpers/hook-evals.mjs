import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../../.claude/helpers/db.cjs');
const skillReuse = require('../../.claude/helpers/skill-reuse.cjs');

function initDb() {
  const root = process.env.VAULTFLOW_METRICS_ROOT || null;
  db.initialize(root, null);
  return db.raw();
}

function readConfigSkillsDir() {
  try {
    const yaml = require('js-yaml');
    const cfgPath = require('../../config/resolve.cjs');
    if (!fs.existsSync(cfgPath)) return null;
    const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
    return cfg.paths && cfg.paths.user_skills_dir || null;
  } catch (_) {
    return null;
  }
}

export function evaluatePreRead(input) {
  const toolName = input && input.tool_name || '';
  const filePath = input && input.tool_input && input.tool_input.file_path;
  if (toolName !== 'Read' || !filePath || typeof filePath !== 'string') return null;

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 1500) return null;
  } catch (_) {}

  let raw;
  try {
    raw = initDb();
    if (!raw) return null;
  } catch (_) {
    return null;
  }

  const cutoff = new Date(Date.now() - 90 * 86400 * 1000).toISOString();
  const norm = filePath.replace(/\\/g, '/');
  const baseLike = path.basename(norm);

  let edits = [];
  try {
    edits = raw.prepare(`
      SELECT file_path, project, change_type, timestamp, session_id
      FROM   edit_events
      WHERE  (file_path = ? OR REPLACE(file_path,'\\','/') = ?)
        AND  timestamp >= ?
      ORDER  BY timestamp DESC
      LIMIT  ?
    `).all(filePath, norm, cutoff, 10);
  } catch (_) {}

  const seenSession = new Set();
  const uniqEdits = [];
  for (const e of edits) {
    if (!e.session_id || seenSession.has(e.session_id)) continue;
    seenSession.add(e.session_id);
    uniqEdits.push(e);
  }

  let memory = [];
  try {
    memory = raw.prepare(`
      SELECT title, body
      FROM   memory_entries
      WHERE  body LIKE ? OR title LIKE ?
      LIMIT  ?
    `).all(`%${baseLike}%`, `%${baseLike}%`, 3);
  } catch (_) {}

  let symCount = 0;
  let fileSize = 0;
  try {
    symCount = raw.prepare(
      `SELECT COUNT(*) AS n FROM code_symbols WHERE file = ? OR file = ?`
    ).get(filePath, filePath.replace(/\\/g, '/')).n || 0;
  } catch (_) {}
  try { fileSize = fs.statSync(filePath).size; } catch (_) {}

  if (uniqEdits.length === 0 && memory.length === 0 && symCount === 0) return null;

  const sessionId = input.session_id || (input.session && input.session.id) || null;
  const dedupPath = (() => {
    try {
      const yaml = require('js-yaml');
      const cfgPath = require('../../config/resolve.cjs');
      if (!fs.existsSync(cfgPath)) return null;
      const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
      const metrics = cfg.paths && cfg.paths.metrics_root;
      return metrics ? path.join(metrics, 'recent-injections.json') : null;
    } catch (_) { return null; }
  })();

  if (sessionId && dedupPath) {
    try {
      const state = fs.existsSync(dedupPath)
        ? JSON.parse(fs.readFileSync(dedupPath, 'utf8'))
        : {};
      const seen = state[sessionId] || {};
      if (seen[filePath]) return null;
      seen[filePath] = Date.now();
      state[sessionId] = seen;
      for (const k of Object.keys(state)) {
        if (k === sessionId) continue;
        const newest = Math.max(0, ...Object.values(state[k] || {}));
        if (Date.now() - newest > 24 * 3600 * 1000) delete state[k];
      }
      fs.writeFileSync(dedupPath, JSON.stringify(state), 'utf8');
    } catch (_) {}
  }

  const lines = [];
  lines.push(`vaultflow context for ${path.basename(filePath)}:`);
  if (uniqEdits.length) {
    const projectGuess = uniqEdits.find(e => e.project)?.project || '';
    if (projectGuess) lines.push(`  project: ${projectGuess}`);
    lines.push(`  recent activity (${uniqEdits.length} sessions):`);
    for (const e of uniqEdits) {
      lines.push(`    - ${e.change_type.padEnd(6)} ${new Date(e.timestamp).toISOString().slice(0, 10)}  (session ${String(e.session_id).slice(0, 8)})`);
    }
  }
  if (memory.length) {
    lines.push(`  related memory:`);
    for (const m of memory) {
      const snippet = String(m.body || '').replace(/\s+/g, ' ').slice(0, 120);
      lines.push(`    - ${m.title}: ${snippet}`);
    }
  }
  if (symCount >= 10 && fileSize > 5000) {
    lines.push(`  ${symCount} symbols indexed (${Math.round(fileSize / 1024)}KB).`);
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: lines.join('\n').slice(0, 1500),
    },
  };
}

export function evaluatePreEdit(input) {
  const toolName = input && input.tool_name || '';
  if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) return null;

  const tin = input.tool_input || {};
  const files = toolName === 'MultiEdit'
    ? [...new Set((tin.edits || []).map(e => e.file_path).filter(Boolean))]
    : (tin.file_path ? [tin.file_path] : []);
  if (files.length === 0) return null;

  let cg;
  let raw;
  try {
    raw = initDb();
    cg = require('../../.claude/helpers/code-graph.cjs');
  } catch (_) {
    return null;
  }

  const warnings = [];
  for (const fp of files) {
    try {
      if (!cg.shouldIndex(fp)) continue;
      const deps = cg.getBlastRadius(db, fp);
      if (!deps || deps.length < 10) continue;
      const top = deps.slice(0, 5).map(d => {
        const idx = Math.max(d.file.lastIndexOf('/'), d.file.lastIndexOf('\\'));
        const base = idx >= 0 ? d.file.slice(idx + 1) : d.file;
        return `  - ${base}:${d.line}`;
      });
      const more = deps.length > 5 ? `\n  ...and ${deps.length - 5} more` : '';
      warnings.push(
        `Hub file — ${fp} has ${deps.length} dependents in this project.\n` +
        `Before changing exported names/signatures, audit callers:\n` +
        top.join('\n') + more
      );
    } catch (_) {}
  }

  if (toolName === 'Write' && typeof tin.content === 'string') {
    try {
      const fp = tin.file_path;
      const looksLikeSkill = (() => {
        const np = String(fp || '').replace(/\\/g, '/').toLowerCase();
        if (!np.endsWith('.md')) return false;
        const fragments = ['.agents/skills/', '.claude/skills/'];
        const userSkillsDir = readConfigSkillsDir();
        if (userSkillsDir) {
          let frag = String(userSkillsDir).replace(/\\/g, '/').toLowerCase();
          if (!frag.endsWith('/')) frag += '/';
          fragments.push(frag);
        }
        return fragments.some(f => np.includes(f));
      })();

      if (looksLikeSkill && !fs.existsSync(fp)) {
        const m = tin.content.match(/^\s*name\s*:\s*(.+?)\s*$/m);
        const d = tin.content.match(/^\s*description\s*:\s*(.+?)\s*$/m);
        if (m && d) {
          const name = m[1].replace(/^["']|["']$/g, '').trim();
          const description = d[1].replace(/^["']|["']$/g, '').trim();
          const rows = db.searchVaultAgents(`${name} ${description}`, 6) || [];
          const matches = skillReuse.scoreSkillRows(`${name} ${description}`, rows)
            .filter(r => r.confidence >= skillReuse.MIN_CONFIDENCE)
            .slice(0, 3);
          if (matches.length) {
            warnings.push(
              `⚠ New skill "${name}" — reuse before building.\n` +
              `Closest existing skills (consider modifying one of these instead):\n` +
              matches.map(r =>
                `  • ${r.name} (${r.source})${r.description ? ` — ${String(r.description).slice(0, 160)}` : ''}`
              ).join('\n') + '\n' +
              `→ Run \`vaultflow find-skill "${description.slice(0, 80)}"\` or open the closest skill above. Build new only if none fit.`
            );
          } else {
            warnings.push(`✓ No close existing skill to "${name}" — OK to build new.`);
          }
        }
      }
    } catch (_) {}
  }

  if (warnings.length === 0) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: warnings.join('\n\n'),
    },
  };
}
