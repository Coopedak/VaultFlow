/**
 * system-control.js — Control panel view for the Synapse dashboard.
 *
 * Ports v1 loadControl / button handlers to the v2 module pattern.
 * No charts — this is a pure action panel.
 *
 * On mount:
 *   • GET /api/watcher/status — shows running/stopped badge + PID
 *   • GET /api/config — auto-loaded and displayed in a <pre> block
 *
 * Action buttons (each: disable during request, show result/error in its status line):
 *   • Flush (POST /api/flush)
 *   • Run Learning Loop (POST /api/learning/run)
 *   • Full Backfill (POST /api/backfill)
 *   • Skills Backfill (POST /api/backfill { skillsOnly: true })
 *   • Dict Import (POST /api/dict/import)
 *   • Watcher Start (POST /api/watcher/start)
 *   • Watcher Stop (POST /api/watcher/stop)
 *   • Run Audit (POST /api/audit)
 */

import { api, registerView } from './core.js';

/** Escape HTML special characters in user-controlled strings before innerHTML injection. */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function trunc(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + '…' : str;
}

registerView('system-control', async (el) => {
  el.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <h3 style="margin-bottom:16px">Watcher
        <span id="sc-watcher-badge" class="watcher-badge stopped" style="margin-left:8px;font-size:12px;font-weight:400">stopped</span>
      </h3>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button id="sc-btn-watcher-start" class="btn">Start</button>
        <button id="sc-btn-watcher-stop"  class="btn">Stop</button>
      </div>
      <pre id="sc-status-watcher" class="ctrl-status" style="margin-top:10px"></pre>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h3 style="margin-bottom:16px">Data Operations</h3>
      <div style="display:grid;gap:12px">

        <div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
            <button id="sc-btn-flush" class="btn">Flush to Parquet</button>
          </div>
          <pre id="sc-status-flush" class="ctrl-status"></pre>
        </div>

        <div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
            <button id="sc-btn-learning" class="btn">Run Learning Loop</button>
          </div>
          <pre id="sc-status-learning" class="ctrl-status"></pre>
        </div>

        <div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
            <button id="sc-btn-backfill"        class="btn">Full Backfill</button>
            <button id="sc-btn-backfill-skills" class="btn">Skills Backfill</button>
          </div>
          <pre id="sc-status-backfill" class="ctrl-status"></pre>
        </div>

        <div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
            <button id="sc-btn-dict-import" class="btn">Dict Import</button>
          </div>
          <pre id="sc-status-dict" class="ctrl-status"></pre>
        </div>

      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h3 style="margin-bottom:16px">Health Audit</h3>
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <button id="sc-btn-audit" class="btn">Run Audit</button>
      </div>
      <pre id="sc-status-audit" class="ctrl-status"></pre>
    </div>

    <div class="card">
      <h3 style="margin-bottom:16px">Config</h3>
      <pre id="sc-status-config" class="ctrl-status" style="max-height:400px;overflow-y:auto">Loading…</pre>
    </div>`;

  // ── helpers ──────────────────────────────────────────────────────────────

  function setStatus(id, text, cls = '') {
    const node = el.querySelector('#' + id);
    if (!node) return;
    node.textContent = text;
    node.className = `ctrl-status${cls ? ' ' + cls : ''}`;
  }

  function setWatcherBadge(running) {
    const badge = el.querySelector('#sc-watcher-badge');
    if (!badge) return;
    badge.textContent = running ? 'running' : 'stopped';
    badge.className = `watcher-badge ${running ? 'running' : 'stopped'}`;
  }

  // ── initial data loads ───────────────────────────────────────────────────

  // Watcher status
  try {
    const data = await api('/api/watcher/status');
    setWatcherBadge(data.running);
    if (data.pid) setStatus('sc-status-watcher', `PID ${data.pid}`);
  } catch (_) {
    setWatcherBadge(false);
  }

  // Config
  try {
    const data = await api('/api/config');
    el.querySelector('#sc-status-config').textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    el.querySelector('#sc-status-config').textContent = `Error: ${e.message}`;
  }

  // ── watcher controls ─────────────────────────────────────────────────────

  el.querySelector('#sc-btn-watcher-start').addEventListener('click', async () => {
    setStatus('sc-status-watcher', 'Starting…');
    try {
      const r    = await fetch('/api/watcher/start', { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      setWatcherBadge(true);
      setStatus('sc-status-watcher', data.message || 'Started', 'ok');
    } catch (e) {
      setStatus('sc-status-watcher', `Error: ${e.message}`, 'err');
    }
  });

  el.querySelector('#sc-btn-watcher-stop').addEventListener('click', async () => {
    setStatus('sc-status-watcher', 'Stopping…');
    try {
      const r    = await fetch('/api/watcher/stop', { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      setWatcherBadge(false);
      setStatus('sc-status-watcher', data.message || 'Stopped', 'ok');
    } catch (e) {
      setStatus('sc-status-watcher', `Error: ${e.message}`, 'err');
    }
  });

  // ── flush ────────────────────────────────────────────────────────────────

  el.querySelector('#sc-btn-flush').addEventListener('click', async () => {
    const btn = el.querySelector('#sc-btn-flush');
    btn.disabled = true;
    setStatus('sc-status-flush', 'Flushing…');
    try {
      const r    = await fetch('/api/flush', { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      const lines = [];
      if (data.parquet)   lines.push(`parquet: ${JSON.stringify(data.parquet)}`);
      if (data.telemetry) lines.push(`telemetry: ${JSON.stringify(data.telemetry)}`);
      setStatus('sc-status-flush', lines.join('\n') || 'Done', 'ok');
    } catch (e) {
      setStatus('sc-status-flush', `Error: ${e.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  // ── learning loop ────────────────────────────────────────────────────────

  el.querySelector('#sc-btn-learning').addEventListener('click', async () => {
    const btn = el.querySelector('#sc-btn-learning');
    btn.disabled = true;
    setStatus('sc-status-learning', 'Running retrieval learning loop…');
    try {
      const r    = await fetch('/api/learning/run', { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);

      const lines = [
        `batches reviewed: ${data.batchesReviewed ?? 0}`,
        `strategies reviewed: ${data.strategiesReviewed ?? 0}`,
        `patterns promoted: ${(data.promotedPatterns || []).length}`,
      ];
      if (Array.isArray(data.promotedPatterns) && data.promotedPatterns.length) {
        lines.push('', 'promoted patterns:');
        for (const p of data.promotedPatterns.slice(0, 8)) lines.push(`- ${p}`);
      }
      if (Array.isArray(data.topStrategies) && data.topStrategies.length) {
        lines.push('', 'top strategies:');
        for (const row of data.topStrategies.slice(0, 5)) {
          lines.push(`- ${row.project} / ${row.cli} / ${row.source_type} / ${row.command_family} => ${(row.success_rate * 100).toFixed(0)}% (${row.success_count}/${row.sample_count})`);
        }
      }
      if (Array.isArray(data.topFailures) && data.topFailures.length) {
        lines.push('', 'failure hotspots:');
        for (const row of data.topFailures.slice(0, 3)) {
          lines.push(`- ${row.project} / ${row.cli} (${row.failure_count}) ${trunc(row.query_text, 90)}`);
        }
      }
      setStatus('sc-status-learning', lines.join('\n') || 'Done', 'ok');
    } catch (e) {
      setStatus('sc-status-learning', `Error: ${e.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  // ── backfill ─────────────────────────────────────────────────────────────

  el.querySelector('#sc-btn-backfill').addEventListener('click', async () => {
    const btnFull   = el.querySelector('#sc-btn-backfill');
    const btnSkills = el.querySelector('#sc-btn-backfill-skills');
    btnFull.disabled   = true;
    btnSkills.disabled = true;
    setStatus('sc-status-backfill', 'Running full backfill… (this may take 30-60s)');
    try {
      const r    = await fetch('/api/backfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      const out = data.stdout ? data.stdout.slice(-800) : '';
      setStatus('sc-status-backfill', `Exit ${data.exitCode ?? 0}\n${out}`, data.exitCode === 0 ? 'ok' : 'err');
    } catch (e) {
      setStatus('sc-status-backfill', `Error: ${e.message}`, 'err');
    } finally {
      btnFull.disabled   = false;
      btnSkills.disabled = false;
    }
  });

  el.querySelector('#sc-btn-backfill-skills').addEventListener('click', async () => {
    const btnFull   = el.querySelector('#sc-btn-backfill');
    const btnSkills = el.querySelector('#sc-btn-backfill-skills');
    btnSkills.disabled = true;
    btnFull.disabled   = true;
    setStatus('sc-status-backfill', 'Running skills backfill…');
    try {
      const r    = await fetch('/api/backfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skillsOnly: true }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      const out = data.stdout ? data.stdout.slice(-800) : '';
      setStatus('sc-status-backfill', `Exit ${data.exitCode ?? 0}\n${out}`, data.exitCode === 0 ? 'ok' : 'err');
    } catch (e) {
      setStatus('sc-status-backfill', `Error: ${e.message}`, 'err');
    } finally {
      btnSkills.disabled = false;
      btnFull.disabled   = false;
    }
  });

  // ── dict import ──────────────────────────────────────────────────────────

  el.querySelector('#sc-btn-dict-import').addEventListener('click', async () => {
    const btn = el.querySelector('#sc-btn-dict-import');
    btn.disabled = true;
    setStatus('sc-status-dict', 'Importing…');
    try {
      const r    = await fetch('/api/dict/import', { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      setStatus('sc-status-dict', data.message || JSON.stringify(data), 'ok');
    } catch (e) {
      setStatus('sc-status-dict', `Error: ${e.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  // ── audit ────────────────────────────────────────────────────────────────

  el.querySelector('#sc-btn-audit').addEventListener('click', async () => {
    const btn = el.querySelector('#sc-btn-audit');
    btn.disabled = true;
    setStatus('sc-status-audit', 'Running…');
    try {
      const r    = await fetch('/api/audit', { method: 'POST' });
      const rows = await r.json();
      if (!r.ok) throw new Error(rows.error || r.statusText);
      const text = rows.map(row => {
        const icon = row.status === 'ok' ? '✓' : row.status === 'warn' ? '⚠' : '✗';
        return `${icon} [${row.status.toUpperCase().padEnd(4)}] ${row.check.padEnd(35)} ${row.detail}`;
      }).join('\n');
      setStatus('sc-status-audit', text || 'Done', 'ok');
    } catch (e) {
      setStatus('sc-status-audit', `Error: ${e.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  });
});
