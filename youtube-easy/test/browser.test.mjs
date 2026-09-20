import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  browserCandidates,
  selectReusableTarget,
  YouTubeBrowser,
  CdpClient,
} from "../src/browser.js";

test("browser detection covers Helium, Chrome, Edge, and Chromium on supported platforms", () => {
  const winEnv = {
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\A\\AppData\\Local",
  };
  const win = browserCandidates("win32", winEnv, () => true).join("\n");
  assert.match(win, /imput\\Helium\\Application\\chrome\.exe/);
  assert.match(win, /Google\\Chrome\\Application\\chrome\.exe/);
  assert.match(win, /Microsoft\\Edge\\Application\\msedge\.exe/);

  const mac = browserCandidates("darwin", {}, () => true).join("\n");
  assert.match(mac, /Helium\.app/);
  assert.match(mac, /Google Chrome\.app/);
  assert.match(mac, /Microsoft Edge\.app/);
  assert.match(mac, /Chromium\.app/);

  const linux = browserCandidates("linux", {}, () => true).join("\n");
  assert.match(linux, /\/usr\/bin\/helium/);
  assert.match(linux, /google-chrome/);
  assert.match(linux, /chromium/);
  assert.match(linux, /microsoft-edge/);
});

test("browser detection returns only existing unique files", () => {
  const seen = [];
  const found = browserCandidates("linux", {}, (candidate) => {
    seen.push(candidate);
    return candidate === "/usr/bin/chromium";
  });
  assert.deepEqual(found, ["/usr/bin/chromium"]);
  assert.ok(seen.length > 1);
});

test("reusable targets must be approved HTTPS pages with exact-port loopback CDP", () => {
  const targets = [
    { type: "page", url: "https://studio.youtube.com.evil.test/", webSocketDebuggerUrl: "ws://127.0.0.1:43117/devtools/page/evil" },
    { type: "page", url: "https://studio.youtube.com/", webSocketDebuggerUrl: "ws://192.168.1.2:43117/devtools/page/lan" },
    { type: "service_worker", url: "https://studio.youtube.com/", webSocketDebuggerUrl: "ws://127.0.0.1:43117/devtools/page/worker" },
    { type: "page", url: "https://accounts.google.com/signin", webSocketDebuggerUrl: "ws://127.0.0.1:43117/devtools/page/good" },
  ];
  assert.equal(selectReusableTarget(targets, 43117).url, "https://accounts.google.com/signin");
  assert.equal(selectReusableTarget(targets, 9222), null);
});

test("an approved reusable tab is still navigated to the tool's requested page", async () => {
  let current = "https://www.youtube.com/watch?v=abc123xyz89";
  const commands = [];
  class FakeWebSocket {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    emit(name, event) { this.listeners.get(name)?.(event); }
    send(raw) {
      const message = JSON.parse(raw);
      commands.push(message);
      if (message.method === "Page.navigate") current = message.params.url;
      const value = message.method === "Runtime.evaluate"
        ? message.params.expression.includes("ready:") ? { ready: "complete", href: current } : current
        : undefined;
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: message.id, result: value === undefined ? {} : { result: { value } } }) }));
    }
    close() { this.emit("close", {}); }
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-easy-reuse-"));
  const browser = new YouTubeBrowser({ stateDir: root, WebSocketClass: FakeWebSocket });
  browser.start = async () => 43117;
  browser.listTargets = async () => [{ type: "page", url: current, webSocketDebuggerUrl: "ws://127.0.0.1:43117/devtools/page/one" }];
  const client = await browser.page("https://studio.youtube.com/");
  client.close();
  assert.equal(current, "https://studio.youtube.com/");
  assert.equal(commands.filter((item) => item.method === "Page.navigate").length, 1);
});

test("dedicated browser launch binds loopback, uses an ephemeral port, and isolates the profile", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-easy-browser-"));
  const executable = path.join(root, "chromium.exe");
  fs.writeFileSync(executable, "fake");
  const calls = [];
  const fakeSpawn = (exe, args, options) => {
    calls.push({ exe, args, options });
    const profileArg = args.find((arg) => arg.startsWith("--user-data-dir="));
    const profile = profileArg.slice("--user-data-dir=".length);
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, "DevToolsActivePort"), "43117\n/devtools/browser/test\n");
    return { unref() {} };
  };
  const fakeFetch = async (url) => {
    if (String(url).endsWith("/json/version")) {
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:43117/devtools/browser/test" }) };
    }
    throw new Error(`unexpected ${url}`);
  };
  const browser = new YouTubeBrowser({
    stateDir: root,
    platform: "linux",
    env: {},
    fsApi: fs,
    spawnFn: fakeSpawn,
    fetchFn: fakeFetch,
    candidateProvider: () => [executable],
    sleepFn: async () => {},
  });

  assert.equal(await browser.start(), 43117);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, executable);
  assert.ok(calls[0].args.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(calls[0].args.includes("--remote-debugging-port=0"));
  assert.ok(calls[0].args.includes(`--user-data-dir=${path.join(root, "browser-profile")}`));
  assert.equal(calls[0].options.detached, true);
});

test("CDP file assignment resolves one input and sends only the supplied local path", async () => {
  const sent = [];
  const client = Object.create(CdpClient.prototype);
  client.send = async (method, params) => {
    sent.push({ method, params });
    if (method === "Runtime.evaluate") return { result: { objectId: "input-1" } };
    if (method === "DOM.setFileInputFiles") return {};
    throw new Error(`unexpected ${method}`);
  };

  await client.setFileInputFiles("input[type=file]", ["C:\\media\\clip.mp4"]);
  assert.deepEqual(sent.map((item) => item.method), ["Runtime.evaluate", "DOM.setFileInputFiles"]);
  assert.equal(sent[1].params.objectId, "input-1");
  assert.deepEqual(sent[1].params.files, ["C:\\media\\clip.mp4"]);
});

test("CDP file assignment fails closed when the selector is absent or ambiguous", async () => {
  const client = Object.create(CdpClient.prototype);
  client.send = async () => ({ result: { value: { count: 2 } } });
  await assert.rejects(() => client.setFileInputFiles("input[type=file]", ["clip.mp4"]), /exactly one/);
});

test("CDP refuses malformed generated browser scripts before sending them", async () => {
  let sends = 0;
  const client = Object.create(CdpClient.prototype);
  client.send = async () => { sends++; return {}; };
  await assert.rejects(() => client.evaluate("(() => { const broken = ; })()"), /invalid browser script/i);
  assert.equal(sends, 0);
});
