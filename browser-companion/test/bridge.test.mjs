import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { makeServer } from "../server.mjs";

const origin = `chrome-extension://${"a".repeat(32)}`;
const browserId = "b".repeat(32);
const dataFolder = () => fs.mkdtempSync(path.join(os.tmpdir(), "easy-social-companion-"));
const open = (socket) => new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
const next = (socket) => new Promise((resolve, reject) => {
  socket.once("message", (data) => resolve(JSON.parse(data.toString())));
  socket.once("error", reject);
});

test("paired companion reuses an existing browser, creates its own allowed tabs and forwards CDP", async () => {
  const directory = dataFolder();
  const bridge = makeServer({ port: 0, directory });
  const port = await bridge.start();
  const key = fs.readFileSync(bridge.keyPath, "utf8");
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${key}` };
  const session = new WebSocket(`ws://127.0.0.1:${port}/extension?key=${key}&browserId=${browserId}`, { origin });
  const owned = [{ id: 51, url: "https://www.reddit.com/", title: "Logged-in Reddit", active: true },
    { id: 53, url: "https://old.reddit.com/", title: "Earlier Reddit tab", active: false },
    { id: 54, url: "https://x.com/home", title: "Opened X before companion", active: false }];
  const other = [{ id: 99, url: "https://example.com/private", title: "Unrelated tab" }];
  const actions = [];
  session.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    actions.push(msg);
    if (msg.type === "list") session.send(JSON.stringify({ id: msg.id, result: [...owned, ...other] }));
    if (msg.type === "open") {
      const tab = { id: 52, url: msg.url, title: "X" };
      owned.push(tab);
      session.send(JSON.stringify({ id: msg.id, result: tab }));
    }
    if (msg.type === "command") {
      session.send(JSON.stringify({ id: msg.id, result: { result: { value: "logged-in" } } }));
      session.send(JSON.stringify({ type: "event", tabId: msg.tabId,
        method: "Network.responseReceived", params: { response: { status: 200 } } }));
    }
  });
  let pageSocket;
  try {
    await open(session);
    session.send(JSON.stringify({ type: "hello", browser: "Helium" }));
    assert.equal((await fetch(base + "/json/version")).status, 403);
    assert.equal((await fetch(base + "/json/version", { headers: { ...auth, Origin: "https://attacker.example" } })).status, 403);
    const version = await (await fetch(base + "/json/version", { headers: auth })).json();
    assert.equal(version.Browser, "EasySocialCompanion/v1");
    const pages = await (await fetch(base + "/json/list", { headers: auth })).json();
    assert.deepEqual(pages.map((page) => page.url), [
      "https://www.reddit.com/", "https://old.reddit.com/", "https://x.com/home"]);
    assert.equal(pages[0].loginStatus, "unchecked");
    assert.equal(pages[0].existing, true);
    assert.equal(pages[0].active, true);
    const filtered = await (await fetch(base + "/json/candidates?site=reddit", { headers: auth })).json();
    assert.deepEqual(filtered.map((page) => page.url),
      ["https://www.reddit.com/", "https://old.reddit.com/"]);
    assert.equal(actions.filter((action) => action.type === "command" || action.type === "open").length,
      0, "Discovering already-open tabs must never issue CDP commands or open new tabs");
    assert.equal((await fetch(base + "/json/candidates?site=unknown", { headers: auth })).status, 400);
    assert.equal((await fetch(base + "/json/new?https%3A%2F%2Fevil.example", { method: "PUT", headers: auth })).status, 400);
    const created = await (await fetch(base + "/json/new?https%3A%2F%2Fx.com%2Fhome", { method: "PUT", headers: auth })).json();
    assert.equal(created.url, "https://x.com/home");
    assert.equal(actions.filter((a) => a.type === "open").length, 1);
    const tiktok = await (await fetch(base + "/json/new?https%3A%2F%2Fwww.tiktok.com%2F", { method: "PUT", headers: auth })).json();
    assert.equal(tiktok.url, "https://www.tiktok.com/");

    pageSocket = new WebSocket(pages[0].webSocketDebuggerUrl);
    await open(pageSocket);
    const replies = [];
    pageSocket.on("message", (raw) => replies.push(JSON.parse(raw.toString())));
    pageSocket.send(JSON.stringify({ id: 12, method: "Runtime.evaluate", params: { expression: "location.href" } }));
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { clearInterval(poll); reject(new Error("CDP did not reply")); }, 2000);
      const poll = setInterval(() => {
        if (replies.some((r) => r.id === 12) && replies.some((r) => r.method === "Network.responseReceived")) {
          clearTimeout(timeout); clearInterval(poll); resolve();
        }
      }, 10);
    });
    assert.equal(replies.find((r) => r.id === 12)?.result?.result?.value, "logged-in");
    assert.equal(actions.find((a) => a.type === "command").tabId, 51);
    assert.equal(other.length, 1);
    const malicious = new WebSocket(pages[0].webSocketDebuggerUrl, { origin: "https://evil.example" });
    await assert.rejects(open(malicious));
    const invalidated = new Promise((resolve) => pageSocket.once("close", resolve));
    session.send(JSON.stringify({ type: "invalidated", tabId: 51 }));
    const closeCode = await invalidated;
    assert.equal(closeCode, 1008, "Tab navigation to an unapproved site closes its CDP clients");
  } finally {
    pageSocket?.close();
    session.close();
    await bridge.stop();
  }
});

test("bridge refuses a missing browser and refuses to choose between two browser profiles", async () => {
  const directory = dataFolder();
  const bridge = makeServer({ port: 0, directory });
  const port = await bridge.start();
  const key = fs.readFileSync(bridge.keyPath, "utf8");
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${key}` };
  let first;
  let second;
  try {
    assert.equal((await fetch(base + "/json/version", { headers })).status, 503);
    first = new WebSocket(`ws://127.0.0.1:${port}/extension?key=${key}&browserId=${browserId}`, { origin });
    await open(first);
    second = new WebSocket(`ws://127.0.0.1:${port}/extension?key=${key}&browserId=${"c".repeat(32)}`, { origin });
    await open(second);
    assert.equal((await fetch(base + "/json/version", { headers })).status, 503);
  } finally {
    first?.close(); second?.close();
    await bridge.stop();
  }
  const nextBridge = makeServer({ port: 0, directory });
  await nextBridge.start();
  try {
    assert.equal(fs.readFileSync(nextBridge.keyPath, "utf8"), key, "pairing survives server restart");
  } finally { await nextBridge.stop(); }
});

test("paired browser can reconnect after its old live socket stops sending heartbeats", async () => {
  const bridge = makeServer({ port: 0, directory: dataFolder(), staleBrowserMs: 500 });
  const port = await bridge.start();
  const key = fs.readFileSync(bridge.keyPath, "utf8");
  const uri = `ws://127.0.0.1:${port}/extension?key=${key}&browserId=${browserId}`;
  const options = { origin };
  const headers = { Authorization: `Bearer ${key}` };
  const base = `http://127.0.0.1:${port}`;
  let original;
  let replacement;
  try {
    original = new WebSocket(uri, options);
    await open(original);
    const freshDuplicate = new WebSocket(uri, options);
    await assert.rejects(open(freshDuplicate), undefined,
      "Duplicate live browser sessions must remain rejected");
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal((await fetch(base + "/json/version", { headers })).status, 503,
      "An unresponsive old socket must not remain usable for browser operations");
    replacement = new WebSocket(uri, options);
    replacement.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "list") replacement.send(JSON.stringify({
        id: message.id, result: [{ id: 61, url: "https://www.reddit.com/", title: "Existing tab" }],
      }));
    });
    await open(replacement);
    const pages = await (await fetch(base + "/json/list", { headers })).json();
    assert.deepEqual(pages.map(({ url }) => url), ["https://www.reddit.com/"]);
    assert.equal(original.readyState !== WebSocket.OPEN, true,
      "Stale connection was revoked when the same browser reconnected");
  } finally {
    original?.terminate();
    replacement?.terminate();
    await bridge.stop();
  }
});
