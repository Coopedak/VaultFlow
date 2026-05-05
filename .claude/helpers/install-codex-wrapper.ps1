#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Installs the vaultflow Codex CLI wrapper into your PowerShell profile.

.DESCRIPTION
    Adds a 'vaultflow-codex' function to your $PROFILE that wraps 'codex' with
    vaultflow session tracking, without shadowing the real Codex CLI.
    After installation:

        vaultflow-codex "refactor this function to be async"
        vaultflow-codex --help

    The real 'codex' command remains fully available and is never overridden.

    To uninstall: run with -Uninstall flag, or remove the marked block
    from your PowerShell profile manually.

.PARAMETER Uninstall
    Remove the codex wrapper from the profile instead of installing.

.PARAMETER ProfilePath
    Override the profile file to modify (default: $PROFILE).

.EXAMPLE
    # Install
    powershell -File install-codex-wrapper.ps1

    # Uninstall
    powershell -File install-codex-wrapper.ps1 -Uninstall
#>

param(
    [switch]$Uninstall,
    [string]$ProfilePath = $PROFILE
)

$GUARD_START = '# ── vaultflow codex wrapper (start) ──'
$GUARD_END   = '# ── vaultflow codex wrapper (end) ──'
$WRAPPER     = Join-Path $PSScriptRoot 'codex-wrapper.ps1'

$BLOCK = @"

$GUARD_START
# Installed by: $PSScriptRoot\install-codex-wrapper.ps1
# To uninstall: run the installer with -Uninstall
function vaultflow-codex {
    & '$WRAPPER' @args
}
$GUARD_END
"@

# ── ensure profile file exists ────────────────────────────────────────────────

$profileDir = Split-Path $ProfilePath -Parent
if (-not (Test-Path $profileDir)) {
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
}
if (-not (Test-Path $ProfilePath)) {
    New-Item -ItemType File -Path $ProfilePath -Force | Out-Null
}

$current = Get-Content $ProfilePath -Raw -ErrorAction SilentlyContinue
if ($null -eq $current) { $current = '' }

# ── uninstall ─────────────────────────────────────────────────────────────────

if ($Uninstall) {
    if ($current -notmatch [regex]::Escape($GUARD_START)) {
        Write-Host 'vaultflow codex wrapper not found in profile — nothing to remove.'
        exit 0
    }
    # Remove the block between the guards (inclusive)
    $pattern = "(?s)\r?\n$([regex]::Escape($GUARD_START)).*?$([regex]::Escape($GUARD_END))\r?\n?"
    $cleaned = $current -replace $pattern, ''
    Set-Content $ProfilePath $cleaned -NoNewline
    Write-Host "Removed codex wrapper from: $ProfilePath"
    exit 0
}

# ── install ───────────────────────────────────────────────────────────────────

if ($current -match [regex]::Escape($GUARD_START)) {
    $pattern = "(?s)\r?\n$([regex]::Escape($GUARD_START)).*?$([regex]::Escape($GUARD_END))\r?\n?"
    $current = $current -replace $pattern, ''
}

# Verify the wrapper script exists
if (-not (Test-Path $WRAPPER)) {
    Write-Error "Wrapper script not found: $WRAPPER"
    Write-Error "Make sure vaultflow is installed and the helpers directory is intact."
    exit 1
}

# Verify codex is available
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
    Write-Warning "'codex' not found in PATH. Install it before using 'vaultflow-codex'."
}

Add-Content $ProfilePath $BLOCK
Write-Host "Installed codex wrapper in: $ProfilePath"
Write-Host ""
Write-Host "Reload your profile with:"
Write-Host "    . `$PROFILE"
Write-Host ""
Write-Host "Then use:"
Write-Host "    vaultflow-codex `"refactor this function to be async`""
Write-Host "    vaultflow-codex --help"
Write-Host ""
Write-Host "The real Codex CLI remains available as:"
Write-Host "    codex"
