<#
.SYNOPSIS
  Install the Dev Team plugin on this machine from GitHub.

.DESCRIPTION
  Registers the ProgressiveSurface/dev-team repo as a Claude Code marketplace and installs the plugin.
  The repo is its own marketplace, so this is just the two `claude plugin` commands plus a preflight.
  Works on any device — no local clone required. Requires the `claude` CLI; Node.js is needed for analytics.

.PARAMETER Scope
  Install scope: user (default) or project.

.EXAMPLE
  pwsh scripts/install.ps1

.NOTES
  Equivalent inside Claude Code:
    /plugin marketplace add ProgressiveSurface/dev-team
    /plugin install dev-team@dev-team
#>
[CmdletBinding()]
param(
  [ValidateSet('user', 'project')]
  [string]$Scope = 'user'
)

$ErrorActionPreference = 'Stop'

$repo = 'ProgressiveSurface/dev-team'   # GitHub org/repo (also the marketplace name: "dev-team")
$plugin = 'dev-team@dev-team'            # plugin@marketplace

Write-Host "Dev Team installer" -ForegroundColor Cyan

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Error "The 'claude' CLI was not found on PATH. Install Claude Code first, then re-run."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Warning "Node.js was not found on PATH. The plugin installs fine, but analytics (logging + /dev-team-report) need Node."
}

Write-Host "`nRegistering marketplace $repo ..." -ForegroundColor Cyan
claude plugin marketplace add $repo

Write-Host "`nInstalling $plugin (scope: $Scope) ..." -ForegroundColor Cyan
claude plugin install $plugin --scope $Scope

Write-Host "`nDone." -ForegroundColor Green
Write-Host "Try it: open Claude Code and say 'use the dev team on <your task>'."
Write-Host "Analytics: run /dev-team-report to see team activity."
Write-Host "Update later: claude plugin marketplace update dev-team"
