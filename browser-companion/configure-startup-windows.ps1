param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Enable", "Disable")]
  [string] $Action
)

$ErrorActionPreference = "Stop"
$startup = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startup "Easy Social Browser Companion.lnk"
if ($Action -eq "Disable") {
  if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath
  }
  Write-Output "Easy Social browser companion will no longer start at sign-in."
  exit 0
}

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw "Node.js must be installed before enabling startup."
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "node_modules\ws\package.json"))) {
  throw "Run start-windows.cmd once before enabling startup."
}
$launcher = Join-Path $PSScriptRoot "start-hidden-windows.vbs"
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Windows startup helper is missing."
}
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
$shortcut.Arguments = '"' + $launcher + '"'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Description = "Starts the local Easy Social browser companion at Windows sign-in"
$shortcut.Save()
Write-Output "Easy Social browser companion will start automatically when you sign in to Windows."
