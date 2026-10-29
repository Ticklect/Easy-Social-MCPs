import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

test("extension detaches debugging when a social tab navigates away", async () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),
    "../extension/background.js"), "utf8");
  const listeners = {};
  const attached = [];
  const detached = [];
  let currentUrl = "https://www.reddit.com/";
  const existingTabs = [{ id: 13, url: "https://x.com/home", active: true },
    { id: 31, url: currentUrl, active: false },
    { id: 45, url: "https://private.example/", active: true }];
  const chrome = {
    tabs: {
      get: async (id) => ({ id, url: currentUrl }),
      query: async () => existingTabs,
      onRemoved: { addListener(fn) { listeners.removed = fn; } },
      onUpdated: { addListener(fn) { listeners.updated = fn; } },
    },
    debugger: {
      attach: async ({ tabId }) => { attached.push(tabId); },
      detach: async ({ tabId }) => { detached.push(tabId); },
      sendCommand: async () => ({ result: "ok" }),
      onEvent: { addListener(fn) { listeners.event = fn; } },
      onDetach: { addListener(fn) { listeners.detach = fn; } },
    },
    storage: { local: { get: async () => ({}) } },
    runtime: {
      onMessage: { addListener() {} }, onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const sandbox = vm.createContext({ chrome, URL, WebSocket: { OPEN: 1, CONNECTING: 0 },
    setInterval, clearInterval, setTimeout });
  vm.runInContext(source, sandbox);
  const discovered = await vm.runInContext('dispatch({type:"list"})', sandbox);
  assert.deepEqual(Array.from(discovered, (tab) => ({ id: tab.id, active: tab.active })),
    [{ id: 13, active: true }, { id: 31, active: false }]);
  assert.deepEqual(attached, [], "Listing already-open social tabs cannot attach a debugger");
  const command = 'dispatch({type:"command",tabId:31,method:"Runtime.evaluate",params:{expression:"location.href"}})';
  await vm.runInContext(command, sandbox);
  assert.deepEqual(attached, [31]);
  assert.equal(vm.runInContext("watched.size", sandbox), 1);
  currentUrl = "https://www.evil.example/";
  listeners.updated(31, { url: currentUrl });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(detached, [31]);
  assert.equal(vm.runInContext("watched.size", sandbox), 0);
  await assert.rejects(vm.runInContext(command, sandbox), /outside the approved social websites/);

  currentUrl = "https://www.tiktok.com/";
  await vm.runInContext(command, sandbox);
  assert.equal(vm.runInContext("watched.size", sandbox), 1);
  listeners.event({ tabId: 31 }, "Page.frameNavigated",
    { frame: { url: "https://elsewhere.example/" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(detached, [31, 31], "Top-frame redirect also revokes debugger access");
});

function commandHarness(attach) {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),
    "../extension/background.js"), "utf8");
  const listeners = {};
  const detached = [];
  const commands = [];
  let currentUrl = "https://www.reddit.com/";
  const chrome = {
    tabs: {
      get: async (id) => ({ id, url: currentUrl }),
      onRemoved: { addListener(fn) { listeners.removed = fn; } },
      onUpdated: { addListener(fn) { listeners.updated = fn; } },
    },
    debugger: {
      attach,
      detach: async ({ tabId }) => { detached.push(tabId); },
      sendCommand: async (_target, method) => { commands.push(method); return { result: "ok" }; },
      onEvent: { addListener(fn) { listeners.event = fn; } },
      onDetach: { addListener(fn) { listeners.detach = fn; } },
    },
    storage: { local: { get: async () => ({}) } },
    runtime: {
      onMessage: { addListener() {} }, onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const sandbox = vm.createContext({ chrome, URL, WebSocket: { OPEN: 1, CONNECTING: 0 },
    setInterval, clearInterval, setTimeout });
  vm.runInContext(source, sandbox);
  const command = () => vm.runInContext(
    'dispatch({type:"command",tabId:31,method:"Runtime.evaluate",params:{expression:"1"}})', sandbox);
  return { sandbox, listeners, command, detached, commands,
    setUrl(url) { currentUrl = url; } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("concurrent first commands share one debugger attachment and both finish", async () => {
  const gate = deferred();
  let attachCalls = 0;
  const h = commandHarness(async () => { attachCalls++; await gate.promise; });
  const a = h.command();
  const b = h.command();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attachCalls, 1, "Chrome cannot reliably attach twice to one tab");
  gate.resolve();
  assert.equal((await a).result, "ok");
  assert.equal((await b).result, "ok");
  assert.equal(h.commands.length, 2);
  assert.equal(vm.runInContext("attaching.size", h.sandbox), 0);
  assert.equal(vm.runInContext("watched.size", h.sandbox), 1);
});

test("navigation during an in-flight attach revokes the debugger before commands run", async () => {
  const gate = deferred();
  let attachCalls = 0;
  const h = commandHarness(async () => { attachCalls++; await gate.promise; });
  const a = h.command();
  const b = h.command();
  await new Promise((resolve) => setImmediate(resolve));
  h.setUrl("https://blocked.example/");
  h.listeners.updated(31, { url: "https://blocked.example/" });
  // Even a quick redirect back to an approved URL cannot rescue an invalidated attach.
  h.setUrl("https://www.reddit.com/");
  gate.resolve();
  await assert.rejects(a, /Tab left the approved social websites/);
  await assert.rejects(b, /Tab left the approved social websites/);
  assert.equal(attachCalls, 1);
  assert.deepEqual(h.detached, [31]);
  assert.equal(h.commands.length, 0);
  assert.equal(vm.runInContext("attaching.size + watched.size", h.sandbox), 0);
});

test("failed attach clears its slot, and closing a tab during attachment detaches it", async () => {
  let attempts = 0;
  const gate = deferred();
  const h = commandHarness(() => {
    attempts++;
    if (attempts === 1) throw new Error("Mock debugger unavailable");
    if (attempts === 2) return gate.promise;
    return Promise.resolve();
  });
  await assert.rejects(h.command(), /Mock debugger unavailable/);
  assert.equal(vm.runInContext("attaching.size", h.sandbox), 0);
  const pending = h.command();
  await new Promise((resolve) => setImmediate(resolve));
  h.listeners.removed(31);
  gate.resolve();
  await assert.rejects(pending, /Tab left the approved social websites/);
  assert.deepEqual(h.detached, [31]);
  assert.equal(vm.runInContext("attaching.size + watched.size", h.sandbox), 0);
  assert.equal((await h.command()).result, "ok", "A later valid tab may attach normally");
  assert.equal(attempts, 3);
});

test("disconnect while Chrome is attaching cannot leave a debugger running", async () => {
  const gate = deferred();
  let attempts = 0;
  const h = commandHarness(async () => { if (++attempts === 1) await gate.promise; });
  const pending = h.command();
  await new Promise((resolve) => setImmediate(resolve));
  const disconnecting = vm.runInContext("disconnect()", h.sandbox);
  await disconnecting; // Native attach is still pending; disconnect must not wait for it.
  const stale = h.command();
  gate.resolve();
  await assert.rejects(pending, /Tab left the approved social websites/);
  await assert.rejects(stale, /Tab left the approved social websites/);
  assert.deepEqual(h.detached, [31]);
  assert.equal(h.commands.length, 0);
  assert.equal(vm.runInContext("attaching.size + watched.size", h.sandbox), 0);
  assert.equal((await h.command()).result, "ok", "Reconnection may attach a fresh browser debugger");
  assert.equal(attempts, 2);
});

test("unexpected debugger detach during attach emits only one invalidation", async () => {
  const gate = deferred();
  const h = commandHarness(async () => gate.promise);
  const messages = [];
  h.sandbox.sent = messages;
  vm.runInContext("connection = { readyState: WebSocket.OPEN, send: (raw) => sent.push(JSON.parse(raw)) }", h.sandbox);
  const pending = h.command();
  await new Promise((resolve) => setImmediate(resolve));
  h.listeners.detach({ tabId: 31 });
  h.listeners.updated(31, { url: "https://blocked.example/" });
  gate.resolve();
  await assert.rejects(pending, /Tab left the approved social websites/);
  assert.equal(messages.filter(({ type }) => type === "invalidated").length, 1);
  assert.deepEqual(h.detached, [31]);
});
