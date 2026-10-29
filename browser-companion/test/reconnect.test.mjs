import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

test("a saved pairing reconnects after browser worker socket closes without user login", async () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),
    "../extension/background.js"), "utf8");
  const sockets = [];
  const listeners = {};
  const pairingCode = "a".repeat(64);
  const browserId = "b".repeat(32);
  const sent = [];
  const intervals = new Set();
  let nextInterval = 0;
  let finishCommand;
  const commandResult = new Promise((resolve) => { finishCommand = resolve; });
  let sentCommands = 0;
  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = FakeSocket.CONNECTING;
      this.listeners = {};
      sockets.push(this);
    }
    addEventListener(name, handler) {
      (this.listeners[name] ||= []).push(handler);
    }
    removeEventListener(name, handler) {
      this.listeners[name] = (this.listeners[name] || []).filter((fn) => fn !== handler);
    }
    send(data) {
      const item = JSON.parse(data);
      sent.push(item);
      (this.messages ||= []).push(item);
    }
    emitOpen() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
    close() {
      if (this.readyState === FakeSocket.CLOSED) return;
      this.readyState = FakeSocket.CLOSED;
      queueMicrotask(() => {
        this.onclose?.();
        for (const handler of this.listeners.close || []) handler();
      });
    }
  }
  const chrome = {
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async () => { sentCommands++; return commandResult; },
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
    },
    tabs: {
      get: async (id) => ({ id, url: "https://www.reddit.com/" }),
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    storage: { local: {
      get: async () => ({ pairingCode, browserId }),
      set: async () => { throw new Error("Saved browser ID should not change."); },
    } },
    runtime: {
      onMessage: { addListener(fn) { listeners.message = fn; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    alarms: { create() {}, onAlarm: { addListener(fn) { listeners.alarm = fn; } } },
  };
  const sandbox = vm.createContext({
    chrome, URL, WebSocket: FakeSocket, navigator: { userAgent: "Mozilla/5.0 Chrome/155.0" },
    setInterval: () => { const id = ++nextInterval; intervals.add(id); return id; },
    clearInterval: (id) => intervals.delete(id), setTimeout, clearTimeout, crypto: {},
  });
  vm.runInContext(source, sandbox);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 1, "Saved pairing is used at extension startup");
  assert.match(sockets[0].url, new RegExp(`key=${pairingCode}&browserId=${browserId}`));
  sockets[0].emitOpen();
  assert.ok(sent.some((item) => item.type === "hello"));
  sockets[0].close();
  await new Promise((resolve) => setImmediate(resolve));
  listeners.alarm({ name: "connect" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 2, "Alarm reconnects without new pairing");
  assert.equal(sockets[1].url, sockets[0].url);
  sockets[1].emitOpen();
  assert.equal(intervals.size, 1, "Only the live socket keeps a heartbeat");
  sockets[1].onmessage({ data: JSON.stringify({ id: 77, type: "command", tabId: 31,
    method: "Runtime.evaluate", params: { expression: "1" } }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sentCommands, 1, "Test command is pending at Chrome's debugger API");
  const response = await new Promise((resolve) =>
    listeners.message({ type: "reconnect" }, {}, resolve));
  assert.equal(response.ok, true, "Popup supports an immediate manual retry");
  assert.equal(sockets.length, 3);
  sockets[2].emitOpen();
  finishCommand({ result: "late response" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets[2].messages.some((msg) => msg.id === 77), false,
    "An old command must not reply through the new WebSocket session");
  sockets[1].onmessage({ data: JSON.stringify({ id: 78, type: "command", tabId: 31,
    method: "Runtime.evaluate" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sentCommands, 1, "Closed WebSocket commands must not dispatch after reconnect");
  sockets[2].close();
});
