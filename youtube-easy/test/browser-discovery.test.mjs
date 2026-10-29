import test from "node:test";
import assert from "node:assert/strict";
import { discoverAlreadyOpenSocialBrowser } from "../src/open-browser-discovery.js";

test("32-port discovery bounds concurrency, completes all candidates and preserves unique selection", async () => {
  const ports = Array.from({ length: 32 }, (_, i) => 41001 + i);
  let active = 0;
  let peak = 0;
  const requests = [];
  const fixture = {
    ports: [...ports, ports[0]],
    validateWebSocket: (url, port) => { if (url !== `ws://127.0.0.1:${port}/devtools/page/valid`) throw new Error("Wrong port"); },
    allowed: (url) => url === "https://studio.youtube.com/",
    request: async (href) => {
      active++;
      peak = Math.max(peak, active);
      requests.push(href);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      const url = new URL(href);
      const port = Number(url.port);
      const webSocketDebuggerUrl = `ws://127.0.0.1:${port}/devtools/page/valid`;
      if (url.pathname === "/json/version") return { webSocketDebuggerUrl };
      return [{ type: "page", webSocketDebuggerUrl, url: port === ports[31] ? "https://studio.youtube.com/" : "https://unrelated.example/" }];
    },
  };
  assert.equal(await discoverAlreadyOpenSocialBrowser(fixture), ports[31]);
  assert.equal(peak, 8);
  assert.equal(active, 0);
  assert.equal(requests.length, 64, "each unique candidate needs a version and tab-list check");
  assert.ok(requests.every((url) => url.endsWith("/json/version") || url.endsWith("/json/list")));
});

test("failed and spoofed browser ports do not prevent finding a real candidate", async () => {
  const result = await discoverAlreadyOpenSocialBrowser({
    ports: [43101, 43102, 43103],
    request: async (href) => {
      const { port, pathname } = new URL(href);
      if (port === "43101") throw new Error("Debugger exited");
      if (pathname === "/json/version") return { webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/real` };
      return [{ type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${port === "43102" ? "9999" : port}/devtools/page/id`, url: "https://studio.youtube.com/" }];
    },
    validateWebSocket: (ws, port) => { if (!ws.startsWith(`ws://127.0.0.1:${port}/`)) throw new Error("Spoofed port"); },
    allowed: (url) => url === "https://studio.youtube.com/",
  });
  assert.equal(result, 43103);
});

test("simultaneous matches always reject ambiguity even if one responds later", async () => {
  const seen = [];
  await assert.rejects(discoverAlreadyOpenSocialBrowser({
    ports: [43101, 43102, 43103],
    request: async (href) => {
      seen.push(href);
      const { port, pathname } = new URL(href);
      if (port === "43103") await new Promise((resolve) => setTimeout(resolve, 5));
      const webSocketDebuggerUrl = `ws://127.0.0.1:${port}/devtools/page/valid`;
      return pathname === "/json/version" ? { webSocketDebuggerUrl } : [{ type: "page", webSocketDebuggerUrl,
        url: port === "43102" ? "https://unrelated.example/" : "https://studio.youtube.com/" }];
    },
    validateWebSocket: (ws, port) => { if (!ws.startsWith(`ws://127.0.0.1:${port}/`)) throw new Error("Not loopback"); },
    allowed: (url) => url === "https://studio.youtube.com/",
  }), /Multiple existing Chromium browsers/);
  assert.equal(seen.length, 6, "do not select one browser before checking all candidates");
});
