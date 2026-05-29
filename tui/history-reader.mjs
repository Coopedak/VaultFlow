/**
 * history-reader.mjs — read ~/.claude/history.jsonl into session records
 *
 * Returns one entry per sessionId with the earliest prompt, last activity,
 * project path, and a friendly name (from ~/.claude/sessions.json — populated
 * by sync-csm-names.mjs, also honors csm /rename writes).
 */

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';

const HISTORY_FILE  = path.join(os.homedir(), '.claude', 'history.jsonl');
const SESSIONS_JSON = path.join(os.homedir(), '.claude', 'sessions.json');

function readNames() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_JSON, 'utf8'));
    const out = {};
    for (const [sid, slot] of Object.entries(raw)) {
      if (slot && typeof slot === 'object' && slot.name) out[sid] = slot.name;
    }
    return out;
  } catch {
    return {};
  }
}

export function readHistory({ limit = 200 } = {}) {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  const text = fs.readFileSync(HISTORY_FILE, 'utf8');
  const names = readNames();
  const map = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    const sid = entry.sessionId;
    if (!sid) continue;
    const ts = entry.timestamp || 0;
    const display = (entry.display || '').replace(/\s+/g, ' ').trim();
    const project = entry.project || '';
    let slot = map.get(sid);
    if (!slot) {
      slot = { sid, project, firstMsg: display, firstTs: ts, lastTs: ts, count: 0 };
      map.set(sid, slot);
    }
    slot.count += 1;
    if (ts && ts < slot.firstTs) { slot.firstTs = ts; slot.firstMsg = display || slot.firstMsg; }
    if (ts && ts > slot.lastTs) slot.lastTs = ts;
    if (!slot.project && project) slot.project = project;
  }
  const arr = Array.from(map.values())
    .map(s => ({ ...s, name: names[s.sid] || s.firstMsg || '(unnamed)' }))
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, limit);
  return arr;
}

/**
 * Find the on-disk transcript file for a sessionId and read its `cwd`.
 * Returns null if no transcript exists — meaning the session is NOT resumable
 * by `claude --resume`, regardless of what history.jsonl says.
 */
export function findSessionCwd(sid) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  let dirs;
  try { dirs = fs.readdirSync(projectsDir); } catch { return null; }
  for (const d of dirs) {
    const candidate = path.join(projectsDir, d, sid + '.jsonl');
    if (!fs.existsSync(candidate)) continue;
    try {
      const fd = fs.openSync(candidate, 'r');
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const text = buf.slice(0, n).toString('utf8');
      const firstLine = text.split('\n')[0];
      const obj = JSON.parse(firstLine);
      if (obj.cwd) return { cwd: obj.cwd, file: candidate };
    } catch {}
    // Even without parseable cwd we know the file exists — fall back to
    // reversing the encoded project dir name.
    return { cwd: d.replace(/--/g, ':\\').replace(/-/g, '\\'), file: candidate };
  }
  return null;
}

export function shortProject(project) {
  if (!project) return '(none)';
  const norm = project.replace(/\//g, '\\');
  const parts = norm.split('\\').filter(Boolean);
  return parts.slice(-1)[0] || norm;
}

export function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60_000) return 'now';
  if (d < 3_600_000) return Math.floor(d / 60_000) + 'm';
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + 'h';
  if (d < 604_800_000) return Math.floor(d / 86_400_000) + 'd';
  return Math.floor(d / 604_800_000) + 'w';
}
