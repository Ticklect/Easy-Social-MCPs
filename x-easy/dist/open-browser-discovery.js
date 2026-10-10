import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Discover Chromium processes which already opted into the local DevTools API.
// Ordinary browser profiles are not accessible to CDP, and are never copied.
const PROCESS_QUERY = String.raw`
$ErrorActionPreference='Stop'
$filter="Name='chrome.exe' OR Name='msedge.exe' OR Name='brave.exe' OR Name='vivaldi.exe' OR Name='opera.exe'"
$current=$env:USERNAME
$domain=$env:USERDOMAIN
$result=@(Get-CimInstance Win32_Process -Filter $filter | Where-Object {
  $_.CommandLine -match '(?i)--remote-debugging-port=' -and $_.CommandLine -notmatch '(?i)--type='
} | ForEach-Object {
  $owner=Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue
  if($owner -and $owner.User -eq $current -and $owner.Domain -eq $domain) {
    [pscustomobject]@{args=$_.CommandLine}
  }
} | Select-Object -First 32)
ConvertTo-Json -InputObject $result -Compress -Depth 2
`;

function commandFlag(args, name) {
  const escaped = name.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&");
  const match = new RegExp("(?:^|\\s)--" + escaped + "=(?:\"([^\"]+)\"|([^\\s]+))", "i").exec(String(args || ""));
  return match ? match[1] || match[2] : null;
}

export function debuggerCandidatesFromProcesses(processes, { fsApi = fs, pathApi = path } = {}) {
  const found = new Set();
  for (const process of Array.isArray(processes) ? processes.slice(0, 32) : []) {
    const args = typeof process === "string" ? process : process?.args;
    if (typeof args !== "string" || /(?:^|\s)--type=/.test(args)) continue;
    const address = commandFlag(args, "remote-debugging-address");
    if (address && !["127.0.0.1", "localhost", "[::1]", "::1"].includes(address.toLowerCase())) continue;
    const rawPort = commandFlag(args, "remote-debugging-port");
    if (!rawPort || !/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65535) continue;
    let port = Number(rawPort);
    if (!port) {
      const directory = commandFlag(args, "user-data-dir");
      if (!directory || !pathApi.isAbsolute(directory)) continue;
      try {
        const firstLine = fsApi.readFileSync(pathApi.join(directory, "DevToolsActivePort"), "utf8").split(/\r?\n/, 1)[0];
        if (!/^[1-9]\d{0,4}$/.test(firstLine) || Number(firstLine) > 65535) continue;
        port = Number(firstLine);
      } catch { continue; }
    }
    found.add(port);
  }
  return [...found].sort((a, b) => a - b);
}

export function listAlreadyOpenDebuggers({ platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32") return [];
  try {
    const script = Buffer.from(PROCESS_QUERY, "utf16le").toString("base64");
    const data = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", script], {
      encoding: "utf8", windowsHide: true, timeout: 4_000, maxBuffer: 64 * 1024, env,
    }).trim();
    return debuggerCandidatesFromProcesses(JSON.parse(data));
  } catch {
    return [];
  }
}

export async function discoverAlreadyOpenSocialBrowser({
  ports,
  request,
  allowed,
  validateWebSocket,
} = {}) {
  const eligible = [];
  for (const port of [...new Set(ports || [])].slice(0, 32)) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const base = `http://127.0.0.1:${port}`;
    const info = await request(`${base}/json/version`);
    try { validateWebSocket(info?.webSocketDebuggerUrl, port); }
    catch { continue; }
    const tabs = await request(`${base}/json/list`);
    if (!Array.isArray(tabs)) continue;
    if (tabs.some((tab) => {
      if (tab?.type !== "page" || !tab.webSocketDebuggerUrl) return false;
      try {
        validateWebSocket(tab.webSocketDebuggerUrl, port);
        return allowed(tab.url);
      } catch { return false; }
    })) eligible.push(port);
  }
  if (eligible.length > 1) {
    throw new Error("Multiple existing Chromium browsers have this social site open. Select the intended browser with the Easy Social Browser Companion or EASY_SOCIAL_BROWSER_DEBUG_PORT.");
  }
  return eligible[0] || null;
}
