import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

export const PORT = 19411;
const HOST = "127.0.0.1";
const ALLOWED = ["reddit.com", "x.com", "twitter.com", "youtube.com", "accounts.google.com"];
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT = 10_000;

export function stateDir(platform = process.platform, env = process.env, home = os.homedir()) {
  const base = platform === "win32" ? env.LOCALAPPDATA || env.APPDATA || home :
    platform === "darwin" ? path.join(home, "Library", "Application Support") :
    env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(base, "ChatOnSteroids", "EasySocialBrowserBridge");
}

function approved(href) {
  try {
    const url = new URL(href);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return url.protocol === "https:" && ALLOWED.some((name) => host === name || host.endsWith("." + name));
  } catch { return false; }
}

function hostOrigin(req, port) {
  return req.headers.host === `127.0.0.1:${port}`;
}

export function makeServer({ port = PORT, directory = stateDir() } = {}) {
  const keyPath = path.join(directory, "pairing-key");
  // Stable pairing survives process restarts; users need to pair each browser
  // once. Only the local account can read this key on Unix platforms.
  let secret;
  try {
    const existing = fs.readFileSync(keyPath, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) secret = existing;
  } catch {}
  secret ||= crypto.randomBytes(32).toString("hex");
  const server = http.createServer();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES });
  const browsers = new Map();
  const clients = new Map();
  const pending = new Map();
  let counter = 0;

  function portNumber() { return server.address().port; }
  function returnJson(res, status, payload) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(payload));
  }
  function selection() {
    const connected = [...browsers.values()].filter((b) => b.socket.readyState === WebSocket.OPEN);
    if (!connected.length) throw new Error("No connected browser companion. Pair the extension in Helium, Chrome, Edge, Brave, Opera or Vivaldi.");
    // Never silently choose between different signed-in browsers.
    if (connected.length > 1) throw new Error("More than one browser is connected. Disconnect the extra companion before posting.");
    return connected[0];
  }
  function request(browser, type, extra) {
    if (browser.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Browser disconnected."));
    const id = ++counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Browser companion timed out.")); }, TIMEOUT);
      pending.set(id, { browser, resolve, reject, timer });
      browser.socket.send(JSON.stringify({ id, type, ...extra }));
    });
  }
  function pageInfo(browser, tab) {
    if (!Number.isInteger(tab?.id) || tab.id < 0 || !approved(tab.url)) return null;
    return { id: `${browser.id}:${tab.id}`, type: "page", title: String(tab.title || ""),
      url: tab.url,
      webSocketDebuggerUrl: `ws://${HOST}:${portNumber()}/devtools/page/${browser.id}/${tab.id}?key=${secret}` };
  }
  server.on("request", async (req, res) => {
    if (!hostOrigin(req, portNumber()) || req.headers.origin ||
        req.headers.authorization !== `Bearer ${secret}`) returnJson(res, 403, { error: "Unauthorized browser debugger request." });
    else {
      let requestUrl;
      try { requestUrl = new URL(req.url, `http://${HOST}:${portNumber()}`); }
      catch { return returnJson(res, 400, { error: "Invalid request." }); }
      try {
        const browser = selection();
        if (req.method === "GET" && requestUrl.pathname === "/json/version") {
          return returnJson(res, 200, { Browser: "EasySocialCompanion/v1",
            browser: browser.label,
            webSocketDebuggerUrl: `ws://${HOST}:${portNumber()}/devtools/browser/local?key=${secret}` });
        }
        if (req.method === "GET" && requestUrl.pathname === "/json/list") {
          const tabs = await request(browser, "list", {});
          return returnJson(res, 200, (Array.isArray(tabs) ? tabs : []).map((tab) => pageInfo(browser, tab)).filter(Boolean));
        }
        if (req.method === "PUT" && requestUrl.pathname === "/json/new") {
          const url = decodeURIComponent(requestUrl.search.slice(1));
          if (!approved(url)) return returnJson(res, 400, { error: "Only approved social-site HTTPS URLs can be opened." });
          const tab = await request(browser, "open", { url });
          const result = pageInfo(browser, tab);
          if (!result) return returnJson(res, 502, { error: "Browser returned an unexpected tab." });
          return returnJson(res, 200, result);
        }
        return returnJson(res, 404, { error: "No such endpoint." });
      } catch (error) { return returnJson(res, 503, { error: String(error.message).slice(0, 200) }); }
    }
  });
  server.on("upgrade", (req, socket, head) => {
    let url;
    try { url = new URL(req.url, `http://${HOST}:${portNumber()}`); }
    catch { socket.destroy(); return; }
    const isExtension = url.pathname === "/extension";
    const matched = /^\/devtools\/page\/([a-f0-9]{32})\/(\d+)$/.exec(url.pathname);
    const isBrowser = url.pathname === "/devtools/browser/local";
    // A random, per-run key is mandatory for every connection, including the
    // extension. Browser-originated WebSockets cannot masquerade as local MCPs.
    if (!hostOrigin(req, portNumber()) || url.searchParams.get("key") !== secret ||
        (isExtension ? !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin || "") :
          Boolean(req.headers.origin) || (!matched && !isBrowser))) { socket.destroy(); return; }
    const clientId = url.searchParams.get("browserId");
    if (isExtension && (!/^[a-f0-9]{32}$/.test(clientId || "") || browsers.has(clientId))) {
      socket.destroy(); return;
    }
    const id = isExtension ? clientId : null;
    if (matched && (!browsers.has(matched[1]) || browsers.get(matched[1]) !== selectionOrNull())) { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      if (isExtension) {
        const browser = { id, label: "Chromium browser", socket: ws };
        browsers.set(id, browser);
        ws.on("message", (raw) => {
          let item;
          try { item = JSON.parse(raw.toString()); } catch { return; }
          if (item.type === "hello") { browser.label = String(item.browser || "Chromium browser").slice(0, 80); return; }
          if (item.type === "event") {
            const key = `${id}:${item.tabId}`;
            if (!/^[A-Za-z]+\.[A-Za-z]+$/.test(item.method || "")) return;
            const broadcast = JSON.stringify({ method: item.method, params: item.params || {} });
            for (const client of clients.get(key) || []) if (client.readyState === WebSocket.OPEN) client.send(broadcast);
            return;
          }
          const work = pending.get(item.id);
          if (!work || work.browser !== browser) return;
          clearTimeout(work.timer); pending.delete(item.id);
          if (item.error) work.reject(new Error(String(item.error).slice(0, 250)));
          else work.resolve(item.result);
        });
        ws.on("close", () => {
          browsers.delete(id);
          for (const [key, work] of pending) if (work.browser === browser) {
            clearTimeout(work.timer); work.reject(new Error("Browser disconnected.")); pending.delete(key);
          }
          for (const [key, subscribers] of clients) if (key.startsWith(id + ":")) {
            for (const client of subscribers) client.close(1011, "Browser disconnected");
            clients.delete(key);
          }
        });
        return;
      }
      const key = matched ? `${matched[1]}:${matched[2]}` : null;
      const browser = matched ? browsers.get(matched[1]) : null;
      if (key) {
        if (!clients.has(key)) clients.set(key, new Set());
        clients.get(key).add(ws);
      }
      ws.on("message", async (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!Number.isSafeInteger(msg.id)) return;
        try {
          if (!browser) throw new Error("Browser-wide debugger commands are not allowed.");
          if (!/^(Page|Runtime|Network|DOM|Input|Emulation|Storage)\.[A-Za-z]+$/.test(msg.method || "")) throw new Error("Unsupported debugger command.");
          const value = await request(browser, "command", { tabId: Number(matched[2]), method: msg.method, params: msg.params || {} });
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: msg.id, result: value || {} }));
        } catch (err) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: msg.id, error: { message: err.message } }));
        }
      });
      ws.on("close", () => {
        if (!key) return;
        clients.get(key)?.delete(ws);
        if (clients.get(key)?.size === 0) clients.delete(key);
      });
    });
  });
  function selectionOrNull() { try { return selection(); } catch { return null; } }
  return {
    server, keyPath,
    async start() {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, HOST, resolve); });
      try {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.writeFileSync(keyPath, secret, { mode: 0o600 });
        if (process.platform !== "win32") { fs.chmodSync(directory, 0o700); fs.chmodSync(keyPath, 0o600); }
      } catch (error) { await new Promise((done) => server.close(done)); throw error; }
      return portNumber();
    },
    async stop() {
      for (const ws of sockets.clients) ws.terminate();
      for (const work of pending.values()) { clearTimeout(work.timer); work.reject(new Error("Bridge stopped.")); }
      pending.clear();
      await new Promise((done) => server.close(done));
    },
  };
}

const here = process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
if (here) {
  const bridge = makeServer();
  bridge.start().then((port) => {
    console.log(`Easy Social browser companion: listening on 127.0.0.1:${port}`);
    console.log(`Enter this one-time session pairing code in the extension popup:\n${fs.readFileSync(bridge.keyPath, "utf8")}`);
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
