# install-watcher-task.ps1 -- register vaultflow watcher as a Windows scheduled task
#
# WHY: The watcher must keep running across reboots so Copilot/Codex sessions
# always see fresh context, regardless of which CLI was used last. Registering
# as a logon-triggered scheduled task is the cleanest single-point-of-entry:
# survives reboot, doesn't require any CLI to spawn it, exits cleanly.
#
# Run once:
#   powershell -ExecutionPolicy Bypass -File install-watcher-task.ps1
#
# Override the watch dir:
#   powershell -ExecutionPolicy Bypass -File install-watcher-task.ps1 -WatchDir C:\dev
#
# Uninstall:
#   powershell -ExecutionPolicy Bypass -File install-watcher-task.ps1 -Uninstall

[CmdletBinding()]
param(
    [string]$WatchDir   = "C:\GIT",
    [string]$TaskName   = "VaultflowWatcher",
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'."
    } else {
        Write-Host "Scheduled task '$TaskName' not found."
    }
    exit 0
}

# Resolve absolute paths so the task survives even when run from a different cwd.
$helpersDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ensurePath   = Join-Path $helpersDir "ensure-watcher.mjs"
$nodeExe      = (Get-Command node -ErrorAction Stop).Source

if (-not (Test-Path $ensurePath)) {
    throw "ensure-watcher.mjs not found at $ensurePath. Run from inside the vaultflow repo."
}

# Action: node ensure-watcher.mjs <WatchDir>
# ensure-watcher is idempotent. If the daemon is already running, it no-ops.
$action  = New-ScheduledTaskAction `
    -Execute $nodeExe `
    -Argument """$ensurePath"" ""$WatchDir"""

# Trigger: at user logon. AtStartup would require SYSTEM context which
# complicates the user-profile-bound paths vaultflow uses.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -RestartCount 0 `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0)

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

# Replace any existing task with the same name so re-running is idempotent.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Ensures the vaultflow watcher daemon is running so any CLI sees fresh context after reboot." | Out-Null

Write-Host "Registered scheduled task '$TaskName'."
Write-Host "  Trigger:  At logon ($env:USERNAME)"
Write-Host "  Action:   $nodeExe `"$ensurePath`" `"$WatchDir`""
Write-Host ""
Write-Host "Run now without waiting for next logon:"
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
