# Prototype only: JSON-line PowerShell worker for read-only Chromium process
# discovery. Each `scan` obtains a NEW filtered CIM snapshot and checks the
# Windows process owner before returning at most 32 numeric loopback ports.
# -Fixture accepts synthetic rows for isolated deterministic tests only.
param([switch]$Fixture)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$names = @('chrome.exe','chromium.exe','msedge.exe','brave.exe','vivaldi.exe','opera.exe','opera_gx.exe','helium.exe')
$nameLookup = @{}
foreach ($name in $names) { $nameLookup[$name] = $true }
$filter = ($names | ForEach-Object { "Name='$_'" }) -join ' OR '
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name

function Get-EphemeralPort([string]$commandLine) {
  $match = [regex]::Match($commandLine, '(?i)(?:^|\s)--user-data-dir=(?:"([^\"]+)"|([^\s]+))(?=\s|$)')
  if (-not $match.Success) { return $null }
  $raw = $match.Groups[1].Value + $match.Groups[2].Value
  # Reject UNC/device/drive-relative paths. Avoid network or device access.
  if ($raw -notmatch '^[a-zA-Z]:[\\/]') { return $null }
  try {
    $directory = [IO.Path]::GetFullPath($raw)
    # A junction/symlink in any path segment, including the port file, could
    # redirect a read away from the selected profile. Fail closed.
    $current = $directory.Substring(0, 3)
    foreach ($part in $directory.Substring(3).TrimEnd('\\').Split('\\')) {
      if (-not $part) { continue }
      $current = [IO.Path]::Combine($current, $part)
      if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $null }
    }
    $file = [IO.Path]::Combine($directory, 'DevToolsActivePort')
    if (([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $null }
    $firstLine = [IO.File]::ReadLines($file) | Select-Object -First 1
    if ($firstLine -notmatch '^[1-9]\d{0,4}$') { return $null }
    $port = [int]$firstLine
    if ($port -gt 65535) { return $null }
    return $port
  } catch { return $null }
}

function Get-Port([string]$commandLine) {
  if ([string]::IsNullOrWhiteSpace($commandLine) -or $commandLine -match '(?i)(?:^|\s)--type(?:=|\s)') { return $null }
  $match = [regex]::Match($commandLine, '(?i)(?:^|\s)--remote-debugging-port=(?:"(\d{1,5})"|(\d{1,5}))(?=\s|$)')
  if (-not $match.Success) { return $null }
  $port = [int]($match.Groups[1].Value + $match.Groups[2].Value)
  if ($port -gt 65535) { return $null }
  $address = [regex]::Match($commandLine, '(?i)(?:^|\s)--remote-debugging-address=(?:"([^\"]+)"|([^\s]+))(?=\s|$)')
  if ($address.Success) {
    $hostName = ($address.Groups[1].Value + $address.Groups[2].Value).ToLowerInvariant()
    if ($hostName -notin @('127.0.0.1','localhost','[::1]','::1')) { return $null }
  }
  if ($port -eq 0) { return Get-EphemeralPort $commandLine }
  return $port
}

function Get-Ports($rows, [bool]$isFixture) {
  $ports = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($row in $rows) {
    if (-not $nameLookup.ContainsKey([string]$row.Name)) { continue }
    $commandLine = [string]$row.CommandLine
    if (-not $commandLine -or $commandLine -match '(?i)(?:^|\s)--type(?:=|\s)' -or
        $commandLine -notmatch '(?i)(?:^|\s)--remote-debugging-port=') { continue }
    if ($isFixture) {
      $returnValue = $row.OwnerReturnValue
      $domain = [string]$row.OwnerDomain
      $user = [string]$row.OwnerUser
    } else {
      try { $owner = Invoke-CimMethod -InputObject $row -MethodName GetOwner -ErrorAction Stop }
      catch { continue }
      $returnValue = $owner.ReturnValue
      $domain = [string]$owner.Domain
      $user = [string]$owner.User
    }
    if ($returnValue -ne 0 -or ($domain + [char]92 + $user) -ine $identity) { continue }
    $port = Get-Port $commandLine
    if ($null -eq $port) { continue }
    [void]$ports.Add([int]$port)
    if ($ports.Count -eq 32) { break }
  }
  return @($ports | Sort-Object)
}

while ($null -ne ($line = [Console]::ReadLine())) {
  $id = $null
  $startCpu = [Diagnostics.Process]::GetCurrentProcess().TotalProcessorTime.TotalMilliseconds
  $clock = [Diagnostics.Stopwatch]::StartNew()
  try {
    if ($line.Length -gt 262144) { throw 'oversized request' }
    $request = ConvertFrom-Json -InputObject $line -ErrorAction Stop
    if ($request.id -isnot [string] -or $request.id -notmatch '^[a-zA-Z0-9:._-]{1,96}$' -or $request.op -ne 'scan') {
      throw 'invalid request'
    }
    $id = $request.id
    if ($Fixture) {
      $rows = @($request.rows)
    } else {
      $rows = @(Get-CimInstance -ClassName Win32_Process -Filter $filter -ErrorAction Stop)
    }
    $ports = @(Get-Ports $rows ([bool]$Fixture))
    $clock.Stop()
    $proc = [Diagnostics.Process]::GetCurrentProcess()
    $proc.Refresh()
    $response = [ordered]@{
      id = $id; ok = $true; ports = [int[]]$ports; scanMs = [math]::Round($clock.Elapsed.TotalMilliseconds,3)
      cpuMs = [math]::Round(($proc.TotalProcessorTime.TotalMilliseconds - $startCpu),3)
      rssMb = [math]::Round($proc.WorkingSet64 / 1MB,3); pid = $PID
    }
  } catch {
    $response = [ordered]@{id = $id; ok = $false; error = 'scan failed or malformed request' }
  }
  [Console]::WriteLine((ConvertTo-Json -InputObject ([pscustomobject]$response) -Compress -Depth 3))
}
