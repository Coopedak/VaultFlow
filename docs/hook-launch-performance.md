# Hook launch performance on Windows

## Symptom

Claude Code session startup took ~50–60 seconds. Every `Bash`, `Write`, `Edit`,
and `UserPromptSubmit` tool call also stalled for ~20+ seconds. vaultflow's hook
script (`hook-handler.cjs`) was being blamed, but the bottleneck was the launch
wrapper, not the script.

## Diagnosis

Measured on Windows 11 Pro 26200, node 22, PowerShell 5.1, vaultflow on master:

| Invocation | Time |
|---|---|
| `node hook-handler.cjs session-start` (direct) | **1.3 s** |
| `cmd /c node hook-handler.cjs session-start` | 4.1 s |
| `powershell -Command "node hook-handler.cjs session-start"` | **24–40 s** |
| `powershell -NoProfile -Command "node ..."` | 24 s |
| `powershell -Command "Write-Host hi"` (no node) | 0.36 s |

PowerShell startup itself is fast. The penalty appears only when PowerShell's
`-Command` parser sees a `node` invocation and spawns it as a child. Most
likely Defender / AMSI scans the command string and the freshly spawned
`node.exe` on every call. `-NoProfile` does not help, so it is not profile
loading.

## Why session start felt like a full minute

`~/.claude/settings.json` registered three `SessionStart` hooks, run
sequentially:

1. `powershell -File on-session-start.ps1` (~0.8 s — fast, runs PS directly)
2. `powershell -Command "node hook-handler.cjs session-start"` (~24 s)
3. `powershell -Command "node hook-handler.cjs session-restore"` (~24 s)

→ ~50 s before the prompt is ready. The same 24 s penalty also applied to
every `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionEnd`,
`PreCompact`, and `SubagentStop` invocation.

## Fix

Drop the `powershell -Command` wrapper. Call `node.exe` directly with its full
path so the hook runner does not need PATH resolution.

```diff
- "command": "powershell -Command \"node C:/GIT/vaultflow/.claude/helpers/hook-handler.cjs session-start\""
+ "command": "\"C:\\Program Files\\nodejs\\node.exe\" C:/GIT/vaultflow/.claude/helpers/hook-handler.cjs session-start"
```

Applied to all 9 vaultflow hook entries in `~/.claude/settings.json`. The three
`powershell -File "..."` entries (`on-session-start.ps1`, `on-stop.ps1`,
`on-commit.ps1`) stay as-is because they invoke PowerShell scripts, not node,
and were already fast.

## Result

| Phase | Before | After |
|---|---|---|
| Session start | ~50 s | ~3 s |
| Per tool-call hook overhead | ~24 s | ~1 s |
| UserPromptSubmit | ~24 s | ~1 s |

## Cross-CLI scope

Only Claude Code's `~/.claude/settings.json` used the slow wrapper. Other CLIs
reach vaultflow via different paths and were unaffected:

- **Codex** — `.agents/config.toml` (no shell wrapper)
- **Copilot** — `copilot-wrapper.ps1` (its own launcher)
- **Cursor** — `.cursor/rules/wiki.mdc` (pointer file, no hooks)
- **All non-Claude tools** — caught by the watcher daemon at the filesystem layer

The hook script bodies did not change, only the launch path.

## Revert

If a hook silently no-ops or recent-activity injection disappears, swap the
`"C:\\Program Files\\nodejs\\node.exe"` prefix back to `powershell -Command \"node`
on that one entry and reopen Claude Code.

## Reproducing the measurement

```powershell
$r1 = Measure-Command { & node C:/GIT/vaultflow/.claude/helpers/hook-handler.cjs session-start *>&1 | Out-Null }
$r2 = Measure-Command { & cmd /c "node C:/GIT/vaultflow/.claude/helpers/hook-handler.cjs session-start" *>&1 | Out-Null }
$r3 = Measure-Command { & powershell -NoProfile -Command "node C:/GIT/vaultflow/.claude/helpers/hook-handler.cjs session-start" *>&1 | Out-Null }
"direct: $($r1.TotalMilliseconds)ms; cmd: $($r2.TotalMilliseconds)ms; ps: $($r3.TotalMilliseconds)ms"
```

If `direct` and `ps` are similar on a given machine, the AMSI/Defender cost is
not present there and the wrapper is fine. On this machine the gap was ~20×.
