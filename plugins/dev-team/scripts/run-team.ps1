<#
.SYNOPSIS
  Run the Dev Team headlessly against a project from another process (CI, script, scheduler).

.DESCRIPTION
  Wraps `claude -p` to trigger the dev-team skill non-interactively. The session adopts the
  Project Manager role and dispatches the worker subagents. Requires the dev-team plugin to be
  installed (run scripts/install.ps1 first) and the `claude` CLI on PATH.

.PARAMETER Task
  The task for the team, in plain language. Quote it or pass it as trailing words.

.PARAMETER Project
  Target repo to work in. Defaults to the current directory.

.PARAMETER Json
  Emit structured JSON (claude --output-format json) instead of text.

.PARAMETER Yolo
  Fully unattended: --dangerously-skip-permissions (no prompts at all). Use only in a sandbox/CI.
  Without it, the default is --permission-mode acceptEdits (auto-accepts file edits; other tools
  may still prompt if a human is present).

.EXAMPLE
  pwsh scripts/run-team.ps1 "add a search box to the customer list"

.EXAMPLE
  pwsh scripts/run-team.ps1 -Project C:\git\MyApp -Json -Yolo "implement issue #42"
#>
[CmdletBinding()]
param(
  [string]$Project = (Get-Location).Path,
  [switch]$Json,
  [switch]$Yolo,
  [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
  [string[]]$Task
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Error "The 'claude' CLI was not found on PATH. Install Claude Code and the dev-team plugin first."
}

$taskText = ($Task -join ' ').Trim()
if (-not $taskText) {
  Write-Error "Provide a task, e.g.  run-team.ps1 'add a search box to the customer list'"
}

$prompt = "Use the dev team to: $taskText"
$cliArgs = @('-p', $prompt)
$cliArgs += if ($Yolo) { '--dangerously-skip-permissions' } else { @('--permission-mode', 'acceptEdits') }
if ($Json) { $cliArgs += @('--output-format', 'json') }

Write-Host "Dev Team (headless) → $Project" -ForegroundColor Cyan
Write-Host "Task: $taskText`n"

Push-Location $Project
try {
  & claude @cliArgs
}
finally {
  Pop-Location
}
