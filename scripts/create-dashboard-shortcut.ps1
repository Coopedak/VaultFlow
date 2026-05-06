param(
  [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$projectPath = Join-Path $repoRoot "desktop\VaultFlow.DashboardLauncher\VaultFlow.DashboardLauncher.csproj"
$publishDir = Join-Path $repoRoot "desktop\VaultFlow.DashboardLauncher\bin\$Configuration\net8.0-windows\publish"
$exePath = Join-Path $publishDir "VaultFlow.DashboardLauncher.exe"
$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "VaultFlow Dashboard.lnk"

dotnet publish $projectPath -c $Configuration

if (-not (Test-Path $exePath)) {
  throw "Published launcher not found at $exePath"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = $repoRoot
$shortcut.Arguments = "--repo `"$repoRoot`""
$shortcut.IconLocation = "$exePath,0"
$shortcut.Description = "Launch the VaultFlow dashboard"
$shortcut.Save()

Write-Host "Created shortcut: $shortcutPath"
Write-Host "Launcher: $exePath"
