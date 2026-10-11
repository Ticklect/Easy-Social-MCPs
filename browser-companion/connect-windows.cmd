@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0connect-windows.ps1"
if errorlevel 1 (
  echo.
  echo Easy Social Browser Companion setup could not finish.
)
echo.
pause
