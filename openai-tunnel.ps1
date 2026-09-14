# OpenAI Secure MCP Tunnel - stable URL that does not change on every run (alternative to cloudflared).
param(
    [int]$Port = 0,
    [int]$HealthPort = 0,
    [switch]$Install,
    [switch]$Doctor,
    [switch]$Init,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$TUNNEL_VERSION = "v0.0.10"
$BinDir = Join-Path $ScriptDir "bin"
$TunnelExe = Join-Path $BinDir "tunnel-client.exe"
$ProfileName = "codex-local"
$ProfileDir = Join-Path $ScriptDir "profiles"
$ProfileFile = Join-Path $ProfileDir "$ProfileName.yaml"
$ZipName = "tunnel-client-$TUNNEL_VERSION-windows-amd64.zip"
$DownloadUrl = "https://github.com/openai/tunnel-client/releases/download/$TUNNEL_VERSION/$ZipName"

function Get-DotEnvValue([string]$Name) {
    if (-not (Test-Path ".env")) { return $null }
    $line = Get-Content ".env" | Where-Object {
        $_ -match "^\s*$Name\s*=" -and -not $_.TrimStart().StartsWith("#")
    } | Select-Object -First 1
    if (-not $line) { return $null }
    return (($line -split "=", 2)[1].Trim()).Trim("'").Trim('"')
}

function Set-DotEnvValue([string]$Name, [string]$Value) {
    if (-not (Test-Path ".env")) {
        Copy-Item ".env.example" ".env"
    }
    $lines = Get-Content ".env"
    $found = $false
    $out = foreach ($line in $lines) {
        if ($line -match "^\s*$Name\s*=" -and -not $line.TrimStart().StartsWith("#")) {
            $found = $true
            "$Name=$Value"
        } else {
            $line
        }
    }
    if (-not $found) {
        $out += "$Name=$Value"
    }
    Set-Content ".env" -Value $out -Encoding UTF8
}

function Get-TunnelClientPath {
    if (Test-Path $TunnelExe) { return $TunnelExe }
    $cmd = Get-Command tunnel-client -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Install-TunnelClient {
    if (Test-Path $TunnelExe) {
        Write-Host "tunnel-client already installed: $TunnelExe" -ForegroundColor Green
        return $TunnelExe
    }

    Write-Host "Downloading tunnel-client $TUNNEL_VERSION ..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    $zipPath = Join-Path $env:TEMP $ZipName

    Invoke-WebRequest -Uri $DownloadUrl -OutFile $zipPath -UseBasicParsing
    Expand-Archive -Path $zipPath -DestinationPath $BinDir -Force

    $candidates = Get-ChildItem -Path $BinDir -Recurse -Filter "tunnel-client.exe" -ErrorAction SilentlyContinue
    if ($candidates.Count -eq 0) {
        throw "Could not find tunnel-client.exe in $ZipName"
    }

    $extracted = $candidates[0].FullName
    if ($extracted -ne $TunnelExe) {
        Move-Item -Path $extracted -Destination $TunnelExe -Force
        Get-ChildItem $BinDir -Directory | Where-Object { $_.Name -ne "." } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }

    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
    Write-Host "Installed: $TunnelExe" -ForegroundColor Green
    return $TunnelExe
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

function Test-TunnelHealthy([int]$TargetHealthPort) {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$TargetHealthPort/readyz" -UseBasicParsing -TimeoutSec 2
        return $resp.Content -match "ready"
    } catch {
        return $false
    }
}

function Stop-ExistingTunnel([int]$TargetHealthPort) {
    $ownerPid = Get-PortOwnerPid -TargetPort $TargetHealthPort
    if (-not $ownerPid) { return }
    $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    $name = if ($proc) { $proc.ProcessName } else { "unknown" }
    Write-Host "Stopping existing tunnel (PID $ownerPid - $name)..." -ForegroundColor Yellow
    Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

function Ensure-Profile([string]$McpUrl, [string]$TunnelId, [int]$TargetHealthPort) {
    New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
    $yaml = @"
config_version: 1
control_plane:
  tunnel_id: $TunnelId
  api_key: env:OPENAI_TUNNEL_API_KEY
log:
  level: info
  format: struct-text
health:
  listen_addr: 127.0.0.1:$TargetHealthPort
mcp:
  server_urls:
    - channel: main
      url: $McpUrl
"@
    Set-Content -Path $ProfileFile -Value $yaml -Encoding UTF8
}

function Test-McpServer([int]$TargetPort) {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$TargetPort/health" -UseBasicParsing -TimeoutSec 3
        return $resp.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Show-ConnectorGuide([string]$TunnelId, [int]$UiPort = 8080) {
    Write-Host ""
    Write-Host "=== ChatGPT Connector (one-time setup) ===" -ForegroundColor Cyan
    Write-Host "1. Keep this terminal running (tunnel-client)"
    Write-Host "2. Open: https://chatgpt.com/#settings/Connectors"
    Write-Host "3. Add a connector -> Connection: Tunnel -> choose 'my tunnel'"
    Write-Host "   Or paste the tunnel_id: $TunnelId"
    Write-Host "4. Settings -> Apps -> configure connector permissions"
    Write-Host "5. Refresh the connector and open a new chat"
    Write-Host ""
    Write-Host "Admin UI: http://127.0.0.1:$UiPort/ui" -ForegroundColor Green
    Write-Host "Health:   http://127.0.0.1:$UiPort/readyz" -ForegroundColor Green
    Write-Host ""
    Write-Host "NOTE: If 'Always allow' resets the MCP session, configure permissions in Settings -> Apps instead." -ForegroundColor Yellow
}

function Invoke-TunnelInit {
    Write-Host ""
    Write-Host "=== OpenAI Tunnel - First-time setup ===" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Two values are required from OpenAI Platform:" -ForegroundColor Yellow
    Write-Host "  Tunnels:  https://platform.openai.com/settings/organization/tunnels"
    Write-Host "  API Keys: https://platform.openai.com/settings/organization/api-keys"
    Write-Host "  (Use a Runtime API key, NOT an Admin key)" -ForegroundColor DarkGray
    Write-Host ""

    $existingId = Get-DotEnvValue "OPENAI_TUNNEL_ID"
    $existingKey = Get-DotEnvValue "OPENAI_TUNNEL_API_KEY"

    if ($existingId) {
        $tunnelId = $existingId
        Write-Host "Tunnel ID (from .env): $tunnelId"
    } else {
        $tunnelId = Read-Host "Enter OPENAI_TUNNEL_ID (tunnel_...)"
    }

    if ($existingKey) {
        $apiKey = $existingKey
        Write-Host "API Key: **** (from .env)"
    } else {
        $apiKey = Read-Host "Enter OPENAI_TUNNEL_API_KEY (sk-...)"
    }

    if (-not $tunnelId -or $tunnelId -notmatch '^tunnel_[0-9a-f]{32}$') {
        throw "Invalid OPENAI_TUNNEL_ID. Expected tunnel_ followed by 32 hexadecimal characters."
    }
    if (-not $apiKey) {
        throw "OPENAI_TUNNEL_API_KEY is empty."
    }

    Set-DotEnvValue "OPENAI_TUNNEL_ID" $tunnelId
    Set-DotEnvValue "OPENAI_TUNNEL_API_KEY" $apiKey

    $envPort = Get-DotEnvValue "PORT"
    $resolvedPort = if ($Port -gt 0) { $Port } elseif ($envPort) { [int]$envPort } else { 3000 }
    $envHealth = Get-DotEnvValue "OPENAI_TUNNEL_HEALTH_PORT"
    $resolvedHealth = if ($HealthPort -gt 0) { $HealthPort } elseif ($envHealth) { [int]$envHealth } else { 8080 }
    $token = Get-DotEnvValue "MCP_TOKEN"
    $mcpUrl = if ($token) { "http://127.0.0.1:$resolvedPort/mcp/$token" } else { "http://127.0.0.1:$resolvedPort/mcp" }
    Ensure-Profile -McpUrl $mcpUrl -TunnelId $tunnelId -TargetHealthPort $resolvedHealth

    $bin = Install-TunnelClient
    $env:OPENAI_TUNNEL_API_KEY = $apiKey
    $env:CONTROL_PLANE_API_KEY = $apiKey
    $env:CONTROL_PLANE_TUNNEL_ID = $tunnelId

    Write-Host ""
    Write-Host "Running doctor..." -ForegroundColor Yellow
    & $bin doctor --profile-file $ProfileFile --explain
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Doctor failed - check tunnel_id, API key, and Tunnels Read+Use permissions." -ForegroundColor Red
        exit 1
    }

    Write-Host ""
    Write-Host "Saved to .env. Next time, run:" -ForegroundColor Green
    Write-Host "  .\start.ps1 -Force          # terminal 1"
    Write-Host "  .\openai-tunnel.ps1         # terminal 2"
    Show-ConnectorGuide -TunnelId $tunnelId
}

# --- Main ---

if ($Init) {
    Invoke-TunnelInit
    exit 0
}

if ($Install) {
    Install-TunnelClient | Out-Null
    exit 0
}

$envPort = Get-DotEnvValue "PORT"
$resolvedPort = if ($Port -gt 0) { $Port } elseif ($envPort) { [int]$envPort } else { 3000 }
$envHealth = Get-DotEnvValue "OPENAI_TUNNEL_HEALTH_PORT"
$resolvedHealth = if ($HealthPort -gt 0) { $HealthPort } elseif ($envHealth) { [int]$envHealth } else { 8080 }
$tunnelId = Get-DotEnvValue "OPENAI_TUNNEL_ID"
$apiKey = Get-DotEnvValue "OPENAI_TUNNEL_API_KEY"

if (-not $tunnelId -or -not $apiKey) {
    Write-Host ""
    Write-Host "[NOT CONFIGURED] Run first-time setup:" -ForegroundColor Yellow
    Write-Host "  .\openai-tunnel.ps1 -Init" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Or add these values to .env:" -ForegroundColor DarkGray
    Write-Host "  OPENAI_TUNNEL_ID=tunnel_..."
    Write-Host "  OPENAI_TUNNEL_API_KEY=sk-..."
    exit 1
}

$bin = Get-TunnelClientPath
if (-not $bin) {
    $bin = Install-TunnelClient
}

$token = Get-DotEnvValue "MCP_TOKEN"
$mcpUrl = if ($token) { "http://127.0.0.1:$resolvedPort/mcp/$token" } else { "http://127.0.0.1:$resolvedPort/mcp" }
Ensure-Profile -McpUrl $mcpUrl -TunnelId $tunnelId -TargetHealthPort $resolvedHealth

$env:OPENAI_TUNNEL_API_KEY = $apiKey
$env:CONTROL_PLANE_API_KEY = $apiKey
$env:CONTROL_PLANE_TUNNEL_ID = $tunnelId

$existingPid = Get-PortOwnerPid -TargetPort $resolvedHealth
if ($existingPid -and (Test-TunnelHealthy $resolvedHealth)) {
    if (-not $Force) {
        Write-Host ""
        Write-Host "[OK] Tunnel is already running (PID $existingPid, port $resolvedHealth)" -ForegroundColor Green
        Write-Host "No need to start another one - only one tunnel-client instance is required." -ForegroundColor Yellow
        Write-Host "To restart: .\openai-tunnel.ps1 -Force" -ForegroundColor DarkGray
        Write-Host "To stop it: Stop-Process -Id $existingPid -Force" -ForegroundColor DarkGray
        Show-ConnectorGuide -TunnelId $tunnelId -UiPort $resolvedHealth
        exit 0
    }
    Stop-ExistingTunnel -TargetHealthPort $resolvedHealth
} elseif ($existingPid) {
    if ($Force) {
        Stop-ExistingTunnel -TargetHealthPort $resolvedHealth
    } else {
        Write-Host ""
        Write-Host "[ERROR] Port $resolvedHealth is occupied by PID $existingPid, but no healthy tunnel was detected." -ForegroundColor Red
        Write-Host "Run again with -Force to stop the existing process, or change the port in .env:" -ForegroundColor Yellow
        Write-Host "  OPENAI_TUNNEL_HEALTH_PORT=8081" -ForegroundColor Cyan
        exit 1
    }
}

if ($Doctor) {
    & $bin doctor --profile-file $ProfileFile --explain
    exit $LASTEXITCODE
}

if (-not (Test-McpServer $resolvedPort)) {
    Write-Host ""
    Write-Host "[WARNING] MCP server is not running at http://127.0.0.1:$resolvedPort" -ForegroundColor Yellow
    Write-Host "Open another terminal and run: .\start.ps1 -Force" -ForegroundColor Cyan
    Write-Host ""
    $answer = Read-Host "Start the tunnel anyway? (y/n)"
    if ($answer -notmatch '^[yY]') { exit 1 }
}

Write-Host ""
Write-Host "=== OpenAI Secure MCP Tunnel ===" -ForegroundColor Cyan
Write-Host "Tunnel ID:  $tunnelId"
Write-Host "MCP local:  $mcpUrl"
Write-Host "Health UI:  http://127.0.0.1:$resolvedHealth/ui"
Write-Host ""
Write-Host "Stable URL - it does not change on every run, unlike a cloudflared quick tunnel." -ForegroundColor Green
Write-Host "Press Ctrl+C to stop the tunnel" -ForegroundColor DarkGray
Write-Host ""

Show-ConnectorGuide -TunnelId $tunnelId -UiPort $resolvedHealth

& $bin run --profile-file $ProfileFile
exit $LASTEXITCODE
