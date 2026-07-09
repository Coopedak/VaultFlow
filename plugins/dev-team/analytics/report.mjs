#!/usr/bin/env node
/**
 * Dev Team analytics report.
 *
 * Reads <dataDir>/events.jsonl (written by log-event.mjs) and prints a Markdown summary of team
 * activity: dispatches per role, review-loop depth, cycle time per run, and recent activity.
 *
 * Usage:
 *   node report.mjs --data "<dir>" [--since YYYY-MM-DD] [--limit N] [--json]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(name);

function resolveDataDir() {
  const fromArg = arg('--data');
  const fromEnv = process.env.CLAUDE_PLUGIN_DATA || '';
  return (fromArg && fromArg !== '${CLAUDE_PLUGIN_DATA}') ? fromArg
    : (fromEnv || join(homedir(), '.claude', 'dev-team-analytics'));
}

function loadEvents(dataDir, since) {
  const file = join(dataDir, 'events.jsonl');
  if (!existsSync(file)) return [];
  const sinceTs = since ? Date.parse(since) : null;
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .filter((e) => (sinceTs ? Date.parse(e.ts) >= sinceTs : true));
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function analyze(events) {
  const dispatches = events.filter((e) => e.event === 'dispatch');
  const teamDispatches = dispatches.filter((e) => e.team);

  const byRole = {};
  for (const d of teamDispatches) byRole[d.role] = (byRole[d.role] || 0) + 1;

  // Group by session for cycle-time and review-loop depth.
  const sessions = {};
  for (const e of events) {
    if (!e.session) continue;
    const s = (sessions[e.session] ||= { id: e.session, project: e.project, events: [] });
    s.events.push(e);
    if (e.project) s.project = e.project;
  }

  const runs = [];
  for (const s of Object.values(sessions)) {
    const teamD = s.events.filter((e) => e.event === 'dispatch' && e.team);
    if (teamD.length === 0) continue; // only count sessions where the team actually ran
    const times = s.events.map((e) => Date.parse(e.ts)).filter(Number.isFinite);
    const reviewRounds = teamD.filter((e) => e.role === 'code-reviewer').length;
    runs.push({
      id: s.id,
      project: s.project || '—',
      dispatches: teamD.length,
      reviewRounds,
      start: Math.min(...times),
      end: Math.max(...times),
      duration: Math.max(...times) - Math.min(...times),
    });
  }
  runs.sort((a, b) => b.end - a.end);

  const reviewRoundsArr = runs.map((r) => r.reviewRounds).filter((n) => n > 0);
  const avgReview = reviewRoundsArr.length
    ? (reviewRoundsArr.reduce((a, b) => a + b, 0) / reviewRoundsArr.length)
    : 0;

  return {
    totalDispatches: dispatches.length,
    teamDispatches: teamDispatches.length,
    byRole,
    runs,
    avgReviewRounds: avgReview,
    capHitRuns: runs.filter((r) => r.reviewRounds >= 3).length,
    span: events.length
      ? { from: events[0].ts, to: events[events.length - 1].ts }
      : null,
  };
}

function renderMarkdown(a, limit) {
  if (a.teamDispatches === 0) {
    return '# Dev Team Analytics\n\nNo dev-team activity recorded yet. Run the team on a task, then check back.\n';
  }
  const lines = [];
  lines.push('# Dev Team Analytics');
  lines.push('');
  if (a.span) lines.push(`**Window:** ${a.span.from} → ${a.span.to}`);
  lines.push(`**Runs (sessions with team activity):** ${a.runs.length}`);
  lines.push(`**Total subagent dispatches:** ${a.teamDispatches}`);
  lines.push(`**Avg review rounds per run:** ${a.avgReviewRounds.toFixed(1)}`);
  if (a.capHitRuns) lines.push(`**Runs that hit the 3-round review cap:** ${a.capHitRuns}`);
  lines.push('');

  lines.push('## Dispatches by role');
  lines.push('');
  lines.push('| Role | Dispatches |');
  lines.push('|------|-----------:|');
  const roleOrder = ['project-manager', 'voice-of-reason', 'researcher', 'code-developer', 'code-reviewer', 'documenter', 'integrator'];
  const roles = Object.keys(a.byRole).sort((x, y) => {
    const ix = roleOrder.indexOf(x), iy = roleOrder.indexOf(y);
    return (ix === -1 ? 99 : ix) - (iy === -1 ? 99 : iy);
  });
  for (const role of roles) lines.push(`| ${role} | ${a.byRole[role]} |`);
  lines.push('');

  lines.push('## Recent runs');
  lines.push('');
  lines.push('| When | Project | Dispatches | Review rounds | Duration |');
  lines.push('|------|---------|-----------:|--------------:|---------:|');
  for (const r of a.runs.slice(0, limit)) {
    const when = new Date(r.end).toISOString().replace('T', ' ').slice(0, 16);
    const proj = String(r.project).split(/[\\/]/).pop() || r.project;
    const cap = r.reviewRounds >= 3 ? ' ⚠️' : '';
    lines.push(`| ${when} | ${proj} | ${r.dispatches} | ${r.reviewRounds}${cap} | ${fmtDuration(r.duration)} |`);
  }
  lines.push('');
  lines.push('_⚠️ = review loop hit the 3-round cap._');
  return lines.join('\n');
}

function main() {
  const dataDir = resolveDataDir();
  const since = arg('--since');
  const limit = parseInt(arg('--limit', '15'), 10) || 15;
  const events = loadEvents(dataDir, since);
  const a = analyze(events);

  if (hasFlag('--json')) {
    process.stdout.write(JSON.stringify({ dataDir, ...a }, null, 2) + '\n');
  } else {
    process.stdout.write(renderMarkdown(a, limit) + '\n');
  }
}

main();
