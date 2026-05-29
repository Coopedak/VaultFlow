'use strict';
const { Terminal } = window;
const FitAddon = (window.FitAddon && window.FitAddon.FitAddon) || (window.AddonFit && window.AddonFit.FitAddon);

const historyListEl = document.getElementById('history-list');
const liveListEl    = document.getElementById('live-list');
const termWrap      = document.getElementById('term-wrap');
const emptyEl       = document.getElementById('empty');
const middleTitle   = document.getElementById('middle-title');

const sessions = new Map(); // ptyId → { term, fit, container, sid, project, cwd, status }
let activePtyId = null;
let historyEntries = [];

function shortProject(p) {
  if (!p) return '(none)';
  return p.replace(/\//g, '\\').split('\\').filter(Boolean).slice(-1)[0] || p;
}
function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60_000) return 'now';
  if (d < 3_600_000) return Math.floor(d / 60_000) + 'm';
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + 'h';
  if (d < 604_800_000) return Math.floor(d / 86_400_000) + 'd';
  return Math.floor(d / 604_800_000) + 'w';
}

async function refreshHistory() {
  historyEntries = await window.vf.listHistory();
  const groups = new Map();
  for (const e of historyEntries) {
    const key = (e.project || '(none)').toLowerCase();
    if (!groups.has(key)) groups.set(key, { label: shortProject(e.project), sessions: [], lastTs: 0 });
    const g = groups.get(key);
    g.sessions.push(e);
    if (e.lastTs > g.lastTs) g.lastTs = e.lastTs;
  }
  const ordered = Array.from(groups.values()).sort((a, b) => b.lastTs - a.lastTs);
  historyListEl.innerHTML = '';
  for (const g of ordered) {
    const gh = document.createElement('div');
    gh.className = 'group';
    gh.textContent = `${g.label}  (${g.sessions.length})`;
    historyListEl.appendChild(gh);
    for (const e of g.sessions) {
      const row = document.createElement('div');
      row.className = 'row';
      row.title = e.name;
      row.innerHTML = `<span class="ts">${relTime(e.lastTs)}</span>${escapeHtml(e.name)}`;
      row.addEventListener('click', () => resume(e));
      historyListEl.appendChild(row);
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function refreshLiveList() {
  liveListEl.innerHTML = '';
  for (const [id, s] of sessions) {
    const row = document.createElement('div');
    row.className = 'live-row' + (id === activePtyId ? ' active' : '');
    const status = s.status === 'dead' ? '<span class="status dead">exited</span>' : '<span class="status">● live</span>';
    row.innerHTML = `${status}<div class="sid">${(s.sid || '').slice(0,8) || 'new'}</div><div class="proj">${escapeHtml(shortProject(s.project || s.cwd))}</div>`;
    row.addEventListener('click', () => activate(id));
    liveListEl.appendChild(row);
  }
  if (sessions.size === 0) {
    liveListEl.innerHTML = '<div style="padding:12px;color:#555">no sessions yet</div>';
  }
}

function activate(id) {
  const s = sessions.get(id);
  if (!s) return;
  if (emptyEl && emptyEl.parentNode) emptyEl.remove();
  for (const [, other] of sessions) other.container.classList.add('hidden');
  s.container.classList.remove('hidden');
  activePtyId = id;
  middleTitle.textContent = `${shortProject(s.project || s.cwd)} — ${(s.sid || '').slice(0,8) || 'new'}`;
  refreshLiveList();
  setTimeout(() => { try { s.fit.fit(); s.term.focus(); } catch {} }, 0);
}

async function resume(entry) {
  const { id, cwd } = await window.vf.spawn({ sid: entry.sid, mode: 'resume', cwdHint: entry.project });
  attachTerminal(id, { sid: entry.sid, cwd, project: entry.project || cwd });
  activate(id);
}

function attachTerminal(id, meta) {
  const container = document.createElement('div');
  container.className = 'term hidden';
  termWrap.appendChild(container);
  const term = new Terminal({
    fontFamily: 'Consolas, "Cascadia Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: { background: '#000', foreground: '#ddd' },
    allowProposedApi: true,
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  try { fit.fit(); } catch {}
  term.onData((data) => { window.vf.write(id, data); });
  term.onResize(({ cols, rows }) => { window.vf.resize(id, cols, rows); });
  sessions.set(id, { term, fit, container, sid: meta.sid, cwd: meta.cwd, project: meta.project, status: 'live' });
  refreshLiveList();
}

window.vf.onData(({ id, data }) => {
  const s = sessions.get(id);
  if (s) s.term.write(data);
});
window.vf.onExit(({ id, exitCode }) => {
  const s = sessions.get(id);
  if (s) {
    s.status = 'dead';
    s.term.write(`\r\n\x1b[90m[claude exited code ${exitCode}]\x1b[0m\r\n`);
    refreshLiveList();
  }
});

window.addEventListener('resize', () => {
  for (const [, s] of sessions) { try { s.fit.fit(); } catch {} }
});

refreshHistory();
refreshLiveList();
