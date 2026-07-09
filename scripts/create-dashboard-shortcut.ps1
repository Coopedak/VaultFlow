param(
  [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$projectPath = Join-Path $repoRoot "desktop\VaultFlow.DashboardLauncher\VaultFlow.DashboardLauncher.csproj"
$sourcePublishDir = Join-Path $repoRoot "desktop\VaultFlow.DashboardLauncher\bin\$Configuration\net8.0-windows\publish"
$installRoot = Join-Path $env:LOCALAPPDATA "VaultFlow\DashboardLauncher"
$installDir = Join-Path $installRoot $Configuration
$exePath = Join-Path $installDir "VaultFlow.DashboardLauncher.exe"
$repoRootPath = Join-Path $installDir "vaultflow.repo-root.txt"
$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "VaultFlow Dashboard.lnk"

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$dotnetCmd = Get-Command dotnet -ErrorAction SilentlyContinue
$dotnet = $null
if ($dotnetCmd) {
  $dotnet = $dotnetCmd.Source
}

if ($dotnet) {
  & $dotnet publish $projectPath -c $Configuration -o $installDir
} elseif (Test-Path (Join-Path $sourcePublishDir "VaultFlow.DashboardLauncher.exe")) {
  Copy-Item -Path (Join-Path $sourcePublishDir '*') -Destination $installDir -Recurse -Force
} else {
  throw "dotnet was not found and no published launcher exists at $sourcePublishDir"
}

if (-not (Test-Path $exePath)) {
  throw "Published launcher not found at $exePath"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = $installDir
$shortcut.IconLocation = "$exePath,0"
$shortcut.Description = "Launch the VaultFlow dashboard"
$shortcut.Save()

Set-Content -Path $repoRootPath -Value $repoRoot -NoNewline

Write-Host "Created shortcut: $shortcutPath"
Write-Host "Launcher: $exePath"
Write-Host "Installed to: $installDir"
Write-Host "Repo root manifest: $repoRootPath"
