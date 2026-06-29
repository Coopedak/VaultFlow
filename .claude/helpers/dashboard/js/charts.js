/**
 * charts.js — Phase-2 Chart.js foundation for the Synapse dashboard.
 *
 * Applies a dark-theme baseline to Chart.js (global defaults) and exports
 * factory helpers `sparkline` and `line` for the section tabs migrated in
 * Phase 2. The Command Center home uses inline-SVG sparklines instead so this
 * module is NOT imported by command-center.js — it is committed ready for the
 * next wave of views.
 *
 * Guard: if `typeof Chart === 'undefined'` (shell hasn't loaded the vendor
 * script yet, or this runs in a test-HTTP-200 context), theme application
 * no-ops gracefully.
 */

// ── dark theme defaults ───────────────────────────────────────────────────
(function applyDarkDefaults() {
  if (typeof Chart === 'undefined') return; // guard — no-op when vendor absent

  Chart.defaults.color           = '#7C89A8';   // --muted
  Chart.defaults.borderColor     = '#202845';   // --border
  Chart.defaults.backgroundColor = 'transparent';
  Chart.defaults.font.family     = 'ui-monospace,"Cascadia Code","Consolas",monospace';
  Chart.defaults.font.size       = 12;

  Chart.defaults.plugins.legend.display = false;

  // Shared scale defaults applied via override on each factory call so we don't
  // mutate a single global object that different chart types share differently.
})();

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * sparkline(canvas, points, color) — minimal single-line area chart.
 *
 * @param {HTMLCanvasElement} canvas  - target element
 * @param {number[]}          points  - data values (y), index = x
 * @param {string}            color   - CSS color for the line (e.g. '#34E1FF')
 * @returns {Chart}
 */
export function sparkline(canvas, points, color = '#34E1FF') {
  if (typeof Chart === 'undefined') return null;

  const labels = points.map((_, i) => i);
  return new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data:            points,
        borderColor:     color,
        borderWidth:     2,
        pointRadius:     0,
        tension:         0.35,
        fill:            true,
        backgroundColor: `${color}18`,
      }],
    },
    options: {
      animation:  false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false, grid: { display: false } },
        y: { display: false, grid: { display: false } },
      },
    },
  });
}

/**
 * bar(canvas, labels, data, opts) — horizontal bar chart for ranked lists.
 *
 * Renders an `indexAxis: 'y'` bar chart — the standard for "top N files/agents/etc"
 * views in Synapse. Callers are responsible for the destroy-before-init guard:
 *   if (_c) { _c.destroy(); _c = null; }
 *   _c = bar(canvas, labels, data);
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string[]}          labels  - y-axis labels (one per bar)
 * @param {number[]}          data    - bar lengths (x values)
 * @param {object}            [opts]  - optional overrides merged into options
 * @returns {Chart|null}
 */
export function bar(canvas, labels, data, opts = {}) {
  if (typeof Chart === 'undefined') return null;

  const PALETTE = [
    '#6366f1','#22d3ee','#4ade80','#facc15','#f87171',
    '#a78bfa','#fb923c','#34d399','#60a5fa','#e879f9',
    '#f472b6','#2dd4bf','#818cf8','#fbbf24','#86efac',
  ];
  const bg     = labels.map((_, i) => PALETTE[i % PALETTE.length] + '99');
  const border = labels.map((_, i) => PALETTE[i % PALETTE.length]);

  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: bg,
        borderColor:     border,
        borderWidth:     1,
      }],
    },
    options: Object.assign({
      animation:  false,
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1d27',
          borderColor:     '#2a2d3a',
          borderWidth:     1,
          titleColor:      '#e2e8f0',
          bodyColor:       '#8892a4',
        },
      },
      scales: {
        x: { ticks: { color: '#7C89A8', font: { family: 'ui-monospace,monospace', size: 11 } }, grid: { color: '#202845' } },
        y: { ticks: { color: '#7C89A8', font: { family: 'ui-monospace,monospace', size: 11 } }, grid: { color: '#202845' } },
      },
    }, opts),
  });
}

/**
 * doughnut(canvas, labels, data) — pie/doughnut chart for proportional breakdowns.
 *
 * Used by activity-tools.js to show tool distribution.
 * Callers are responsible for the destroy-before-init guard:
 *   if (_c) { _c.destroy(); _c = null; }
 *   _c = doughnut(canvas, labels, data);
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string[]}          labels  - one label per slice
 * @param {number[]}          data    - slice values
 * @returns {Chart|null}
 */
export function doughnut(canvas, labels, data) {
  if (typeof Chart === 'undefined') return null;

  const PALETTE = [
    '#6366f1','#22d3ee','#4ade80','#facc15','#f87171',
    '#a78bfa','#fb923c','#34d399','#60a5fa','#e879f9',
    '#f472b6','#2dd4bf','#818cf8','#fbbf24','#86efac',
  ];
  const bg     = labels.map((_, i) => PALETTE[i % PALETTE.length] + 'cc');
  const border = labels.map((_, i) => PALETTE[i % PALETTE.length]);

  return new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: bg,
        borderColor:     border,
        borderWidth:     1,
      }],
    },
    options: {
      animation:  false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display:  true,
          position: 'right',
          labels: {
            color:    '#7C89A8',
            boxWidth: 12,
            font:     { family: 'ui-monospace,monospace', size: 11 },
          },
        },
        tooltip: {
          backgroundColor: '#1a1d27',
          borderColor:     '#2a2d3a',
          borderWidth:     1,
          titleColor:      '#e2e8f0',
          bodyColor:       '#8892a4',
        },
      },
    },
  });
}

/**
 * line(canvas, labels, data) — full labelled line chart for section tabs.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string[]}          labels  - x-axis labels
 * @param {number[]}          data    - y values
 * @returns {Chart}
 */
export function line(canvas, labels, data) {
  if (typeof Chart === 'undefined') return null;

  return new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor:     '#34E1FF',
        backgroundColor: 'rgba(52,225,255,.08)',
        borderWidth:     2,
        pointRadius:     2,
        pointBackgroundColor: '#34E1FF',
        tension:         0.3,
        fill:            true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          grid:  { color: '#202845' },
          ticks: { color: '#7C89A8', font: { family: 'ui-monospace,monospace', size: 11 } },
        },
        y: {
          grid:  { color: '#202845' },
          ticks: { color: '#7C89A8', font: { family: 'ui-monospace,monospace', size: 11 } },
        },
      },
    },
  });
}
