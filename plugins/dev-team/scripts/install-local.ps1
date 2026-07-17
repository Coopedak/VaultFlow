<#
.SYNOPSIS
  Install the Dev Team plugin from THIS folder (local marketplace), no GitHub needed.

.DESCRIPTION
  For the hand-off / exported copy. Registers this extracted folder as a Claude Code marketplace and
  installs the plugin. Requires the `claude` CLI; Node.js is needed for analytics.

.PARAMETER Scope
  Install scope: user (default) or project.

.EXAMPLE
  pwsh scripts/install-local.ps1

.NOTES
  Equivalent inside Claude Code (use the full path to this folder):
    /plugin marketplace add "<this folder>"
    /plugin install dev-team@dev-team
#>
[CmdletBinding()]
param(
  [ValidateSet('user', 'project')]
  [string]$Scope = 'user'
)

$ErrorActionPreference = 'Stop'

# This folder (the plugin = marketplace root) is one level up from scripts/.
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

Write-Host "Dev Team installer (local)" -ForegroundColor Cyan
Write-Host "Plugin folder: $root"

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Error "The 'claude' CLI was not found on PATH. Install Claude Code first, then re-run."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Warning "Node.js was not found on PATH. The plugin installs fine, but analytics (logging + /dev-team-report) need Node."
}
if (-not (Test-Path (Join-Path $root '.claude-plugin\marketplace.json'))) {
  Write-Error "marketplace.json not found in $root\.claude-plugin\. Run this from inside the extracted dev-team folder."
}

Write-Host "`nRegistering local marketplace..." -ForegroundColor Cyan
claude plugin marketplace add "$root"

Write-Host "`nInstalling dev-team@dev-team (scope: $Scope) ..." -ForegroundColor Cyan
claude plugin install "dev-team@dev-team" --scope $Scope

Write-Host "`nDone." -ForegroundColor Green
Write-Host "Try it: open Claude Code and say 'use the dev team on <your task>'."
Write-Host "Analytics: run /dev-team-report to see team activity."
