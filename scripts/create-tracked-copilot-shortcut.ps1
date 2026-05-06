param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$target = Join-Path $repoRoot "scripts\copilot-tracked.cmd"
$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "Copilot (VaultFlow Tracked).lnk"

if (-not (Test-Path $target)) {
  throw "Tracked Copilot launcher not found at $target"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $repoRoot
$shortcut.IconLocation = "%SystemRoot%\System32\shell32.dll,220"
$shortcut.Description = "Launch Copilot with VaultFlow SQLite telemetry"
$shortcut.Save()

Write-Host "Created shortcut: $shortcutPath"
Write-Host "Target: $target"
