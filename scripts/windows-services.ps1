[CmdletBinding()]
param(
    [ValidateSet('start', 'stop')][string]$Action = 'start',
    [string]$Root = (Split-Path $PSScriptRoot -Parent),
    [ValidateRange(1, 60)][int]$HealthTimeoutSeconds = 12
)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw 'Workspace directory does not exist.' }
$RunDirectory = Join-Path $Root '.run'

function Load-Environment {
    $envFile = Join-Path $Root '.env'
    if (-not (Test-Path -LiteralPath $envFile)) { $envFile = Join-Path $Root 'hub/.env' }
    if (-not (Test-Path -LiteralPath $envFile)) { return }
    foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
        if ($line -match '^\s*(#|$)') { continue }
        if ($line -notmatch '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { throw 'Invalid .env assignment.' }
        $key = $Matches[1]
        $value = $Matches[2].Trim()
        if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        } else { $value = ($value -replace '\s+#.*$', '').TrimEnd() }
        [Environment]::SetEnvironmentVariable($key, $value, 'Process')
    }
}

function Set-Default([string]$Name, [string]$Value) {
    if (-not [Environment]::GetEnvironmentVariable($Name, 'Process')) { [Environment]::SetEnvironmentVariable($Name, $Value, 'Process') }
}

function Find-Python {
    $candidates = @()
    if ($env:HUB_PYTHON) { $candidates += [Environment]::ExpandEnvironmentVariables($env:HUB_PYTHON) }
    else {
        foreach ($name in @('python', 'python3', 'py')) {
            $entry = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($entry) { $candidates += $entry.Source }
        }
        if ($env:USERPROFILE) {
            $bundled = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
            if (Test-Path -LiteralPath $bundled) { $candidates += $bundled }
        }
    }
    foreach ($candidate in $candidates) {
        if ($candidate -match '[\\/]Microsoft[\\/]WindowsApps[\\/]') { continue }
        $prefix = @()
        if ([IO.Path]::GetFileName($candidate) -ieq 'py.exe') { $prefix = @('-3') }
        try {
            $check = & $candidate @prefix -c "import sys; print('AGENTHUB_PYTHON_OK' if sys.version_info >= (3, 8) else 'OLD')" 2>$null
            if ($LASTEXITCODE -eq 0 -and $check -eq 'AGENTHUB_PYTHON_OK') { return @{ Executable = $candidate; Prefix = $prefix } }
        } catch { }
    }
    throw 'No working Python 3.8+ found. Set HUB_PYTHON to the full python.exe path in .env.'
}

function Stop-Recorded([string]$Service) {
    $recordPath = Join-Path $RunDirectory ($Service + '.windows.json')
    if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) { return }
    try {
        $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$record.Root -ne $Root -or -not $record.Pid -or -not $record.StartTicks -or -not $record.Entry) { throw 'Invalid process record.' }
        $tracked = Get-Process -Id ([int]$record.Pid) -ErrorAction SilentlyContinue
        if ($tracked -and $tracked.StartTime.ToUniversalTime().Ticks.ToString() -eq [string]$record.StartTicks) {
            $native = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$record.Pid)
            if ($native -and $native.CommandLine.IndexOf([string]$record.Entry, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                Stop-Process -InputObject $tracked -Force -ErrorAction Stop
                $tracked.WaitForExit(5000) | Out-Null
            }
        }
    } catch { Write-Warning ('Could not validate/stop owned ' + $Service + ' process: ' + $_.Exception.Message); return }
    Remove-Item -LiteralPath $recordPath -Force
}

function Start-Recorded([string]$Service, [string]$Executable, [string[]]$Arguments, [string]$Entry) {
    $argumentsQuoted = @($Arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' })
    $proc = Start-Process -FilePath $Executable -ArgumentList $argumentsQuoted -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $Root ('logs/' + $Service + '.out.log')) -RedirectStandardError (Join-Path $Root ('logs/' + $Service + '.err.log'))
    try {
        $ticks = $proc.StartTime.ToUniversalTime().Ticks.ToString()
        @{ Root = $Root; Pid = $proc.Id; StartTicks = $ticks; Entry = $Entry } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RunDirectory ($Service + '.windows.json')) -Encoding UTF8
    } catch {
        if (-not $proc.HasExited) { Stop-Process -InputObject $proc -Force }
        throw
    }
    return $proc
}

function Wait-Health($Process, [string]$Url, [string]$ExpectedService = '') {
    $deadline = [DateTime]::UtcNow.AddSeconds($HealthTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $Process.Refresh()
        if ($Process.HasExited) { throw ('Service exited during startup; inspect logs/: ' + $Url) }
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 1
            $content = $response.Content
            if ($content -is [byte[]]) { $content = [Text.Encoding]::UTF8.GetString($content) }
            if ($response.StatusCode -eq 200 -and (-not $ExpectedService -or (($content | ConvertFrom-Json).service -eq $ExpectedService))) {
                $listeners = @(Get-NetTCPConnection -LocalPort ([Uri]$Url).Port -State Listen -ErrorAction Stop | Where-Object { $_.OwningProcess -eq $Process.Id })
                $Process.Refresh()
                if ($listeners.Count -gt 0 -and -not $Process.HasExited) { return }
            }
        } catch { }
        Start-Sleep -Milliseconds 100
    }
    throw ('Health check timed out; inspect logs/: ' + $Url)
}

try {
    if ($Action -eq 'stop') {
        Stop-Recorded 'console'
        Stop-Recorded 'hub'
        Write-Output 'Stopped matching services recorded by this workspace.'
        exit 0
    }
    Load-Environment
    Set-Default 'AGENTHUB_HOST' '127.0.0.1'
    Set-Default 'AGENTHUB_PORT' '8765'
    Set-Default 'HUBCONSOLE_HOST' '127.0.0.1'
    Set-Default 'HUBCONSOLE_PORT' '8890'
    foreach ($port in @($env:AGENTHUB_PORT, $env:HUBCONSOLE_PORT)) {
        if ($port -notmatch '^\d+$' -or [int]$port -lt 1 -or [int]$port -gt 65535) { throw 'Ports must be integers between 1 and 65535.' }
    }
    $connectHost = $env:AGENTHUB_HOST
    if ($connectHost -eq '0.0.0.0') { $connectHost = '127.0.0.1' }
    if ($connectHost -eq '::') { $connectHost = '::1' }
    if ($connectHost.Contains(':')) { $connectHost = '[' + $connectHost + ']' }
    Set-Default 'HUBCONSOLE_SERVER_URL' ('http://' + $connectHost + ':' + $env:AGENTHUB_PORT + '/mcp')
    Set-Default 'HUBCONSOLE_SERVER_TOKEN' $env:HUB_TOKEN
    $python = Find-Python
    $node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $nodeVersion = & $node.Source --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) { throw 'Node.js 20+ is required.' }
    $hubEntry = Join-Path $Root 'hub/agent_hub.py'
    $consoleEntry = Join-Path $Root 'console/server.mjs'
    if (-not (Test-Path -LiteralPath $hubEntry) -or -not (Test-Path -LiteralPath $consoleEntry)) { throw 'Hub/console source files are missing.' }
    New-Item -ItemType Directory -Force -Path $RunDirectory, (Join-Path $Root 'logs') | Out-Null
    Stop-Recorded 'console'
    Stop-Recorded 'hub'
    $agents = Join-Path $Root 'hub/agents.json'
    if (-not (Test-Path -LiteralPath $agents)) {
        Copy-Item -LiteralPath (Join-Path $Root 'hub/agents.windows.example.json') -Destination $agents
        Write-Output 'Created Windows worker template; replace C:/PATH/TO entries before dispatch.'
    }
    $started = @()
    try {
        $hubProcess = Start-Recorded 'hub' $python.Executable (@($python.Prefix) + @($hubEntry, '--http', $env:AGENTHUB_PORT, '--host', $env:AGENTHUB_HOST)) $hubEntry
        $started += 'hub'
        Wait-Health $hubProcess ('http://' + $connectHost + ':' + $env:AGENTHUB_PORT + '/health') 'agent-hub'
        $consoleProcess = Start-Recorded 'console' $node.Source @($consoleEntry) $consoleEntry
        $started += 'console'
        $consoleHost = $env:HUBCONSOLE_HOST
        if ($consoleHost -eq '0.0.0.0') { $consoleHost = '127.0.0.1' }
        if ($consoleHost -eq '::') { $consoleHost = '::1' }
        if ($consoleHost.Contains(':')) { $consoleHost = '[' + $consoleHost + ']' }
        Wait-Health $consoleProcess ('http://' + $consoleHost + ':' + $env:HUBCONSOLE_PORT + '/dashboard')
    } catch {
        foreach ($service in $started) { Stop-Recorded $service }
        throw
    }
    Write-Output ('Hub: ' + ([Uri]$env:HUBCONSOLE_SERVER_URL).GetLeftPart([UriPartial]::Path))
    Write-Output ('Console: http://' + $consoleHost + ':' + $env:HUBCONSOLE_PORT + '/dashboard')
} catch { Write-Error $_.Exception.Message; exit 1 }
