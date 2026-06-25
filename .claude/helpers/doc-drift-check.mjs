#!/usr/bin/env node
/**
 * doc-drift-check.mjs — verify CLAUDE.md claims against repo reality.
 *
 * CLAUDE.md is hand-written. The nightly job updates DATA (DB hygiene,
 * code graph, embeddings, Parquet). It does NOT touch DOCS. As features
 * land, the doc decays. This module compares machine-verifiable claims
 * in CLAUDE.md to what the filesystem says and reports the diffs so
 * the next session (or a future auto-rewrite step) can resync.
 *
 * Checks performed:
 *   1. Endpoint count           — `(N endpoints)` vs `app.(get|post|...)` count in server.mjs
 *   2. Skill directory count    — `N skill directories` vs subdir count under `.agents/skills/`
 *   3. Agent enabled/disabled   — `(N enabled / M disabled)` vs `.agents/config.toml`
 *   4. File-map drift           — helpers on disk vs helpers mentioned in CLAUDE.md File Map
 *
 * Usage:
 *   node .claude/helpers/doc-drift-check.mjs              # CLI report, exit code = drift count
 *   import { runDocDriftCheck } from './doc-drift-check.mjs'
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..');

function readClaudeMd(repoRoot) {
  const p = path.join(repoRoot, 'CLAUDE.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function countDashboardRoutes(repoRoot) {
  const p = path.join(repoRoot, '.claude', 'helpers', 'dashboard', 'server.mjs');
  if (!fs.existsSync(p)) return null;
  const src = fs.readFileSync(p, 'utf8');
  const matches = src.match(/\bapp\.(get|post|put|delete|patch)\s*\(/g);
  return matches ? matches.length : 0;
}

function listHelperFiles(repoRoot) {
  const dir = path.join(repoRoot, '.claude', 'helpers');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.isFile() && /\.(cjs|mjs|js)$/.test(e.name)) {
        out.push(path.relative(dir, fp).replace(/\\/g, '/'));
      }
    }
  })(dir);
  return out;
}

function countSkillDirs(repoRoot) {
  const dir = path.join(repoRoot, '.agents', 'skills');
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).length;
}

function readAgentToggleCounts(repoRoot) {
  const p = path.join(repoRoot, '.agents', 'config.toml');
  if (!fs.existsSync(p)) return null;
  const src = fs.readFileSync(p, 'utf8');
  return {
    enabled:  (src.match(/^\s*enabled\s*=\s*true/gmi)  || []).length,
    disabled: (src.match(/^\s*enabled\s*=\s*false/gmi) || []).length,
  };
}

function snippetAround(md, idx, len) {
  const start = Math.max(0, idx - 30);
  const end   = Math.min(md.length, idx + len + 30);
  return md.slice(start, end).replace(/\s+/g, ' ').trim();
}

export function check(repoRoot = DEFAULT_REPO_ROOT) {
  const md = readClaudeMd(repoRoot);
  if (!md) return { ok: false, error: 'CLAUDE.md not found', drifts: [], summary: {} };

  const drifts = [];

  // 1. Endpoint count claims
  const routes = countDashboardRoutes(repoRoot);
  if (routes != null) {
    const re = /\((\d+)\s+(?:read-only\s+API\s+)?endpoints?\)/gi;
    let m;
    while ((m = re.exec(md)) !== null) {
      const claimed = Number(m[1]);
      if (claimed !== routes) {
        drifts.push({
          section: 'endpoint-count',
          claim:   `${claimed} endpoints`,
          actual:  `${routes} routes in .claude/helpers/dashboard/server.mjs`,
          snippet: snippetAround(md, m.index, m[0].length),
        });
      }
    }
  }

  // 2. Skill directory count claims
  const skills = countSkillDirs(repoRoot);
  if (skills != null) {
    const re = /(\d+)\s+skill\s+director(?:y|ies)/gi;
    let m;
    while ((m = re.exec(md)) !== null) {
      const claimed = Number(m[1]);
      if (claimed !== skills) {
        drifts.push({
          section: 'skill-count',
          claim:   `${claimed} skill directories`,
          actual:  `${skills} directories in .agents/skills/`,
          snippet: snippetAround(md, m.index, m[0].length),
        });
      }
    }
  }

  // 3. Agent enabled / disabled toggle counts
  const agents = readAgentToggleCounts(repoRoot);
  if (agents != null) {
    // `(N enabled / M disabled)` form
    {
      const re = /\((\d+)\s+enabled\s*\/\s*(\d+)\s+disabled\)/gi;
      let m;
      while ((m = re.exec(md)) !== null) {
        const cE = Number(m[1]), cD = Number(m[2]);
        if (cE !== agents.enabled || cD !== agents.disabled) {
          drifts.push({
            section: 'agent-toggles',
            claim:   `${cE} enabled / ${cD} disabled`,
            actual:  `${agents.enabled} enabled / ${agents.disabled} disabled in .agents/config.toml`,
            snippet: snippetAround(md, m.index, m[0].length),
          });
        }
      }
    }
    // `(N enabled)` standalone form
    {
      const re = /\((\d+)\s+enabled\)(?!\s*\/)/gi;
      let m;
      while ((m = re.exec(md)) !== null) {
        const cE = Number(m[1]);
        if (cE !== agents.enabled) {
          drifts.push({
            section: 'agent-toggles',
            claim:   `${cE} enabled`,
            actual:  `${agents.enabled} enabled in .agents/config.toml`,
            snippet: snippetAround(md, m.index, m[0].length),
          });
        }
      }
    }
  }

  // 4. File-map drift — helpers on disk vs helpers named in CLAUDE.md File Map block.
  //
  // The File Map documents multiple top-level directories (.claude/helpers/,
  // config/, .agents/). We only want helper files, so we walk lines inside
  // the `.claude/helpers/` section only. Top-level sections start at column 0
  // and end with `/`; indented lines (including sub-folders like `dashboard/`)
  // are treated as members of the enclosing section.
  const fileMapMatch = md.match(/##\s*File Map[\s\S]*?```[\s\S]*?```/);
  if (fileMapMatch) {
    const block = fileMapMatch[0];
    const mentioned = new Set();
    let inHelpers = false;
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.replace(/\s+$/, '');
      if (!line || line.includes('```') || /^##/.test(line)) continue;
      // Column-0 top-level section header: a path ending in `/` with no leading
      // whitespace (e.g. `.claude/helpers/`, `config/`, `.agents/`).
      if (/^[\w./-]+\/$/.test(line)) {
        inHelpers = line.startsWith('.claude/helpers/');
        continue;
      }
      if (!inHelpers) continue;
      // File listing line: leading whitespace, then a basename.ext as the
      // first non-space token. Dots are allowed inside the name so multi-dot
      // vendored libs match (e.g. `chart.umd.min.js`, `markdown-it.min.js`).
      // The trailing `\b` after the final extension keeps `.json` from matching
      // `.js` (the `js` in `.json` is followed by a word char, so no boundary).
      const m = line.match(/^[ \t]+([a-z0-9][a-z0-9_.-]*\.(?:cjs|mjs|js))\b/i);
      if (m) mentioned.add(m[1].toLowerCase());
    }

    const onDisk = new Set(listHelperFiles(repoRoot).map(h => path.basename(h).toLowerCase()));

    const missingFromDoc  = [...onDisk].filter(b => !mentioned.has(b)).sort();
    const missingFromDisk = [...mentioned].filter(b => !onDisk.has(b)).sort();

    if (missingFromDoc.length) {
      drifts.push({
        section: 'file-map-missing-in-doc',
        claim:   `File Map mentions ${mentioned.size} helper file(s)`,
        actual:  `${onDisk.size} helper files exist; ${missingFromDoc.length} not documented`,
        items:   missingFromDoc,
      });
    }
    if (missingFromDisk.length) {
      drifts.push({
        section: 'file-map-missing-on-disk',
        claim:   `Doc references ${missingFromDisk.length} helper(s) that no longer exist`,
        actual:  `On-disk helper count: ${onDisk.size}`,
        items:   missingFromDisk,
      });
    }
  }

  return {
    ok: drifts.length === 0,
    drifts,
    summary: {
      endpoints:       routes,
      skill_dirs:      skills,
      agents,
      helpers_on_disk: listHelperFiles(repoRoot).length,
    },
  };
}

/**
 * Runs the check and (when metricsRoot is provided) writes a dated JSON
 * report to {metricsRoot}/doc-drift/doc-drift-{YYYY-MM-DD}.json so the
 * doctor command and dashboard can surface it.
 */
export function runDocDriftCheck(repoRoot = DEFAULT_REPO_ROOT, metricsRoot = null) {
  const result = check(repoRoot);
  if (metricsRoot) {
    try {
      const outDir = path.join(metricsRoot, 'doc-drift');
      fs.mkdirSync(outDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const payload = {
        date: today,
        generated_at: new Date().toISOString(),
        repo_root: repoRoot,
        ...result,
      };
      fs.writeFileSync(path.join(outDir, `doc-drift-${today}.json`), JSON.stringify(payload, null, 2), 'utf8');
      fs.writeFileSync(path.join(outDir, 'latest.json'),               JSON.stringify(payload, null, 2), 'utf8');
    } catch (_) { /* report write is best-effort */ }
  }
  return result;
}

// CLI entry point
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = runDocDriftCheck();
  if (result.error) {
    process.stderr.write(`doc-drift-check: ${result.error}\n`);
    process.exit(2);
  }
  if (result.ok) {
    process.stdout.write('CLAUDE.md is in sync with the repo. No drift detected.\n');
  } else {
    process.stdout.write(`Found ${result.drifts.length} drift(s) in CLAUDE.md:\n\n`);
    for (const d of result.drifts) {
      process.stdout.write(`  [${d.section}]\n`);
      process.stdout.write(`    claim:  ${d.claim}\n`);
      process.stdout.write(`    actual: ${d.actual}\n`);
      if (d.snippet) process.stdout.write(`    near:   "${d.snippet}"\n`);
      if (d.items && d.items.length) {
        const preview = d.items.slice(0, 12).join(', ');
        const more    = d.items.length > 12 ? ` (+${d.items.length - 12} more)` : '';
        process.stdout.write(`    items:  ${preview}${more}\n`);
      }
      process.stdout.write('\n');
    }
  }
  process.exit(result.ok ? 0 : 1);
}
