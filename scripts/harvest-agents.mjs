#!/usr/bin/env node
/**
 * harvest-agents.mjs — collect per-project Claude Code agents into ~/.claude/agents
 * so they are available in EVERY project instead of only the one they live in.
 *
 * WHY: agents authored inside a project's .claude/agents/ work only in that
 * project. In practice the same agent gets copy-pasted between repos
 * (branch-vault-sync existed in 11), while newly-created projects start with
 * none — so a library of 45 agents produced zero reuse in day-to-day work.
 * ~/.claude/agents is user-global: install once, dispatch anywhere.
 *
 * Conflict handling — the reason this is a script and not a `cp`:
 *   - Identical copies of one name collapse silently (byte-compared).
 *   - DRIFTED copies are genuinely different agents that share a name, usually
 *     because each was specialized for its project. The newest/richest wins the
 *     bare name and every other variant is kept as `<name>--<project>`. Nothing
 *     is discarded; a specialized variant never silently replaces another.
 *   - Files without valid `name` + `description` frontmatter are skipped: Claude
 *     Code cannot dispatch them, so copying them would only add noise.
 *   - A hand-authored agent already in ~/.claude/agents is never overwritten
 *     unless it carries the marker showing this script wrote it.
 *
 * Usage:
 *   node scripts/harvest-agents.mjs --from D:/GIT            # copy
 *   node scripts/harvest-agents.mjs --from D:/GIT --dry-run  # report only
 *   node scripts/harvest-agents.mjs --from D:/GIT --uninstall
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f, d) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };

const SOURCES = valOf('--from', 'D:/GIT').split(',').map((s) => s.trim()).filter(Boolean);
const DRY = has('--dry-run');
const UNINSTALL = has('--uninstall');
const DEST = path.join(os.homedir(), '.claude', 'agents');
const MARKER = '.vaultflow-harvested';

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`, warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/** Parse YAML frontmatter minimally. BOM-tolerant: several agent files were
 *  written by PowerShell and begin with U+FEFF, which breaks a naive
 *  startsWith('---') check and silently rejects a valid agent. */
function frontmatter(raw) {
  const text = raw.replace(/^﻿/, '');
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const block = text.slice(3, end);
  const get = (k) => {
    const m = block.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  };
  return { name: get('name'), description: get('description') };
}

/** Filename-derived slug. Agent `name:` values are sometimes prose
 *  ("Branch Vault Sync Agent"); the file basename is the reliable identifier. */
const slugOf = (file) => path.basename(file, '.md').toLowerCase().replace(/[^a-z0-9-]+/g, '-');

/**
 * Force the frontmatter `name:` to equal the slug the file is stored under.
 *
 * Claude Code dispatches an agent by its declared `name`, so a file saved as
 * branch-vault-sync.md that declares "Branch Vault Sync Agent" is addressable
 * only by a prose string with spaces — effectively undispatchable. Drifted
 * variants also need this: `<name>--<project>` must declare that exact name or
 * two files would both claim the bare one and collide.
 */
function normalizeName(body, slug) {
  if (!body.startsWith('---')) return body;
  const end = body.indexOf('\n---', 3);
  if (end === -1) return body;
  const head = body.slice(0, end);
  const rest = body.slice(end);
  if (!/^name:\s*/m.test(head)) return body;
  return head.replace(/^name:\s*.*$/m, `name: ${slug}`) + rest;
}

function discover() {
  const found = [];
  for (const root of SOURCES) {
    if (!fs.existsSync(root)) { console.log(c.warn(`  source not found, skipping: ${root}`)); continue; }
    for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const dir = path.join(root, proj.name, '.claude', 'agents');
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        const file = path.join(dir, f);
        let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
        const fm = frontmatter(raw);
        if (!fm || !fm.name || !fm.description) continue;   // not dispatchable
        // Documents that happen to carry frontmatter are not agents. README and
        // MIGRATION_SUMMARY both parsed as "valid" and would be installed as
        // dispatchable agents, adding noise to every session's agent list.
        if (/^(readme|changelog|migration[_-]?summary|index|notes?|todo)$/i.test(path.basename(file, '.md'))) continue;
        found.push({
          project: proj.name, file, raw, slug: slugOf(file),
          hash: crypto.createHash('md5').update(raw.replace(/^﻿/, '')).digest('hex'),
          mtime: fs.statSync(file).mtimeMs, size: raw.length,
        });
      }
    }
  }
  return found;
}

console.log(c.bold(`\nharvest agents → ${DEST}${DRY ? c.dim(' (dry-run)') : ''}`));
console.log(c.dim(`  sources: ${SOURCES.join(', ')}\n`));

if (UNINSTALL) {
  let removed = 0;
  if (fs.existsSync(DEST)) {
    for (const f of fs.readdirSync(DEST)) {
      const p = path.join(DEST, f);
      if (!f.endsWith('.md')) continue;
      if (!fs.readFileSync(p, 'utf8').includes(MARKER)) continue;   // hand-authored — leave it
      if (!DRY) fs.unlinkSync(p);
      removed++;
    }
  }
  console.log(`  removed ${removed} harvested agent(s); hand-authored files left untouched\n`);
  process.exit(0);
}

const found = discover();
const bySlug = new Map();
for (const a of found) {
  if (!bySlug.has(a.slug)) bySlug.set(a.slug, []);
  bySlug.get(a.slug).push(a);
}

const plan = [];
for (const [slug, copies] of bySlug) {
  // Collapse byte-identical copies, keeping the NEWEST mtime among them.
  // Keeping the first-seen copy instead understates a version's age: an agent
  // present in both PRGJSMES (Apr 3) and PRGJSMES-wt (May 20) would be dated
  // Apr 3, losing to an Apr 4 rival — which demoted the developed 28KB
  // frontend-dev under a 5.6KB one purely on directory iteration order.
  const versions = new Map();
  for (const cpy of copies) {
    const seen = versions.get(cpy.hash);
    if (!seen || cpy.mtime > seen.mtime) versions.set(cpy.hash, cpy);
  }
  // Newest wins; size breaks a same-day tie (the richer file is the developed one).
  const ranked = [...versions.values()].sort((a, b) => (b.mtime - a.mtime) || (b.size - a.size));
  plan.push({ slug, winner: ranked[0], variants: ranked.slice(1), copies: copies.length });
}
plan.sort((a, b) => a.slug.localeCompare(b.slug));

if (!DRY) fs.mkdirSync(DEST, { recursive: true });

let written = 0, variantsWritten = 0, skipped = 0;
for (const p of plan) {
  const targets = [{ name: p.slug, src: p.winner }];
  for (const v of p.variants) targets.push({ name: `${p.slug}--${v.project.toLowerCase()}`, src: v });

  for (const t of targets) {
    const dest = path.join(DEST, `${t.name}.md`);
    if (fs.existsSync(dest) && !fs.readFileSync(dest, 'utf8').includes(MARKER)) { skipped++; continue; }
    const body = normalizeName(t.src.raw.replace(/^﻿/, ''), t.name);
    const stamped = `${body}\n\n<!-- ${MARKER}: from ${t.src.project} (${path.basename(t.src.file)}). Re-run \`npm run harvest-agents\` to refresh. -->\n`;
    if (!DRY) fs.writeFileSync(dest, stamped, 'utf8');
    if (t.name === p.slug) written++; else variantsWritten++;
  }
}

for (const p of plan) {
  const note = p.variants.length
    ? c.warn(`${p.copies} copies, ${p.variants.length + 1} versions → +${p.variants.map((v) => `${p.slug}--${v.project.toLowerCase()}`).join(', ')}`)
    : (p.copies > 1 ? c.dim(`${p.copies} identical copies collapsed`) : '');
  console.log(`  ${c.ok('✓')} ${p.slug.padEnd(30)} ${note}`);
}

console.log(`\n  ${written} agent(s) installed, ${variantsWritten} drifted variant(s) preserved` +
            `${skipped ? `, ${skipped} hand-authored left alone` : ''}${DRY ? c.dim(' [dry-run]') : ''}`);
console.log(c.dim('  Restart Claude Code to load them.\n'));
