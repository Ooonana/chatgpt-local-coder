# Start ChatGPT Local Coder MCP on Windows in the foreground so logs remain visible.
param(
    [string]$Workspace = $env:WORKSPACE_PATH,
    [int]$Port = 3000,
    [switch]$Force,
    [switch]$OpenUI,
    [switch]$NoTunnel
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

function Test-TunnelHealthy([int]$TargetHealthPort) {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$TargetHealthPort/readyz" -UseBasicParsing -TimeoutSec 2
        return $resp.Content -match "ready"
    } catch {
        return $false
    }
}

function Test-TunnelProfileMatches(
    [string]$ProfilePath,
    [string]$TunnelId,
    [string]$McpUrl,
    [int]$TargetHealthPort
) {
    if (-not (Test-Path $ProfilePath)) { return $false }

    try {
        $profile = Get-Content $ProfilePath -Raw
        return (
            $profile -match [regex]::Escape("tunnel_id: $TunnelId") -and
            $profile -match [regex]::Escape("listen_addr: 127.0.0.1:$TargetHealthPort") -and
            $profile -match [regex]::Escape("url: $McpUrl")
        )
    } catch {
        return $false
    }
}

function Start-TunnelIfNeeded([int]$McpPort) {
    $tunnelScript = Join-Path $ScriptDir "openai-tunnel.ps1"
    if (-not (Test-Path $tunnelScript)) {
        Write-Host "[Tunnel] openai-tunnel.ps1 not found - starting MCP server only." -ForegroundColor Yellow
        return
    }

    $tunnelId = Get-DotEnvValue "OPENAI_TUNNEL_ID"
    $apiKey = Get-DotEnvValue "OPENAI_TUNNEL_API_KEY"
    if (-not $tunnelId -or -not $apiKey) {
        Write-Host "[Tunnel] Not configured - starting MCP server only." -ForegroundColor DarkGray
        return
    }

    $healthValue = Get-DotEnvValue "OPENAI_TUNNEL_HEALTH_PORT"
    $healthPort = if ($healthValue) { [int]$healthValue } else { 8080 }
    $token = Get-DotEnvValue "MCP_TOKEN"
    $mcpUrl = if ($token) { "http://127.0.0.1:$McpPort/mcp/$token" } else { "http://127.0.0.1:$McpPort/mcp" }
    $profilePath = Join-Path $ScriptDir "profiles\codex-local.yaml"

    $healthy = Test-TunnelHealthy -TargetHealthPort $healthPort
    $profileMatches = Test-TunnelProfileMatches `
        -ProfilePath $profilePath `
        -TunnelId $tunnelId `
        -McpUrl $mcpUrl `
        -TargetHealthPort $healthPort

    if ($healthy -and $profileMatches) {
        Write-Host "[Tunnel] Already healthy on port $healthPort - reusing it." -ForegroundColor Green
        return
    }

    $restartTunnel = $healthy
    if (-not $healthy) {
        $healthOwnerPid = Get-PortOwnerPid -TargetPort $healthPort
        if ($healthOwnerPid) {
            $healthOwner = Get-Process -Id $healthOwnerPid -ErrorAction SilentlyContinue
            if ($healthOwner -and $healthOwner.ProcessName -match '^tunnel-client$') {
                $restartTunnel = $true
            }
        }
    }

    if ($healthy) {
        Write-Host "[Tunnel] Running tunnel uses stale settings - it will be refreshed after MCP starts." -ForegroundColor Yellow
    } else {
        Write-Host "[Tunnel] Not running - it will start automatically after MCP is healthy." -ForegroundColor Yellow
    }

    $shell = Get-Command pwsh -ErrorAction SilentlyContinue
    if (-not $shell) { $shell = Get-Command powershell.exe -ErrorAction SilentlyContinue }
    if (-not $shell) {
        Write-Host "[Tunnel] Could not find PowerShell to launch openai-tunnel.ps1." -ForegroundColor Red
        return
    }

    $quotedTunnelScript = '"' + $tunnelScript.Replace('"', '\"') + '"'
    $args = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $quotedTunnelScript,
        "-Port", $McpPort,
        "-HealthPort", $healthPort,
        "-WaitForServer"
    )
    if ($restartTunnel) { $args += "-Force" }

    try {
        Start-Process -FilePath $shell.Source -ArgumentList $args -WorkingDirectory $ScriptDir | Out-Null
        Write-Host "[Tunnel] Launcher started in a separate PowerShell window." -ForegroundColor Green
    } catch {
        Write-Host "[Tunnel] Failed to launch automatically: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "         You can still run .\openai-tunnel.ps1 manually." -ForegroundColor DarkGray
    }
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

Write-Host "Building latest source..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed!" -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host "Starting Local Coder dashboard..." -ForegroundColor Green
Write-Host "The TUI shows live tool calls, running work, usage, and resource state. Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

# start.ps1 is the single entry point: if the OpenAI tunnel is configured and
# needs attention, launch it separately. The tunnel process waits until the MCP
# server below is healthy before connecting, so the dashboard can remain in the
# current foreground terminal.
if ($NoTunnel) {
    Write-Host "[Tunnel] Skipped (-NoTunnel)." -ForegroundColor DarkGray
} else {
    Start-TunnelIfNeeded -McpPort $Port
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