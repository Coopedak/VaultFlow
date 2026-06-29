/**
 * agent-authoring.mjs — pure logic for the Agent Wizard feature.
 *
 * Creates the two-form representation of a new dev-team agent:
 *   - ~/.claude/agents/{slug}.md    (dispatch form, stack-tuned)
 *   - ~/.claude/skills/{slug}/SKILL.md  (skill form, multi-provider)
 * Then registers it in devteam-config.json and skills/index.md.
 *
 * WHY pure module with no Express: keeps logic testable in isolation —
 * tests inject a temp claudeDir and never touch the real ~/.claude.
 * The server.mjs /api/agents/* routes are thin wrappers over these exports.
 *
 * CJS/ESM note: this file is ESM (.mjs). server.mjs is ESM and imports
 * this directly. No require() of this file anywhere — only `await import()`.
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

// ── constants ──────────────────────────────────────────────────────────────

/**
 * Base directories derived at runtime relative to claudeDir.
 * Every function that touches the FS accepts an optional claudeDir param
 * (default: ~/.claude) so tests can inject a fresh temp dir.
 */
const HOME_CLAUDE = path.join(os.homedir(), '.claude');

function agentsBase(claudeDir = HOME_CLAUDE) {
  return path.join(claudeDir, 'agents');
}
function skillsBase(claudeDir = HOME_CLAUDE) {
  return path.join(claudeDir, 'skills');
}

const CONFIG_SCHEMA =
  'C:\\Users\\DCC\\vault\\dev-team\\config\\devteam-config.schema.json';

// ── validateSlug ───────────────────────────────────────────────────────────

/**
 * Valid slug: starts with lowercase letter, ends with lowercase-or-digit,
 * 3–50 chars total, interior chars are [a-z0-9-].
 * Rejects: empty, dots, slashes, uppercase, leading/trailing hyphen.
 *
 * @param {string} s
 * @returns {boolean}
 */
export function validateSlug(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  return /^[a-z][a-z0-9-]{1,48}[a-z0-9]$/.test(s);
}

// ── assertSafe ─────────────────────────────────────────────────────────────

/**
 * Throw a 400-status error if `resolved` is not safely inside `base`.
 * Prevents path-traversal attacks (e.g. slug "../../evil").
 *
 * @param {string} resolved  Absolute resolved path (e.g. from path.resolve)
 * @param {string} base      The allowed base directory
 * @throws {{message, status:400}} if traversal detected
 */
export function assertSafe(resolved, base) {
  if (resolved === base || resolved.startsWith(base + path.sep)) return;
  throw Object.assign(new Error('Path traversal rejected'), { status: 400 });
}

// ── renderSkillMd ──────────────────────────────────────────────────────────

/**
 * Render the SKILL.md file body per ARCHITECTURE §3 schema.
 *
 * @param {object} opts
 * @param {string} opts.name           kebab-case slug
 * @param {string} opts.role           Human-readable role title (e.g. "Performance Reviewer")
 * @param {string} opts.description    One-paragraph description for the frontmatter
 * @param {string} opts.model          Model shorthand or tier (e.g. "sonnet", "Mid")
 * @param {string} [opts.domain]       What the agent owns / is responsible for
 * @param {string} [opts.boundaries]   What the agent does NOT do
 * @param {string} [opts.orientation]  How to orient (project-specific hints)
 * @param {string} [opts.doneCriteria] Completion / report-back contract
 * @returns {string}
 */
export function renderSkillMd({
  name,
  role,
  description,
  model,
  domain        = 'Defined during implementation.',
  boundaries    = 'Does not touch files outside its assigned layer.',
  orientation   = 'Read CLAUDE.md, then find 1-2 matching existing files as pattern guides.',
  doneCriteria  = 'All acceptance criteria met. Build passes. Report: files changed + build status.',
}) {
  const today = new Date().toISOString().slice(0, 10);
  // Plain-scalar positions (name, model) must never contain raw newlines —
  // they would produce invalid YAML and silently break skill loading.
  // The description uses a `>` block-scalar so its internal newlines are fine,
  // but we still normalise it for the indented block form.
  const safeName  = String(name  || '').replace(/\n/g, ' ').trim();
  const safeModel = String(model || '').replace(/\n/g, ' ').trim();
  const title     = (role ? String(role).replace(/\n/g, ' ').trim() : null) || safeName;

  return `---
name: ${safeName}
metadata:
  version: "1.3.3"
  bundle:  "dev-team"
  author:  "vaultflow-wizard"
  updated: "${today}"
description: >
  ${String(description || '').trim().replace(/\n/g, '\n  ')}
---

# ${title} Agent

## Agent Identity

You are the **${title}**. Begin every response with \`**[${title}]**\`.

You exist as part of the dev-team multi-agent pipeline. The Project Manager (PM)
dispatches you with a specific task; return your result as a structured report so
the PM can gate, review, and chain it.

## Model Configuration

Tier configured in \`devteam-config.json → agent_models.${safeName}\`.
Default: ${safeModel}.

Run at the configured tier — do not escalate or downgrade without PM direction.

## Your Domain

${domain.trim()}

## You do NOT

${boundaries.trim()}

Do not expand scope silently. If you discover work outside your assignment, flag it
in your report rather than doing it.

## How to orient

${orientation.trim()}

1. Read \`CLAUDE.md\` in the project root — tech stack, run commands, critical rules.
2. Read \`.claude/PROJECT-PROFILE.md\` for confirmed patterns and gotchas (if present).
3. Find 1-2 existing files that match what you are building; use them as the pattern.
4. Understand the acceptance criteria fully before writing a single line.

## Definition of done

${doneCriteria.trim()}

- Code compiles / lints with 0 errors.
- Naming and style match existing project conventions.
- No hardcoded values that should be configurable.
- Report back: files changed + line counts + build/test status.
`;
}

// ── renderAgentMd ──────────────────────────────────────────────────────────

/**
 * Render the agents/{slug}.md dispatch file per ARCHITECTURE §4 skeleton.
 * The stack param (from detectStacks) is injected into the orientation section
 * so the agent knows the active project's tech context.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.role
 * @param {string} opts.description   Frontmatter description (1-2 sentences)
 * @param {string} opts.model
 * @param {string} [opts.domain]
 * @param {string} [opts.boundaries]
 * @param {string} [opts.orientation]
 * @param {string} [opts.doneCriteria]
 * @param {Array<{key:string,confidence:number}>} [opts.stack]  detectStacks output
 * @returns {string}
 */
export function renderAgentMd({
  name,
  role,
  description,
  model,
  domain        = 'Defined during implementation.',
  boundaries    = 'Does not touch files outside its assigned layer.',
  orientation   = 'Read CLAUDE.md, then find 1-2 matching existing files as pattern guides.',
  doneCriteria  = 'All acceptance criteria met. Build passes. Report: files changed + build status.',
  stack         = [],
}) {
  // All plain-scalar frontmatter values must have raw newlines collapsed to a
  // single space — a multi-line plain scalar produces invalid YAML and Claude
  // Code will silently refuse to load the agent file.
  const safeName  = String(name        || '').replace(/\n/g, ' ').trim();
  const safeDesc  = String(description || '').replace(/\n/g, ' ').trim();
  const safeModel = String(model       || '').replace(/\n/g, ' ').trim();
  const title     = (role ? String(role).replace(/\n/g, ' ').trim() : null) || safeName;

  // Format detected stack keys into orientation context.
  const stackLines = stack.length > 0
    ? stack.map(s => `  - ${s.key} (confidence: ${(s.confidence * 100).toFixed(0)}%)`).join('\n')
    : '  - (no stack detected — check CLAUDE.md)';

  return `---
name: ${safeName}
description: ${safeDesc}
model: ${safeModel}
---

# ${title} Agent

**Role:** ${safeDesc}

**Identity:** Begin every response with \`**[${title}]**\`

## Your Domain

${domain.trim()}

## You do NOT

${boundaries.trim()}

Do not expand scope silently. Flag out-of-scope discoveries in your report.

## How to orient

1. Read \`CLAUDE.md\` in the project root — tech stack, run commands, critical rules.
2. Read \`.claude/PROJECT-PROFILE.md\` for confirmed patterns and gotchas (if present).
3. Find 1-2 existing files that match what you are building; match their exact style.

**Detected project stack (at agent creation time):**
${stackLines}

${orientation.trim()}

## Definition of done

${doneCriteria.trim()}

- Build/tests pass with 0 errors.
- Naming follows project conventions.
- Report back: files changed + line counts + build status.
- Contract/dependency section included if this task crosses layers.
`;
}

// ── mergeAgentIntoConfig ───────────────────────────────────────────────────

/**
 * Read ~/.claude/devteam-config.json, add the new agent's model entry (and
 * optional tech stack entry), preserve ALL other keys, write back.
 *
 * Safe-merge rules:
 *   - Deep objects (agent_models, tech_stacks, pipeline, token_budgets, etc.)
 *     are updated by adding/overwriting only the new agent's key.
 *   - Array-valued keys are NEVER touched (arrays replace in the 3-tier merge;
 *     we only need to add a new keyed entry, never modify an array).
 *   - Scalar root keys (_comment, config_tier, config_version) are preserved.
 *   - $schema is always set to the canonical vault path.
 *
 * @param {object} opts
 * @param {string} opts.slug
 * @param {string} opts.model
 * @param {object|null} [opts.techStackEntry]  Optional tech_stacks entry
 * @param {string} [opts.claudeDir]
 */
export function mergeAgentIntoConfig({
  slug,
  model,
  techStackEntry = null,
  claudeDir = HOME_CLAUDE,
}) {
  const configPath = path.join(claudeDir, 'devteam-config.json');

  // Seed skeleton if file missing; surface parse errors as 400 (not opaque 500).
  let cfg = { config_version: '1.3.3', config_tier: 'user' };
  if (fs.existsSync(configPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      throw Object.assign(
        new Error('devteam-config.json is malformed: ' + e.message),
        { status: 400 },
      );
    }
  }

  // Always normalise $schema to the canonical path.
  cfg.$schema = CONFIG_SCHEMA;

  // Add the new agent model entry — never replace the whole agent_models object.
  if (!cfg.agent_models || typeof cfg.agent_models !== 'object' || Array.isArray(cfg.agent_models)) {
    cfg.agent_models = {};
  }
  cfg.agent_models[slug] = model;

  // Optional tech stack entry.
  if (techStackEntry != null) {
    if (!cfg.tech_stacks || typeof cfg.tech_stacks !== 'object' || Array.isArray(cfg.tech_stacks)) {
      cfg.tech_stacks = {};
    }
    cfg.tech_stacks[slug] = techStackEntry;
  }

  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

// ── registerInSkillsIndex ──────────────────────────────────────────────────

/**
 * Append a new row to the "Dev-Team Pipeline Agents" table in
 * ~/.claude/skills/index.md.  Idempotent — skips if the slug row exists.
 *
 * The table block is identified by its header line
 *   `## Dev-Team Pipeline Agents`
 * followed by a markdown table.  The new row is inserted after the last
 * `|…|` row inside that table (before the next blank line or next `##`).
 *
 * @param {object} opts
 * @param {string} opts.slug
 * @param {string} opts.description
 * @param {string} [opts.claudeDir]
 */
export function registerInSkillsIndex({ slug, description, claudeDir = HOME_CLAUDE }) {
  const indexPath = path.join(claudeDir, 'skills', 'index.md');
  if (!fs.existsSync(indexPath)) return; // silently skip if index absent

  const content = fs.readFileSync(indexPath, 'utf8');

  // Idempotent guard: bail if this slug already appears in the file.
  if (content.includes(`[${slug}]`)) return;

  const lines    = content.split('\n');
  const newRow   = `| [${slug}](${slug}/SKILL.md) | ${description} |`;

  // Find the "Dev-Team Pipeline Agents" section header.
  const headerIdx = lines.findIndex(l => l.trim() === '## Dev-Team Pipeline Agents');
  if (headerIdx === -1) {
    // Section not found — append at EOF as a safe fallback.
    const appended = content.trimEnd() + '\n' + newRow + '\n';
    fs.writeFileSync(indexPath, appended, 'utf8');
    return;
  }

  // Walk forward from the header to find the last `|` row in this table block.
  // Stop at the next `##` heading or at EOF.
  let lastTableRow = -1;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('##')) break; // next section
    if (trimmed.startsWith('|'))  lastTableRow = i;
  }

  if (lastTableRow === -1) {
    // Table header found but no rows yet — insert after the section header.
    lines.splice(headerIdx + 1, 0, newRow);
  } else {
    lines.splice(lastTableRow + 1, 0, newRow);
  }

  fs.writeFileSync(indexPath, lines.join('\n'), 'utf8');
}

// ── createAgent ────────────────────────────────────────────────────────────

/**
 * Orchestrate the full agent creation flow:
 *   validateSlug → path resolution + assertSafe → collision check →
 *   mkdirSync → write agents/{slug}.md + skills/{slug}/SKILL.md →
 *   mergeAgentIntoConfig → registerInSkillsIndex
 *
 * @param {object} opts
 * @param {string}  opts.slug
 * @param {string}  opts.role
 * @param {string}  opts.description
 * @param {string}  opts.model
 * @param {string}  [opts.domain]
 * @param {string}  [opts.boundaries]
 * @param {string}  [opts.orientation]
 * @param {string}  [opts.doneCriteria]
 * @param {Array}   [opts.stack]          detectStacks output
 * @param {object}  [opts.techStackEntry]
 * @param {boolean} [opts.overwrite=false]
 * @param {string}  [opts.claudeDir]
 *
 * @returns {{ files: string[] }}
 * @throws On slug validation failure (status 400), path traversal (status 400),
 *         or collision without overwrite (status 409).
 */
export async function createAgent(opts) {
  const {
    slug,
    role,
    description,
    model         = 'sonnet',
    domain,
    boundaries,
    orientation,
    doneCriteria,
    stack         = [],
    techStackEntry = null,
    overwrite     = false,
    claudeDir     = HOME_CLAUDE,
  } = opts || {};

  // 1. Validate slug.
  if (!validateSlug(slug)) {
    throw Object.assign(
      new Error(`Invalid slug "${slug}". Must match ^[a-z][a-z0-9-]{1,48}[a-z0-9]$`),
      { status: 400 },
    );
  }

  // 2. Compute resolved paths and assert no traversal.
  const AGENTS_BASE = agentsBase(claudeDir);
  const SKILLS_BASE = skillsBase(claudeDir);

  const agentPath = path.resolve(AGENTS_BASE, `${slug}.md`);
  const skillDir  = path.resolve(SKILLS_BASE, slug);
  const skillPath = path.join(skillDir, 'SKILL.md');

  assertSafe(agentPath, AGENTS_BASE);
  assertSafe(skillDir,  SKILLS_BASE);

  // 3. Collision check.
  const agentExists = fs.existsSync(agentPath);
  const skillExists = fs.existsSync(skillPath);
  if ((agentExists || skillExists) && !overwrite) {
    throw Object.assign(
      new Error(`Agent "${slug}" already exists.`),
      {
        status: 409,
        existing: {
          agent: agentExists ? agentPath : null,
          skill: skillExists ? skillPath : null,
        },
      },
    );
  }

  // 4. Ensure directories exist.
  fs.mkdirSync(AGENTS_BASE, { recursive: true });
  fs.mkdirSync(skillDir,    { recursive: true });

  // 5. Render and write files.
  const renderOpts = { name: slug, role, description, model, domain, boundaries, orientation, doneCriteria };

  const agentMd = renderAgentMd({ ...renderOpts, stack });
  const skillMd = renderSkillMd(renderOpts);

  fs.writeFileSync(agentPath, agentMd, 'utf8');
  fs.writeFileSync(skillPath, skillMd, 'utf8');

  // 6. Register in config + index.
  mergeAgentIntoConfig({ slug, model, techStackEntry, claudeDir });
  registerInSkillsIndex({ slug, description, claudeDir });

  return { files: [agentPath, skillPath] };
}
