/**
 * install-git-hooks.mjs — install git hooks for AI-agnostic session boundaries
 *
 * Installs hooks into a project's .git/hooks/ directory to record session
 * boundaries and edit events for Copilot/Codex sessions that don't use
 * the Claude Code hook system.
 *
 * Hooks installed:
 *   post-commit  — records a 'commit' edit event + refreshes AI context files
 *   post-merge   — closes and restarts session boundary after a merge
 *   pre-push     — flushes telemetry Parquet before pushing
 *
 * Usage:
 *   node install-git-hooks.mjs [project-path]   Install hooks
 *   node install-git-hooks.mjs --remove [path]  Remove vaultflow hooks
 *   node install-git-hooks.mjs --status [path]  Show hook status
 */

import path              from 'node:path';
import fs                from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync }      from 'node:child_process';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const HOOK_GUARD = '# vaultflow-managed';

// ── hook scripts ──────────────────────────────────────────────────────────

const POST_COMMIT_HOOK = (vaultflowRoot) => `#!/bin/sh
${HOOK_GUARD}
# Records the commit as an edit event and refreshes gen-context files.
# Safe to fail — never blocks the commit.

VAULTFLOW="${vaultflowRoot}"
HOOK_HANDLER="$VAULTFLOW/.claude/helpers/hook-handler.cjs"
GEN_CONTEXT="$VAULTFLOW/.claude/helpers/gen-context.mjs"

if [ -f "$HOOK_HANDLER" ]; then
  # Record the commit as a session event
  echo '{"tool_input":{"command":"git commit"}}' | node "$HOOK_HANDLER" post-task 2>/dev/null || true
fi

if [ -f "$GEN_CONTEXT" ]; then
  # Refresh Copilot/Cursor context files for this project
  node "$GEN_CONTEXT" "$(pwd)" 2>/dev/null || true
fi

exit 0
`;

const POST_MERGE_HOOK = (vaultflowRoot) => `#!/bin/sh
${HOOK_GUARD}
# Signals a session boundary after a merge (branch switch or pull).

VAULTFLOW="${vaultflowRoot}"
HOOK_HANDLER="$VAULTFLOW/.claude/helpers/hook-handler.cjs"

if [ -f "$HOOK_HANDLER" ]; then
  node "$HOOK_HANDLER" session-start 2>/dev/null || true
fi

exit 0
`;

const PRE_PUSH_HOOK = (vaultflowRoot) => `#!/bin/sh
${HOOK_GUARD}
# Flush telemetry to Parquet before push so history is archived.

VAULTFLOW="${vaultflowRoot}"
FLUSH="$VAULTFLOW/.claude/helpers/flush-parquet.mjs"

if [ -f "$FLUSH" ]; then
  node "$FLUSH" 2>/dev/null || true
fi

exit 0
`;

// ── helpers ───────────────────────────────────────────────────────────────

function getGitRoot(projectPath) {
  try {
    const result = execSync('git rev-parse --git-dir', {
      cwd:   projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    // result is relative to cwd (usually ".git") or absolute
    return path.isAbsolute(result)
      ? result
      : path.join(projectPath, result);
  } catch (_) {
    return null;
  }
}

function isVaultflowHook(hookPath) {
  if (!fs.existsSync(hookPath)) return false;
  const content = fs.readFileSync(hookPath, 'utf8');
  return content.includes(HOOK_GUARD);
}

function hookStatus(hookPath) {
  if (!fs.existsSync(hookPath)) return 'absent';
  if (isVaultflowHook(hookPath)) return 'installed';
  return 'foreign'; // exists but not ours
}

// ── public API ────────────────────────────────────────────────────────────

/**
 * Install vaultflow git hooks into a project.
 *
 * If a hook already exists and isn't ours, we append rather than overwrite.
 *
 * @param {string} projectPath
 * @returns {{ installed: string[], skipped: string[], error: string|null }}
 */
export function installHooks(projectPath) {
  const absProject = path.resolve(projectPath);
  const gitDir     = getGitRoot(absProject);

  if (!gitDir) {
    return { installed: [], skipped: [], error: `Not a git repository: ${absProject}` };
  }

  const hooksDir = path.join(gitDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  // Normalize vaultflow root path for use in shell scripts (forward slashes)
  const vaultflowRoot = __dirname.replace(/\\/g, '/').replace(/\/.claude\/helpers$/, '');

  const hooks = {
    'post-commit': POST_COMMIT_HOOK(vaultflowRoot),
    'post-merge':  POST_MERGE_HOOK(vaultflowRoot),
    'pre-push':    PRE_PUSH_HOOK(vaultflowRoot),
  };

  const installed = [];
  const skipped   = [];

  for (const [hookName, hookContent] of Object.entries(hooks)) {
    const hookPath = path.join(hooksDir, hookName);
    const status   = hookStatus(hookPath);

    if (status === 'installed') {
      skipped.push(`${hookName} (already installed)`);
      continue;
    }

    if (status === 'foreign') {
      // Append our hook to the existing file
      const existing = fs.readFileSync(hookPath, 'utf8');
      const appended = existing.trimEnd() + '\n\n' + hookContent.trimStart();
      fs.writeFileSync(hookPath, appended, 'utf8');
    } else {
      fs.writeFileSync(hookPath, hookContent, 'utf8');
    }

    // Make executable (no-op on Windows, required on Unix)
    try {
      fs.chmodSync(hookPath, 0o755);
    } catch (_) {}

    installed.push(hookName);
  }

  return { installed, skipped, error: null };
}

/**
 * Remove vaultflow-managed hooks from a project.
 *
 * @param {string} projectPath
 * @returns {{ removed: string[] }}
 */
export function removeHooks(projectPath) {
  const absProject = path.resolve(projectPath);
  const gitDir     = getGitRoot(absProject);
  if (!gitDir) return { removed: [] };

  const hooksDir = path.join(gitDir, 'hooks');
  const hookNames = ['post-commit', 'post-merge', 'pre-push'];
  const removed   = [];

  for (const hookName of hookNames) {
    const hookPath = path.join(hooksDir, hookName);
    if (!isVaultflowHook(hookPath)) continue;

    const content = fs.readFileSync(hookPath, 'utf8');
    // If the file is ONLY our hook, delete it. Otherwise, strip our section.
    const withoutOurs = content
      .split('\n')
      .filter((line, i, arr) => {
        // Remove lines that are part of a vaultflow block
        // Simple approach: if the file ONLY contains our guard, delete entirely
        return true;
      })
      .join('\n');

    // Check if anything meaningful remains after removing vaultflow content
    const allContent = content.trim();
    const ourContent = hookName === 'post-commit'
      ? POST_COMMIT_HOOK('').trim()
      : hookName === 'post-merge'
        ? POST_MERGE_HOOK('').trim()
        : PRE_PUSH_HOOK('').trim();

    // If the entire file is only our hook (allow for different vaultflow root paths)
    if (allContent.includes(HOOK_GUARD) && allContent.split('\n').length <= 20) {
      fs.unlinkSync(hookPath);
    } else {
      // Strip our section — find the guard line and remove until next blank+exit block
      const lines = content.split('\n');
      const startIdx = lines.findIndex(l => l.includes(HOOK_GUARD));
      if (startIdx !== -1) {
        // Remove from guard to the next "exit 0" that follows
        let endIdx = startIdx;
        for (let i = startIdx + 1; i < lines.length; i++) {
          if (lines[i].trim() === 'exit 0') { endIdx = i; break; }
        }
        lines.splice(startIdx, endIdx - startIdx + 2); // +2 for guard + trailing blank
        fs.writeFileSync(hookPath, lines.join('\n'), 'utf8');
      }
    }

    removed.push(hookName);
  }

  return { removed };
}

/**
 * Show installation status for all vaultflow hooks.
 *
 * @param {string} projectPath
 * @returns {Array<{hook: string, status: 'installed'|'absent'|'foreign'}>}
 */
export function getStatus(projectPath) {
  const absProject = path.resolve(projectPath);
  const gitDir     = getGitRoot(absProject);
  if (!gitDir) return [];

  const hooksDir = path.join(gitDir, 'hooks');
  return ['post-commit', 'post-merge', 'pre-push'].map(hook => ({
    hook,
    status: hookStatus(path.join(hooksDir, hook)),
  }));
}

// ── CLI ───────────────────────────────────────────────────────────────────

const thisPath = fileURLToPath(import.meta.url);

if (process.argv[1] === thisPath) {
  const args   = process.argv.slice(2);
  const cmd    = args[0];
  const target = (args[1] && !args[1].startsWith('--')) ? args[1] : process.cwd();

  if (cmd === '--remove' || cmd === 'remove') {
    const result = removeHooks(target);
    if (result.removed.length === 0) {
      console.log('No vaultflow hooks found to remove.');
    } else {
      result.removed.forEach(h => console.log(`  removed: ${h}`));
    }

  } else if (cmd === '--status' || cmd === 'status') {
    const statuses = getStatus(target);
    if (statuses.length === 0) {
      console.log(`Not a git repository: ${target}`);
    } else {
      statuses.forEach(s => {
        const icon = s.status === 'installed' ? '✓' : s.status === 'foreign' ? '!' : '✗';
        console.log(`  ${icon} ${s.hook.padEnd(16)} ${s.status}`);
      });
    }

  } else {
    // Default: install
    const result = installHooks(target);
    if (result.error) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    if (result.installed.length > 0) {
      result.installed.forEach(h => console.log(`  installed: ${h}`));
    }
    if (result.skipped.length > 0) {
      result.skipped.forEach(h => console.log(`  skipped: ${h}`));
    }
    if (result.installed.length === 0 && result.skipped.length === 0) {
      console.log('No hooks to install (already current).');
    }
    console.log(`\nHooks installed in: ${target}`);
  }
}
