# Expose the MCP server through a Cloudflare Tunnel (alternative to ngrok).
param(
    [int]$Port = 3000
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

function Get-CloudflaredPath {
    $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $local = Join-Path $ScriptDir "cloudflared.exe"
    if (Test-Path $local) { return $local }

    return $null
}

$cloudflared = Get-CloudflaredPath
if (-not $cloudflared) {
    Write-Host ""
    Write-Host "[ERROR] cloudflared is not installed!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Install it using one of these methods:" -ForegroundColor Yellow
    Write-Host "  scoop install cloudflared"
    Write-Host "  winget install --id Cloudflare.cloudflared"
    Write-Host ""
    Write-Host "Or download it and place it in this directory:" -ForegroundColor Yellow
    Write-Host "  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host ""
Write-Host "=== Cloudflare Tunnel ===" -ForegroundColor Cyan
Write-Host "Local:  http://localhost:$Port"
Write-Host "Public: (URL appears below as *.trycloudflare.com)"
Write-Host ""
Write-Host "ChatGPT connector URL (use one of these forms):" -ForegroundColor Green
Write-Host "  https://<url-shown-below>"
Write-Host "  https://<url-shown-below>/mcp"
Write-Host ""
Write-Host "Press Ctrl+C to stop the tunnel" -ForegroundColor DarkGray
Write-Host ""

& $cloudflared tunnel --url "http://localhost:$Port"