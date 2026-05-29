const TOOL_COMMANDS = {
  claude:  { cmd: 'claude',  windowsCmd: 'claude.cmd',  label: 'Claude Code',    supportsNamedResume: true },
  copilot: { cmd: 'copilot', windowsCmd: 'copilot.cmd', label: 'GitHub Copilot', supportsNamedResume: true },
  codex:   { cmd: 'codex',   windowsCmd: 'codex.cmd',   label: 'Codex',          supportsNamedResume: false },
};

export function getToolDefinition(tool) {
  return TOOL_COMMANDS[tool] || TOOL_COMMANDS.claude;
}

export function getToolLabel(tool) {
  return getToolDefinition(tool).label;
}

function sanitizeSegment(value) {
  return String(value || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'session';
}

export function ensureSessionLaunchMeta(session) {
  if (!session) return null;
  if (!session.launchName) {
    const project = sanitizeSegment(session.project);
    const shortId = String(session.id || '').slice(0, 8) || 'live';
    session.launchName = `vaultflow-${project}-${shortId}`;
  }
  return session.launchName;
}

export function buildToolCommand(tool, session, { mode = 'pty' } = {}) {
  const def = getToolDefinition(tool);
  const launchName = ensureSessionLaunchMeta(session);
  let args = [];

  // Resuming a specific historical session UUID always wins over name-based modes.
  if (session && session.resumeUuid && tool === 'claude') {
    args = ['--resume', session.resumeUuid];
    return {
      cmd: def.cmd,
      windowsCmd: def.windowsCmd || def.cmd,
      args,
      label: def.label,
      launchName,
      resumable: true,
    };
  }

  if (mode === 'pty') {
    if (tool === 'claude' && launchName) args = ['-n', launchName];
    else if (tool === 'copilot' && launchName) args = ['--name', launchName];
  } else if (mode === 'resume') {
    if (tool === 'claude' && launchName) args = ['--resume', launchName];
    else if (tool === 'copilot' && launchName) args = ['--resume', launchName];
  }

  return {
    cmd: def.cmd,
    windowsCmd: def.windowsCmd || def.cmd,
    args,
    label: def.label,
    launchName,
    resumable: mode === 'resume' && def.supportsNamedResume,
  };
}

export function buildDisplayCommand(tool, session, opts) {
  const spec = buildToolCommand(tool, session, opts);
  return [spec.windowsCmd, ...spec.args].join(' ');
}

