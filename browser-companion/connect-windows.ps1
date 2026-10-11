$ErrorActionPreference = "Stop"

# First-run setup only. The existing browser and its sign-ins are never modified.
$root = $PSScriptRoot
$keyPath = Join-Path $env:LOCALAPPDATA "ChatOnSteroids\EasySocialBrowserBridge\pairing-key"

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw "Node.js 22 or newer is required. Install it from https://nodejs.org/."
}
$nodeVersion = (& node.exe --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
  throw "Node.js 22 or newer is required. Found $nodeVersion."
}

if (-not (Test-Path -LiteralPath (Join-Path $root "node_modules\ws\package.json"))) {
  Write-Output "Installing local browser companion dependencies..."
  Push-Location $root
  try {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "Could not install browser companion dependencies." }
  } finally { Pop-Location }
}

& (Join-Path $root "configure-startup-windows.ps1") -Action Enable

function Get-BridgeStatus {
  if (-not (Test-Path -LiteralPath $keyPath)) { return "missing" }
  $key = (Get-Content -LiteralPath $keyPath -Raw).Trim()
  if ($key -notmatch '^[0-9a-f]{64}$') { return "missing" }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:19411/json/version' `
      -Headers @{ Authorization = "Bearer $key" } -TimeoutSec 2
    # Older bridge builds returned case-colliding Browser/browser keys which
    # ConvertFrom-Json rejects in Windows PowerShell. Check the fixed marker.
    if ($response.Content -match '"Browser"\s*:\s*"EasySocialCompanion/v1"') { return "connected" }
  } catch [System.Net.WebException] {
    $response = $_.Exception.Response
    if ($response -and [int]$response.StatusCode -eq 503) {
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
      try {
        $message = $reader.ReadToEnd() | ConvertFrom-Json
      } finally { $reader.Dispose() }
      if ($message.error -match '^No connected browser companion\.') { return "unpaired" }
    }
  }
  return "unavailable"
}

$status = Get-BridgeStatus
if ($status -eq 'missing' -or $status -eq 'unavailable') {
  $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 19411 -State Listen -ErrorAction SilentlyContinue
  if ($listener) { throw "Port 19411 is occupied by another process. The browser companion was not started." }
  Write-Output "Starting Easy Social Browser Companion in the background..."
  & (Join-Path $env:WINDIR 'System32\wscript.exe') (Join-Path $root 'start-hidden-windows.vbs')
  for ($attempt = 0; $attempt -lt 24; $attempt++) {
    Start-Sleep -Milliseconds 250
    $status = Get-BridgeStatus
    if ($status -eq 'connected' -or $status -eq 'unpaired') { break }
  }
  if ($status -ne 'connected' -and $status -ne 'unpaired') {
    throw "The local companion did not start. Check Node.js and the companion folder."
  }
}

Write-Output ""
Write-Output "Easy Social Browser Companion is running and will start when you sign in to Windows."
if ($status -eq 'connected') {
  Write-Output "Your existing browser is connected. Reddit, X and YouTube Easy can reuse its sign-ins."
} else {
  Write-Output "Load the companion extension into your existing Chrome, Edge, Helium or Brave browser:"
  Write-Output (Join-Path $root 'extension')
  Write-Output "In the extension popup, enter this one-time pairing code:"
  Write-Output (Get-Content -LiteralPath $keyPath -Raw).Trim()
  Write-Output "Your social accounts stay signed in. No second login is needed."
}
