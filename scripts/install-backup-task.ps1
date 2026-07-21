# install-backup-task.ps1 -- register the weekly C: -> D: archive backup.
#
# WHY: scripts/backup-to-archive.ps1 preserves the working drive into the
# long-term archive, but a backup that depends on someone remembering to run it
# is not a backup. This registers it as a Scheduled Task.
#
# Modeled on .claude/helpers/install-nightly-task.ps1, including the two
# failure modes that script already learned the hard way:
#
#   - S4U ("run whether logged on or not") requires elevation. Registering S4U
#     non-elevated fails, so the principal is chosen by elevation UP FRONT and
#     degrades to Interactive rather than erroring out.
#   - Overwrite in place with -Force. An earlier version of the nightly script
#     unregistered first and then failed on the register, deleting the task
#     outright. Never unregister-then-register.
#
# -StartWhenAvailable matters more here than for the nightly job: a weekly task
# missed because the machine was off would otherwise wait a full week.
#
# Usage (elevated recommended, works either way):
#   powershell -ExecutionPolicy Bypass -File scripts/install-backup-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/install-backup-task.ps1 -RunNow
#   powershell -ExecutionPolicy Bypass -File scripts/install-backup-task.ps1 -Uninstall
#
# NOTE: keep this file ASCII-only (no BOM; PS 5.1 reads it as ANSI).

param(
    [switch]$RunNow,
    [switch]$Uninstall,
    [string]$Day  = 'Sunday',
    [string]$Time = '19:00'
)

$ErrorActionPreference = 'Stop'
$TaskName = 'VaultflowArchiveBackup'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = Resolve-Path (Join-Path $ScriptDir '..') | ForEach-Object Path
$BackupPs1  = Join-Path $ScriptDir 'backup-to-archive.ps1'
if (-not (Test-Path $BackupPs1)) { throw "backup-to-archive.ps1 not found at $BackupPs1" }

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Unregistered scheduled task: $TaskName"
    } else {
        Write-Host "No task named $TaskName found."
    }
    return
}

$PwshExe = (Get-Command powershell -ErrorAction SilentlyContinue).Source
if (-not $PwshExe) { throw 'powershell not found in PATH' }

$Action = New-ScheduledTaskAction -Execute $PwshExe `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$BackupPs1`"" `
    -WorkingDirectory $RepoRoot

$Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Day -At $Time

# 4 hours: the first run copies whole projects; later runs are incremental (/XO).
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 4)

$IsElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($IsElevated) {
    $LogonType = 'S4U'
} else {
    $LogonType = 'Interactive'
    Write-Warning "Not elevated - registering with Interactive logon (runs at $Day $Time only while logged on; catches up at next logon)."
    Write-Warning "Re-run from an elevated PowerShell for 'runs while logged off' behavior."
}
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType $LogonType -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName `
    -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal `
    -Description 'vaultflow weekly archive backup - additive copy of the working drive into the long-term archive drive. Never mirrors, never deletes.' `
    -Force | Out-Null

Write-Host "Registered scheduled task: $TaskName ($Day @ $Time, logon type: $LogonType)"
Write-Host "  Action: $BackupPs1"

if ($RunNow) {
    Write-Host ""
    Write-Host "Running backup now..."
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "  Last run: $($info.LastRunTime)  Last result: $($info.LastTaskResult)"
}
