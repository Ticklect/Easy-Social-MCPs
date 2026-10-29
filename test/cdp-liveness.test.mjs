import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const variants = [
  { label: "Reddit", file: "src/index.js", domains: ["Page.enable", "Runtime.enable"] },
  { label: "X", file: "x-easy/src/index.js", domains: ["Page.enable", "Runtime.enable", "Network.enable"] },
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Execute the actual CdpClient code against an inert socket. Accelerate the
// 5s handshake and 30s command deadlines to milliseconds for deterministic
// failure checks. No real browser is opened and no network traffic occurs.
function fixture(file, { connection = "open", replies = "normal", throttle = false } = {}) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const start = source.indexOf("class CdpClient {");
  const end = source.indexOf("\nasync function listTargets(", start);
  assert.ok(start >= 0 && end > start, "CdpClient source was not found");
  const sockets = [];
  const timers = new Set();
  const injectedTimeout = (fn, timeout) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); },
      timeout === 5_000 ? 8 : timeout === 30_000 ? 10 : timeout);
    timers.add(timer);
    return timer;
  };
  const injectedClear = (timer) => { clearTimeout(timer); timers.delete(timer); };
  class FakeWebSocket {
    constructor() {
      this.listeners = new Map();
      this.sent = [];
      this.closed = false;
      sockets.push(this);
      if (connection === "late-open") setTimeout(() => this.emit("open", {}), 20);
      else if (connection === "early-close") setTimeout(() => this.close(), 1);
      else if (connection === "early-error") setTimeout(() => this.emit("error", {}), 1);
      else queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(name, callback) {
      const callbacks = this.listeners.get(name) || [];
      callbacks.push(callback);
      this.listeners.set(name, callbacks);
    }
    emit(name, value) {
      for (const callback of this.listeners.get(name) || []) callback(value);
    }
    send(message) {
      if (this.closed) throw new Error("Socket is closed");
      const command = JSON.parse(message);
      this.sent.push(command);
      if (replies === "throw") throw new Error("Socket send failed");
      if (replies === "silent") return;
      if (replies === "midflight-close") {
        setTimeout(() => this.close(), 1);
        return;
      }
      if (throttle) {
        setTimeout(() => this.emit("message", { data: JSON.stringify({
          method: "Network.responseReceived", params: { response: {
            status: 429, url: "https://x.com/i/api/graphql", headers: { "Retry-After": "60" },
          } },
        }) }), 1);
        return;
      }
      setTimeout(() => this.emit("message", { data: JSON.stringify({
        id: command.id, result: { result: { value: "ok" } },
      }) }), 1);
    }
    close() {
      this.closed = true;
      this.emit("close", {});
    }
  }
  const Client = new Function("WebSocket", "validateLocalDebuggerWs", "setTimeout", "clearTimeout",
    "CDP_COMMAND_TIMEOUT_MS", "parseXHttpsUrl", "noteHttpResponse", "appDir",
    `${source.slice(start, end)}\nreturn CdpClient;`)(
    FakeWebSocket, (value) => value, injectedTimeout, injectedClear, 30_000,
    (value) => new URL(value), () => true, "/inert-test-state",
  );
  return { Client, sockets, timers, create: () => new Client("ws://127.0.0.1:43111/devtools/page/test", 43111) };
}

for (const { label, file, domains } of variants) {
  test(`${label} completes five read invocations and frees each socket and deadline`, async () => {
    const mock = fixture(file);
    for (let i = 0; i < 5; i++) {
      const client = mock.create();
      await client.connect();
      await Promise.all(domains.map((domain) => client.send(domain)));
      for (let j = 0; j < 3; j++) await client.send("Runtime.evaluate", { expression: "location.href" });
      assert.equal(client.pending.size, 0);
      client.close();
    }
    assert.equal(mock.sockets.length, 5);
    assert.ok(mock.sockets.every((socket) => socket.closed));
    assert.equal(mock.timers.size, 0, "No pending command timers after repeated invocations");
  });

  test(`${label} command silence times out and rejects every pending command without retrying`, async () => {
    const mock = fixture(file, { replies: "silent" });
    const client = mock.create();
    await client.connect();
    const commands = [client.send("Runtime.evaluate"), client.send("Page.navigate")];
    const results = await Promise.allSettled(commands);
    assert.ok(results.every(({ status, reason }) => status === "rejected" && /timed out.*unknown/i.test(reason.message)));
    assert.equal(mock.sockets[0].sent.length, 2);
    assert.equal(client.pending.size, 0);
    assert.equal(mock.timers.size, 0);
    assert.ok(mock.sockets[0].closed);
    assert.throws(() => client.send("Runtime.evaluate"), /timed out.*unknown/i);
    // A delayed response must never resurrect this timed-out connection.
    mock.sockets[0].emit("message", { data: JSON.stringify({ id: 1, result: {} }) });
    assert.equal(client.pending.size, 0);
  });

  test(`${label} mid-flight disconnection rejects, prevents reuse and allows a fresh client`, async () => {
    const broken = fixture(file, { replies: "midflight-close" });
    const client = broken.create();
    await client.connect();
    await assert.rejects(client.send("Runtime.evaluate"), /connection closed/i);
    assert.equal(client.pending.size, 0);
    assert.equal(broken.timers.size, 0);
    assert.throws(() => client.send("Runtime.evaluate"), /connection closed/i);
    const healthy = fixture(file);
    const replacement = healthy.create();
    await replacement.connect();
    await replacement.send("Runtime.evaluate");
    replacement.close();
    assert.equal(healthy.timers.size, 0);
  });

  test(`${label} failed send cannot leave pending requests or silently retry`, async () => {
    const mock = fixture(file, { replies: "throw" });
    const client = mock.create();
    await client.connect();
    await assert.rejects(client.send("Runtime.evaluate"), /could not be sent/i);
    assert.equal(mock.sockets[0].sent.length, 1);
    assert.equal(client.pending.size, 0);
    assert.equal(mock.timers.size, 0);
    assert.ok(mock.sockets[0].closed);
    assert.throws(() => client.send("Runtime.evaluate"), /could not be sent/i);
  });

  for (const connection of ["late-open", "early-close", "early-error"]) {
    test(`${label} ${connection} cannot revive a rejected handshake`, async () => {
      const mock = fixture(file, { connection });
      const client = mock.create();
      await assert.rejects(client.connect(), connection === "early-close"
        ? /closed before connecting/i : /timed out|connection failed/i);
      await sleep(25);
      assert.equal(client.ws, null);
      assert.equal(client.connectingSocket, null);
      assert.ok(mock.sockets[0].closed);
      assert.equal(mock.timers.size, 0);
      assert.throws(() => client.send("Runtime.evaluate"), /timed out|closed before connecting|connection failed/i);
    });
  }
}

test("X network 429 cancels outstanding CDP requests while preserving the cooldown failure", async () => {
  const mock = fixture("x-easy/src/index.js", { throttle: true });
  const client = mock.create();
  await client.connect();
  await assert.rejects(client.send("Runtime.evaluate"), /X returned HTTP 429/);
  assert.equal(client.networkFailure?.code, "X_RATE_LIMITED");
  assert.equal(client.pending.size, 0);
  assert.equal(mock.timers.size, 0);
  assert.ok(mock.sockets[0].closed);
  assert.throws(() => client.send("Runtime.evaluate"), /X returned HTTP 429/);
});
