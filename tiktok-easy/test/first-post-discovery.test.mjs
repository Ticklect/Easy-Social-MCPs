import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { extractZip } from "./zip.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("v0.1.6 initial post scans once and never falls back to QR on missing or ambiguous browsers", async (t) => {
  const directory = path.join(root, ".work", `worker3-first-post-test-${process.pid}`);
  assert.equal(fs.existsSync(directory), false, "fixture must not overwrite previous runs");
  fs.mkdirSync(directory, { recursive: true });
  const previous = {
    debug: process.env.EASY_SOCIAL_BROWSER_DEBUG_PORT,
    mode: process.env.EASY_SOCIAL_BROWSER_MODE,
    local: process.env.LOCALAPPDATA,
    data: process.env.TIKTOK_MCP_DATA_DIR,
  };
  t.after(() => {
    for (const [name, value] of Object.entries({
      EASY_SOCIAL_BROWSER_DEBUG_PORT: previous.debug,
      EASY_SOCIAL_BROWSER_MODE: previous.mode,
      LOCALAPPDATA: previous.local,
      TIKTOK_MCP_DATA_DIR: previous.data,
    })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    const expected = path.resolve(root, ".work", `worker3-first-post-test-${process.pid}`);
    assert.equal(path.resolve(directory), expected);
    assert.ok(expected.startsWith(path.resolve(root, ".work") + path.sep));
    fs.rmSync(expected, { recursive: true, force: true });
    delete globalThis.__tiktokMockDiscoveryCalls;
    delete globalThis.__tiktokDiscoveryMode;
  });
  extractZip(path.join(root, "tiktok-easy-v0.1.6.mcpb"), directory);
  const app = path.join(directory, "app");
  fs.writeFileSync(path.join(app, "dist", "runtime", "browser-discovery.js"), `
    export async function discoverOpenBrowserPort() {
      globalThis.__tiktokMockDiscoveryCalls++;
      if (globalThis.__tiktokDiscoveryMode === 'ambiguous') {
        throw new Error('Multiple already-open browser debug sessions detected. Refusing to select a TikTok account automatically.');
      }
      return globalThis.__tiktokDiscoveryMode === 'missing' ? null : 9222;
    }
  `);
  delete process.env.EASY_SOCIAL_BROWSER_DEBUG_PORT;
  delete process.env.EASY_SOCIAL_BROWSER_MODE;
  process.env.LOCALAPPDATA = directory;
  process.env.TIKTOK_MCP_DATA_DIR = path.join(directory, "account-state");
  const fromBundle = (relative) => import(pathToFileURL(path.join(app, relative)).href);
  const [{ createTikTokServer }, { findUsableExistingBrowserPort }, { LocalTikTokRuntime }, { Client }, { InMemoryTransport }] = await Promise.all([
    fromBundle("dist/server.js"),
    fromBundle("dist/runtime/social-runtime.js"),
    fromBundle("dist/runtime/local-runtime.js"),
    fromBundle("node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"),
    fromBundle("node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js"),
  ]);

  async function invoke(runtime) {
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const server = createTikTokServer({ runtime });
    const client = new Client({ name: "offline-discovery-test", version: "1" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return await client.callTool({ name: "tiktok_post", arguments: {
        caption: "Offline test only", video_url: "https://example.invalid/file.mp4",
      } });
    } finally {
      await client.close();
      await server.close();
    }
  }

  let postCalls = 0;
  const validRuntime = {
    accounts: () => ({ accounts: [] }),
    connect: async (args) => {
      assert.deepEqual(args, { account_id: "default", existing_browser_only: true });
      assert.equal(await findUsableExistingBrowserPort(), 9222);
      return { status: "done", reused_browser: true, profile_name: "creator" };
    },
    post: () => { postCalls++; return { operation_id: "offline-id", status: "pending" }; },
  };
  globalThis.__tiktokDiscoveryMode = "valid";
  globalThis.__tiktokMockDiscoveryCalls = 0;
  const valid = await invoke(validRuntime);
  assert.ok(!valid.isError, JSON.stringify(valid));
  assert.equal(postCalls, 1);
  assert.equal(globalThis.__tiktokMockDiscoveryCalls, 1, "connect must own the single fresh discovery");

  let qrCalled = 0;
  const runtime = new LocalTikTokRuntime({
    create: async () => { qrCalled++; throw new Error("QR relay was unexpectedly called"); },
  });
  for (const mode of ["missing", "ambiguous"]) {
    globalThis.__tiktokDiscoveryMode = mode;
    globalThis.__tiktokMockDiscoveryCalls = 0;
    const response = await invoke(runtime);
    assert.equal(response.isError, true, JSON.stringify(response));
    assert.match(JSON.stringify(response), mode === "missing"
      ? /No accessible signed-in TikTok browser debugger/
      : /Multiple already-open browser debug sessions/);
    assert.equal(globalThis.__tiktokMockDiscoveryCalls, 1);
    assert.equal(qrCalled, 0);
    assert.equal(postCalls, 1);
  }
});
