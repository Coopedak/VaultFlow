#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Installs the vaultflow Copilot CLI wrapper into your PowerShell profile.

.DESCRIPTION
    Adds a 'copilot' function to your $PROFILE that wraps 'gh copilot' with
    vaultflow session tracking. After installation:

        copilot suggest "how do I tar a directory?"
        copilot explain "find . -name '*.log' -mtime +7 -delete"

    To uninstall: run with -Uninstall flag, or remove the marked block
    from your PowerShell profile manually.

.PARAMETER Uninstall
    Remove the copilot wrapper from the profile instead of installing.

.PARAMETER ProfilePath
    Override the profile file to modify (default: $PROFILE).

.EXAMPLE
    # Install
    powershell -File install-copilot-wrapper.ps1

    # Uninstall
    powershell -File install-copilot-wrapper.ps1 -Uninstall
#>

param(
    [switch]$Uninstall,
    [string]$ProfilePath = $PROFILE
)

$GUARD_START = '# ── vaultflow copilot wrapper (start) ──'
$GUARD_END   = '# ── vaultflow copilot wrapper (end) ──'
$WRAPPER     = 'C:\GIT\vaultflow\.claude\helpers\copilot-wrapper.ps1'

$BLOCK = @"

$GUARD_START
# Installed by: C:\GIT\vaultflow\.claude\helpers\install-copilot-wrapper.ps1
# To uninstall: run the installer with -Uninstall
function copilot {
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
        Write-Host 'vaultflow copilot wrapper not found in profile — nothing to remove.'
        exit 0
    }
    # Remove the block between the guards (inclusive)
    $pattern = "(?s)\r?\n$([regex]::Escape($GUARD_START)).*?$([regex]::Escape($GUARD_END))\r?\n?"
    $cleaned = $current -replace $pattern, ''
    Set-Content $ProfilePath $cleaned -NoNewline
    Write-Host "Removed copilot wrapper from: $ProfilePath"
    exit 0
}

# ── install ───────────────────────────────────────────────────────────────────

if ($current -match [regex]::Escape($GUARD_START)) {
    Write-Host "copilot wrapper already installed in: $ProfilePath"
    Write-Host "Run with -Uninstall first if you want to reinstall."
    exit 0
}

# Verify the wrapper script exists
if (-not (Test-Path $WRAPPER)) {
    Write-Error "Wrapper script not found: $WRAPPER"
    Write-Error "Make sure vaultflow is installed at C:\GIT\vaultflow"
    exit 1
}

# Verify gh copilot is available
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Warning "'gh' (GitHub CLI) not found in PATH. Install it from https://cli.github.com before using 'copilot'."
}

Add-Content $ProfilePath $BLOCK
Write-Host "Installed copilot wrapper in: $ProfilePath"
Write-Host ""
Write-Host "Reload your profile with:"
Write-Host "    . `$PROFILE"
Write-Host ""
Write-Host "Then use:"
Write-Host "    copilot suggest `"how do I list all git branches?`""
Write-Host "    copilot explain `"git rebase -i HEAD~3`""
