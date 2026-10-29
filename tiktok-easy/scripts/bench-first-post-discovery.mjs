/** Deterministic initial-post discovery bench against the actual MCPB server. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { extractZip } from "../test/zip.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, ".work", "worker3-post-discovery-benchmark");
const samples = 31;
const mockDiscoveryMs = 35;

if (fs.existsSync(fixture)) throw new Error("Refusing to overwrite an existing benchmark fixture");
fs.mkdirSync(fixture, { recursive: true });
const before = {
  debugPort: process.env.EASY_SOCIAL_BROWSER_DEBUG_PORT,
  mode: process.env.EASY_SOCIAL_BROWSER_MODE,
  local: process.env.LOCALAPPDATA,
};
try {
  extractZip(path.join(root, "tiktok-easy-v0.1.6.mcpb"), fixture);
  const app = path.join(fixture, "app");
  fs.writeFileSync(path.join(app, "dist", "runtime", "browser-discovery.js"), `
    export async function discoverOpenBrowserPort() {
      globalThis.__tiktokMockDiscoveryCalls++;
      await new Promise((resolve) => setTimeout(resolve, ${mockDiscoveryMs}));
      return 9222;
    }
  `);
  delete process.env.EASY_SOCIAL_BROWSER_DEBUG_PORT;
  delete process.env.EASY_SOCIAL_BROWSER_MODE;
  process.env.LOCALAPPDATA = fixture;
  const fromBundle = (relative) => import(pathToFileURL(path.join(app, relative)).href);
  const [{ createTikTokServer }, { findUsableExistingBrowserPort }, { Client }, { InMemoryTransport }] = await Promise.all([
    fromBundle("dist/server.js"), fromBundle("dist/runtime/social-runtime.js"),
    fromBundle("node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"),
    fromBundle("node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js"),
  ]);
  let postCalls = 0;
  const fakeRuntime = {
    accounts: () => ({ accounts: [] }),
    connect: async (input) => {
      assert.deepEqual(input, { account_id: "default", existing_browser_only: true });
      assert.equal(await findUsableExistingBrowserPort(), 9222);
      return { status: "done", reused_browser: true, profile_name: "offline_test" };
    },
    post: () => { postCalls++; return { operation_id: "offline-id", status: "pending" }; },
  };
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createTikTokServer({ runtime: fakeRuntime });
  const client = new Client({ name: "offline-benchmark", version: "1" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const durations = [];
    const discoveryCounts = [];
    for (let i = 0; i < samples; i++) {
      globalThis.__tiktokMockDiscoveryCalls = 0;
      const start = performance.now();
      const response = await client.callTool({ name: "tiktok_post", arguments: {
        caption: "Benchmark only", video_url: "https://example.invalid/video.mp4",
      } });
      assert.ok(!response.isError, JSON.stringify(response));
      durations.push(performance.now() - start);
      discoveryCounts.push(globalThis.__tiktokMockDiscoveryCalls);
    }
    assert.equal(postCalls, samples);
    assert.equal(new Set(discoveryCounts).size, 1, "discovery count must be deterministic");
    durations.sort((a, b) => a - b);
    const p = (pct) => Number(durations[Math.ceil(pct * samples) - 1].toFixed(2));
    console.log(JSON.stringify({ samples, mock_discovery_ms: mockDiscoveryMs,
      discoveries_per_first_post: discoveryCounts[0], p50_ms: p(0.5), p95_ms: p(0.95),
    }, null, 2));
  } finally {
    await client.close();
    await server.close();
    delete globalThis.__tiktokMockDiscoveryCalls;
  }
} finally {
  for (const [key, value] of Object.entries({
    EASY_SOCIAL_BROWSER_DEBUG_PORT: before.debugPort,
    EASY_SOCIAL_BROWSER_MODE: before.mode,
    LOCALAPPDATA: before.local,
  })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const expected = path.resolve(root, ".work", "worker3-post-discovery-benchmark");
  if (path.resolve(fixture) !== expected || !expected.startsWith(path.resolve(root, ".work") + path.sep)) {
    throw new Error("Unsafe benchmark cleanup path");
  }
  fs.rmSync(expected, { recursive: true, force: true });
}
