import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sources = [
  { label: "Reddit", file: "src/index.js", domainNames: ["Page.enable", "Runtime.enable"] },
  { label: "X", file: "x-easy/src/index.js", domainNames: ["Page.enable", "Runtime.enable", "Network.enable"] },
];

// Run the actual runtime getPageClient implementation against deterministic
// local CDP mocks. Never opens a browser or contacts a social account.
function fixture({ file, delayMs = 0, failOn = null }) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const start = source.indexOf("async function getPageClient() {");
  const end = source.indexOf("\nasync function evaluate(", start);
  assert.ok(start >= 0 && end > start, `Missing browser bootstrap in ${file}`);
  const calls = [];
  const clients = [];
  let inflight = 0;
  let peak = 0;
  const page = { id: "owned-page", type: "page", url: file.startsWith("x-") ? "https://x.com/home" : "https://reddit.com/",
    webSocketDebuggerUrl: "ws://127.0.0.1:44222/devtools/page/owned-page" };
  class CdpClient {
    closed = false;
    constructor(url, port) { assert.equal(url, page.webSocketDebuggerUrl); assert.equal(port, 44222); clients.push(this); }
    async connect() { calls.push("connect"); }
    async send(method) {
      calls.push(method);
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      inflight--;
      if (method === failOn) throw new Error(`Mock domain failure: ${method}`);
      return {};
    }
    close() { this.closed = true; calls.push("close"); }
  }
  const names = ["startBrowser", "listTargets", "isExternalPort", "readOwnedExternalTab", "parseRedditHttpsUrl",
    "parseXHttpsUrl", "validateLocalDebuggerWs", "createPage", "saveOwnedExternalTab", "CdpClient"];
  const dependencies = [async () => 44222, async () => [page], () => false, () => null,
    () => {}, () => {}, () => {}, async () => { throw new Error("Unexpected page creation"); },
    () => { throw new Error("Unexpected external tab mutation"); }, CdpClient];
  const getPageClient = new Function(...names, `${source.slice(start, end)}\nreturn getPageClient;`)(...dependencies);
  return { getPageClient, calls, clients, peak: () => peak };
}

for (const entry of sources) {
  test(`${entry.label} enables all CDP domains before handing control to an invoked tool`, async () => {
    const mock = fixture({ ...entry, delayMs: 1 });
    const client = await mock.getPageClient();
    assert.equal(client, mock.clients[0]);
    assert.deepEqual(mock.calls, ["connect", ...entry.domainNames]);
    assert.equal(mock.peak(), entry.domainNames.length, "CDP domain enables should be pipelined");
  });

  test(`${entry.label} closes a failed CDP bootstrap before invoking any tool`, async () => {
    const mock = fixture({ ...entry, delayMs: 1, failOn: "Runtime.enable" });
    await assert.rejects(mock.getPageClient(), /Mock domain failure/);
    assert.equal(mock.clients.length, 1);
    assert.equal(mock.clients[0].closed, true);
  });
}

if (process.env.CDP_BOOTSTRAP_BENCH === "1") {
  test("deterministic mocked CDP bootstrap p50/p95 latency", async () => {
    for (const entry of sources) {
      const values = [];
      for (let i = 0; i < 21; i++) {
        const mock = fixture({ ...entry, delayMs: 30 });
        const before = performance.now();
        await mock.getPageClient();
        if (i > 0) values.push(performance.now() - before);
      }
      values.sort((a, b) => a - b);
      console.log(`CDP_BOOTSTRAP ${entry.label} n=${values.length} mocked_domain_delay=30ms p50=${values[Math.floor(values.length * 0.5)].toFixed(2)}ms p95=${values[Math.ceil(values.length * 0.95) - 1].toFixed(2)}ms`);
    }
  });
}
