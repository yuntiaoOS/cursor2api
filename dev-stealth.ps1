# Windows: start stealth-proxy, then cursor2api
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$logOut = Join-Path $PSScriptRoot "stealth-proxy-startup.log"
$logErr = Join-Path $PSScriptRoot "stealth-proxy-startup.err.log"
foreach ($f in @($logOut, $logErr)) { if (Test-Path $f) { Remove-Item $f -Force } }

Write-Host "[dev-stealth] Starting stealth-proxy on :3011 (log: stealth-proxy-startup.log)"
Write-Host "[dev-stealth] First launch may take 1-3 min (Chrome + Vercel challenge)..."

$stealth = Start-Process -FilePath "node" `
    -ArgumentList "stealth-proxy/index.js" `
    -PassThru `
    -RedirectStandardOutput $logOut `
    -RedirectStandardError $logErr `
    -WindowStyle Hidden

$ready = $false
# 5 retries x ~90s challenge each; allow up to 8 minutes
$maxWait = 240
$totalSec = $maxWait * 2
for ($i = 1; $i -le $maxWait; $i++) {
    $elapsedSec = $i * 2
    if ($stealth.HasExited) {
        Write-Host "[dev-stealth] ERROR: stealth-proxy exited. Last log lines:"
        if (Test-Path $logOut) { Get-Content $logOut -Tail 15 | ForEach-Object { Write-Host "  $_" } }
        exit 1
    }
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:3011/health" -UseBasicParsing -TimeoutSec 3
        if ($r.Content -match '"status"\s*:\s*"ok"') {
            $ready = $true
            Write-Host "[dev-stealth] stealth-proxy is ready!"
            break
        }
        if ($r.Content -match 'initializing') {
            Write-Host ("[dev-stealth] Chrome challenge in progress ({0}s / {1}s)" -f $elapsedSec, $totalSec)
        }
    } catch {
        Write-Host ("[dev-stealth] Waiting for port 3011 ({0}s / {1}s)" -f $elapsedSec, $totalSec)
    }
    Start-Sleep -Seconds 2
}

if (-not $ready) {
    Write-Host ("[dev-stealth] ERROR: not ready after {0}s, aborting." -f $totalSec)
    if (Test-Path $logOut) { Get-Content $logOut -Tail 12 | ForEach-Object { Write-Host "  $_" } }
    if ($stealth -and -not $stealth.HasExited) { Stop-Process -Id $stealth.Id -Force -ErrorAction SilentlyContinue }
    exit 1
}

$env:STEALTH_PROXY = "http://127.0.0.1:3011"
Write-Host "[dev-stealth] Starting cursor2api (STEALTH_PROXY=$env:STEALTH_PROXY)..."
try {
    npx tsx watch src/index.ts
} finally {
    if ($stealth -and -not $stealth.HasExited) {
        Stop-Process -Id $stealth.Id -Force -ErrorAction SilentlyContinue
    }
}
