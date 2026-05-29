'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');
const cp   = require('node:child_process');
const pty  = require('node-pty');

let mainWindow = null;
const ptys = new Map(); // ptyId → { proc, sid, cwd, project }
let nextPtyId = 1;

function resolveClaudeExe() {
  try {
    const r = cp.spawnSync('where.exe', ['claude'], { encoding: 'utf8' });
    const lines = (r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return lines.find(l => l.toLowerCase().endsWith('.exe')) || lines[0] || 'claude.exe';
  } catch { return 'claude.exe'; }
}
const CLAUDE_EXE = resolveClaudeExe();

function readNames() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'sessions.json'), 'utf8'));
    const out = {};
    for (const [sid, slot] of Object.entries(raw)) if (slot?.name) out[sid] = slot.name;
    return out;
  } catch { return {}; }
}

function readHistory(limit = 300) {
  const file = path.join(os.homedir(), '.claude', 'history.jsonl');
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const names = readNames();
  const map = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e; try { e = JSON.parse(trimmed); } catch { continue; }
    const sid = e.sessionId; if (!sid) continue;
    const ts = e.timestamp || 0;
    const display = (e.display || '').replace(/\s+/g, ' ').trim();
    let slot = map.get(sid);
    if (!slot) { slot = { sid, project: e.project || '', firstMsg: display, firstTs: ts, lastTs: ts, count: 0 }; map.set(sid, slot); }
    slot.count += 1;
    if (ts && ts < slot.firstTs) { slot.firstTs = ts; slot.firstMsg = display || slot.firstMsg; }
    if (ts && ts > slot.lastTs) slot.lastTs = ts;
    if (!slot.project && e.project) slot.project = e.project;
  }
  return Array.from(map.values())
    .map(s => ({ ...s, name: names[s.sid] || s.firstMsg || '(unnamed)' }))
    .sort((a, b) => b.lastTs - a.lastTs).slice(0, limit);
}

function findSessionCwd(sid) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  let dirs; try { dirs = fs.readdirSync(projectsDir); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(projectsDir, d, sid + '.jsonl');
    if (!fs.existsSync(f)) continue;
    try {
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const obj = JSON.parse(buf.slice(0, n).toString('utf8').split('\n')[0]);
      if (obj.cwd) return obj.cwd;
    } catch {}
    return d.replace(/--/g, ':\\').replace(/-/g, '\\');
  }
  return null;
}

function spawnSession({ sid, mode, cwdHint, cols = 120, rows = 32 }) {
  const cwd = (mode === 'resume' && sid) ? (findSessionCwd(sid) || cwdHint || process.cwd())
                                         : (cwdHint || process.cwd());
  const safeCwd = (() => { try { return fs.statSync(cwd).isDirectory() ? cwd : process.cwd(); } catch { return process.cwd(); } })();
  const env = { ...process.env, TERM: 'xterm-256color' };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_') || k.startsWith('ANTHROPIC_')) delete env[k];
  const args = (mode === 'resume' && sid) ? ['--resume', sid] : [];
  const proc = pty.spawn(CLAUDE_EXE, args, { name: 'xterm-256color', cols, rows, cwd: safeCwd, env, useConpty: true });
  const id = nextPtyId++;
  ptys.set(id, { proc, sid: sid || null, cwd: safeCwd, project: safeCwd, startedAt: Date.now() });
  proc.onData((data) => { mainWindow?.webContents.send('pty:data', { id, data }); });
  proc.onExit(({ exitCode, signal }) => {
    mainWindow?.webContents.send('pty:exit', { id, exitCode, signal });
    ptys.delete(id);
  });
  return { id, cwd: safeCwd };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, title: 'vaultflow',
    backgroundColor: '#0a0a0a',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile('index.html');
}

ipcMain.handle('history:list',  () => readHistory());
ipcMain.handle('pty:spawn',     (_e, opts) => spawnSession(opts || {}));
ipcMain.handle('pty:write',     (_e, { id, data }) => { ptys.get(id)?.proc.write(data); });
ipcMain.handle('pty:resize',    (_e, { id, cols, rows }) => { try { ptys.get(id)?.proc.resize(cols, rows); } catch {} });
ipcMain.handle('pty:kill',      (_e, { id }) => { try { ptys.get(id)?.proc.kill(); } catch {}; ptys.delete(id); });
ipcMain.handle('pty:list',      () => Array.from(ptys.entries()).map(([id, p]) => ({ id, sid: p.sid, cwd: p.cwd, startedAt: p.startedAt })));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { for (const [, p] of ptys) { try { p.proc.kill(); } catch {} } app.quit(); });
