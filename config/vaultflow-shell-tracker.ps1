# vaultflow shell tracker — add to $PROFILE to capture shell commands with timestamps + CWD
# Source this file from your $PROFILE:
#   . "C:\GIT\vaultflow\config\vaultflow-shell-tracker.ps1"
#
# Derives metrics_root from vaultflow.yaml automatically — no hardcoded paths.

$__vf_config = Join-Path $PSScriptRoot 'vaultflow.yaml'
if (-not (Test-Path $__vf_config)) { $__vf_config = Join-Path $PSScriptRoot 'vaultflow.local.yaml' }
if (-not (Test-Path $__vf_config)) { $__vf_config = Join-Path $PSScriptRoot 'vaultflow.example.yaml' }

$__vf_metricsRoot = (Get-Content $__vf_config | Select-String 'metrics_root').ToString() -replace '^[^:]+:\s*["'']?([^"'']+)["'']?\s*$','$1'
$__vf_metricsRoot = $__vf_metricsRoot.Replace('/', '\').Trim()

$global:__vf_jsonl = Join-Path $__vf_metricsRoot 'shell-commands.jsonl'
$null = New-Item -ItemType Directory -Force -Path $__vf_metricsRoot -ErrorAction SilentlyContinue

Set-PSReadLineOption -AddToHistoryHandler {
    param([string]$line)
    if ($line.Trim()) {
        try {
            $ts  = (Get-Date).ToUniversalTime().ToString('o')
            $cmd = $line    | ConvertTo-Json -Compress
            $cwd = $PWD.Path | ConvertTo-Json -Compress
            $entry = "{`"ts`":`"$ts`",`"cmd`":$cmd,`"cwd`":$cwd,`"shell`":`"powershell`"}"
            Add-Content -Path $global:__vf_jsonl -Value $entry -Encoding UTF8 -ErrorAction SilentlyContinue
        } catch {}
    }
    return [Microsoft.PowerShell.AddToHistoryOption]::MemoryAndFile
}
