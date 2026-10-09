import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = fs.readFileSync(path.join(root, "src", "index.js"), "utf8");

// Evaluate the actual browser expression shipped in the runtime, not a
// reimplementation of the matching algorithm.
const template = /const CONTROL_SCRIPT = (`[\s\S]*?`);/.exec(runtime)?.[1];
assert.ok(template, "CONTROL_SCRIPT must be present in the shipped source");
const controlSource = vm.runInNewContext(template);

function fakePost(id, selector, clicks, { targetLink = true, extraControl = false } = {}) {
  const article = {};
  const link = {
    getAttribute(name) { return name === "href" ? `/author/status/${id}` : null; },
    closest(name) { return name === "article" ? article : null; },
  };
  const control = {
    closest(name) { return name === "article" ? article : null; },
    click() { clicks.push(id); },
  };
  article.querySelectorAll = (query) => query === 'a[href*="/status/"]'
    ? targetLink ? [link] : []
    : query === selector ? extraControl ? [control, control] : [control] : [];
  return article;
}

function perform(posts, id, selector, press = true) {
  const document = { querySelectorAll(name) {
    assert.equal(name, 'article[data-testid="tweet"]');
    return posts;
  } };
  return vm.runInNewContext(`(${controlSource})(${JSON.stringify(id)}, ${JSON.stringify(selector)}, ${press})`, { document });
}

test("like, bookmark and repost clicks target only the exact requested post ID", () => {
  for (const selector of ['[data-testid="like"]', '[data-testid="bookmark"]', '[data-testid="retweet"]']) {
    const clicks = [];
    const posts = [fakePost("111", selector, clicks), fakePost("222", selector, clicks)];
    assert.equal(perform(posts, "222", selector), "ok");
    assert.deepEqual(clicks, ["222"], `Wrong target for ${selector}`);
  }
});

test("missing ID and absent matching status link cannot click the first visible post", () => {
  for (const selector of ['[data-testid="like"]', '[data-testid="bookmark"]', '[data-testid="retweet"]']) {
    const clicks = [];
    const posts = [fakePost("111", selector, clicks), fakePost("333", selector, clicks)];
    assert.equal(perform(posts, "222", selector), "no-post");
    assert.equal(perform([fakePost("222", selector, clicks, { targetLink: false })], "222", selector), "no-post");
    assert.deepEqual(clicks, []);
  }
});

test("duplicate post IDs or multiple owned controls are ambiguous and never clicked", () => {
  const selector = '[data-testid="like"]';
  const clicks = [];
  const duplicates = [fakePost("222", selector, clicks), fakePost("222", selector, clicks)];
  assert.equal(perform(duplicates, "222", selector), "ambiguous-post");
  assert.equal(perform([fakePost("222", selector, clicks, { extraControl: true })], "222", selector), "ambiguous-control");
  assert.deepEqual(clicks, []);
});

test("status links inside a quoted nested article do not make the surrounding post eligible", () => {
  const selector = '[data-testid="retweet"]';
  const clicks = [];
  const outer = fakePost("111", selector, clicks);
  const nestedArticle = {};
  const nestedLink = {
    getAttribute: () => "/author/status/222",
    closest: () => nestedArticle,
  };
  const original = outer.querySelectorAll;
  outer.querySelectorAll = (query) => query === 'a[href*="/status/"]'
    ? [...original(query), nestedLink] : original(query);
  assert.equal(perform([outer], "222", selector), "no-post");
  assert.deepEqual(clicks, []);
});

// Reconstruct the *actual* CdpClient class with an inert local test socket.
const classStart = runtime.indexOf("class CdpClient {");
const classEnd = runtime.indexOf("\nasync function listTargets(", classStart);
assert.ok(classStart >= 0 && classEnd > classStart);
const classSource = runtime.slice(classStart, classEnd);

class FakeWebSocket {
  static last;
  constructor() {
    this.listeners = new Map();
    this.commands = [];
    FakeWebSocket.last = this;
    queueMicrotask(() => this.emit("open", {}));
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  emit(type, message) { this.listeners.get(type)?.(message); }
  emitNetwork(status, url = "https://x.com/i/api/graphql") {
    this.emit("message", { data: JSON.stringify({
      method: "Network.responseReceived",
      params: { response: { status, url, headers: { "Retry-After": "60" } } },
    }) });
  }
  send(data) { this.commands.push(JSON.parse(data)); }
  close() { this.emit("close", {}); }
}

function fakeClient(noteHttpResponse) {
  const construct = new Function(
    "WebSocket", "validateLocalDebuggerWs", "parseXHttpsUrl", "noteHttpResponse", "appDir",
    `return (${classSource});`,
  );
  return new (construct(
    FakeWebSocket, (url) => url,
    (url) => {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !["x.com", "twitter.com"].includes(parsed.hostname)) {
        throw new Error("Not a first-party X response");
      }
      return parsed;
    },
    noteHttpResponse, "/test-inert-app-data",
  ))("ws://127.0.0.1:43111/devtools/page/one", 43111);
}

test("CDP 429 persistence failure rejects pending and future browser actions", async () => {
  const client = fakeClient(() => { throw new Error("EPERM saving cooldown"); });
  await client.connect();
  const socket = FakeWebSocket.last;
  const awaiting = client.send("Runtime.evaluate", { expression: "true" });
  socket.emitNetwork(429);
  await assert.rejects(awaiting, /cooldown could not be persisted.*EPERM/);
  assert.equal(client.networkFailure.code, "X_COOLDOWN_PERSISTENCE_FAILED");
  assert.throws(() => client.send("Page.navigate", { url: "https://x.com/home" }), /cooldown could not be persisted/);
  assert.equal(socket.commands.length, 1, "No subsequent CDP command may be transmitted");
  client.close();
});

test("CDP first-party 429 latches even when persisted successfully; unrelated responses do not", async () => {
  let observations = 0;
  const client = fakeClient(() => { observations++; return true; });
  await client.connect();
  const socket = FakeWebSocket.last;
  socket.emitNetwork(429, "https://unrelated.example/api");
  assert.equal(observations, 0);
  const waiting = client.send("Runtime.evaluate");
  socket.emitNetwork(429);
  await assert.rejects(waiting, /X returned HTTP 429/);
  assert.equal(observations, 1);
  assert.equal(client.networkFailure.code, "X_RATE_LIMITED");
  assert.throws(() => client.send("Runtime.evaluate"), /HTTP 429/);
  client.close();
});

test("a read callback cannot report success after a CDP throttle or persistence failure", async () => {
  const start = runtime.indexOf("async function withXPage(fn) {");
  const end = runtime.indexOf("\nasync function openXUrl(", start);
  assert.ok(start >= 0 && end > start);
  const code = runtime.slice(start, end);
  const factory = new Function(
    "withLease", "appDir", "getPageClient", "evaluate", "parseXHttpsUrl", "navigate",
    `${code}; return withXPage;`,
  );
  let closed = 0;
  const cdp = { networkFailure: null, close() { closed++; } };
  const page = factory(
    async (_root, _name, _key, fn) => await fn(),
    "/test-inert-app-data",
    async () => cdp,
    async () => "https://x.com/home",
    (value) => new URL(value),
    async () => {},
  );
  await assert.rejects(page(async () => {
    cdp.networkFailure = new Error("Cannot persist the HTTP 429 cooldown");
    return "incorrect read success";
  }), /Cannot persist/);
  assert.equal(closed, 1, "Read failure must still close the CDP session");
});
