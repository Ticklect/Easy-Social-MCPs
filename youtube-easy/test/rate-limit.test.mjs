import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { coordinationPaths, noteYouTubeResponse } from "../src/coordination.js";
import { YouTubeBrowser, withYouTubePage } from "../src/browser.js";

const worker = fileURLToPath(new URL("./rate-limit-worker.mjs", import.meta.url));
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "youtube-easy-rate-"));

function run(mode, folder, activity) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, mode, folder, activity], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (part) => { stdout += part; });
    child.stderr.on("data", (part) => { stderr += part; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`${mode} code=${code}: ${stderr}`)));
  });
}

test("independent browser sessions maintain a gap after the prior process leaves", async () => {
  const folder = root();
  const activity = path.join(folder, "activity.log");
  const [a, b] = await Promise.all([run("profile", folder, activity), run("profile", folder, activity)]);
  const [first, second] = [a, b].sort((x, y) => x.start - y.start);
  assert.ok(second.start >= first.end + 170, `second start ${second.start}, first end ${first.end}`);
  assert.equal(fs.readFileSync(activity, "utf8").trim().split("\n").length, 2);
});

test("observed 429 blocks a separate process before browser work and survives process exits", async () => {
  const folder = root();
  const activity = path.join(folder, "activity.log");
  const result = await run("throttle", folder, activity);
  assert.equal(result.status, 429);
  assert.ok(result.cooldownUntil > Date.now() + 2_000);
  const blocked = await run("blocked", folder, activity);
  assert.equal(blocked.code, "YOUTUBE_COOLDOWN");
  assert.match(blocked.message, /429/);
  assert.equal(fs.existsSync(activity), false, "cooldown must fail before executing the callback");

  const file = coordinationPaths(folder).profileTraffic;
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...state, cooldownUntil: Date.now() - 1 }));
  assert.equal((await run("allowed", folder, activity)).status, "allowed");
});

test("429 and transient 5xx use Retry-After and reject unrelated CDP traffic", () => {
  const folder = root();
  const now = Date.now();
  const irrelevant = [
    { type: "Image", response: { status: 429, url: "https://www.youtube.com/image.png" } },
    { type: "XHR", response: { status: 429, url: "https://youtube.com.evil.test/api" } },
    { type: "XHR", response: { status: 429, url: "http://www.youtube.com/api" } },
    { type: "XHR", response: { status: 403, url: "https://studio.youtube.com/api" } },
  ];
  for (const response of irrelevant) assert.equal(noteYouTubeResponse(folder, response, now), null);
  assert.equal(fs.existsSync(coordinationPaths(folder).profileTraffic), false);

  const first = noteYouTubeResponse(folder, { type: "Fetch", response: { status: 503, url: "https://studio.youtube.com/youtubei/v1/stats" } }, now);
  assert.equal(first.cooldownUntil, now + 15_000);
  const second = noteYouTubeResponse(folder, { type: "XHR", response: { status: 429, url: "https://www.youtube.com/youtubei/v1/browse", headers: { "Retry-After": "60" } } }, now + 1);
  assert.equal(second.cooldownUntil, now + 60_001);
  const third = noteYouTubeResponse(folder, { type: "Document", response: { status: 502, url: "https://studio.youtube.com/", headers: { "retry-after": new Date(now + 40_000).toUTCString() } } }, now + 2);
  assert.equal(third.cooldownUntil, second.cooldownUntil, "a shorter transient failure cannot remove an existing cooldown");
});

test("zero or tiny Retry-After cannot override local 429 and 5xx minimum cooldowns", () => {
  for (const [status, retryAfter, minimum] of [
    [429, "0", 60_000],
    [429, "0.1", 60_000],
    [503, "0", 15_000],
    [503, "0.1", 15_000],
  ]) {
    const folder = root();
    const now = Date.now();
    const observed = noteYouTubeResponse(folder, {
      type: "XHR",
      response: { status, url: "https://studio.youtube.com/youtubei/v1/browse", headers: { "Retry-After": retryAfter } },
    }, now);
    assert.equal(observed.cooldownUntil, now + minimum, `HTTP ${status} Retry-After ${retryAfter}`);
  }
});

test("real CDP network event persists cooldown and stops the current browser read", async () => {
  const folder = root();
  let closed = 0;
  let callbackInvoked = 0;
  class FakeWebSocket {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    emit(name, event) { this.listeners.get(name)?.(event); }
    send(raw) {
      const message = JSON.parse(raw);
      if (message.method === "Page.navigate") {
        queueMicrotask(() => this.emit("message", { data: JSON.stringify({
          method: "Network.responseReceived",
          params: { type: "XHR", response: { status: 429, url: "https://studio.youtube.com/youtubei/v1/browse", headers: { "Retry-After": "30" } } },
        }) }));
      }
      const value = message.method === "Runtime.evaluate" ? { ready: "complete", href: "https://studio.youtube.com/" } : undefined;
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: message.id, result: value ? { result: { value } } : {} }) }));
    }
    close() { closed++; this.emit("close", {}); }
  }
  const browser = new YouTubeBrowser({ stateDir: folder, WebSocketClass: FakeWebSocket });
  browser.start = async () => 43117;
  browser.listTargets = async () => [{ type: "page", url: "https://studio.youtube.com/", webSocketDebuggerUrl: "ws://127.0.0.1:43117/devtools/page/one" }];
  await assert.rejects(() => withYouTubePage(async () => { callbackInvoked++; }, { browser }), /HTTP 429/);
  assert.equal(callbackInvoked, 0, "browser navigation should fail before issuing another UI action");
  assert.equal(closed, 1, "error must close CDP connection");
  assert.ok(JSON.parse(fs.readFileSync(coordinationPaths(folder).profileTraffic, "utf8")).cooldownUntil > Date.now() + 20_000);
});
