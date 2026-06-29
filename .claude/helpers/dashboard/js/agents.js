/**
 * agents.js — Create Agent wizard for the Synapse dashboard.
 *
 * Registers the 'agents' view with core.js. Implements a deterministic
 * 7-step single-agent creation wizard (no LLM, no team support):
 *
 *   1. Identity       — slug, role, description
 *   2. Reuse check    — search existing skills by description; verdict REUSE/MODIFY/BUILD-NEW-OK
 *   3. Capabilities   — domain, boundaries, orientation
 *   4. Output contract — doneCriteria
 *   5. Config         — model select + project picker → detect-stack
 *   6. Preview/diff   — dryRun POST → skillMd + agentMd preview + collision status
 *   7. Confirm        — final POST; handles 409 with explicit Overwrite button
 *
 * Consumes:
 *   GET  /api/agents/projects
 *   GET  /api/agents/detect-stack?path=<abs>
 *   GET  /api/agents/search?q=<q>&limit=<n>
 *   POST /api/agents/create   (dryRun:true for step 6, no dryRun for step 7)
 *
 * No new dependencies — vanilla JS ES module only.
 */

import { registerView } from './core.js';

// ── helpers ───────────────────────────────────────────────────────────────

/** Escape HTML special characters in user-controlled strings before innerHTML injection. */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Minimal fetch wrapper that returns { ok, status, data } without throwing,
 * so individual steps can handle errors inline.
 */
async function apiFetch(path, opts) {
  const r = await fetch(path, opts);
  let data;
  try { data = await r.json(); } catch { data = {}; }
  return { ok: r.ok, status: r.status, data };
}

/** Validate a slug: lowercase/kebab, 3-50 chars, no dots or slashes. */
function slugValid(s) {
  return /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(s) && !/[./]/.test(s);
}

/** Human hint for slug validation. */
function slugHint(s) {
  if (!s) return '';
  if (s.length < 3)  return 'Too short (min 3 characters)';
  if (s.length > 50) return 'Too long (max 50 characters)';
  if (/[A-Z]/.test(s))  return 'Must be lowercase';
  if (/[./]/.test(s))   return 'No dots or slashes allowed';
  if (!/^[a-z0-9-]+$/.test(s)) return 'Only a-z, 0-9, and hyphens';
  if (/^-|-$/.test(s)) return 'Cannot start or end with a hyphen';
  return '';
}

/** Verdict badge HTML for a reuse search result. */
function verdictBadge(verdict) {
  const map = {
    'REUSE':        ['var(--green)',  'REUSE'],
    'MODIFY':       ['var(--amber)',  'MODIFY'],
    'BUILD-NEW-OK': ['var(--muted)',  'BUILD NEW OK'],
  };
  const [color, label] = map[verdict] || ['var(--muted)', verdict];
  return `<span style="font:600 10px/1 var(--mono);color:${color};border:1px solid ${color};border-radius:20px;padding:2px 8px;">${label}</span>`;
}

// ── wizard state ──────────────────────────────────────────────────────────

function makeState() {
  return {
    step: 1,
    // step 1
    slug: '', role: '', description: '',
    // step 2
    reuseResults: null,     // null = not fetched yet
    reuseChosen: null,      // { name, source, description } if user picked existing
    // step 3
    domain: '', boundaries: '', orientation: '',
    // step 4
    doneCriteria: '',
    // step 5
    model: 'sonnet',
    projectPath: '',
    projectName: '',
    detectedStacks: [],
    // step 6
    preview: null,          // { skillMd, agentMd }
    collision: null,        // { agent, skill }
    previewError: null,
    // step 7
    createResult: null,
    createError: null,
    overwriteAvailable: false,
    existingPaths: null,
  };
}

// ── step renderers ────────────────────────────────────────────────────────

function renderStep1(st) {
  const slugErr = slugHint(st.slug);
  const slugOk  = st.slug && slugValid(st.slug);
  return `
    <div class="sec">Step 1 of 7 — Identity</div>
    <div class="card" style="max-width:600px">
      <div style="margin-bottom:18px">
        <label class="wiz-label">Agent slug <span style="color:var(--muted)">(unique identifier)</span></label>
        <input class="wiz-input" id="wiz-slug" value="${esc(st.slug)}" placeholder="my-agent-name" autocomplete="off" spellcheck="false" />
        <div class="wiz-hint ${slugErr ? 'wiz-hint-err' : slugOk ? 'wiz-hint-ok' : ''}">
          ${slugErr || (slugOk ? 'Looks good' : 'Lowercase, kebab-case, 3–50 chars, no dots or slashes')}
        </div>
      </div>
      <div style="margin-bottom:18px">
        <label class="wiz-label">Role <span style="color:var(--muted)">(display title)</span></label>
        <input class="wiz-input" id="wiz-role" value="${esc(st.role)}" placeholder="e.g. Back-End Developer" autocomplete="off" />
      </div>
      <div style="margin-bottom:18px">
        <label class="wiz-label">Description <span style="color:var(--muted)">(one sentence)</span></label>
        <textarea class="wiz-textarea" id="wiz-description" rows="3" placeholder="What this agent does in one sentence…">${esc(st.description)}</textarea>
      </div>
      <div class="wiz-footer">
        <span></span>
        <button class="wiz-btn wiz-btn-primary" id="wiz-next" ${(!slugOk || !st.role.trim() || !st.description.trim()) ? 'disabled' : ''}>
          Next →
        </button>
      </div>
    </div>`;
}

function renderStep2(st) {
  const { reuseResults, reuseChosen } = st;

  if (reuseChosen) {
    return `
      <div class="sec">Step 2 of 7 — Reuse Check</div>
      <div class="card" style="max-width:600px">
        <div style="color:var(--green);font:600 13px/1 var(--mono);margin-bottom:12px">Reusing existing agent</div>
        <div class="wiz-reuse-chosen">
          <div style="font-weight:600;margin-bottom:4px">${esc(reuseChosen.name)}</div>
          <div style="color:var(--muted);font-size:12px;margin-bottom:4px">${esc(reuseChosen.source)}</div>
          <div style="color:var(--text)">${esc(reuseChosen.description)}</div>
        </div>
        <p style="color:var(--muted);font-size:13px;margin:12px 0">
          Use this existing agent instead of creating a new one. No files will be written.
        </p>
        <div class="wiz-footer">
          <button class="wiz-btn" id="wiz-back">← Back</button>
          <button class="wiz-btn" id="wiz-reuse-cancel">Create new anyway</button>
        </div>
      </div>`;
  }

  if (!reuseResults) {
    return `
      <div class="sec">Step 2 of 7 — Reuse Check</div>
      <div class="card" style="max-width:600px">
        <div class="loading">Searching for existing agents…</div>
      </div>`;
  }

  const results = reuseResults;
  const grouped = { REUSE: [], MODIFY: [], 'BUILD-NEW-OK': [] };
  for (const r of results) (grouped[r.verdict] || grouped['BUILD-NEW-OK']).push(r);

  const hasStrong = grouped.REUSE.length > 0 || grouped.MODIFY.length > 0;

  const rowsHtml = results.length === 0
    ? '<div style="color:var(--muted);padding:8px 0">No similar agents found. Safe to create new.</div>'
    : results.map(r => `
        <div class="wiz-reuse-row" data-name="${esc(r.name)}" data-source="${esc(r.source)}" data-desc="${esc(r.description)}" data-verdict="${esc(r.verdict)}">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
            ${verdictBadge(r.verdict)}
            <span style="font-weight:600">${esc(r.name)}</span>
          </div>
          <div style="color:var(--muted);font-size:12px;margin-bottom:6px">${esc(r.source)}</div>
          <div style="color:var(--text);font-size:13px;margin-bottom:8px">${esc(r.description)}</div>
          ${r.verdict === 'REUSE' ? `<button class="wiz-btn wiz-btn-primary wiz-pick-existing" data-name="${esc(r.name)}" data-source="${esc(r.source)}" data-desc="${esc(r.description)}">Use existing →</button>` : ''}
        </div>`).join('');

  return `
    <div class="sec">Step 2 of 7 — Reuse Check</div>
    <div class="card" style="max-width:600px">
      <p style="color:var(--muted);font-size:13px;margin-bottom:14px">
        Searched for agents matching your description. Review before building new.
      </p>
      <div style="margin-bottom:16px">${rowsHtml}</div>
      <div class="wiz-footer">
        <button class="wiz-btn" id="wiz-back">← Back</button>
        <button class="wiz-btn ${hasStrong ? '' : 'wiz-btn-primary'}" id="wiz-next">
          ${hasStrong ? 'Create new anyway →' : 'Continue →'}
        </button>
      </div>
    </div>`;
}

function renderStep3(st) {
  return `
    <div class="sec">Step 3 of 7 — Capabilities</div>
    <div class="card" style="max-width:600px">
      <div style="margin-bottom:18px">
        <label class="wiz-label">Domain <span style="color:var(--muted)">(what it knows / owns — one item per line)</span></label>
        <textarea class="wiz-textarea" id="wiz-domain" rows="4" placeholder="- TypeScript services&#10;- REST API design&#10;- Database migrations">${esc(st.domain)}</textarea>
      </div>
      <div style="margin-bottom:18px">
        <label class="wiz-label">Boundaries <span style="color:var(--muted)">(what it does NOT do)</span></label>
        <textarea class="wiz-textarea" id="wiz-boundaries" rows="3" placeholder="Does not modify UI files&#10;Does not touch infrastructure config">${esc(st.boundaries)}</textarea>
      </div>
      <div style="margin-bottom:18px">
        <label class="wiz-label">Orientation notes <span style="color:var(--muted)">(stack / pattern hints for session start)</span></label>
        <textarea class="wiz-textarea" id="wiz-orientation" rows="3" placeholder="Read CLAUDE.md first. Match existing service patterns.">${esc(st.orientation)}</textarea>
      </div>
      <div class="wiz-footer">
        <button class="wiz-btn" id="wiz-back">← Back</button>
        <button class="wiz-btn wiz-btn-primary" id="wiz-next">Next →</button>
      </div>
    </div>`;
}

function renderStep4(st) {
  return `
    <div class="sec">Step 4 of 7 — Output Contract</div>
    <div class="card" style="max-width:600px">
      <div style="margin-bottom:18px">
        <label class="wiz-label">Done criteria <span style="color:var(--muted)">(how you know the agent finished correctly)</span></label>
        <textarea class="wiz-textarea" id="wiz-done-criteria" rows="5" placeholder="- Code compiles with 0 errors&#10;- All tests pass&#10;- Report includes files changed and build status">${esc(st.doneCriteria)}</textarea>
      </div>
      <div class="wiz-footer">
        <button class="wiz-btn" id="wiz-back">← Back</button>
        <button class="wiz-btn wiz-btn-primary" id="wiz-next">Next →</button>
      </div>
    </div>`;
}

function renderStep5(st, projects) {
  const projectOptions = (projects || [])
    .map(p => `<option value="${esc(p.fullPath)}" ${st.projectPath === p.fullPath ? 'selected' : ''}>${esc(p.name)}</option>`)
    .join('');

  const stackHtml = st.detectedStacks.length
    ? `<div class="wiz-stacks">
        <div class="wiz-label" style="margin-top:12px">Detected stacks</div>
        ${st.detectedStacks.map(s => `
          <span class="wiz-stack-tag">
            ${esc(s.key)}
            <span style="color:var(--muted)"> ${Math.round(s.confidence * 100)}%</span>
          </span>`).join('')}
       </div>`
    : (st.projectPath ? '<div style="color:var(--muted);font-size:12px;margin-top:8px">No stacks detected</div>' : '');

  return `
    <div class="sec">Step 5 of 7 — Config</div>
    <div class="card" style="max-width:600px">
      <div style="margin-bottom:18px">
        <label class="wiz-label">Model</label>
        <select class="wiz-select" id="wiz-model">
          <option value="haiku"  ${st.model === 'haiku'  ? 'selected' : ''}>haiku  — fast, low cost</option>
          <option value="sonnet" ${st.model === 'sonnet' ? 'selected' : ''}>sonnet — balanced</option>
          <option value="opus"   ${st.model === 'opus'   ? 'selected' : ''}>opus   — most capable</option>
        </select>
      </div>
      <div style="margin-bottom:18px">
        <label class="wiz-label">Project <span style="color:var(--muted)">(optional — for stack detection)</span></label>
        <select class="wiz-select" id="wiz-project">
          <option value="">— None —</option>
          ${projectOptions}
        </select>
        ${stackHtml}
      </div>
      <div class="wiz-footer">
        <button class="wiz-btn" id="wiz-back">← Back</button>
        <button class="wiz-btn wiz-btn-primary" id="wiz-next">Preview →</button>
      </div>
    </div>`;
}

function renderStep6(st) {
  if (!st.preview && !st.previewError) {
    return `
      <div class="sec">Step 6 of 7 — Preview</div>
      <div class="card" style="max-width:700px">
        <div class="loading">Generating preview…</div>
      </div>`;
  }

  if (st.previewError) {
    return `
      <div class="sec">Step 6 of 7 — Preview</div>
      <div class="card" style="max-width:700px">
        <div style="color:var(--red);margin-bottom:12px">Preview failed: ${esc(st.previewError)}</div>
        <div class="wiz-footer">
          <button class="wiz-btn" id="wiz-back">← Back</button>
          <button class="wiz-btn" id="wiz-retry-preview">Retry</button>
        </div>
      </div>`;
  }

  const { skillMd, agentMd } = st.preview;
  const col = st.collision || {};
  const colHtml = (col.agent || col.skill)
    ? `<div class="wiz-collision">
        <span style="color:var(--amber);font:600 11px/1 var(--mono)">⚠ COLLISION</span>
        ${col.agent ? `<div style="color:var(--muted);font-size:12px;margin-top:4px">Agent already exists: <code>${esc(col.agent)}</code></div>` : ''}
        ${col.skill ? `<div style="color:var(--muted);font-size:12px;margin-top:2px">Skill already exists: <code>${esc(col.skill)}</code></div>` : ''}
        <div style="color:var(--muted);font-size:12px;margin-top:4px">You will be prompted to overwrite in the next step.</div>
       </div>`
    : '<div style="color:var(--green);font:600 11px/1 var(--mono)">✓ No collisions</div>';

  return `
    <div class="sec">Step 6 of 7 — Preview</div>
    <div class="card" style="max-width:700px">
      ${colHtml}
      <div class="wiz-label" style="margin-top:16px">skill.md</div>
      <pre class="wiz-pre">${esc(skillMd)}</pre>
      <div class="wiz-label" style="margin-top:16px">agent.md</div>
      <pre class="wiz-pre">${esc(agentMd)}</pre>
      <div class="wiz-footer">
        <button class="wiz-btn" id="wiz-back">← Back</button>
        <button class="wiz-btn wiz-btn-primary" id="wiz-next">Confirm &amp; Create →</button>
      </div>
    </div>`;
}

function renderStep7(st) {
  if (st.createResult) {
    const { files, notice } = st.createResult;
    const filesHtml = (files || [])
      .map(f => `<div style="font:12px/1.5 var(--mono);color:var(--green);padding:2px 0">✓ ${esc(f)}</div>`)
      .join('');
    return `
      <div class="sec">Step 7 of 7 — Done</div>
      <div class="card" style="max-width:600px">
        <div style="color:var(--green);font:700 15px/1 var(--mono);margin-bottom:14px">Agent created successfully</div>
        ${filesHtml}
        ${notice ? `<div class="wiz-notice">${esc(notice)}</div>` : ''}
        <div class="wiz-footer" style="margin-top:16px">
          <button class="wiz-btn wiz-btn-primary" id="wiz-start-over">Create another →</button>
        </div>
      </div>`;
  }

  if (st.createError && st.overwriteAvailable) {
    const ex = st.existingPaths || {};
    return `
      <div class="sec">Step 7 of 7 — Confirm</div>
      <div class="card" style="max-width:600px">
        <div style="color:var(--amber);font:600 13px/1 var(--mono);margin-bottom:12px">Agent already exists (409)</div>
        ${ex.agent ? `<div style="color:var(--muted);font-size:12px;margin-bottom:4px">Agent: <code>${esc(ex.agent)}</code></div>` : ''}
        ${ex.skill ? `<div style="color:var(--muted);font-size:12px;margin-bottom:12px">Skill: <code>${esc(ex.skill)}</code></div>` : ''}
        <p style="color:var(--muted);font-size:13px;margin-bottom:14px">
          The existing files will be overwritten. This cannot be undone.
        </p>
        <div class="wiz-footer">
          <button class="wiz-btn" id="wiz-back">← Back</button>
          <button class="wiz-btn wiz-btn-danger" id="wiz-overwrite">Overwrite</button>
        </div>
      </div>`;
  }

  if (st.createError) {
    return `
      <div class="sec">Step 7 of 7 — Confirm</div>
      <div class="card" style="max-width:600px">
        <div style="color:var(--red);margin-bottom:12px">Error: ${esc(st.createError)}</div>
        <div class="wiz-footer">
          <button class="wiz-btn" id="wiz-back">← Back</button>
          <button class="wiz-btn" id="wiz-retry-create">Retry</button>
        </div>
      </div>`;
  }

  // Default: loading / confirming
  return `
    <div class="sec">Step 7 of 7 — Confirm</div>
    <div class="card" style="max-width:600px">
      <div class="loading">Creating agent…</div>
    </div>`;
}

// ── stepper nav ────────────────────────────────────────────────────────────

function stepperHtml(step) {
  const labels = ['Identity', 'Reuse', 'Capabilities', 'Contract', 'Config', 'Preview', 'Confirm'];
  return `<div class="wiz-stepper">
    ${labels.map((l, i) => {
      const n = i + 1;
      const cls = n < step ? 'wiz-step-done' : n === step ? 'wiz-step-active' : 'wiz-step-todo';
      return `<div class="${cls}"><span class="wiz-step-num">${n < step ? '✓' : n}</span><span class="wiz-step-lbl">${l}</span></div>`;
    }).join('<div class="wiz-step-sep"></div>')}
  </div>`;
}

// ── inline styles ─────────────────────────────────────────────────────────

const WIZARD_CSS = `
  .wiz-stepper {
    display: flex; align-items: center; gap: 0; margin-bottom: 20px;
    overflow-x: auto; padding-bottom: 4px;
  }
  .wiz-step-done, .wiz-step-active, .wiz-step-todo {
    display: flex; align-items: center; gap: 6px;
    font: 600 11px/1 var(--mono); white-space: nowrap; padding: 6px 8px;
  }
  .wiz-step-done  { color: var(--green); }
  .wiz-step-active{ color: var(--accent); }
  .wiz-step-todo  { color: var(--faint); }
  .wiz-step-num {
    width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center;
    font-size: 10px; font-weight: 700; flex-shrink: 0;
  }
  .wiz-step-done   .wiz-step-num { background: rgba(74,222,128,.18); color: var(--green); }
  .wiz-step-active .wiz-step-num { background: rgba(52,225,255,.18); color: var(--accent); }
  .wiz-step-todo   .wiz-step-num { background: var(--panel-2); color: var(--faint); }
  .wiz-step-sep {
    flex: 1; min-width: 16px; height: 1px;
    background: var(--border); margin: 0 2px;
  }
  .wiz-label {
    display: block; font: 600 11px/1 var(--mono); letter-spacing: .12em;
    text-transform: uppercase; color: var(--muted); margin-bottom: 7px;
  }
  .wiz-input, .wiz-textarea, .wiz-select {
    width: 100%; background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 9px; color: var(--text); padding: 8px 12px;
    font: 13px var(--ui); outline: none; resize: vertical;
  }
  .wiz-input:focus, .wiz-textarea:focus, .wiz-select:focus { border-color: var(--accent); }
  .wiz-select { cursor: pointer; }
  .wiz-hint { font: 11px/1.5 var(--mono); color: var(--muted); margin-top: 4px; min-height: 16px; }
  .wiz-hint-err { color: var(--red); }
  .wiz-hint-ok  { color: var(--green); }
  .wiz-footer {
    display: flex; justify-content: space-between; align-items: center;
    margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border-soft);
  }
  .wiz-btn {
    padding: 8px 18px; border-radius: 8px; border: 1px solid var(--border);
    background: var(--panel-2); color: var(--text); font: 600 12px/1 var(--ui);
    cursor: pointer; transition: background .15s, border-color .15s;
  }
  .wiz-btn:hover { background: var(--panel); border-color: var(--border); }
  .wiz-btn:disabled { opacity: .4; cursor: not-allowed; }
  .wiz-btn-primary {
    background: rgba(52,225,255,.12); border-color: rgba(52,225,255,.4); color: var(--accent);
  }
  .wiz-btn-primary:hover { background: rgba(52,225,255,.2); }
  .wiz-btn-danger {
    background: rgba(251,113,133,.12); border-color: rgba(251,113,133,.4); color: var(--red);
  }
  .wiz-btn-danger:hover { background: rgba(251,113,133,.2); }
  .wiz-reuse-row {
    padding: 12px; border: 1px solid var(--border-soft); border-radius: 10px;
    margin-bottom: 10px; background: var(--panel-2);
  }
  .wiz-reuse-chosen {
    padding: 12px; border: 1px solid rgba(74,222,128,.3); border-radius: 10px;
    background: rgba(74,222,128,.06);
  }
  .wiz-collision {
    padding: 10px 12px; border: 1px solid rgba(250,204,21,.3); border-radius: 8px;
    background: rgba(250,204,21,.06); margin-bottom: 14px;
  }
  .wiz-pre {
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px; font: 12px/1.6 var(--mono); color: var(--text);
    overflow-x: auto; white-space: pre; max-height: 240px; overflow-y: auto;
  }
  .wiz-notice {
    margin-top: 14px; padding: 10px 12px; border: 1px solid rgba(52,225,255,.25);
    border-radius: 8px; background: rgba(52,225,255,.06);
    font: 12px/1.6 var(--mono); color: var(--accent);
    white-space: pre-wrap;
  }
  .wiz-stacks { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .wiz-stack-tag {
    padding: 4px 10px; border-radius: 20px; border: 1px solid var(--border);
    font: 600 11px/1 var(--mono); color: var(--text); background: var(--panel-2);
  }
`;

// ── read form values into state ────────────────────────────────────────────

function readStep1(el, st) {
  const slug = el.querySelector('#wiz-slug')?.value.trim() ?? '';
  const role = el.querySelector('#wiz-role')?.value.trim() ?? '';
  const description = el.querySelector('#wiz-description')?.value.trim() ?? '';
  return { ...st, slug, role, description };
}

function readStep3(el, st) {
  return {
    ...st,
    domain:      el.querySelector('#wiz-domain')?.value.trim() ?? '',
    boundaries:  el.querySelector('#wiz-boundaries')?.value.trim() ?? '',
    orientation: el.querySelector('#wiz-orientation')?.value.trim() ?? '',
  };
}

function readStep4(el, st) {
  return { ...st, doneCriteria: el.querySelector('#wiz-done-criteria')?.value.trim() ?? '' };
}

function readStep5(el, st) {
  return {
    ...st,
    model:       el.querySelector('#wiz-model')?.value ?? 'sonnet',
    projectPath: el.querySelector('#wiz-project')?.value ?? '',
  };
}

// ── build create payload ───────────────────────────────────────────────────

function buildPayload(st, opts = {}) {
  return {
    slug:           st.slug,
    role:           st.role,
    description:    st.description,
    domain:         st.domain,
    boundaries:     st.boundaries,
    orientation:    st.orientation,
    doneCriteria:   st.doneCriteria,
    model:          st.model,
    stack:          st.detectedStacks,
    techStackEntry: st.projectName || undefined,
    ...opts,
  };
}

// ── view ──────────────────────────────────────────────────────────────────

registerView('agents', async (el) => {
  // Inject scoped styles once
  if (!document.getElementById('wiz-styles')) {
    const style = document.createElement('style');
    style.id = 'wiz-styles';
    style.textContent = WIZARD_CSS;
    document.head.appendChild(style);
  }

  let st = makeState();
  let projects = [];

  // Load projects list up front (non-blocking; used in step 5)
  apiFetch('/api/agents/projects').then(({ ok, data }) => {
    if (ok && Array.isArray(data)) projects = data;
  }).catch(() => {});

  // ── render loop ──────────────────────────────────────────────────────

  function renderWizard() {
    const topbar = `
      <div class="topbar">
        <h1>Create Agent</h1>
        <span class="crumb">/ agents / new</span>
      </div>`;

    let stepHtml;
    switch (st.step) {
      case 1: stepHtml = renderStep1(st); break;
      case 2: stepHtml = renderStep2(st); break;
      case 3: stepHtml = renderStep3(st); break;
      case 4: stepHtml = renderStep4(st); break;
      case 5: stepHtml = renderStep5(st, projects); break;
      case 6: stepHtml = renderStep6(st); break;
      case 7: stepHtml = renderStep7(st); break;
      default: stepHtml = '<div class="loading">Unknown step</div>';
    }

    el.innerHTML = topbar + stepperHtml(st.step) + stepHtml;
  }

  // ── async step actions ───────────────────────────────────────────────

  async function fetchReuse() {
    const { ok, data } = await apiFetch(
      '/api/agents/search?q=' + encodeURIComponent(st.description) + '&limit=6'
    );
    st = { ...st, reuseResults: ok ? (data.results || []) : [] };
    renderWizard();
  }

  async function detectStack(path) {
    if (!path) {
      st = { ...st, detectedStacks: [], projectName: '' };
      renderWizard();
      return;
    }
    const { ok, data } = await apiFetch(
      '/api/agents/detect-stack?path=' + encodeURIComponent(path)
    );
    const proj = projects.find(p => p.fullPath === path);
    st = {
      ...st,
      detectedStacks: ok ? (data.stacks || []) : [],
      projectName:    proj ? proj.name : '',
    };
    renderWizard();
  }

  async function fetchPreview() {
    st = { ...st, preview: null, previewError: null };
    renderWizard();
    const { ok, status, data } = await apiFetch('/api/agents/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(st, { dryRun: true })),
    });
    if (ok && data.preview) {
      st = { ...st, preview: data.preview, collision: data.collision || null, previewError: null };
    } else {
      st = { ...st, previewError: data.error || `HTTP ${status}` };
    }
    renderWizard();
  }

  async function doCreate(overwrite = false) {
    st = { ...st, createResult: null, createError: null, overwriteAvailable: false };
    renderWizard();
    const payload = buildPayload(st);
    if (overwrite) payload.overwrite = true;
    const { ok, status, data } = await apiFetch('/api/agents/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (ok && data.ok) {
      st = { ...st, createResult: data };
    } else if (status === 409) {
      st = {
        ...st,
        createError: data.error || 'Agent already exists',
        overwriteAvailable: true,
        existingPaths: data.existing || null,
      };
    } else {
      st = { ...st, createError: data.error || `HTTP ${status}` };
    }
    renderWizard();
  }

  // ── step navigation ──────────────────────────────────────────────────

  function advance() {
    const next = st.step + 1;
    // Skip reuseChosen: if user picked an existing agent, wizard is "done" (shown in step 2)
    st = { ...st, step: next };
    if (next === 2) {
      renderWizard();
      fetchReuse();
      return;
    }
    if (next === 6) {
      renderWizard();
      fetchPreview();
      return;
    }
    if (next === 7) {
      renderWizard();
      doCreate(false);
      return;
    }
    renderWizard();
  }

  function retreat() {
    const prev = Math.max(1, st.step - 1);
    // Clear async state when going back through step 7 or 6
    if (st.step === 7) st = { ...st, createResult: null, createError: null, overwriteAvailable: false, existingPaths: null };
    if (st.step === 6) st = { ...st, preview: null, previewError: null };
    st = { ...st, step: prev };
    renderWizard();
  }

  // ── delegated event handler ──────────────────────────────────────────

  el.addEventListener('click', async (e) => {
    // Live-read current step values before acting
    if (st.step === 1 && e.target.closest('#wiz-next')) {
      st = readStep1(el, st);
      advance();
      return;
    }
    if (st.step === 2 && e.target.closest('#wiz-next')) {
      // Clear reuseChosen (user chose to create new anyway)
      st = { ...st, reuseChosen: null };
      advance();
      return;
    }
    if (st.step === 2) {
      const pickBtn = e.target.closest('.wiz-pick-existing');
      if (pickBtn) {
        st = {
          ...st,
          reuseChosen: {
            name: pickBtn.dataset.name,
            source: pickBtn.dataset.source,
            description: pickBtn.dataset.desc,
          },
        };
        renderWizard();
        return;
      }
    }
    if (st.step === 2 && e.target.closest('#wiz-reuse-cancel')) {
      // User said "create new anyway" from the chosen-existing panel
      st = { ...st, reuseChosen: null };
      renderWizard();
      return;
    }
    if (st.step === 3 && e.target.closest('#wiz-next')) {
      st = readStep3(el, st);
      advance();
      return;
    }
    if (st.step === 4 && e.target.closest('#wiz-next')) {
      st = readStep4(el, st);
      advance();
      return;
    }
    if (st.step === 5 && e.target.closest('#wiz-next')) {
      st = readStep5(el, st);
      advance();
      return;
    }
    if (st.step === 6 && e.target.closest('#wiz-retry-preview')) {
      fetchPreview();
      return;
    }
    if (st.step === 6 && e.target.closest('#wiz-next')) {
      // No readStep6: step 6 (preview) has no editable fields.
      st = { ...st, step: 7 };
      renderWizard();
      doCreate(false);
      return;
    }
    if (st.step === 7 && e.target.closest('#wiz-retry-create')) {
      doCreate(false);
      return;
    }
    if (st.step === 7 && e.target.closest('#wiz-overwrite')) {
      doCreate(true);
      return;
    }
    if (st.step === 7 && e.target.closest('#wiz-start-over')) {
      st = makeState();
      projects = [];
      apiFetch('/api/agents/projects').then(({ ok, data }) => {
        if (ok && Array.isArray(data)) projects = data;
      }).catch(() => {});
      renderWizard();
      return;
    }
    if (e.target.closest('#wiz-back')) {
      retreat();
      return;
    }
  });

  // Live slug validation + Next button gating on step 1
  el.addEventListener('input', (e) => {
    if (st.step !== 1) return;
    const slugEl = el.querySelector('#wiz-slug');
    const roleEl = el.querySelector('#wiz-role');
    const descEl = el.querySelector('#wiz-description');
    if (!slugEl) return;

    const slug        = slugEl.value.trim();
    const role        = roleEl?.value.trim() ?? '';
    const description = descEl?.value.trim() ?? '';
    st = { ...st, slug, role, description };

    // Update slug hint inline without full re-render
    const hintEl = el.querySelector('.wiz-hint');
    if (hintEl) {
      const err = slugHint(slug);
      const ok  = slug && slugValid(slug);
      hintEl.textContent = err || (ok ? 'Looks good' : 'Lowercase, kebab-case, 3–50 chars, no dots or slashes');
      hintEl.className   = 'wiz-hint' + (err ? ' wiz-hint-err' : ok ? ' wiz-hint-ok' : '');
    }

    // Gate Next button
    const nextBtn = el.querySelector('#wiz-next');
    if (nextBtn) {
      nextBtn.disabled = !(slugValid(slug) && role && description);
    }
  });

  // Project picker → detect stack
  el.addEventListener('change', async (e) => {
    if (st.step !== 5) return;
    const projEl = e.target.closest('#wiz-project');
    if (projEl) {
      st = { ...st, projectPath: projEl.value };
      detectStack(projEl.value);
    }
    const modelEl = e.target.closest('#wiz-model');
    if (modelEl) {
      st = { ...st, model: modelEl.value };
    }
  });

  // Initial render
  renderWizard();
});
