# Start ChatGPT Local Coder MCP on Windows in the foreground so logs remain visible.
param(
    [string]$Workspace = $env:WORKSPACE_PATH,
    [int]$Port = 3000,
    [switch]$Force,
    [switch]$OpenUI,
    [switch]$NoTunnel,
    [switch]$Rebuild,
    [switch]$NoBuild
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# Old launchers wrote server/tunnel output to these files. They are no longer
# authoritative and can contain historical tokenized MCP endpoints, so remove
# them rather than letting stale logs look like current runtime state.
foreach ($LegacyLog in @(".server.log", ".tunnel.log")) {
    if (Test-Path $LegacyLog) {
        Remove-Item $LegacyLog -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path $LegacyLog)) {
            Write-Host "[Cleanup] Removed legacy runtime log: $LegacyLog" -ForegroundColor DarkGray
        }
    }
}

function Get-PortOwnerPid([int]$TargetPort) {
    $lines = netstat -ano | Select-String ":$TargetPort\s" | Select-String "LISTENING"
    foreach ($line in $lines) {
        $parts = ($line -replace '\s+', ' ').ToString().Trim().Split(' ')
        $processId = [int]$parts[-1]
        if ($processId -gt 0) { return $processId }
    }
    return $null
}

function Test-IsLocalCoderProcess([int]$TargetPid) {
    try {
        $info = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetPid" -ErrorAction Stop
        $commandLine = [string]$info.CommandLine
        if (-not $commandLine) { return $false }
        return (
            $commandLine -match 'chatgpt-local-coder' -or
            $commandLine -match 'dist[\\/]+index\.js'
        )
    } catch {
        return $false
    }
}

function Get-DotEnvValue([string]$Name) {
    if (-not (Test-Path ".env")) { return $null }

    $line = Get-Content ".env" | Where-Object {
        $_ -match "^\s*$Name\s*=" -and -not $_.TrimStart().StartsWith("#")
    } | Select-Object -First 1

    if (-not $line) { return $null }

    $value = ($line -split "=", 2)[1].Trim()
    return $value.Trim("'").Trim('"')
}

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "Created .env - update WORKSPACE_PATH before using the server." -ForegroundColor Yellow
}

if (-not $Workspace) {
    $Workspace = Get-DotEnvValue "WORKSPACE_PATH"
}

if (-not $Workspace) {
    $Workspace = $ScriptDir
}

$ChatGptAutoApprove = Get-DotEnvValue "CHATGPT_AUTO_APPROVE"

$env:WORKSPACE_PATH = $Workspace
$env:PORT = $Port
if ($ChatGptAutoApprove) {
    $env:CHATGPT_AUTO_APPROVE = $ChatGptAutoApprove
}

Write-Host ""
Write-Host "=== ChatGPT Local Coder MCP ===" -ForegroundColor Cyan
Write-Host "Default cwd: $Workspace"
Write-Host "Full machine access: ON"
if ($ChatGptAutoApprove) { Write-Host "ChatGPT auto-approve: $ChatGptAutoApprove" }
$AdminPort = Get-DotEnvValue "ADMIN_PORT"
if (-not $AdminPort) { $AdminPort = "3001" }
$env:ADMIN_PORT = $AdminPort

Write-Host "Port: $Port"
Write-Host "Admin UI: http://127.0.0.1:$AdminPort/ui"
Write-Host ""

# Validate/compile the replacement build before touching a currently healthy
# Local Coder process. A compile failure must not take the working server down.
Write-Host "Checking build..." -ForegroundColor Yellow
$buildArgs = @("scripts/build-if-needed.mjs")
if ($Rebuild) { $buildArgs += "--force" }
if ($NoBuild) { $buildArgs += "--skip" }
& node @buildArgs
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}

$existingPid = Get-PortOwnerPid -TargetPort $Port
if ($existingPid) {
    $proc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    $procName = if ($proc) { $proc.ProcessName } else { "unknown" }
    $isLocalCoder = Test-IsLocalCoderProcess -TargetPid $existingPid

    Write-Host "[WARNING] Port $Port is already in use by PID $existingPid ($procName)" -ForegroundColor Yellow

    if ($isLocalCoder -or $Force) {
        Write-Host "Stopping the existing process automatically..." -ForegroundColor Yellow
        Stop-Process -Id $existingPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    } else {
        Write-Host "[ERROR] Port $Port belongs to another process. Refusing to stop it automatically." -ForegroundColor Red
        Write-Host "Run .\start.ps1 -Force only if you intentionally want to terminate PID $existingPid." -ForegroundColor Yellow
        exit 1
    }
}

if ($env:OPEN_UI -eq "1" -or $OpenUI) {
    Start-Process "http://127.0.0.1:$AdminPort/ui"
}

Write-Host "Starting Local Coder dashboard..." -ForegroundColor Green
Write-Host "The TUI shows live tool calls, running work, usage, and resource state. Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

# start.ps1 is the single entry point. Phase 6 lets the Node runtime supervise
# tunnel-client directly, so normal startup uses one visible terminal only.
if ($NoTunnel) {
    $env:LOCAL_CODER_MANAGE_TUNNEL = "0"
    Write-Host "[Tunnel] Skipped (-NoTunnel)." -ForegroundColor DarkGray
} else {
    $env:LOCAL_CODER_MANAGE_TUNNEL = "1"
    Write-Host "[Tunnel] Managed by Local Coder (no separate window)." -ForegroundColor DarkGray
}

& node dist/index.js
$exitCode = $LASTEXITCODE

Write-Host ""
if ($exitCode -ne 0) {
    Write-Host "Server exited with an error (exit code: $exitCode)" -ForegroundColor Red
} else {
    Write-Host "Server stopped." -ForegroundColor Yellow
}

exit $exitCode