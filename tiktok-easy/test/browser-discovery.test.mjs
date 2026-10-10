import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { extractZip } from "./zip.mjs";

test("discovers only trusted running browser debugger ports and fails closed on ambiguity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiktok-discovery-check-"));
  try {
    extractZip(path.join(import.meta.dirname, "..", "tiktok-easy-v0.1.4-source.zip"), dir);
    // Production TypeScript module is also shipped compiled in the MCPB.
    const pkg = path.join(dir, "package");
    extractZip(path.join(import.meta.dirname, "..", "tiktok-easy-v0.1.4.mcpb"), pkg);
    const { discoverOpenBrowserPort, PROCESS_QUERY } = await import(pathToFileURL(path.join(
      pkg, "app", "dist", "runtime", "browser-discovery.js")).href);
    // These assertions check the actual emitted PowerShell string, rather
    // than the TypeScript source before JS string escape processing.
    assert.ok(PROCESS_QUERY.includes("--remote-debugging-port=(\\d{1,5})"));
    assert.ok(PROCESS_QUERY.includes("(?:^|\\s)"));
    assert.ok(PROCESS_QUERY.includes("\\x22"));
    assert.match(PROCESS_QUERY, /Get-CimInstance\s+-ClassName\s+Win32_Process\s+-Filter\s+\$filter/);
    assert.match(PROCESS_QUERY, /Invoke-CimMethod\s+-InputObject\s+\$p\s+-MethodName\s+GetOwner/);
    if (process.platform === "win32") {
      // Execute the exact production PowerShell with mock CIM process records.
      // This verifies regex matching, targeted CIM query and owner filtering
      // without waiting on the host's potentially slow Win32_Process provider.
      const mockCim = [
        "$actual=[Security.Principal.WindowsIdentity]::GetCurrent().Name.Split([char]92)",
        "$ownUser=$actual[-1]",
        "$ownDomain=$actual[0]",
        "$own=[pscustomobject]@{ReturnValue=0;User=$ownUser;Domain=$ownDomain}",
        "$foreign=[pscustomobject]@{ReturnValue=0;User='not-the-user';Domain=$ownDomain}",
        "$all=@(",
        "[pscustomobject]@{Name='chrome.exe';ProcessId=101;ExecutablePath='C:\\Chrome\\chrome.exe';CommandLine='chrome.exe --remote-debugging-port=9222 --user-data-dir=\"C:\\Browser Data\"';Owner=$own},",
        "[pscustomobject]@{Name='helium.exe';ProcessId=102;ExecutablePath='C:\\Helium\\helium.exe';CommandLine='helium.exe --remote-debugging-port=9333';Owner=$foreign},",
        "[pscustomobject]@{Name='chrome.exe';ProcessId=103;ExecutablePath='C:\\Chrome\\chrome.exe';CommandLine='chrome.exe --type=renderer --remote-debugging-port=9444';Owner=$own},",
        "[pscustomobject]@{Name='chrome.exe';ProcessId=104;ExecutablePath='C:\\Chrome\\chrome.exe';CommandLine='chrome.exe --remote-debugging-port=0 --user-data-dir=C:\\Ephemeral';Owner=$own},",
        "[pscustomobject]@{Name='chrome.exe';ProcessId=105;ExecutablePath='C:\\Chrome\\chrome.exe';CommandLine='chrome.exe --remote-debugging-port=oops';Owner=$own}",
        ")",
        "function Get-CimInstance { [CmdletBinding()] param([string]$ClassName,[string]$Filter)",
        " if($ClassName -ne 'Win32_Process' -or $Filter -notmatch \"Name='chrome.exe'\" -or $Filter -notmatch \"Name='helium.exe'\" -or $Filter -notmatch ' OR ') {throw 'Unfiltered CIM lookup'}",
        " return $all",
        "}",
        "function Invoke-CimMethod { [CmdletBinding()] param([object]$InputObject,[string]$MethodName)",
        " if($MethodName -ne 'GetOwner') {throw 'Unexpected CIM method'}",
        " return $InputObject.Owner",
        "}",
      ].join("\n");
      const raw = execFileSync("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", mockCim + "\n" + PROCESS_QUERY],
        { encoding: "utf8", windowsHide: true, timeout: 8000 });
      const metadata = JSON.parse(raw);
      assert.deepEqual(metadata.map((item) => item.port).sort((a, b) => a - b), [0, 9222]);
      assert.equal(metadata.find((item) => item.port === 9222)?.dataDir, "C:\\Browser Data");
      assert.ok(metadata.every((item) => !("CommandLine" in item)));
    }
    const debug = (port, host = "127.0.0.1", id = "browser-one") =>
      ({ Browser: "Chrome/145.0.0.0", webSocketDebuggerUrl: "ws://" + host + ":" + port + "/devtools/browser/" + id });
    const browserProcess = (pid, port, dataDir) => ({
      pid, port, dataDir, executablePath: "C:\\Users\\tester\\AppData\\Local\\imput\\Helium\\Application\\chrome.exe",
    });
    assert.equal(await discoverOpenBrowserPort({
      processes: [browserProcess(1234, 9222)],
      getVersion: async (port) => debug(port),
    }), 9222);
    assert.equal(await discoverOpenBrowserPort({
      processes: [browserProcess(1234, 9222), browserProcess(1235, 9222)],
      getVersion: async (port) => debug(port),
    }), 9222);
    assert.equal(await discoverOpenBrowserPort({
      processes: [browserProcess(1234, 0, "C:\\Users\\tester\\browser-profile")],
      readFile: () => "5678\n/devtools/browser/browser-one\n",
      fileSize: () => 40,
      getVersion: async (port) => debug(port),
    }), 5678);
    assert.equal(await discoverOpenBrowserPort({
      processes: [browserProcess(1234, 0, "C:\\Users\\tester\\browser-profile")],
      readFile: () => "5678\n/devtools/browser/different-session\n",
      fileSize: () => 40,
      getVersion: async (port) => debug(port),
    }), null);
    assert.equal(await discoverOpenBrowserPort({
      processes: [browserProcess(1234, 9222)],
      getVersion: async (port) => debug(port, "192.0.2.12"),
    }), null);
    assert.equal(await discoverOpenBrowserPort({
      processes: [browserProcess(1234, 9222), browserProcess(1235, 9333)],
      getVersion: async (port) => debug(port),
    }).then(() => false, (error) => /Multiple already-open browser debug sessions/.test(error.message)), true);
    assert.equal(await discoverOpenBrowserPort({
      processes: [{ ...browserProcess(1234, 9222), executablePath: "C:\\Users\\tester\\tools\\random.exe" }],
      getVersion: async (port) => debug(port),
    }), null);
    assert.equal(await discoverOpenBrowserPort({
      processes: [browserProcess(1234, 9222)],
      getVersion: async () => { throw new Error("connection closed"); },
    }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
