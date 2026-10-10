@echo off
setlocal
cd /d "%~dp0"
set "BACKGROUND=%~1"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 22 or later is required. Install it from https://nodejs.org/
  if /i not "%BACKGROUND%"=="--background" pause
  exit /b 1
)
if not exist "node_modules\ws\package.json" (
  echo Installing browser companion dependencies...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo Could not install the companion dependencies.
    if /i not "%BACKGROUND%"=="--background" pause
    exit /b 1
  )
)
echo Starting local browser companion...
echo Leave this window open while using Easy Social plugins.
node server.mjs
if errorlevel 1 (
  echo The companion stopped unexpectedly.
  if /i not "%BACKGROUND%"=="--background" pause
  exit /b 1
)
