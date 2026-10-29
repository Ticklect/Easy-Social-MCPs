import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { debuggerCandidatesFromProcesses, discoverAlreadyOpenSocialBrowser } from "../src/open-browser-discovery.js";

test("detects only already-running loopback browser debugger ports, including auto-selected ports", () => {
  const file = new Map([["C:\\Browser Profile\\DevToolsActivePort", "43125\n/devtools/browser/local"]]);
  const fsApi = { readFileSync(name) {
    if (!file.has(name)) throw new Error("no debugger");
    return file.get(name);
  } };
  const processes = [
    { args: '"C:\\Program Files\\Helium\\chrome.exe" --remote-debugging-port=0 --user-data-dir="C:\\Browser Profile"' },
    { args: '"C:\\Program Files\\Chrome\\chrome.exe" --remote-debugging-port=43126 --remote-debugging-address=127.0.0.1' },
    { args: 'chrome.exe --type=renderer --remote-debugging-port=43127' },
    { args: 'chrome.exe --remote-debugging-port=43128 --remote-debugging-address=0.0.0.0' },
    { args: 'chrome.exe --remote-debugging-port=invalid' },
  ];
  assert.deepEqual(debuggerCandidatesFromProcesses(processes, { fsApi, pathApi: path.win32 }), [43125, 43126]);
});

test("selects the sole debugger with an already-open matching social tab; does not touch unrelated tabs", async () => {
  const requested = [];
  const request = async (url) => {
    requested.push(url);
    const port = Number(new URL(url).port);
    if (url.endsWith("/json/version")) return { webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/id` };
    return port === 43125
      ? [{ type: "page", url: "https://www.reddit.com/r/example", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/id` }]
      : [{ type: "page", url: "https://mail.example.com", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/id` }];
  };
  const params = {
    ports: [43125, 43126],
    request,
    validateWebSocket: (ws, port) => {
      assert.ok(ws?.startsWith(`ws://127.0.0.1:${port}/`));
    },
    allowed: (url) => new URL(url).hostname === "www.reddit.com",
  };
  assert.equal(await discoverAlreadyOpenSocialBrowser(params), 43125);
  assert.equal(requested.every((url) => url.endsWith("/json/version") || url.endsWith("/json/list")), true);
  await assert.rejects(
    () => discoverAlreadyOpenSocialBrowser({ ...params, allowed: (url) => new URL(url).protocol === "https:" }),
    /Multiple existing Chromium browsers/,
  );
});

test("Reddit discovery checks every candidate within an eight-request concurrency ceiling", async () => {
  const ports = Array.from({ length: 16 }, (_, i) => 42001 + i);
  let inflight = 0;
  let peak = 0;
  let calls = 0;
  const port = await discoverAlreadyOpenSocialBrowser({
    ports,
    request: async (href) => {
      calls++;
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((resolve) => setImmediate(resolve));
      inflight--;
      const url = new URL(href);
      const ws = `ws://127.0.0.1:${url.port}/devtools/page/a`;
      return url.pathname === "/json/version" ? { webSocketDebuggerUrl: ws } : [{
        type: "page", webSocketDebuggerUrl: ws,
        url: Number(url.port) === ports[15] ? "https://reddit.com/" : "https://other.example/",
      }];
    },
    validateWebSocket: (ws, port) => { if (!ws.startsWith(`ws://127.0.0.1:${port}/`)) throw new Error("Spoofed debugger"); },
    allowed: (url) => url === "https://reddit.com/",
  });
  assert.equal(port, ports[15]);
  assert.equal(peak, 8);
  assert.equal(inflight, 0);
  assert.equal(calls, 32);
});
