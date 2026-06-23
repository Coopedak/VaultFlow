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
