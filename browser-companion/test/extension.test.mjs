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
