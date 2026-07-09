'use strict';

/**
 * pre-edit.cjs — PreToolUse(Edit|Write|MultiEdit) blast-radius warning.
 *
 * WHY: vaultflow's code-graph knows that some files are hubs (50+ dependents).
 * Editing those without auditing callers is the easiest way to ship breaking
 * changes. The data exists; the warning didn't. This hook injects a compact
 * warning into the agent's context BEFORE the edit is applied.
 *
 * Behaviour:
 *  - Only fires for Edit / Write / MultiEdit (NOT Read — pre-read.cjs handles that)
 *  - Looks up blast-radius via code-graph.cjs
 *  - If dependents >= THRESHOLD, injects a warning block listing the top 5
 *  - Always emits "permissionDecision: allow" — never blocks the edit
 *  - Silent for non-source files or low-blast-radius files
 *
 * Output: hookSpecificOutput JSON for PreToolUse, or empty for no-injection.
 */

const HUB_THRESHOLD = 10;

// Skills-dir path fragments. A Write whose normalized (forward-slash, lowercase)
// path contains one of these AND ends in .md is a skill-authoring write. The
// user skills dir is config-driven (cfg.paths.user_skills_dir) and appended at
// runtime. These two are project-relative and stable, so they're hardcoded.
const SKILL_DIR_FRAGMENTS = ['.agents/skills/', '.claude/skills/'];

/** Normalize a path for substring matching: forward slashes, lowercase. */
function normPath(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase();
}

/**
 * Cheap guard: is this Write targeting a markdown file under a skills dir?
 * Pure string ops — no fs, no db, no config parse. Keeps the common case
 * (ordinary file writes) near-zero cost.
 */
function looksLikeSkillWrite(filePath, userSkillsDir) {
  const np = normPath(filePath);
  if (!np.endsWith('.md')) return false;
  const fragments = SKILL_DIR_FRAGMENTS.slice();
  if (userSkillsDir) {
    let frag = normPath(userSkillsDir);
    if (!frag.endsWith('/')) frag += '/';
    fragments.push(frag);
  }
  return fragments.some(f => np.includes(f));
}

/**
 * Extract `name` and `description` from YAML frontmatter without a YAML dep.
 * Mirrors backfill.mjs parseFrontmatter's contract (first `---` block, the
 * `name:`/`description:` scalar lines). Returns null if either is missing.
 */
function parseSkillFrontmatter(content) {
  if (!content || !content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  const block = content.slice(3, end);
  const grab = (key) => {
    // LIMITATION: a YAML block scalar (`description: |` or `>`) captures only the
    // first line — for the `|`/`>` form that's just the indicator char. Such a
    // skill may not trip the gate (silent miss — never a crash).
    const m = block.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'im'));
    if (!m) return '';
    return m[1].replace(/^["']|["']$/g, '').trim();
  };
  const name = grab('name');
  const description = grab('description');
  if (!name || !description) return null;
  return { name, description };
}

/** Resolve config's user_skills_dir cheaply; null on any failure. */
function getUserSkillsDir() {
  try {
    const yaml = require('js-yaml');
    const fs   = require('fs');
    const cfgPath = require('../../config/resolve.cjs');
    if (!fs.existsSync(cfgPath)) return null;
    const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
    return (cfg.paths && cfg.paths.user_skills_dir) || null;
  } catch (_) { return null; }
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end',  () => resolve(raw));
  });
}

function noop() { process.exit(0); }

(async () => {
  let input;
  try { input = JSON.parse(await readStdin() || '{}'); }
  catch (_) { return noop(); }

  const toolName = input.tool_name || '';
  if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) return noop();

  // Resolve target file path(s). MultiEdit uses edits[].file_path; others use file_path.
  const tin = input.tool_input || {};
  const files = toolName === 'MultiEdit'
    ? [...new Set((tin.edits || []).map(e => e.file_path).filter(Boolean))]
    : (tin.file_path ? [tin.file_path] : []);
  if (files.length === 0) return noop();

  let cg, db;
  try {
    db = require('./db.cjs');
    // Honor VAULTFLOW_METRICS_ROOT (same test/headless seam cli-query.mjs uses);
    // falls back to config-resolved root when unset.
    db.initialize(process.env.VAULTFLOW_METRICS_ROOT || null, null);
    cg = require('./code-graph.cjs');
  } catch (_) { return noop(); }

  const warnings = [];
  for (const fp of files) {
    try {
      if (!cg.shouldIndex(fp)) continue; // Only warn about source files we'd index
      const deps = cg.getBlastRadius(db, fp);
      if (!deps || deps.length < HUB_THRESHOLD) continue;

      const top = deps.slice(0, 5).map(d => {
        const idx = Math.max(d.file.lastIndexOf('/'), d.file.lastIndexOf('\\'));
        const base = idx >= 0 ? d.file.slice(idx + 1) : d.file;
        return `  - ${base}:${d.line}`;
      });
      const more = deps.length > 5 ? `\n  …and ${deps.length - 5} more` : '';
      warnings.push(
        `⚠ **Hub file** — ${fp} has ${deps.length} dependents in this project.\n` +
        `Before changing exported names/signatures, audit callers:\n` +
        top.join('\n') + more
      );
    } catch (_) { /* skip this file */ }
  }

  // ── reuse-before-build gate for NEW skills (Write only) ────────────────────
  // Mirrors the vault-tools "search before you build" mandate for skills. Only
  // a Write of a brand-new markdown file under a skills dir, with name+description
  // frontmatter, trips this. The cheap path-substring guard runs first so the
  // GATE'S OWN extra I/O (fs.existsSync, the user-skills-dir config read, and
  // db.searchVaultAgents) is skipped for an ordinary file write. DB init itself
  // is NOT saved here — it already ran unconditionally above for the
  // blast-radius path, so it's a shared cost rather than gate-specific overhead.
  //
  // KNOWN LIMITATIONS (intentional — this gate is a best-effort nudge, not a
  // hard control):
  //   • Write of a NEW skill file only. Authoring a skill via Edit/MultiEdit
  //     into a pre-existing placeholder (e.g. a scaffolded empty SKILL.md) is
  //     NOT gated — the fs.existsSync check below skips files that already exist,
  //     and Edit/MultiEdit carry no full `content` to parse frontmatter from.
  //   • Those uncovered paths are covered upstream by the `search_skills` MCP
  //     tool, whose mandate is "ALWAYS call before creating a new skill" — that
  //     instruction applies regardless of whether the author uses Write or Edit.
  //   This gate hardens the most common path (a fresh Write); it does not try to
  //   be the sole enforcement point.
  if (toolName === 'Write' && typeof tin.content === 'string') {
    try {
      const fp = tin.file_path;
      const matchesProjectDir = looksLikeSkillWrite(fp, null);
      // Cache the project-dir result above; only fall through to the (costlier)
      // config read + second scan when the project dirs didn't already match.
      const userSkillsDir = matchesProjectDir ? null : getUserSkillsDir();
      if (matchesProjectDir || looksLikeSkillWrite(fp, userSkillsDir)) {
        const fs = require('fs');
        // New file only — editing/overwriting an existing skill isn't "authoring new".
        if (!fs.existsSync(fp)) {
          const fm = parseSkillFrontmatter(tin.content);
          if (fm) {
            const skillReuse = require('./skill-reuse.cjs');
            const rows = db.searchVaultAgents(`${fm.name} ${fm.description}`, 6) || [];
            const matches = skillReuse.scoreSkillRows(`${fm.name} ${fm.description}`, rows)
              .filter(r => r.confidence >= skillReuse.MIN_CONFIDENCE)
              .slice(0, 3);
            if (matches.length) {
              const list = matches.map(r =>
                `  • ${r.name} (${r.source})${r.description ? ` — ${String(r.description).slice(0, 160)}` : ''}`
              );
              warnings.push(
                `⚠ New skill "${fm.name}" — reuse before building.\n` +
                `Closest existing skills (consider modifying one of these instead):\n` +
                list.join('\n') + '\n' +
                `→ Run \`vaultflow find-skill "${fm.description.slice(0, 80)}"\` or open the closest skill above. Build new only if none fit.`
              );
            } else {
              warnings.push(`✓ No close existing skill to "${fm.name}" — OK to build new.`);
            }
          }
        }
      }
    } catch (_) { /* gate is best-effort — never block a write */ }
  }

  if (warnings.length === 0) return noop();

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName:      'PreToolUse',
      permissionDecision: 'allow',
      additionalContext:  warnings.join('\n\n') + '\n\nUse `mcp__vaultflow__blast_radius` for the full list before changing public surface area.',
    },
  }));
  process.exit(0);
})();
