[CmdletBinding()]
param(
    [ValidateSet('install','start','stop','status')][string]$Action = 'install',
    [Parameter(ValueFromRemainingArguments=$true)][string[]]$ForwardArgs
)
$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path $PSScriptRoot -Parent
function Find-InstallerPython {
    $candidates = @()
    $chosen = $env:AGENTHUB_PYTHON
    if (-not $chosen) { $chosen = $env:HUB_PYTHON }
    if ($chosen) { $candidates += $chosen }
    else {
        foreach ($name in @('python3','python','py')) {
            $entry = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($entry -and $entry.Source -notmatch '[\\/]WindowsApps[\\/]') { $candidates += $entry.Source }
        }
        if ($env:LOCALAPPDATA) {
            foreach ($relativeBase in @('Python','Programs/Python')) {
                $base = Join-Path $env:LOCALAPPDATA $relativeBase
                foreach ($directory in @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue)) {
                    $entry = Join-Path $directory.FullName 'python.exe'
                    if (Test-Path -LiteralPath $entry -PathType Leaf) { $candidates += $entry }
                }
            }
        }
        if ($env:USERPROFILE) {
            $candidates += @(Get-ChildItem -Path (Join-Path $env:USERPROFILE '.cache/codex-runtimes/*/dependencies/python/python.exe') -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
        }
    }
    foreach ($candidate in $candidates) {
        $prefix = @()
        if ([IO.Path]::GetFileName($candidate) -ieq 'py.exe') { $prefix = @('-3') }
        try {
            $result = & $candidate @prefix -c "import sys; print('AGENTHUB_PYTHON_OK' if sys.version_info >= (3,8) else 'OLD')" 2>$null
            if ($LASTEXITCODE -eq 0 -and $result -eq 'AGENTHUB_PYTHON_OK') { return @{ Exe = $candidate; Prefix = $prefix } }
        } catch { }
    }
    throw 'A working Python 3.8+ is required (native plugin installation: 3.11+). Install from https://www.python.org/downloads/ or set AGENTHUB_PYTHON. No runtime or firewall was changed.'
}
try {
    $python = Find-InstallerPython
    if ($Action -eq 'install') {
        & $python.Exe @($python.Prefix) (Join-Path $PSScriptRoot 'install.py') --bundle $packageRoot @ForwardArgs
    } else {
        & $python.Exe @($python.Prefix) (Join-Path $PSScriptRoot 'service.py') $Action --prefix $packageRoot @ForwardArgs
    }
    exit $LASTEXITCODE
} catch { Write-Error $_.Exception.Message; exit 1 }
