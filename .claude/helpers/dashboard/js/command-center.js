/**
 * command-center.js — Synapse Command Center home view.
 *
 * Registers the 'command-center' view with core.js, fetches /api/overview in
 * a single round-trip, and renders:
 *   • Hero — System Pulse canvas animation + health ring
 *   • Brain Vitals — 8-tile grid with inline-SVG sparklines
 *   • Recent Sessions — last 5 rows
 *   • Needs Attention — discoveries / stale / fail counts
 *
 * Intentionally self-contained: uses inline SVG sparklines (not charts.js)
 * so the home view has zero external module dependencies beyond core.js.
 */

import { api, registerView, F } from './core.js';

// ── helpers ───────────────────────────────────────────────────────────────

/** Convert a healthTone string → CSS variable name for the ring/pill color. */
function toneColor(tone) {
  return tone === 'fail' ? 'var(--red)' : tone === 'warn' ? 'var(--amber)' : 'var(--green)';
}

/** Human headline for the hero based on health tally. */
function headlineText(o, tone) {
  if (tone === 'fail') return `${o.health.fail} check${o.health.fail !== 1 ? 's' : ''} failing`;
  if (tone === 'warn') return `${o.health.warn} warning${o.health.warn !== 1 ? 's' : ''}`;
  return 'All systems nominal';
}

/** Health ring total (ok + warn + fail). */
function ringTotal(h) { return (h.ok || 0) + (h.warn || 0) + (h.fail || 0); }

/** LED class for a tile: 'ok' | 'warn' | 'info'. */
function led(state) {
  return `<span class="led ${state}"></span>`;
}

/** Simple inline SVG sparkline — same markup as the mockup. */
function spark(points, color = '#34E1FF') {
  // Normalise points array to a 120×30 viewBox polyline.
  const n    = points.length;
  if (n < 2) return '';
  const min  = Math.min(...points);
  const max  = Math.max(...points);
  const rng  = max - min || 1;
  const step = 120 / (n - 1);
  const pts  = points
    .map((v, i) => `${(i * step).toFixed(1)},${(28 - ((v - min) / rng) * 24).toFixed(1)}`)
    .join(' ');
  return `<svg class="spark" viewBox="0 0 120 30" preserveAspectRatio="none">
    <polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"/>
  </svg>`;
}

/** Placeholder sparkline (flat mid-line) when we have no history data. */
function flatSpark(color = '#34E1FF') {
  return spark([10, 10, 10, 10, 10, 10, 10, 10], color);
}

/** Format session duration: ms → "Xm" or "Xs". */
function fmtDuration(ms) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`;
}

/** Truncate a string to max length. */
function trunc(s, max = 38) {
  if (!s) return '—';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ── render ────────────────────────────────────────────────────────────────

function render(o) {
  const tone    = F.healthTone(o.health || {});
  const color   = toneColor(tone);
  const total   = ringTotal(o.health || {});
  const ok      = o.health?.ok ?? 0;
  const pPct    = total ? Math.round((ok / total) * 100) : 100;
  const headline = headlineText(o, tone);

  // ── hero narrative ────────────────────────────────────────────────────
  const memPct    = o.memory?.pct ?? 0;
  const nightlyTxt = o.nightly?.ageHours != null ? F.fmtAgo(o.nightly.ageHours) : 'never';
  const watcherTxt = o.watcher?.running ? 'watcher live' : 'watcher stopped';
  const embTotal   = F.fmtNum(o.memory?.embedded ?? 0);
  const dotColor   = tone === 'ok' ? 'var(--green)' : tone === 'warn' ? 'var(--amber)' : 'var(--red)';

  // ── pill ──────────────────────────────────────────────────────────────
  const pillLabel = tone === 'ok' ? 'healthy' : tone === 'warn' ? 'degraded' : 'failing';

  // ── vitals tiles ──────────────────────────────────────────────────────
  const memLed  = memPct >= 90 ? 'ok' : memPct >= 50 ? 'warn' : 'info';
  const cgFiles = F.fmtNum(o.codeGraph?.files ?? 0);
  const cgSym   = F.fmtNum(o.codeGraph?.symbols ?? 0);
  const cgEdges = F.fmtNum(o.codeGraph?.edges ?? 0);
  const sesTot  = F.fmtNum(o.sessions?.total ?? 0);
  const sesPct  = o.sessions?.summarizedPct ?? 0;
  const ret7d   = F.fmtNum(o.retrieval7d ?? 0);
  const eqDepth = F.fmtNum(o.embedQueue?.depth ?? 0);
  const eqOld   = o.embedQueue?.oldestHours != null ? `oldest ${o.embedQueue.oldestHours}h` : 'queue empty';
  const dbMb    = F.fmtBytesMb(o.db?.sizeMb ?? 0);
  const dbInt   = o.db?.integrity ?? 'ok';
  const nightlyH = o.nightly?.ageHours != null ? Number(o.nightly.ageHours).toFixed(1) : '—';
  const nightlyU = o.nightly?.ageHours != null ? 'h ago' : '';
  const nightlyLed = (o.nightly?.ageHours ?? 999) < 30 ? 'ok' : 'warn';
  const eqLed   = (o.embedQueue?.depth ?? 0) < 100 ? 'ok' : 'warn';

  // ── recent sessions ───────────────────────────────────────────────────
  const sessions = (o.recentSessions || []).slice(0, 5);
  const sessRows = sessions.length
    ? sessions.map(s => {
        const proj    = trunc(s.project || 'vaultflow', 16);
        const label   = trunc(s.id ? `session #${s.id}` : '—', 32);
        const durTag  = fmtDuration(s.durationMs);
        const edits   = s.edits != null ? `+${s.edits}` : '—';
        const ago     = s.startedAt ? (() => {
          const h = (Date.now() - new Date(s.startedAt).getTime()) / 3.6e6;
          return h < 1 ? `${Math.round(h * 60)}m ago` : `${h.toFixed(1)}h ago`;
        })() : '';
        return `<div class="srow">
          <div>
            <div class="p">${label}</div>
            <div class="m">${proj}${ago ? ' · ' + ago : ''}</div>
          </div>
          <span class="tag">${durTag}</span>
          <span class="num">${edits}</span>
        </div>`;
      }).join('')
    : '<div class="srow"><div class="p" style="color:var(--muted)">No sessions recorded yet</div><span class="tag">—</span><span class="num">—</span></div>';

  // ── needs attention ───────────────────────────────────────────────────
  const disc   = o.discoveriesUnreviewed ?? 0;
  const stale  = o.staleMemory ?? 0;
  const fail   = o.health?.fail ?? 0;
  const attCount = (disc > 0 ? 1 : 0) + (stale > 0 ? 1 : 0) + (fail > 0 ? 1 : 0);

  const discClass  = disc  > 0 ? 'warn' : '';
  const staleClass = stale > 0 ? 'info' : '';
  const failStyle  = fail  > 0 ? 'color:var(--red)' : 'color:var(--green)';

  return /* html */`
    <!-- topbar -->
    <div class="topbar">
      <h1>Command Center</h1>
      <span class="crumb">/ vaultflow</span>
      <span class="spacer"></span>
      <span class="pill">
        <span class="dot" style="background:${dotColor}"></span>
        ${pillLabel}
      </span>
    </div>

    <!-- hero pulse -->
    <section class="hero">
      <canvas id="pulse"></canvas>
      <div class="hero-inner">
        <div class="hero-lead">
          <div class="eyebrow">System Pulse</div>
          <h2>${headline}</h2>
          <p>
            <span class="accent">${ok} / ${total}</span> checks green
            · nightly consolidated <span class="accent">${nightlyTxt}</span>
            · ${watcherTxt}
            · <span class="accent">${embTotal}</span> memories embedded (${memPct}%)
          </p>
        </div>
        <div class="ring" style="--p:${pPct}; --ring-color:${color}; position:relative; background:conic-gradient(${color} calc(${pPct}*1%), #1c2237 0);">
          <div class="inner">
            <b style="color:${color}">${ok}</b>
            <span>of ${total} ok</span>
          </div>
        </div>
      </div>
    </section>

    <!-- vitals -->
    <div class="sec">Brain Vitals</div>
    <div class="grid">
      <div class="tile">
        <div class="t-label">${led(memLed)}Memory</div>
        <div class="t-val">${F.fmtNum(o.memory?.total ?? 0)}</div>
        <div class="t-sub">${memPct}% embedded · ${F.fmtNum((o.memory?.total ?? 0) - (o.memory?.embedded ?? 0))} pending</div>
        ${flatSpark('#34E1FF')}
      </div>
      <div class="tile">
        <div class="t-label">${led('ok')}Code Graph</div>
        <div class="t-val">${cgSym}<span class="u"> sym</span></div>
        <div class="t-sub">${cgFiles} files · ${cgEdges} edges</div>
        ${flatSpark('#9A86FF')}
      </div>
      <div class="tile">
        <div class="t-label">${led('ok')}Sessions</div>
        <div class="t-val">${sesTot}</div>
        <div class="t-sub">${sesPct}% summarized · last 7d</div>
        ${flatSpark('#34E1FF')}
      </div>
      <div class="tile">
        <div class="t-label">${led('info')}Retrieval</div>
        <div class="t-val">${ret7d}</div>
        <div class="t-sub">docs indexed · last 7d</div>
        ${flatSpark('#34E1FF')}
      </div>

      <div class="tile">
        <div class="t-label">${led(nightlyLed)}Nightly</div>
        <div class="t-val">${nightlyH}<span class="u">${nightlyU}</span></div>
        <div class="t-sub">consolidation ${dbInt === 'ok' ? 'ran clean' : 'check logs'}</div>
      </div>
      <div class="tile">
        <div class="t-label">${led(eqLed)}Embed Queue</div>
        <div class="t-val">${eqDepth}</div>
        <div class="t-sub">${(o.embedQueue?.depth ?? 0) > 0 ? 'draining · ' + eqOld : 'queue empty'}</div>
      </div>
      <div class="tile">
        <div class="t-label">${led(dbInt === 'ok' ? 'ok' : 'warn')}Database</div>
        <div class="t-val">${dbMb}</div>
        <div class="t-sub">integrity ${dbInt}</div>
      </div>
      <div class="tile">
        <div class="t-label">${led('info')}Pattern Signal</div>
        <div class="t-val" style="font-size:18px">${disc > 0 ? 'active' : 'quiet'}</div>
        <div class="t-sub">${disc} unreviewed discoveries</div>
      </div>
    </div>

    <!-- lower row -->
    <div class="row">
      <div class="card">
        <h3>Recent Sessions <span class="ct">last 5</span></h3>
        <div class="slist">${sessRows}</div>
      </div>
      <div class="card">
        <h3>Needs Attention <span class="ct">${attCount}</span></h3>
        <div class="att">
          <div class="b ${discClass}">${disc}</div>
          <div class="d"><b>Unreviewed discoveries</b><br>promote to skills or archive</div>
          <span class="go">review →</span>
        </div>
        <div class="att">
          <div class="b ${staleClass}">${stale}</div>
          <div class="d"><b>Stale memories</b><br>source files vanished</div>
          <span class="go">triage →</span>
        </div>
        <div class="att">
          <div class="b" style="${failStyle}">${fail}</div>
          <div class="d"><b>Failing checks</b><br>${fail > 0 ? `${fail} check${fail !== 1 ? 's' : ''} need attention` : 'everything else is green'}</div>
          <span class="go">health →</span>
        </div>
      </div>
    </div>
  `;
}

// ── canvas pulse animation (ported from mockup) ───────────────────────────

function startPulse(canvas) {
  if (!canvas) return;

  const reduce = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ctx = canvas.getContext('2d');
  let W, H;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  let nodes = [], edges = [], t = 0;
  let rafId = null;

  function size() {
    const r = canvas.getBoundingClientRect();
    W = canvas.width  = r.width  * DPR;
    H = canvas.height = r.height * DPR;
  }

  function build() {
    nodes = []; edges = [];
    const N = 34;
    for (let i = 0; i < N; i++) {
      nodes.push({
        x:  Math.random() * W,
        y:  Math.random() * H,
        vx: (Math.random() - 0.5) * 0.12 * DPR,
        vy: (Math.random() - 0.5) * 0.12 * DPR,
      });
    }
    for (let a = 0; a < N; a++) {
      for (let b = a + 1; b < N; b++) {
        const d = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);
        if (d < 150 * DPR) edges.push([a, b]);
      }
    }
  }

  function frame() {
    ctx.clearRect(0, 0, W, H);

    // edges
    for (let e = 0; e < edges.length; e++) {
      const p = nodes[edges[e][0]], q = nodes[edges[e][1]];
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      const al = Math.max(0, 1 - d / (150 * DPR));
      ctx.strokeStyle = `rgba(52,225,255,${(al * 0.16).toFixed(3)})`;
      ctx.lineWidth   = DPR;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }

    // nodes
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!reduce) {
        n.x += n.vx; n.y += n.vy;
        if (n.x < 0 || n.x > W) n.vx *= -1;
        if (n.y < 0 || n.y > H) n.vy *= -1;
      }
      const pulse = Math.sin(t / 22 + i) * 0.5 + 0.5;
      ctx.fillStyle = `rgba(154,134,255,${(0.25 + pulse * 0.55).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, (1.4 + pulse * 1.7) * DPR, 0, Math.PI * 2);
      ctx.fill();
    }

    // travelling signals
    if (!reduce) {
      for (let k = 0; k < 4; k++) {
        const e2 = edges[(Math.floor(t / 30) + k * 7) % edges.length];
        if (!e2) continue;
        const p = nodes[e2[0]], q = nodes[e2[1]];
        const f = (t / 30) % 1;
        const x = p.x + (q.x - p.x) * f;
        const y = p.y + (q.y - p.y) * f;
        ctx.fillStyle = 'rgba(52,225,255,.95)';
        ctx.beginPath(); ctx.arc(x, y, 2.2 * DPR, 0, Math.PI * 2); ctx.fill();
      }
    }

    t++;
    if (!reduce) rafId = requestAnimationFrame(frame);
  }

  function init() {
    size();
    build();
    frame();
  }

  // Named resize handler for proper cleanup
  function onResize() {
    size();
    build();
    if (reduce) frame(); // redraw static frame at new size
  }

  window.addEventListener('resize', onResize);

  init();

  // Return cleanup function that cancels rAF and removes resize listener
  return () => {
    if (rafId) cancelAnimationFrame(rafId);
    window.removeEventListener('resize', onResize);
  };
}

// ── view registration ─────────────────────────────────────────────────────

let _ccCleanup = null;

registerView('command-center', async (el) => {
  const o = await api('/api/overview');
  el.innerHTML = render(o);
  if (_ccCleanup) {
    _ccCleanup();
    _ccCleanup = null;
  }
  const canvas = el.querySelector('#pulse');
  if (canvas) _ccCleanup = startPulse(canvas);
});
