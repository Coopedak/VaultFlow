/**
 * widgets/new-session-dialog.mjs — N key new session dialog
 *
 * Center modal, 85 cols wide, 22 rows tall.
 * Tool selector (↑↓), project dir input, optional prompt input.
 * Enter to launch, Esc to cancel.
 */

import blessed            from 'blessed';
import path               from 'node:path';
import fs                 from 'node:fs';
import { sessionManager } from '../session-manager.mjs';
import { ptyManager }     from '../pty-manager.mjs';
import { getRecentProjects } from '../db-reader.mjs';
import { recordSessionStart } from '../telemetry.mjs';

const TOOLS = [
  { id: 'claude',     label: 'claude',     desc: 'Claude Code (claude CLI)',              color: '{#ff8800-fg}' },
  { id: 'copilot',    label: 'copilot',    desc: 'GitHub Copilot CLI (copilot)',          color: '{magenta-fg}' },
  { id: 'codex',      label: 'codex',      desc: 'OpenAI Codex CLI (codex)',              color: '{cyan-fg}' },
];

function getDefaultProjectDir() {
  if (process.platform === 'win32') {
    const gitRoot = 'C:\\GIT';
    try {
      if (fs.statSync(gitRoot).isDirectory()) {
        return gitRoot;
      }
    } catch {}
  }

  return process.cwd();
}

export function createNewSessionDialog(screen, { onLaunch } = {}) {
  let visible = false;
  let toolIdx = 0;
  let fieldFocus = 'tool';  // 'tool' | 'projects' | 'dir' | 'prompt'
  let projectDirs = [];
  let projectIdx = 0;
  let projectRoot = getDefaultProjectDir();

  // ── container ──────────────────────────────────────────────────────────────

  const container = blessed.box({
    top:    'center',
    left:   'center',
    width:  87,
    height: 31,
    hidden: true,
    tags:   true,
    border: { type: 'line' },
    style: {
      fg:     'white',
      bg:     'black',
      border: { fg: '#ff8800' },
    },
  });

  // Title
  const titleBox = blessed.box({
    top:    0,
    left:   1,
    width:  '100%-2',
    height: 1,
    tags:   true,
    content: '{bold}{white-fg} NEW SESSION{/}',
    style:  { fg: 'white', bg: 'black' },
  });

  // Tool selector label
  const toolLabel = blessed.box({
    top:    2,
    left:   2,
    width:  '100%-4',
    height: 1,
    tags:   true,
    content: 'Tool',
    style:  { fg: 'grey', bg: 'black' },
  });

  // Tool selector list
  const toolList = blessed.list({
    top:     3,
    left:    2,
    width:   '100%-4',
    height:  TOOLS.length + 2,
    tags:    true,
    border:  { type: 'line' },
    keys:    false,
    mouse:   true,
    style: {
      fg:       'white',
      bg:       'black',
      border:   { fg: 'grey' },
      selected: { fg: 'white', bg: '#333333' },
    },
  });

  // Dir label
  const dirLabel = blessed.box({
    top:    8,
    left:   2,
    width:  '100%-4',
    height: 1,
    tags:   true,
    content: 'Project directory',
    style:  { fg: 'grey', bg: 'black' },
  });

  // Dir input
  const dirInput = blessed.textbox({
    top:      9,
    left:     2,
    width:    '100%-4',
    height:   3,
    border:   { type: 'line' },
    inputOnFocus: true,
    tags:     false,
    style: {
      fg:     'white',
      bg:     'black',
      border: { fg: 'grey' },
      focus:  { border: { fg: '#ff8800' } },
    },
  });

  // Recent projects
  const recentBox = blessed.box({
    top:    21,
    left:   2,
    width:  '100%-4',
    height: 1,
    tags:   true,
    style:  { fg: 'grey', bg: 'black' },
  });

  const projectLabel = blessed.box({
    top:    12,
    left:   2,
    width:  '100%-4',
    height: 1,
    tags:   true,
    content: 'Projects in C:\\GIT',
    style:  { fg: 'grey', bg: 'black' },
  });

  const projectList = blessed.list({
    top:     13,
    left:    2,
    width:   '100%-4',
    height:  8,
    tags:    true,
    border:  { type: 'line' },
    keys:    false,
    mouse:   true,
    scrollable: true,
    alwaysScroll: true,
    style: {
      fg:       'white',
      bg:       'black',
      border:   { fg: 'grey' },
      selected: { fg: 'white', bg: '#333333' },
      scrollbar: { bg: 'grey' },
    },
  });

  // Prompt label
  const promptLabel = blessed.box({
    top:    23,
    left:   2,
    width:  '100%-4',
    height: 1,
    tags:   true,
    content: 'Initial prompt  {grey-fg}(optional — leave blank for interactive shell){/}',
    style:  { fg: 'grey', bg: 'black' },
  });

  // Prompt input
  const promptInput = blessed.textbox({
    top:      24,
    left:     2,
    width:    '100%-4',
    height:   3,
    border:   { type: 'line' },
    inputOnFocus: true,
    tags:     false,
    style: {
      fg:     'white',
      bg:     'black',
      border: { fg: 'grey' },
      focus:  { border: { fg: '#ff8800' } },
    },
  });

  // Footer hint
  const hintBox = blessed.box({
    top:    28,
    left:   2,
    width:  '100%-4',
    height: 1,
    tags:   true,
    content: '{green-fg}Enter:launch{/}    {grey-fg}Tab:next field{/}    {grey-fg}↑↓:choose project{/}    {grey-fg}Esc:cancel{/}',
    style:  { fg: 'white', bg: 'black' },
  });

  // Assemble
  container.append(titleBox);
  container.append(toolLabel);
  container.append(toolList);
  container.append(dirLabel);
  container.append(dirInput);
  container.append(projectLabel);
  container.append(projectList);
  container.append(recentBox);
  container.append(promptLabel);
  container.append(promptInput);
  container.append(hintBox);

  // ── tool list rendering ────────────────────────────────────────────────────

  function renderToolList() {
    const items = TOOLS.map((t, i) => {
      const dot    = i === toolIdx ? '●' : '○';
      const color  = t.color;
      return `${color}${dot}{/} ${t.label.padEnd(14)} {grey-fg}${t.desc}{/}`;
    });
    toolList.setItems(items);
    toolList.select(toolIdx);
  }

  function renderRecent() {
    const recents = getRecentProjects().slice(0, 6);
    if (recents.length === 0) {
      recentBox.setContent('{grey-fg}Recent: (none){/}');
    } else {
      recentBox.setContent(`{grey-fg}Recent: ${recents.join('  ')}{/}`);
    }
  }

  function renderProjectLabel() {
    projectLabel.setContent(`Projects in ${projectRoot}`);
  }

  function loadProjects() {
    projectRoot = getDefaultProjectDir();
    try {
      projectDirs = fs.readdirSync(projectRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      projectDirs = [];
    }
    projectIdx = 0;
    renderProjectLabel();
  }

  function syncDirToProject() {
    const name = projectDirs[projectIdx];
    if (!name) {
      dirInput.setValue(projectRoot);
      return;
    }
    dirInput.setValue(path.join(projectRoot, name));
  }

  function renderProjectList() {
    const items = projectDirs.length === 0
      ? [`{grey-fg}(no projects found under ${projectRoot}){/}`]
      : projectDirs.map((name, i) => {
          const dot = i === projectIdx ? '●' : '○';
          return `{cyan-fg}${dot}{/} ${name}`;
        });
    projectList.setItems(items);
    if (projectDirs.length > 0) {
      projectList.select(projectIdx);
      syncDirToProject();
    } else {
      dirInput.setValue(getDefaultProjectDir());
    }
  }

  // ── focus management ────────────────────────────────────────────────────────

  function setFieldFocus(field) {
    fieldFocus = field;
    // Update border colors to show active field
    projectList.style.border.fg = field === 'projects' ? '#ff8800' : 'grey';
    dirInput.style.border.fg    = field === 'dir'    ? '#ff8800' : 'grey';
    promptInput.style.border.fg = field === 'prompt' ? '#ff8800' : 'grey';

    if (field === 'projects') {
      projectList.focus();
    } else if (field === 'dir') {
      dirInput.focus();
    } else if (field === 'prompt') {
      promptInput.focus();
    } else {
      // tool — blur inputs
      try { projectList.cancel(); } catch {}
      try { dirInput.cancel(); }    catch {}
      try { promptInput.cancel(); } catch {}
      toolList.focus();
    }
    screen.render();
  }

  function tabNext() {
    if (fieldFocus === 'tool')        setFieldFocus('projects');
    else if (fieldFocus === 'projects') setFieldFocus('dir');
    else if (fieldFocus === 'dir')    setFieldFocus('prompt');
    else                              setFieldFocus('tool');
  }

  // ── launch ─────────────────────────────────────────────────────────────────

  function launch() {
    const tool = TOOLS[toolIdx].id;
    const rawCwd = (dirInput.getValue() || '').trim();

    // Resolve to absolute path and validate it exists
    let cwd;
    if (!rawCwd) {
      cwd = getDefaultProjectDir();
    } else {
      try {
        cwd = path.resolve(rawCwd);
      } catch {
        cwd = getDefaultProjectDir();
      }
    }

    // Verify directory exists — node-pty throws error 267 on invalid cwd
    try {
      if (!fs.statSync(cwd).isDirectory()) cwd = getDefaultProjectDir();
    } catch {
      cwd = getDefaultProjectDir();
    }

    const prompt = (promptInput.getValue() || '').trim();
    const project = path.basename(cwd) || 'unknown';

    const session = sessionManager.create({ tool, project, cwd });
    session.commands = prompt ? 1 : 0;
    recordSessionStart(session, { initialPrompt: prompt });
    hide();

    // Get right panel dimensions for PTY sizing
    const cols = Math.max(80, (screen.width || 130) - 37 - 2);
    const rows = Math.max(20, (screen.height || 50) - 5);

    ptyManager.spawn(session, { cols, rows, initialPrompt: prompt });

    if (onLaunch) onLaunch(session);
  }

  // ── key handling ────────────────────────────────────────────────────────────

  /**
   * Handle a key press while dialog is visible.
   * Returns true if the key was consumed.
   */
  function handleKey(key, ch) {
    if (!visible) return false;

    if (key === 'escape') { hide(); return true; }

    if (key === 'tab') { tabNext(); return true; }

    if (fieldFocus === 'tool') {
      if (key === 'up' && toolIdx > 0) {
        toolIdx--;
        renderToolList();
        screen.render();
        return true;
      }
      if (key === 'down' && toolIdx < TOOLS.length - 1) {
        toolIdx++;
        renderToolList();
        screen.render();
        return true;
      }
      if (key === 'enter') {
        setFieldFocus('projects');
        return true;
      }
    }

    if (fieldFocus === 'projects') {
      if (key === 'up' && projectIdx > 0) {
        projectIdx--;
        renderProjectList();
        screen.render();
        return true;
      }
      if (key === 'down' && projectIdx < projectDirs.length - 1) {
        projectIdx++;
        renderProjectList();
        screen.render();
        return true;
      }
      if (key === 'enter') {
        launch();
        return true;
      }
    }

    if (fieldFocus === 'dir' && key === 'enter') {
      setFieldFocus('prompt');
      return true;
    }

    if (fieldFocus === 'prompt' && key === 'enter') {
      launch();
      return true;
    }

    return false;
  }

  // ── show / hide ────────────────────────────────────────────────────────────

  function show() {
    visible  = true;
    toolIdx  = 0;
    fieldFocus = 'tool';
    loadProjects();

    renderProjectList();
    promptInput.clearValue();

    renderToolList();
    renderRecent();

    container.show();
    container.setFront();
    toolList.focus();
    screen.render();
  }

  function hide() {
    visible = false;
    container.hide();
    screen.render();
  }

  function isVisible() {
    return visible;
  }

  return { container, show, hide, isVisible, handleKey };
}
