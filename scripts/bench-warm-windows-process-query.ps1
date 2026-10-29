# Windows read-only process-enumeration benchmark. A *fresh* process snapshot is
# taken on every iteration. Only elapsed milliseconds and counts are emitted.
# Does not open a browser, inspect cookies, or retain candidate accounts.
param([ValidateRange(3, 40)][int]$Samples = 12)
$ErrorActionPreference = 'Stop'
$names = @('chrome.exe','chromium.exe','msedge.exe','brave.exe','vivaldi.exe','opera.exe','opera_gx.exe','helium.exe')
$filter = ($names | ForEach-Object { "Name='$_'" }) -join ' OR '
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$durations = @()
$cpuMs = @()
$counts = @()
$memory = @()
for($i = 0; $i -lt $Samples; $i++) {
  $beforeCpu = (Get-Process -Id $PID).TotalProcessorTime.TotalMilliseconds
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $active = 0
  $rows = @(Get-CimInstance -ClassName Win32_Process -Filter $filter -ErrorAction Stop)
  foreach ($row in $rows) {
    $line = $row.CommandLine
    if (-not $line -or $line -match '(?i)(?:^|\s)--type(?:=|\s)' -or
        $line -notmatch '(?i)(?:^|\s)--remote-debugging-port=\d{1,5}(?=\s|$)') {continue}
    try { $actual = Invoke-CimMethod -InputObject $row -MethodName GetOwner -ErrorAction Stop }
    catch {continue}
    if ($actual.ReturnValue -eq 0 -and ($actual.Domain+[char]92+$actual.User) -ieq $owner) { $active++ }
  }
  $watch.Stop()
  $durations += $watch.Elapsed.TotalMilliseconds
  $cpuMs += ((Get-Process -Id $PID).TotalProcessorTime.TotalMilliseconds - $beforeCpu)
  $counts += $active
  $memory += [Math]::Round((Get-Process -Id $PID).WorkingSet64 / 1MB, 2)
}
$sorted = @($durations | Sort-Object)
$n = $sorted.Count
$result = [ordered]@{
  method = 'Single warm PowerShell process, fresh CIM snapshot each iteration'
  samples = $n
  p50_ms = [Math]::Round($sorted[[int][Math]::Ceiling($n*.5)-1],2)
  p95_ms = [Math]::Round($sorted[[int][Math]::Ceiling($n*.95)-1],2)
  child_cpu_ms_total = [Math]::Round(($cpuMs | Measure-Object -Sum).Sum,2)
  child_rss_start_mb = $memory[0]
  child_rss_end_mb = $memory[-1]
  candidate_counts = $counts
}
ConvertTo-Json -InputObject ([pscustomobject]$result) -Depth 3 -Compress
