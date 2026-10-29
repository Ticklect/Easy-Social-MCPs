import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { discoverOpenBrowserPort } from "../scripts/browser-discovery-v0.1.6.ts";
import { readZipEntry } from "./zip.mjs";

const processFor = (port) => ({
  pid: port,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  port,
});
const versionFor = (port) => ({
  Browser: "Chrome/145.0.0.0",
  webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/browser-${port}`,
});

test("multiple browser accounts are checked concurrently but still rejected", async () => {
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const discovery = discoverOpenBrowserPort({
    processes: Array.from({ length: 6 }, (_, i) => processFor(9001 + i)),
    getVersion: async (port) => {
      started++;
      await gate;
      return versionFor(port);
    },
  });
  try {
    assert.equal(started, 6, "all six probes must begin before any response completes");
  } finally {
    release();
  }
  await assert.rejects(discovery, /Multiple already-open browser debug sessions/);
});

test("a fast valid response cannot hide a second slower signed-in browser", async () => {
  const completed = [];
  await assert.rejects(discoverOpenBrowserPort({
    processes: [processFor(9201), processFor(9202)],
    getVersion: async (port) => {
      if (port === 9202) await new Promise((resolve) => setTimeout(resolve, 8));
      completed.push(port);
      return versionFor(port);
    },
  }), /Multiple already-open browser debug sessions/);
  assert.deepEqual(completed, [9201, 9202]);
});

test("probe concurrency remains bounded and a lone valid session is selected", async () => {
  let inFlight = 0;
  let peak = 0;
  const discovery = await discoverOpenBrowserPort({
    processes: Array.from({ length: 19 }, (_, i) => processFor(9001 + i)),
    getVersion: async (port) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      return port === 9019 ? versionFor(port) : null;
    },
  });
  assert.equal(discovery, 9019);
  assert.equal(peak, 8);
  assert.equal(inFlight, 0);
});

test("concurrent probes keep strict loopback, browser identity and WebSocket checks", async () => {
  const result = await discoverOpenBrowserPort({
    processes: [9001, 9002, 9003, 9004, 9005, 9006].map(processFor),
    getVersion: async (port) => {
      const valid = versionFor(port);
      if (port === 9001) return { ...valid, Browser: "Untrusted/145" };
      if (port === 9002) return { ...valid, webSocketDebuggerUrl: valid.webSocketDebuggerUrl.replace("127.0.0.1", "192.0.2.10") };
      if (port === 9003) return { ...valid, webSocketDebuggerUrl: valid.webSocketDebuggerUrl.replace("/devtools/browser/", "/devtools/page/") };
      if (port === 9004) return { ...valid, webSocketDebuggerUrl: valid.webSocketDebuggerUrl + "?token=bad" };
      if (port === 9005) throw new Error("closed port");
      return valid;
    },
  });
  assert.equal(result, 9006);
});

test("v0.1.6 packaged runtime includes bounded parallel discovery", async () => {
  const archive = path.resolve(import.meta.dirname, "..", "tiktok-easy-v0.1.6.mcpb");
  const compiled = readZipEntry(archive, "app/dist/runtime/browser-discovery.js");
  const { discoverOpenBrowserPort: packagedDiscovery } = await import(
    "data:text/javascript;base64," + compiled.toString("base64"));
  let inFlight = 0;
  let peak = 0;
  const detected = await packagedDiscovery({
    processes: Array.from({ length: 11 }, (_, i) => processFor(9201 + i)),
    getVersion: async (port) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      return port === 9211 ? versionFor(port) : null;
    },
  });
  assert.equal(detected, 9211);
  assert.equal(peak, 8);
});
