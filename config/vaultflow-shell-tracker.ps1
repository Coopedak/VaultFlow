# vaultflow shell tracker — add to $PROFILE to capture shell commands with timestamps + CWD
# Source this file from your $PROFILE:
#   . "C:\GIT\vaultflow\config\vaultflow-shell-tracker.ps1"
#
# Derives metrics_root from vaultflow.yaml automatically — no hardcoded paths.

# Authority order matches CLAUDE.md: .local.yaml is the user's real config,
# .yaml is an alternate name (gitignored), .example.yaml is the committed template.
$__vf_config = $null
foreach ($candidate in @('vaultflow.local.yaml', 'vaultflow.yaml', 'vaultflow.example.yaml')) {
    $path = Join-Path $PSScriptRoot $candidate
    if (Test-Path $path) { $__vf_config = $path; break }
}

if (-not $__vf_config) {
    Write-Warning "vaultflow-shell-tracker: no config found under $PSScriptRoot — tracker disabled"
    return
}

# Pull the metrics_root key, ignoring commented lines. Validate before use.
$__vf_match = Select-String -Path $__vf_config -Pattern '^\s*metrics_root\s*:\s*["'']?([^"''#\r\n]+)["'']?' | Select-Object -First 1
if (-not $__vf_match) {
    Write-Warning "vaultflow-shell-tracker: metrics_root not found in $__vf_config — tracker disabled"
    return
}

$__vf_metricsRoot = $__vf_match.Matches[0].Groups[1].Value.Trim().Replace('/', '\')
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
