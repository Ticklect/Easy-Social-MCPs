import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { extractZip } from "./zip.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("TikTok reuses the authenticated Chromium context without touching original tabs, credentials, or QR relay", { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tiktok-existing-browser-test-"));
  const previous = {
    port: process.env.EASY_SOCIAL_BROWSER_DEBUG_PORT,
    mode: process.env.EASY_SOCIAL_BROWSER_MODE,
    data: process.env.TIKTOK_MCP_DATA_DIR,
    appData: process.env.LOCALAPPDATA,
  };
  let server;
  try {
    extractZip(path.join(root, "tiktok-easy-v0.1.4.mcpb"), directory);
    const moduleDir = path.join(directory, "app", "dist", "runtime");
    const mockedPlaywright = path.join(moduleDir, "node_modules", "playwright");
    fs.mkdirSync(mockedPlaywright, { recursive: true });
    fs.writeFileSync(path.join(mockedPlaywright, "package.json"),
      JSON.stringify({ name: "playwright", type: "module", exports: "./index.mjs" }));
    fs.writeFileSync(path.join(mockedPlaywright, "index.mjs"),
      "export const chromium = globalThis.__tiktokTestChromium;\n");

    const events = [];
    let profileVisible = true;
    let profileHref = "/@real_creator";
    const originalPage = { close: async () => events.push("original-tab-closed") };
    const ownedPage = {
      on() {},
      async route() {},
      async goto(url) { events.push("navigate:" + url); },
      locator(selector) {
        assert.equal(selector, 'a[data-e2e="nav-profile"]');
        return { first: () => ({
          isVisible: async () => profileVisible,
          getAttribute: async (attribute) => {
            assert.equal(attribute, "href");
            return profileHref;
          },
        }) };
      },
      async close() { events.push("new-tab-closed"); },
    };
    const context = {
      pages: () => [originalPage],
      browser: () => browser,
      async newPage() { events.push("new-tab"); return ownedPage; },
      async close() { events.push("existing-context-closed"); },
      async cookies() { throw new Error("Existing browser cookies must never be extracted"); },
    };
    const browser = {
      contexts: () => [context],
      async close() { events.push("cdp-disconnect"); },
    };
    globalThis.__tiktokTestChromium = {
      async connectOverCDP(ws, options) {
        assert.match(ws, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/test-id$/);
        assert.equal(options.timeout, 10_000);
        events.push("cdp-attach");
        return browser;
      },
      async launchPersistentContext() {
        events.push("separate-profile-launched");
        throw new Error("Separate browser profile is forbidden");
      },
    };

    let unsafeEndpoint = false;
    server = http.createServer((_req, res) => {
      const port = server.address().port;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        webSocketDebuggerUrl: unsafeEndpoint
          ? "ws://192.0.2.10:" + port + "/devtools/browser/test-id"
          : "ws://127.0.0.1:" + port + "/devtools/browser/test-id",
      }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.EASY_SOCIAL_BROWSER_DEBUG_PORT = String(server.address().port);
    process.env.EASY_SOCIAL_BROWSER_MODE = "existing";
    process.env.TIKTOK_MCP_DATA_DIR = path.join(directory, "account-state");
    process.env.LOCALAPPDATA = directory;

    const runtimeUrl = pathToFileURL(path.join(moduleDir, "social-runtime.js")).href;
    const { launchLocalContext } = await import(runtimeUrl);
    const session = await launchLocalContext({ accountId: "default", skipAccountIdentityCheck: true });
    assert.equal(session.ctx, context);
    assert.equal(session.page, ownedPage);
    await session.close();
    assert.deepEqual(events.slice(0, 3), ["cdp-attach", "new-tab", "new-tab-closed"]);
    assert.equal(events.includes("existing-context-closed"), false);
    assert.equal(events.includes("original-tab-closed"), false);
    assert.equal(events.includes("separate-profile-launched"), false);

    const { LocalTikTokRuntime } = await import(pathToFileURL(path.join(moduleDir, "local-runtime.js")).href);
    const runtime = new LocalTikTokRuntime({
      async create() { throw new Error("QR relay must not run for an existing authenticated browser"); },
    });
    const connected = await runtime.connect({ account_id: "default" });
    assert.equal(connected.status, "done");
    assert.equal(connected.reused_browser, true);
    assert.equal(connected.profile_name, "real_creator");
    assert.equal(runtime.connectStatus(connected.token).status, "done");
    assert.equal(runtime.accounts().accounts.find((account) => account.id === "default")?.status, "active");
    assert.equal(runtime.accounts().accounts.find((account) => account.id === "default")?.browser_profile_name, "real_creator");
    assert.ok(events.includes("navigate:https://www.tiktok.com/"));
    assert.equal(events.includes("separate-profile-launched"), false);
    await assert.rejects(() => runtime.connect({ account_id: "second" }), /account_id "default"/);
    const verifiedSession = await launchLocalContext({ accountId: "default" });
    await verifiedSession.close();
    profileHref = "/@different_creator";
    await assert.rejects(() => launchLocalContext({ accountId: "default" }), /Connected TikTok account differs/);
    profileHref = "/@real_creator";
    profileVisible = false;
    await assert.rejects(() => runtime.connect({ account_id: "default" }), /signed-in TikTok profile link/);
    assert.equal(runtime.accounts().accounts.find((account) => account.id === "default")?.status, "logged_out");
    profileVisible = true;

    unsafeEndpoint = true;
    const connectionsBefore = events.filter((value) => value === "cdp-attach").length;
    await assert.rejects(() => launchLocalContext({ accountId: "default" }), /unsafe browser endpoint/);
    assert.equal(events.filter((value) => value === "cdp-attach").length, connectionsBefore);

    process.env.EASY_SOCIAL_BROWSER_DEBUG_PORT = "invalid";
    await assert.rejects(() => launchLocalContext({ accountId: "default" }), /localhost port/);
    delete process.env.EASY_SOCIAL_BROWSER_DEBUG_PORT;
    const keyDir = path.join(directory, "ChatOnSteroids", "EasySocialBrowserBridge");
    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(path.join(keyDir, "pairing-key"), "simulated-pairing");
    await assert.rejects(() => launchLocalContext({ accountId: "default" }), /tab-only Easy Social browser companion/);
    assert.equal(events.includes("separate-profile-launched"), false);
  } finally {
    delete globalThis.__tiktokTestChromium;
    for (const [key, original] of [
      ["EASY_SOCIAL_BROWSER_DEBUG_PORT", previous.port],
      ["EASY_SOCIAL_BROWSER_MODE", previous.mode],
      ["TIKTOK_MCP_DATA_DIR", previous.data],
      ["LOCALAPPDATA", previous.appData],
    ]) {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
