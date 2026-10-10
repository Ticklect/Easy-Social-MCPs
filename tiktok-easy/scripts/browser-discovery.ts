import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join, win32 } from "node:path";

type BrowserProcess = { pid?: number; executablePath?: string; port?: number; dataDir?: string };
type Candidate = { port: number; debugPath?: string };

// Only these executable names are Chromium family browser processes. The
// process query emits filtered flags only, never a raw command line.
// String.raw preserves PowerShell's regex escapes (\s, \d, \x22). Normal JS
// quoted strings silently turn those into s, d, x22 and break discovery.
export const PROCESS_QUERY = String.raw`
$ErrorActionPreference='Stop'
$currentOwner=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$names=@('chrome.exe','chromium.exe','msedge.exe','brave.exe','vivaldi.exe','opera.exe','opera_gx.exe','helium.exe')
$filter=($names | ForEach-Object { "Name='$_'" }) -join ' OR '
$rows=@(foreach($p in (Get-CimInstance -ClassName Win32_Process -Filter $filter -ErrorAction Stop)) {
  if(-not $p.ExecutablePath) { continue }
  $cmd=$p.CommandLine
  if(-not $cmd -or $cmd -match '(?i)(?:^|\s)--type(?:=|\s)') { continue }
  if($cmd -match '(?i)(?:^|\s)--remote-debugging-port=(\d{1,5})(?=\s|$)') {
    $port=[int]$Matches[1]
  } else { continue }
  # GetOwner is costly on hosts with many browser processes; call it only on
  # candidate browser roots advertising a debugger.
  try { $identity=Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop }
  catch { continue }
  if($identity.ReturnValue -ne 0 -or ($identity.Domain+[char]92+$identity.User) -ine $currentOwner) { continue }
  $dir=$null
  if($cmd -match '(?i)(?:^|\s)--user-data-dir=(?:\x22([^\x22]{1,1024})\x22|([^\s\x22]{1,1024}))') {
    $dir=$Matches[1]
    if(-not $dir) { $dir=$Matches[2] }
  }
  [pscustomobject]@{pid=[int]$p.ProcessId;executablePath=[string]$p.ExecutablePath;port=$port;dataDir=$dir}
})
ConvertTo-Json -Compress -Depth 3 -InputObject $rows
`;

/** Metadata of already-running processes. No browser starts, no profile read,
 * no credentials and no process command lines leave the PowerShell query.
 */
export function runningWindowsBrowsers(): BrowserProcess[] {
  if (process.platform !== "win32") return [];
  try {
    const output = execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", PROCESS_QUERY],
      { encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true });
    const parsed: unknown = JSON.parse(output);
    return Array.isArray(parsed) ? parsed as BrowserProcess[] : [];
  } catch {
    // On restricted machines process inspection may be unavailable. Callers
    // can still use an explicit debugger port or the dedicated QR profile.
    return [];
  }
}

function candidateFromProcess(process: BrowserProcess,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
  fileSize: (path: string) => number = (path) => {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() ? stat.size : Number.POSITIVE_INFINITY;
  }): Candidate | null {
  const exe = process.executablePath;
  if (typeof exe !== "string" ||
      !/(^|[\\/])(chrome|chromium|msedge|brave|vivaldi|opera|opera_gx|helium)\.exe$/i.test(exe)) return null;
  if (!Number.isInteger(process.pid) || Number(process.pid) <= 0) return null;
  const advertised = process.port;
  if (!Number.isInteger(advertised) || advertised! < 0 || advertised! > 65535) return null;
  if (advertised! > 0) return { port: advertised! };
  // --remote-debugging-port=0: Chromium publishes the assigned ephemeral
  // port and browser WebSocket path in DevToolsActivePort in its own data dir.
  const dir = process.dataDir;
  if (typeof dir !== "string" || dir.length > 1024 ||
      !/^[A-Za-z]:[\\/]/.test(dir) || !win32.isAbsolute(dir) ||
      dir.startsWith("\\\\") || dir.includes("\0")) return null;
  try {
    const filename = join(dir, "DevToolsActivePort");
    // No access to browser cookies, storage, or its profile databases.
    if (fileSize(filename) > 1024) return null;
    const parts = readFile(filename).split(/\r?\n/);
    const port = Number(parts[0]);
    const debugPath = parts[1];
    if (!Number.isInteger(port) || port <= 0 || port > 65535 ||
        !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(debugPath || "")) return null;
    return { port, debugPath };
  } catch {
    return null;
  }
}

export async function discoverOpenBrowserPort(options: {
  processes?: BrowserProcess[];
  readFile?: (path: string) => string;
  fileSize?: (path: string) => number;
  getVersion?: (port: number) => Promise<unknown>;
} = {}): Promise<number | null> {
  const processes = options.processes ?? runningWindowsBrowsers();
  const candidates = new Map<number, Candidate>();
  for (const process of processes) {
    const candidate = candidateFromProcess(process, options.readFile, options.fileSize);
    if (!candidate) continue;
    const previous = candidates.get(candidate.port);
    if (previous && previous.debugPath && candidate.debugPath &&
        previous.debugPath !== candidate.debugPath) {
      throw new Error("Multiple browser debugger identities claim one port. Refusing to choose an account.");
    }
    candidates.set(candidate.port, previous?.debugPath ? previous : candidate);
  }
  const getVersion = options.getVersion ?? (async (port: number) => {
    const response = await fetch("http://127.0.0.1:" + port + "/json/version", {
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return null;
    return response.json();
  });
  const active: number[] = [];
  for (const candidate of candidates.values()) {
    try {
      const details = await getVersion(candidate.port) as { webSocketDebuggerUrl?: unknown; Browser?: unknown } | null;
      if (!details || typeof details.webSocketDebuggerUrl !== "string") continue;
      const ws = new URL(details.webSocketDebuggerUrl);
      if (ws.protocol !== "ws:" || ws.hostname !== "127.0.0.1" ||
          ws.port !== String(candidate.port) || ws.username || ws.password ||
          ws.search || ws.hash || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(ws.pathname)) continue;
      if (candidate.debugPath && candidate.debugPath !== ws.pathname) continue;
      if (typeof details.Browser !== "string" ||
          !/^(Chrome|Chromium|HeadlessChrome|Edg|Brave|Vivaldi|Opera|Helium)\//i.test(details.Browser)) continue;
      active.push(candidate.port);
    } catch {
      // The browser closed, the file was stale or its debugger is unavailable.
    }
  }
  if (active.length > 1) {
    throw new Error("Multiple already-open browser debug sessions detected. Refusing to select a TikTok account automatically.");
  }
  return active[0] ?? null;
}
