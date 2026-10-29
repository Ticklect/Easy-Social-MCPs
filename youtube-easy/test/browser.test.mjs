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
import { StudioAdapter } from "../src/studio.js";

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

test("a freshly verified Studio page skips only its first redundant same-URL reload", async () => {
  let current = "https://studio.youtube.com/";
  const commands = [];
  class Socket {
    constructor() { this.handlers = new Map(); queueMicrotask(() => this.emit("open")); }
    addEventListener(event, handler) { this.handlers.set(event, handler); }
    emit(event, data = {}) { this.handlers.get(event)?.(data); }
    send(raw) {
      const request = JSON.parse(raw);
      commands.push(request.method);
      if (request.method === "Page.navigate") current = request.params.url;
      const result = request.method === "Runtime.evaluate"
        ? { result: { value: { ready: "complete", href: current } } } : {};
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: request.id, result }) }));
    }
    close() { this.emit("close"); }
  }
  const browser = new YouTubeBrowser({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "youtube-easy-duplicate-nav-")),
    WebSocketClass: Socket,
  });
  browser.start = async () => 43117;
  browser.listTargets = async () => [{ type: "page", url: current,
    webSocketDebuggerUrl: "ws://127.0.0.1:43117/devtools/page/one" }];
  const client = await browser.page();
  const studio = new StudioAdapter({ client, browser });
  assert.equal(await studio.goto("https://studio.youtube.com/"), "https://studio.youtube.com/");
  assert.equal(commands.filter((name) => name === "Page.navigate").length, 1);
  await studio.goto("https://studio.youtube.com/");
  assert.equal(commands.filter((name) => name === "Page.navigate").length, 2,
    "a later explicit reload must still navigate");
  client.close();
});

test("the first Studio goto reloads when the page changed after browser setup", async () => {
  let current = "https://studio.youtube.com/";
  const navigations = [];
  class Socket {
    constructor() { this.handlers = new Map(); queueMicrotask(() => this.emit("open")); }
    addEventListener(event, handler) { this.handlers.set(event, handler); }
    emit(event, data = {}) { this.handlers.get(event)?.(data); }
    send(raw) {
      const request = JSON.parse(raw);
      if (request.method === "Page.navigate") { current = request.params.url; navigations.push(current); }
      const result = request.method === "Runtime.evaluate"
        ? { result: { value: { ready: "complete", href: current } } } : {};
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: request.id, result }) }));
    }
    close() { this.emit("close"); }
  }
  const browser = new YouTubeBrowser({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "youtube-easy-changed-nav-")),
    WebSocketClass: Socket,
  });
  browser.start = async () => 43117;
  browser.listTargets = async () => [{ type: "page", url: current,
    webSocketDebuggerUrl: "ws://127.0.0.1:43117/devtools/page/one" }];
  const client = await browser.page();
  current = "https://www.youtube.com/feed/subscriptions";
  const studio = new StudioAdapter({ client, browser });
  assert.equal(await studio.goto("https://studio.youtube.com/"), "https://studio.youtube.com/");
  assert.equal(navigations.length, 2, "unexpected live tab navigation must be repaired");
  client.close();
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
    env: { EASY_SOCIAL_BROWSER_MODE: "dedicated" },
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

test("external browser uses its own YouTube tab and preserves preexisting signed-in tabs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-easy-external-tab-"));
  const calls = [];
  class FakeWebSocket {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.listeners.get("open")?.({}));
    }
    addEventListener(event, listener) { this.listeners.set(event, listener); }
    send(raw) {
      const req = JSON.parse(raw);
      calls.push(req);
      const result = req.method === "Runtime.evaluate"
        ? { result: { value: { ready: "complete", href: "https://studio.youtube.com/" } } } : {};
      queueMicrotask(() => this.listeners.get("message")?.({ data: JSON.stringify({ id: req.id, result }) }));
    }
    close() { this.listeners.get("close")?.({}); }
  }
  const browser = new YouTubeBrowser({
    stateDir: root,
    env: { EASY_SOCIAL_BROWSER_DEBUG_PORT: "43117" },
    WebSocketClass: FakeWebSocket,
  });
  browser.start = async () => { browser.usingExternalBrowser = true; return 43117; };
  const personal = { id: "personal", type: "page", url: "https://www.youtube.com/feed/subscriptions",
    webSocketDebuggerUrl: "ws://127.0.0.1:43117/devtools/page/personal" };
  const owned = { id: "owned", type: "page", url: "https://studio.youtube.com/",
    webSocketDebuggerUrl: "ws://127.0.0.1:43117/devtools/page/owned" };
  let created = 0;
  browser.listTargets = async () => created ? [personal, owned] : [personal];
  browser.createPage = async () => { created++; return owned; };
  const first = await browser.page();
  first.close();
  const second = await browser.page();
  second.close();
  assert.equal(created, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(browser.externalTabFile, "utf8")), { port: 43117, id: "owned" });
  assert.equal(calls.filter((call) => call.method === "Page.navigate").length, 2);
});

test("existing-browser mode connects to the configured debugger without spawning a profile", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-easy-existing-"));
  const seen = [];
  const browser = new YouTubeBrowser({
    stateDir: root, env: { EASY_SOCIAL_BROWSER_DEBUG_PORT: "43117" },
    fetchFn: async (url) => {
      seen.push(url);
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:43117/devtools/browser/current" }) };
    },
    spawnFn: () => { throw new Error("Existing-browser mode must never spawn"); },
    candidateProvider: () => { throw new Error("No executable discovery should be needed"); },
  });
  assert.equal(await browser.start(), 43117);
  assert.deepEqual(seen, ["http://127.0.0.1:43117/json/version"]);
  assert.equal(await browser.closeDedicatedBrowser(), false);
});

test("existing-browser-only mode refuses to launch a separate profile when the companion is absent", async () => {
  const browser = new YouTubeBrowser({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "youtube-easy-no-companion-")),
    env: { EASY_SOCIAL_BROWSER_MODE: "existing" },
    fetchFn: async () => { throw new Error("Connection refused"); },
    spawnFn: () => { throw new Error("Must not spawn"); },
    candidateProvider: () => { throw new Error("Must not discover browsers"); },
  });
  await assert.rejects(() => browser.start(), /could not access your current signed-in browser/);
});

test("default mode refuses a separate browser profile unless explicitly requested", async () => {
  let spawned = false;
  const browser = new YouTubeBrowser({
    stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "youtube-easy-default-existing-")),
    platform: "linux", env: { XDG_DATA_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "youtube-easy-no-bridge-")) },
    fetchFn: async () => { throw new Error("No browser debugger"); },
    debugPortProvider: () => [],
    spawnFn: () => { spawned = true; throw new Error("Unexpected separate profile"); },
  });
  await assert.rejects(browser.start(), /could not access your current signed-in browser/);
  assert.equal(spawned, false);
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

test("CDP commands time out and clear their pending receipt when a live debugger never answers", async () => {
  let opened;
  class SilentWebSocket {
    constructor() { this.listeners = new Map(); opened = this; queueMicrotask(() => this.emit("open")); }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    emit(name, event = {}) { this.listeners.get(name)?.(event); }
    send() { /* Keep the socket live but do not answer. */ }
    close() { this.emit("close"); }
  }
  const client = new CdpClient("ws://127.0.0.1:43117/devtools/page/one", 43117,
    { WebSocketClass: SilentWebSocket, commandTimeoutMs: 20 });
  await client.connect();
  await assert.rejects(client.send("Runtime.evaluate"), /command timed out: Runtime\.evaluate/);
  assert.equal(client.pending.size, 0);
  // An old late reply cannot resolve an unrelated next command.
  opened.emit("message", { data: JSON.stringify({ id: 1, result: { result: { value: "late" } } }) });
  assert.equal(client.pending.size, 0);
  client.close();
});

test("closing a CDP connection rejects outstanding requests promptly and prevents more commands", async () => {
  class SilentWebSocket {
    constructor() { this.listeners = new Map(); queueMicrotask(() => this.listeners.get("open")?.({})); }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    send() {}
    close() { this.listeners.get("close")?.({}); }
  }
  const client = new CdpClient("ws://127.0.0.1:43117/devtools/page/one", 43117,
    { WebSocketClass: SilentWebSocket, commandTimeoutMs: 5_000 });
  await client.connect();
  const unresolved = client.send("Page.navigate");
  client.close();
  await assert.rejects(unresolved, /connection closed/);
  assert.equal(client.pending.size, 0);
  assert.throws(() => client.send("Page.navigate"), /not connected/);
});

test("YouTube tab setup closes the debugger when an enable command fails", async () => {
  let closed = 0;
  class FailedWebSocket {
    constructor() { this.listeners = new Map(); queueMicrotask(() => this.emit("open")); }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    emit(name, event = {}) { this.listeners.get(name)?.(event); }
    send(raw) {
      const { id, method } = JSON.parse(raw);
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id,
        ...(method === "Page.enable" ? { error: { message: "CDP session denied" } } : { result: {} }) }) }));
    }
    close() { closed++; this.emit("close"); }
  }
  const browser = new YouTubeBrowser({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "youtube-easy-enable-")), WebSocketClass: FailedWebSocket });
  browser.start = async () => 43117;
  browser.listTargets = async () => [{ id: "one", type: "page", url: "https://studio.youtube.com/", webSocketDebuggerUrl: "ws://127.0.0.1:43117/devtools/page/one" }];
  await assert.rejects(browser.page(), /CDP session denied/);
  assert.equal(closed, 1);
});

test("a late close and response from an old debugger socket do not break a new connection", async () => {
  const sockets = [];
  class ManualSocket {
    constructor() { this.handlers = new Map(); sockets.push(this); queueMicrotask(() => this.emit("open")); }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    emit(name, payload = {}) { this.handlers.get(name)?.(payload); }
    send(raw) { this.last = JSON.parse(raw); }
    close() { /* A real socket's close event may be delayed. */ }
  }
  const client = new CdpClient("ws://127.0.0.1:43117/devtools/page/one", 43117,
    { WebSocketClass: ManualSocket, commandTimeoutMs: 200 });
  await client.connect();
  const oldPending = client.send("Runtime.evaluate");
  client.close();
  await assert.rejects(oldPending, /connection closed/);
  await client.connect();
  const current = client.send("Runtime.evaluate");
  sockets[0].emit("message", { data: JSON.stringify({ id: sockets[1].last.id, result: { result: { value: "wrong-socket" } } }) });
  sockets[0].emit("close");
  assert.equal(client.ws, sockets[1]);
  sockets[1].emit("message", { data: JSON.stringify({ id: sockets[1].last.id, result: { result: { value: "current" } } }) });
  assert.deepEqual(await current, { result: { value: "current" } });
  client.close();
});

test("concurrent debugger opens are rejected and closing during handshake prevents a zombie reconnect", async () => {
  const sockets = [];
  class ManualSocket {
    constructor() { this.handlers = new Map(); sockets.push(this); }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    emit(name, payload = {}) { this.handlers.get(name)?.(payload); }
    close() { this.emit("close"); }
  }
  const client = new CdpClient("ws://127.0.0.1:43117/devtools/page/one", 43117, { WebSocketClass: ManualSocket });
  const first = client.connect();
  await assert.rejects(client.connect(), /already active or opening/);
  assert.equal(sockets.length, 1);
  client.close();
  await assert.rejects(first, /closed while opening/);
  sockets[0].emit("open");
  assert.equal(client.ws, null);
  const next = client.connect();
  sockets[1].emit("open");
  await next;
  assert.equal(client.ws, sockets[1]);
  client.close();
});

test("CDP domain setup sends independent enables together but navigates only after every acknowledgement", async () => {
  const issued = [];
  class OrderedSocket {
    constructor() { this.handlers = new Map(); queueMicrotask(() => this.emit("open")); }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    emit(name, payload = {}) { this.handlers.get(name)?.(payload); }
    send(raw) {
      const command = JSON.parse(raw);
      issued.push(command.method);
      const response = () => this.emit("message", { data: JSON.stringify({ id: command.id,
        result: command.method === "Runtime.evaluate" ? { result: { value: { ready: "complete", href: "https://studio.youtube.com/" } } } : {} }) });
      setTimeout(response, command.method === "DOM.enable" ? 20 : 0);
    }
    close() { this.emit("close"); }
  }
  const browser = new YouTubeBrowser({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "youtube-easy-batch-")), WebSocketClass: OrderedSocket });
  browser.start = async () => 43117;
  browser.listTargets = async () => [{ type: "page", url: "https://studio.youtube.com/", webSocketDebuggerUrl: "ws://127.0.0.1:43117/devtools/page/one" }];
  const client = await browser.page();
  client.close();
  assert.deepEqual(issued.slice(0, 4), ["Page.enable", "Runtime.enable", "DOM.enable", "Network.enable"]);
  assert.equal(issued[4], "Page.navigate", "all domain acknowledgements must precede navigation");
});
