// Offline, repeatable latency comparison. No live browser, account, network or CDP port.
// Run: node scripts/bench-browser-latency.mjs [--samples=24] [--delay=4]
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverAlreadyOpenSocialBrowser } from "../src/open-browser-discovery.js";
import { CdpClient, YouTubeBrowser } from "../src/browser.js";
import { StudioAdapter } from "../src/studio.js";

const option = (name, fallback) => {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  const number = value ? Number(value.split("=")[1]) : fallback;
  if (!Number.isInteger(number) || number < 1 || number > 100) throw new Error(`Invalid ${name}`);
  return number;
};
const samples = option("samples", 24);
const latency = option("delay", 4);
const navigationDelay = option("navigation-delay", 40);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const allPorts = Array.from({ length: 32 }, (_, index) => 41001 + index);
const percentiles = (data) => {
  const ordered = [...data].sort((a, b) => a - b);
  return { p50_ms: Number(ordered[Math.ceil(ordered.length * 0.5) - 1].toFixed(2)),
    p95_ms: Number(ordered[Math.ceil(ordered.length * 0.95) - 1].toFixed(2)) };
};

// Deliberately keep the original serial algorithm as a benchmark baseline.
async function serialDiscovery({ ports, request, allowed, validateWebSocket }) {
  const eligible = [];
  for (const port of [...new Set(ports || [])].slice(0, 32)) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const base = `http://127.0.0.1:${port}`;
    const info = await request(`${base}/json/version`);
    try { validateWebSocket(info?.webSocketDebuggerUrl, port); } catch { continue; }
    const tabs = await request(`${base}/json/list`);
    if (!Array.isArray(tabs)) continue;
    if (tabs.some((tab) => {
      if (tab?.type !== "page" || !tab.webSocketDebuggerUrl) return false;
      try { validateWebSocket(tab.webSocketDebuggerUrl, port); return allowed(tab.url); }
      catch { return false; }
    })) eligible.push(port);
  }
  if (eligible.length > 1) throw new Error("Multiple existing Chromium browsers");
  return eligible[0] || null;
}

function discoveryFixture(candidateCount) {
  const ports = allPorts.slice(0, candidateCount);
  const chosen = ports[Math.floor(ports.length * 0.75)];
  let requests = 0;
  return {
    ports,
    chosen,
    request: async (url) => {
      requests++;
      await pause(latency);
      const address = new URL(url);
      const port = Number(address.port);
      const webSocketDebuggerUrl = `ws://127.0.0.1:${port}/devtools/page/fixture`;
      return address.pathname === "/json/version" ? { webSocketDebuggerUrl } : [{
        type: "page", webSocketDebuggerUrl,
        url: port === chosen ? "https://studio.youtube.com/" : "https://example.test/",
      }];
    },
    allowed: (url) => url === "https://studio.youtube.com/",
    validateWebSocket: (url, port) => { if (!url.startsWith(`ws://127.0.0.1:${port}/`)) throw new Error("invalid"); },
    count: () => requests,
  };
}

class MockSocket {
  constructor() {
    this.handlers = new Map();
    queueMicrotask(() => this.emit("open", {}));
  }
  addEventListener(name, fn) { this.handlers.set(name, fn); }
  emit(name, payload) { this.handlers.get(name)?.(payload); }
  send(raw) {
    const command = JSON.parse(raw);
    setTimeout(() => this.emit("message", { data: JSON.stringify({ id: command.id, result: {} }) }), latency);
  }
  close() { this.emit("close", {}); }
}
const domains = ["Page.enable", "Runtime.enable", "DOM.enable", "Network.enable"];
async function sessionHandshake(parallel) {
  const client = new CdpClient("ws://127.0.0.1:43117/devtools/page/one", 43117, { WebSocketClass: MockSocket });
  try {
    await client.connect();
    if (parallel) await Promise.all(domains.map((method) => client.send(method)));
    else for (const method of domains) await client.send(method);
  } finally { client.close(); }
}

class StudioSocket extends MockSocket {
  constructor() {
    super();
    this.href = "https://studio.youtube.com/";
  }
  send(raw) {
    const command = JSON.parse(raw);
    if (command.method === "Page.navigate") this.href = command.params.url;
    const result = command.method === "Runtime.evaluate"
      ? { result: { value: { ready: "complete", href: this.href } } } : {};
    setTimeout(() => this.emit("message", { data: JSON.stringify({ id: command.id, result }) }),
      command.method === "Page.navigate" ? navigationDelay : latency);
  }
}
const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-easy-bench-"));
const browser = new YouTubeBrowser({ stateDir: sessionDir, WebSocketClass: StudioSocket });
browser.start = async () => 43117;
browser.listTargets = async () => [{ type: "page", url: "https://studio.youtube.com/",
  webSocketDebuggerUrl: "ws://127.0.0.1:43117/devtools/page/fixture" }];
async function studioSameUrl(reuseFreshPage) {
  const client = await browser.page();
  try {
    if (!reuseFreshPage) client.initialNavigationUrl = null;
    const adapter = new StudioAdapter({ client, browser });
    await adapter.goto("https://studio.youtube.com/");
  } finally { client.close(); }
}

async function measure(label, fn) {
  const values = [];
  const cpu = [];
  const rssDelta = [];
  for (let i = 0; i < samples; i++) {
    const startedCpu = process.cpuUsage();
    const startedRss = process.memoryUsage().rss;
    const begin = performance.now();
    await fn();
    values.push(performance.now() - begin);
    const used = process.cpuUsage(startedCpu);
    cpu.push((used.user + used.system) / 1000);
    rssDelta.push((process.memoryUsage().rss - startedRss) / 1024);
  }
  return { label, ...percentiles(values), cpu_p50_ms: percentiles(cpu).p50_ms,
    rss_delta_p50_kib: percentiles(rssDelta).p50_ms };
}

const measureDiscovery = (fn, count) => measure(`${fn.name} (${count} ports)`, async () => {
  const fixture = discoveryFixture(count);
  if (await fn(fixture) !== fixture.chosen) throw new Error("Discovery changed browser selection");
  if (fixture.count() !== count * 2) throw new Error(`Discovery request count changed: ${fixture.count()}`);
});
const results = [];
for (const count of [1, 4, 8, 32]) {
  results.push(await measureDiscovery(serialDiscovery, count),
    await measureDiscovery(discoverAlreadyOpenSocialBrowser, count));
}
results.push(await measure("CDP handshake sequential", () => sessionHandshake(false)),
  await measure("CDP handshake pipelined", () => sessionHandshake(true)));
results.push(await measure("Studio same-URL forced reload", () => studioSameUrl(false)),
  await measure("Studio same-URL verified reuse", () => studioSameUrl(true)));
console.log(JSON.stringify({ samples, mockPerRequestDelayMs: latency,
  mockNavigationDelayMs: navigationDelay, candidatePortCounts: [1, 4, 8, 32], results }, null, 2));
