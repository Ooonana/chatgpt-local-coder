param([int]$Port = 3000)

$lines = netstat -ano | Select-String ":$Port\s" | Select-String "LISTENING"
$pids = @()

foreach ($line in $lines) {
    $parts = ($line -replace '\s+', ' ').ToString().Trim().Split(' ')
    $processId = [int]$parts[-1]
    if ($processId -gt 0) { $pids += $processId }
}

$pids = $pids | Select-Object -Unique

if ($pids.Count -eq 0) {
    Write-Host "No server is running on port $Port" -ForegroundColor Yellow
    exit 0
}

foreach ($processId in $pids) {
    $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
    $name = if ($proc) { $proc.ProcessName } else { "unknown" }
    Write-Host "Stopping PID $processId ($name)..." -ForegroundColor Yellow
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}

Write-Host "Stopped the server on port $Port" -ForegroundColor Green