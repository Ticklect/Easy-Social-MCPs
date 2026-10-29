// Deterministic local WebSocket and Chrome API mocks. No user browser or accounts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { makeServer } from "../server.mjs";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const baseline = process.env.BENCH_BASELINE === "1";
const source = baseline
  ? execFileSync("git", ["show", "HEAD:browser-companion/extension/background.js"],
    { cwd: root, encoding: "utf8" })
  : fs.readFileSync(path.join(root, "extension/background.js"), "utf8");
const origin = `chrome-extension://${"a".repeat(32)}`;
const browserId = "b".repeat(32);
const windowSize = Number(process.env.BENCH_COMMANDS || 32);
const rounds = Number(process.env.BENCH_ROUNDS || 12);
const warmup = 2;
const delay = () => new Promise((resolve) => setTimeout(resolve, 2));
const percentile = (sorted, p) => sorted[Math.ceil(sorted.length * p) - 1];
const listenOpen = (socket) => new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

async function run() {
  const directory = fs.mkdtempSync(path.join(root, ".easy-companion-bench-"));
  const bridge = makeServer({ port: 0, directory });
  const port = await bridge.start();
  const key = fs.readFileSync(bridge.keyPath, "utf8");
  const listeners = {};
  const workByTab = new Map();
  let attachCalls = 0;
  let socket;
  const chrome = {
    storage: { local: {
      get: async () => ({ pairingCode: key, browserId }),
      set: async () => {},
    } },
    tabs: {
      get: async (tabId) => ({ id: tabId, url: "https://www.reddit.com/" }),
      query: async () => [],
      onUpdated: { addListener(fn) { listeners.updated = fn; } },
      onRemoved: { addListener(fn) { listeners.removed = fn; } },
    },
    debugger: {
      attach: async ({ tabId }) => {
        attachCalls++;
        // Serialize mocked Chrome attachment cost per tab. Contending attach
        // calls represent Chrome API work, independent of OS/network jitter.
        const prior = workByTab.get(tabId) || Promise.resolve();
        const current = prior.then(delay);
        workByTab.set(tabId, current);
        await current;
      },
      detach: async ({ tabId }) => { workByTab.delete(tabId); },
      sendCommand: async () => ({ result: { value: "mock" } }),
      onEvent: { addListener() {} },
      onDetach: { addListener(fn) { listeners.detach = fn; } },
    },
    runtime: {
      onMessage: { addListener() {} }, onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  class ExtensionWebSocket extends WebSocket {
    constructor(url) {
      super(url, { origin });
      socket = this;
    }
  }
  const context = vm.createContext({ chrome, URL, WebSocket: ExtensionWebSocket,
    crypto: { randomUUID: () => "b".repeat(32) }, navigator: { userAgent: "Chrome" },
    setInterval, clearInterval, setTimeout, clearTimeout });
  const all = [];
  const cpu = process.cpuUsage();
  const heapBefore = process.memoryUsage().heapUsed;
  const rssBefore = process.memoryUsage().rss;
  let failures = 0;
  let wallTotal = 0;
  try {
    vm.runInContext(source.replace("ws://127.0.0.1:19411/extension",
      `ws://127.0.0.1:${port}/extension`), context);
    await new Promise((resolve) => {
      const retry = () => socket ? listenOpen(socket).then(resolve) : setImmediate(retry);
      retry();
    });
    for (let round = 0; round < rounds + warmup; round++) {
      const tabId = 100 + round;
      const pageSocket = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${browserId}/${tabId}?key=${key}`);
      await listenOpen(pageSocket);
      const starts = new Map();
      let received = 0;
      const done = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Mock CDP burst timed out")), 4000);
        pageSocket.on("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          if (!Number.isInteger(msg.id)) return;
          const end = performance.now();
          if (msg.error) failures++;
          if (round >= warmup) all.push(end - starts.get(msg.id));
          if (++received === windowSize) { clearTimeout(timeout); resolve(); }
        });
      });
      const began = performance.now();
      for (let i = 1; i <= windowSize; i++) {
        starts.set(i, performance.now());
        pageSocket.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression: "1" } }));
      }
      await done;
      if (round >= warmup) wallTotal += performance.now() - began;
      const closed = new Promise((resolve) => pageSocket.once("close", resolve));
      listeners.updated(tabId, { url: "https://unapproved.example/" });
      await closed;
    }
  } finally {
    if (socket) await vm.runInContext("disconnect()", context);
    await bridge.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(all.length, windowSize * rounds);
  all.sort((a, b) => a - b);
  const cpuDelta = process.cpuUsage(cpu);
  const results = {
    version: baseline ? "git-HEAD" : "working-tree",
    commands: all.length, burstSize: windowSize,
    attachCalls, failures,
    p50Ms: Number(percentile(all, .5).toFixed(2)),
    p95Ms: Number(percentile(all, .95).toFixed(2)),
    meanBurstMs: Number((wallTotal / rounds).toFixed(2)),
    cpuMs: Number(((cpuDelta.user + cpuDelta.system) / 1000).toFixed(2)),
    heapDeltaKiB: Number(((process.memoryUsage().heapUsed - heapBefore) / 1024).toFixed(1)),
    rssDeltaKiB: Number(((process.memoryUsage().rss - rssBefore) / 1024).toFixed(1)),
  };
  console.log(JSON.stringify(results));
}

await run();
