// Deterministic mock of the MV3 extension: no browser, remote site or network.
// Run `node --expose-gc scripts/bench-lifecycle.mjs` for memory measurements.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const source = fs.readFileSync(path.join(root, "extension/background.js"), "utf8");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const percentile = (sorted, fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];

export async function runLifecycle(cycles = 320) {
  assert.ok(Number.isInteger(cycles) && cycles >= 200, "Lifecycle benchmark needs 200+ cycles");
  global.gc?.();
  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const handlesBefore = process._getActiveHandles().length;
  const activeSockets = new Set();
  const activeIntervals = new Set();
  const activeTimeouts = new Set();
  const tabUrls = new Map();
  const attached = new Set();
  const listeners = {};
  const listenerCounts = new Map();
  const latency = [];
  const samples = [];
  const pairingCode = "a".repeat(64);
  const browserId = "b".repeat(32);
  let pairing = pairingCode;
  let nextTimer = 0;
  let createdSockets = 0;
  let attachCalls = 0;
  let detachCalls = 0;
  let maxIntervals = 0;
  let maxPending = 0;
  let outstandingRequests = 0;
  let gate = null;
  let latestSocket;

  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) {
      assert.match(url, /^ws:\/\/127\.0\.0\.1:19411\/extension\?/);
      this.readyState = MockWebSocket.CONNECTING;
      this.closeListeners = new Set();
      this.requests = new Set();
      latestSocket = this;
      createdSockets++;
      activeSockets.add(this);
    }
    addEventListener(type, callback) {
      assert.equal(type, "close");
      this.closeListeners.add(callback);
    }
    removeEventListener(type, callback) {
      assert.equal(type, "close");
      this.closeListeners.delete(callback);
    }
    emitOpen() {
      assert.equal(this.readyState, MockWebSocket.CONNECTING);
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }
    send(raw) {
      assert.equal(this.readyState, MockWebSocket.OPEN);
      const message = JSON.parse(raw);
      if (Number.isSafeInteger(message.id) && this.requests.delete(message.id)) outstandingRequests--;
    }
    async request(message) {
      assert.equal(this.readyState, MockWebSocket.OPEN);
      this.requests.add(message.id);
      outstandingRequests++;
      maxPending = Math.max(maxPending, outstandingRequests);
      await this.onmessage({ data: JSON.stringify(message) });
      assert.equal(this.requests.has(message.id), false, "Every live command receives its answer");
    }
    close() {
      if (this.readyState === MockWebSocket.CLOSED) return;
      this.readyState = MockWebSocket.CLOSED;
      outstandingRequests -= this.requests.size; // Local bridge drops requests on socket close.
      this.requests.clear();
      activeSockets.delete(this);
      queueMicrotask(() => {
        this.onclose?.();
        for (const callback of this.closeListeners) callback();
        this.closeListeners.clear();
      });
    }
  }
  function register(group, key) {
    return { addListener(callback) {
      assert.equal(listeners[key], undefined, `Duplicate Chrome listener: ${key}`);
      listeners[key] = callback;
      listenerCounts.set(group, (listenerCounts.get(group) || 0) + 1);
    } };
  }
  const chrome = {
    storage: { local: {
      async get() { return { pairingCode: pairing, browserId }; },
      async set({ pairingCode: code }) { if (code) pairing = code; },
      async remove(key) { assert.equal(key, "pairingCode"); pairing = undefined; },
    } },
    tabs: {
      async get(tabId) { return { id: tabId, url: tabUrls.get(tabId) }; },
      onRemoved: register("tabs", "removed"),
      onUpdated: register("tabs", "updated"),
    },
    debugger: {
      async attach({ tabId }) {
        attachCalls++;
        if (gate) await gate.promise;
        attached.add(tabId);
      },
      async detach({ tabId }) { detachCalls++; attached.delete(tabId); },
      async sendCommand() { return { result: "mock" }; },
      onEvent: register("debugger", "event"),
      onDetach: register("debugger", "detach"),
    },
    runtime: {
      onMessage: register("runtime", "message"),
      onInstalled: register("runtime", "installed"),
      onStartup: register("runtime", "startup"),
    },
    alarms: {
      create(name) { assert.equal(name, "connect"); },
      onAlarm: register("alarms", "alarm"),
    },
  };
  const context = vm.createContext({
    chrome, WebSocket: MockWebSocket, URL,
    navigator: { userAgent: "Chrome/155.0" },
    crypto: { randomUUID: () => "b".repeat(32) },
    setInterval: () => {
      const id = ++nextTimer;
      activeIntervals.add(id);
      maxIntervals = Math.max(maxIntervals, activeIntervals.size);
      return id;
    },
    clearInterval: (id) => activeIntervals.delete(id),
    setTimeout: () => { const id = ++nextTimer; activeTimeouts.add(id); return id; },
    clearTimeout: (id) => activeTimeouts.delete(id),
  });
  vm.runInContext(source, context);
  const state = vm.runInContext("() => ({ watched: watched.size, attaching: attaching.size })", context);
  const chromeListenersAtStart = [...listenerCounts.values()].reduce((a, b) => a + b, 0);
  assert.equal(chromeListenersAtStart, 8);
  await nextTurn();

  for (let cycle = 0; cycle < cycles; cycle++) {
    const began = performance.now();
    const socket = latestSocket;
    assert.ok(socket && activeSockets.has(socket), `Missing socket at cycle ${cycle}`);
    socket.emitOpen();
    assert.equal(activeIntervals.size, 1);
    const tabId = 2_000 + cycle;
    tabUrls.set(tabId, "https://www.reddit.com/");
    const message = { id: cycle + 1, type: "command", tabId,
      method: "Runtime.evaluate", params: { expression: "1" } };

    if (cycle % 4 === 3) {
      let release;
      gate = { promise: new Promise((resolve) => { release = resolve; }), release: () => release() };
      const pending = socket.request(message);
      await nextTurn();
      assert.equal(state().attaching, 1);
      listeners.removed(tabId);
      gate.release();
      gate = null;
      await pending;
    } else {
      await socket.request(message);
      assert.equal(state().watched, 1);
      if (cycle % 4 === 0) listeners.removed(tabId);
      if (cycle % 4 === 1) {
        tabUrls.set(tabId, "https://blocked.example/");
        listeners.updated(tabId, { url: "https://blocked.example/" });
      }
      if (cycle % 4 === 2) {
        listeners.event({ tabId }, "Page.frameNavigated", { frame: { url: "https://blocked.example/" } });
      }
    }
    await nextTurn();
    assert.equal(state().watched, 0);
    assert.equal(state().attaching, 0);
    assert.equal(attached.size, 0);
    tabUrls.delete(tabId);

    if (cycle % 7 === 0) {
      const reply = await new Promise((resolve) => listeners.message({ type: "disconnect" }, {}, resolve));
      assert.equal(reply.ok, true);
      const paired = await new Promise((resolve) =>
        listeners.message({ type: "pair", code: pairingCode }, {}, resolve));
      assert.equal(paired.ok, true);
    } else if (cycle % 5 === 0) {
      const reply = await new Promise((resolve) => listeners.message({ type: "reconnect" }, {}, resolve));
      assert.equal(reply.ok, true);
    } else {
      socket.close();
      await nextTurn();
      listeners.alarm({ name: "connect" });
    }
    await nextTurn();
    assert.equal(activeSockets.size, 1, `Socket retained after cycle ${cycle}`);
    assert.equal(outstandingRequests, 0, `Pending WebSocket requests after cycle ${cycle}`);
    assert.equal(activeIntervals.size, 0, `Heartbeat retained after cycle ${cycle}`);
    assert.equal(activeTimeouts.size, 0, `Timeout retained after cycle ${cycle}`);
    assert.equal([...listenerCounts.values()].reduce((a, b) => a + b, 0), chromeListenersAtStart);
    latency.push(performance.now() - began);
    if ((cycle + 1) % 50 === 0) {
      samples.push({ cycle: cycle + 1, memory: process.memoryUsage().heapUsed,
        handles: process._getActiveHandles().length, attached: attached.size,
        pending: outstandingRequests, intervals: activeIntervals.size });
    }
  }
  await vm.runInContext("disconnect()", context);
  await nextTurn();
  assert.equal(activeSockets.size, 0);
  assert.equal(activeIntervals.size, 0);
  assert.equal(activeTimeouts.size, 0);
  assert.equal(outstandingRequests, 0);
  assert.equal(state().watched, 0);
  assert.equal(state().attaching, 0);
  assert.equal(attached.size, 0);
  global.gc?.();
  const memoryAfter = process.memoryUsage();
  const cpu = process.cpuUsage(cpuBefore);
  const sorted = latency.sort((a, b) => a - b);
  return {
    cycles, createdSockets, attachCalls, detachCalls,
    p50Ms: Number(percentile(sorted, .5).toFixed(3)),
    p95Ms: Number(percentile(sorted, .95).toFixed(3)),
    cpuMs: Number(((cpu.user + cpu.system) / 1000).toFixed(2)),
    heapDeltaKiB: Math.round((memoryAfter.heapUsed - memoryBefore.heapUsed) / 1024),
    rssDeltaKiB: Math.round((memoryAfter.rss - memoryBefore.rss) / 1024),
    handlesBefore, handlesAfter: process._getActiveHandles().length,
    activeSockets: activeSockets.size, activeIntervals: activeIntervals.size,
    activeTimeouts: activeTimeouts.size, activeDebuggers: attached.size,
    pendingWebSocketRequests: outstandingRequests,
    pendingAttaches: state().attaching, watched: state().watched,
    chromeListeners: chromeListenersAtStart, maxIntervals, maxPending,
    samples,
    note: global.gc ? "GC forced before/after; heap delta still includes mock/test allocations." :
      "GC unavailable; heap delta includes uncollected mock/test allocations.",
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cycles = Number(process.env.BENCH_CYCLES || 320);
  console.log(JSON.stringify(await runLifecycle(cycles)));
}
