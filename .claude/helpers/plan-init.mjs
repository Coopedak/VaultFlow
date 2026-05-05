/**
 * plan-init.mjs — vaultflow project-lift plan scaffolder
 *
 * Creates a structured plan.md for a new project-lift task.
 * Won't overwrite an existing plan. Lists plans with --list.
 *
 * Usage:
 *   node .claude/helpers/plan-init.mjs "Refactor auth layer"
 *   node .claude/helpers/plan-init.mjs --list
 *   npm run plan "Refactor auth layer"
 *   npm run plan:dir
 *
 * Output: writes plans/YYYY-MM-DD-{slug}.md and prints the path.
 */

import { createRequire } from 'node:module';
import path              from 'node:path';
import fs                from 'node:fs';
import os                from 'node:os';

const require   = createRequire(import.meta.url);
const yaml      = require('js-yaml');

// ── config ────────────────────────────────────────────────────────────────

const CONFIG_PATH = require('../../config/resolve.cjs');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try { return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; }
  catch (_) { return {}; }
}

const cfg      = loadConfig();
const METRICS  = cfg.paths?.metrics_root || path.join(os.homedir(), 'vault', 'methodology', '.metrics');
const PLANS_DIR = path.join(METRICS, 'plans');

// ── helpers ───────────────────────────────────────────────────────────────

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── list mode ─────────────────────────────────────────────────────────────

function listPlans() {
  if (!fs.existsSync(PLANS_DIR)) {
    console.log('No plans directory yet. Create one with: npm run plan "Plan title"');
    return;
  }
  const files = fs.readdirSync(PLANS_DIR)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.log('No plans yet. Create one with: npm run plan "Plan title"');
    return;
  }

  console.log(`\nvaultflow plans (${PLANS_DIR})\n${'─'.repeat(50)}`);
  for (const f of files) {
    const fullPath = path.join(PLANS_DIR, f);
    const content  = fs.readFileSync(fullPath, 'utf8');
    // Extract status from frontmatter
    const statusMatch = content.match(/^status:\s*(.+)$/m);
    const status = statusMatch ? statusMatch[1].trim() : 'unknown';
    const icon = status === 'complete' ? '✓' : status === 'in-progress' ? '→' : '○';
    console.log(`  ${icon}  ${f.replace('.md', '')}  [${status}]`);
  }
  console.log('');
}

// ── create mode ───────────────────────────────────────────────────────────

function createPlan(title) {
  fs.mkdirSync(PLANS_DIR, { recursive: true });

  const date     = today();
  const slug     = slugify(title);
  const fileName = `${date}-${slug}.md`;
  const filePath = path.join(PLANS_DIR, fileName);

  if (fs.existsSync(filePath)) {
    console.error(`Plan already exists: ${filePath}`);
    console.error('Edit it directly or choose a different title.');
    process.exit(1);
  }

  const content = [
    `---`,
    `title: "${title}"`,
    `date: ${date}`,
    `status: draft`,
    `scale: project-lift`,
    `---`,
    ``,
    `# ${title}`,
    ``,
    `## Context`,
    ``,
    `> Why are we doing this? What problem does it solve?`,
    ``,
    `## Research Findings`,
    ``,
    `> Fill after researcher + voice-of-reason RESEARCH COMPLETE.`,
    ``,
    `- `,
    ``,
    `## Task List`,
    ``,
    `> Fill after Plan agent + voice-of-reason PLAN APPROVED.`,
    ``,
    `| # | Task | Agent | Status | Files |`,
    `|---|------|-------|--------|-------|`,
    `| 1 |  |  | pending |  |`,
    ``,
    `## Execution Log`,
    ``,
    `> One line per agent completion: date, agent, verdict, what changed.`,
    ``,
    `| Date | Agent | Verdict | Notes |`,
    `|------|-------|---------|-------|`,
    ``,
    `## Decisions`,
    ``,
    `> Architectural or scope decisions made during this plan.`,
    ``,
    `- `,
    ``,
    `## Open Items`,
    ``,
    `- `,
    ``,
    `## Completion Criteria`,
    ``,
    `- [ ] All tasks in Task List have status: complete`,
    `- [ ] voice-of-reason issued final APPROVED`,
    `- [ ] reviewer-code signed off`,
    `- [ ] Changes committed`,
  ].join('\n');

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Created: ${filePath}`);
  return filePath;
}

// ── entry point ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--list') || args.includes('list') || args.length === 0) {
  listPlans();
} else {
  const title = args.filter(a => !a.startsWith('--')).join(' ').trim();
  if (!title) {
    console.error('Usage: plan-init.mjs "Plan title"  or  plan-init.mjs --list');
    process.exit(1);
  }
  createPlan(title);
}
