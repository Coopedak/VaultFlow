# install-nightly-task.ps1 — register vaultflow nightly maintenance as a Scheduled Task.
#
# WHY: The dashboard showed "healthy" because it surfaced row counts.
# Meanwhile sessions weren't summarized, patterns were 97% noise, and vault
# tools sat unpromoted because session-end hooks miss ~95% of sessions and
# no other job was running maintenance. This installs a dedicated nightly
# task that calls nightly.mjs at 3 AM.
#
# Usage (as Administrator):
#   powershell -ExecutionPolicy Bypass -File install-nightly-task.ps1
#   powershell -ExecutionPolicy Bypass -File install-nightly-task.ps1 -RunNow
#   powershell -ExecutionPolicy Bypass -File install-nightly-task.ps1 -Uninstall

param(
    [switch]$RunNow,
    [switch]$Uninstall,
    [string]$Time = '03:00'
)

$ErrorActionPreference = 'Stop'
$TaskName = 'VaultflowNightly'

# Resolve repo root: this script lives at <repo>/.claude/helpers/install-nightly-task.ps1
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Resolve-Path (Join-Path $ScriptDir '../..') | ForEach-Object Path
$NodeExe   = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) { throw 'node not found in PATH' }

$NightlyMjs = Join-Path $ScriptDir 'nightly.mjs'
if (-not (Test-Path $NightlyMjs)) { throw "nightly.mjs not found at $NightlyMjs" }

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Unregistered scheduled task: $TaskName"
    } else {
        Write-Host "No task named $TaskName found."
    }
    return
}

# Build the scheduled task
$Action  = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$NightlyMjs`"" -WorkingDirectory $RepoRoot
$Trigger = New-ScheduledTaskTrigger -Daily -At $Time
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
# S4U = "Run whether user is logged on or not" WITHOUT storing a password.
# Interactive logon type silently skips the 3 AM run whenever the user is
# logged off overnight (and -StartWhenAvailable does NOT catch up condition
# misses), which is why nightly maintenance/backup stalled for days. S4U fires
# regardless of logon state; the limited/no-network token is fine because
# nightly.mjs operates only on local files.
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description 'vaultflow nightly maintenance — session summary backfill, pattern noise purge, vault_tool promotion, retrieval learning loop, parquet flush.' | Out-Null

Write-Host "Registered scheduled task: $TaskName (daily @ $Time)"
Write-Host "  Action: $NodeExe `"$NightlyMjs`""
Write-Host "  Working dir: $RepoRoot"

if ($RunNow) {
    Write-Host ""
    Write-Host "Running nightly task now..."
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 2
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "  Last run: $($info.LastRunTime)  Last result: $($info.LastTaskResult)"
}
