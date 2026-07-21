# install.ps1 -- zero-dependency bootstrap for a fresh Windows machine.
#
# WHY: scripts/install.mjs needs Node to run, so a truly fresh machine needs
# one layer below it. This script installs the required software, then hands
# off to the node installer which does the vaultflow-specific wiring
# (config bootstrap, vault skeleton, global hooks, nightly task, watcher,
# dev-team plugin, doctor).
#
# Installs when missing (all idempotent, all user-scope where possible):
#   1. Node.js 22+          (winget: OpenJS.NodeJS.LTS)
#   2. Git                  (winget: Git.Git)
#   3. Claude Code CLI      (npm install -g @anthropic-ai/claude-code)
#   4. npm dependencies     (npm install --ignore-scripts, done by install.mjs)
#
# Usage (from the repo root, any PowerShell):
#   powershell -ExecutionPolicy Bypass -File scripts/install.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -SkipClaude
#
# NOTE: keep this file ASCII-only. It has no BOM, so Windows PowerShell 5.1
# reads it as ANSI and UTF-8 punctuation becomes parse-breaking smart quotes.

# NOTE: no [CmdletBinding()] here, and $Forward must stay last.
# With CmdletBinding, PowerShell rejects unknown arguments outright, so
# `install.ps1 --dry-run` died with "A positional parameter cannot be found"
# instead of forwarding the flag to install.mjs. ValueFromRemainingArguments
# collects every unbound argument so the documented passthrough actually works.
param(
    [switch]$SkipClaude,                                   # skip installing the Claude Code CLI
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Forward = @()                               # passed straight through to install.mjs
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Step($msg)  { Write-Host "==> $msg" }
function Done($msg)  { Write-Host "    OK: $msg" -ForegroundColor Green }
function Note($msg)  { Write-Host "    $msg" -ForegroundColor Yellow }

function Refresh-Path {
    # Pick up PATH entries added by winget/npm installers without a new shell.
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Get-NodeMajor {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return 0 }
    $v = (& node --version) -replace '^v', ''
    return [int]($v.Split('.')[0])
}

function Require-Winget {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'winget not found. Install "App Installer" from the Microsoft Store, or install Node 22+ and Git manually, then re-run.'
    }
}

# -- 1. Node.js 22+ ----------------------------------------------------------
Step 'Node.js 22+'
$major = Get-NodeMajor
if ($major -ge 22) {
    Done "node $(& node --version) already installed"
} else {
    Require-Winget
    if ($major -gt 0) { Note "node v$major found - vaultflow needs 22+ (node:sqlite). Upgrading via winget." }
    winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
    Refresh-Path
    $major = Get-NodeMajor
    if ($major -lt 22) { throw 'Node install did not land a 22+ version on PATH. Open a new shell and re-run.' }
    Done "node $(& node --version) installed"
}

# -- 2. Git ------------------------------------------------------------------
Step 'Git'
if (Get-Command git -ErrorAction SilentlyContinue) {
    Done "$(& git --version) already installed"
} else {
    Require-Winget
    winget install --id Git.Git --accept-source-agreements --accept-package-agreements --silent
    Refresh-Path
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git install did not land on PATH. Open a new shell and re-run.' }
    Done "$(& git --version) installed"
}

# -- 3. Claude Code CLI ------------------------------------------------------
Step 'Claude Code CLI'
if ($SkipClaude) {
    Note 'skipped (-SkipClaude)'
} elseif (Get-Command claude -ErrorAction SilentlyContinue) {
    Done 'claude already on PATH'
} else {
    npm install -g @anthropic-ai/claude-code
    Refresh-Path
    if (Get-Command claude -ErrorAction SilentlyContinue) { Done 'claude installed globally via npm' }
    else { Note 'claude not on PATH yet - open a new shell; the dev-team plugin step will be skipped this run' }
}

# -- 4. Hand off to the node installer ---------------------------------------
# install.mjs installs npm dependencies itself when they are missing, then
# does config bootstrap, vault skeleton, hooks, nightly task, watcher,
# dev-team plugin, and finishes with the doctor.
Step 'vaultflow setup (scripts/install.mjs)'
$InstallMjs = Join-Path $RepoRoot 'scripts\install.mjs'
if ($Forward.Count -gt 0) {
    Note "forwarding to install.mjs: $($Forward -join ' ')"
    & node $InstallMjs @Forward
} else {
    & node $InstallMjs
}
exit $LASTEXITCODE
