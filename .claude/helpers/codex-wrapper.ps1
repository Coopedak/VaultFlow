#!/usr/bin/env pwsh
<#
.SYNOPSIS
    vaultflow-aware wrapper for the Codex CLI.

.DESCRIPTION
    Fires vaultflow session hooks around every codex call so Codex
    sessions are tracked in the same SQLite DB as Claude Code sessions.

    Hook sequence:
        session-start   — creates/restores a vaultflow session
        copilot-prompt  — logs the prompt (reuses the generic event)
        codex ...       — runs the real command (fully interactive)
        post-task       — syncs MEMORY.md PageRank
        session-end     — closes the session record

.USAGE
    # After running install-codex-wrapper.ps1, use the 'vaultflow-codex' function:
    vaultflow-codex "refactor this function to be async"
    vaultflow-codex --help

.NOTES
    All vaultflow output goes to stderr so it never pollutes codex's stdout.
    If vaultflow is unavailable the real codex runs unchanged.
    The alias 'vaultflow-codex' is used so the real 'codex' command is never shadowed.
#>

param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$Args = @()
)

# ── config ────────────────────────────────────────────────────────────────────

$HNDLR = Join-Path $PSScriptRoot 'hook-handler.cjs'
$VF_OK = Test-Path $HNDLR

# ── passthrough guard ─────────────────────────────────────────────────────────
# If vaultflow is not installed, just run codex unchanged.

if (-not $VF_OK) {
    & codex @Args
    exit $LASTEXITCODE
}

# ── session-start ─────────────────────────────────────────────────────────────

$null = node $HNDLR session-start 2>&1

# ── prompt logging ────────────────────────────────────────────────────────────
# The first non-flag argument is the prompt text passed to codex.

$promptText = ($Args | Where-Object { $_ -notmatch '^-' } | Select-Object -First 1)
if ($promptText) {
    $payload = [ordered]@{
        prompt     = $promptText
        subcommand = 'codex'
        source     = 'codex-cli'
    } | ConvertTo-Json -Compress

    $null = $payload | node $HNDLR copilot-prompt 2>&1
}

# ── run codex (fully interactive) ────────────────────────────────────────────

& codex @Args
$exitCode = $LASTEXITCODE

# ── post-task + session-end ───────────────────────────────────────────────────

$null = node $HNDLR post-task   2>&1
$null = node $HNDLR session-end 2>&1

exit $exitCode
