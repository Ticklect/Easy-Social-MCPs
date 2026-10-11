import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { extractZip } from "./zip.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("TikTok direct post binds the current browser automatically without a login tool", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tiktok-direct-post-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  extractZip(path.join(root, "tiktok-easy-v0.1.5.mcpb"), directory);
  const fromBundle = (relative) => import(pathToFileURL(path.join(directory, relative)).href);
  const [{ createTikTokServer }, { Client }, { InMemoryTransport }] = await Promise.all([
    fromBundle("app/dist/server.js"),
    fromBundle("app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"),
    fromBundle("app/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js"),
  ]);
  const previousMode = process.env.EASY_SOCIAL_BROWSER_MODE;
  process.env.EASY_SOCIAL_BROWSER_MODE = "existing";
  t.after(() => {
    if (previousMode === undefined) delete process.env.EASY_SOCIAL_BROWSER_MODE;
    else process.env.EASY_SOCIAL_BROWSER_MODE = previousMode;
  });

  const calls = [];
  const fakeRuntime = {
    accounts: () => ({ accounts: [] }),
    connect: async (args) => {
      calls.push(["verify-signed-in-account", args]);
      return { status: "done", reused_browser: true, profile_name: "existing_tiktoker" };
    },
    post: (args) => {
      calls.push(["start-post", args]);
      return { operation_id: "offline-post-id", status: "pending" };
    },
  };
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createTikTokServer({ runtime: fakeRuntime });
  const client = new Client({ name: "offline-tiktok-test", version: "1" });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const response = await client.callTool({ name: "tiktok_post", arguments: {
    caption: "Test only — no real post", video_url: "https://example.com/example.mp4",
  } });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "verify-signed-in-account");
  assert.deepEqual(calls[0][1], { account_id: "default", existing_browser_only: true });
  assert.equal(calls[1][0], "start-post");
  assert.equal(calls[1][1].account_id, "default");
  assert.equal(calls[1][1].caption, "Test only — no real post");
});
