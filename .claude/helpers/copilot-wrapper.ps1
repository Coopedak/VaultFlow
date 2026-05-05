#!/usr/bin/env pwsh
<#
.SYNOPSIS
    vaultflow-aware wrapper for gh copilot CLI.

.DESCRIPTION
    Fires vaultflow session hooks around every gh copilot call so Copilot
    sessions are tracked in the same SQLite DB as Claude Code sessions.

    Hook sequence:
        session-start   — creates/restores a vaultflow session
        copilot-prompt  — logs the prompt + routes to skills
        gh copilot ...  — runs the real command (fully interactive)
        post-task       — syncs MEMORY.md PageRank
        session-end     — closes the session record

.USAGE
    # After running Install-CopilotWrapper.ps1, use the 'ghcopilot' function:
    ghcopilot suggest "list all running docker containers"
    ghcopilot explain "grep -rn TODO ."
    ghcopilot --help

.NOTES
    All vaultflow output goes to stderr so it never pollutes copilot's stdout.
    If vaultflow is unavailable the real gh copilot runs unchanged.
#>

param(
    [Parameter(Position = 0)]
    [string]$Subcommand = '',

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Rest = @()
)

# ── config ────────────────────────────────────────────────────────────────────

$HNDLR = Join-Path $PSScriptRoot 'hook-handler.cjs'
$VF_OK = Test-Path $HNDLR

# ── passthrough guard ─────────────────────────────────────────────────────────
# If vaultflow is not installed, just run gh copilot unchanged.

if (-not $VF_OK) {
    if ($Subcommand) {
        & gh copilot $Subcommand @Rest
    } else {
        & gh copilot
    }
    exit $LASTEXITCODE
}

# ── session-start ─────────────────────────────────────────────────────────────

$null = node $HNDLR session-start 2>&1

# ── prompt logging ────────────────────────────────────────────────────────────
# Extract the natural-language prompt from the args.
# For 'suggest' and 'explain', it's the first non-flag argument.

$promptText = ''
if ($Rest.Count -gt 0) {
    $promptText = ($Rest | Where-Object { $_ -notmatch '^-' }) -join ' '
}

if ($promptText -and $Subcommand -in @('suggest', 'explain')) {
    $payload = [ordered]@{
        prompt     = $promptText
        subcommand = $Subcommand
        source     = 'copilot-cli'
    } | ConvertTo-Json -Compress

    $null = $payload | node $HNDLR copilot-prompt 2>&1
}

# ── resume context block ─────────────────────────────────────────────────────
# Print a brief session-resume summary for the current project before launching.

$RESUME = Join-Path $PSScriptRoot 'copilot-resume.cjs'
if (Test-Path $RESUME) {
    $projectName = Split-Path (Get-Location) -Leaf
    node $RESUME $projectName
}

# ── run gh copilot (fully interactive) ───────────────────────────────────────

if ($Subcommand) {
    & gh copilot $Subcommand @Rest
} else {
    & gh copilot
}
$exitCode = $LASTEXITCODE

# ── post-task + session-end ───────────────────────────────────────────────────

$null = node $HNDLR post-task    2>&1
$null = node $HNDLR session-end  2>&1

exit $exitCode
