# Start ChatGPT Local Coder MCP on Windows in the foreground so logs remain visible.
param(
    [string]$Workspace = $env:WORKSPACE_PATH,
    [int]$Port = 3000,
    [switch]$Force,
    [switch]$OpenUI
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

function Get-PortOwnerPid([int]$TargetPort) {
    $lines = netstat -ano | Select-String ":$TargetPort\s" | Select-String "LISTENING"
    foreach ($line in $lines) {
        $parts = ($line -replace '\s+', ' ').ToString().Trim().Split(' ')
        $processId = [int]$parts[-1]
        if ($processId -gt 0) { return $processId }
    }
    return $null
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

if ($env:OPEN_UI -eq "1" -or $OpenUI) {
    Start-Process "http://127.0.0.1:$AdminPort/ui"
}

$existingPid = Get-PortOwnerPid -TargetPort $Port
if ($existingPid) {
    $proc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    $procName = if ($proc) { $proc.ProcessName } else { "unknown" }

    Write-Host "[WARNING] Port $Port is already in use by PID $existingPid ($procName)" -ForegroundColor Yellow

    if ($Force) {
        Write-Host "Stopping the existing process (-Force)..." -ForegroundColor Yellow
        Stop-Process -Id $existingPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    } else {
        $answer = Read-Host "Stop the existing server and restart? (y/n)"
        if ($answer -match '^[yY]') {
            Stop-Process -Id $existingPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        } else {
            Write-Host "Cancelled. The existing server is still running at http://localhost:$Port" -ForegroundColor Red
            exit 1
        }
    }
}

Write-Host "Building latest source..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed!" -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host "Starting server (logs appear below)..." -ForegroundColor Green
Write-Host "Press Ctrl+C to stop the server" -ForegroundColor DarkGray
Write-Host ""

& node dist/index.js
$exitCode = $LASTEXITCODE

Write-Host ""
if ($exitCode -ne 0) {
    Write-Host "Server exited with an error (exit code: $exitCode)" -ForegroundColor Red
} else {
    Write-Host "Server stopped." -ForegroundColor Yellow
}

exit $exitCode