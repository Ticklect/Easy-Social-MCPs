import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseGoogleYoutubeUrl, validateDebuggerWs } from "./validation.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

export function browserCandidates(platform = process.platform, env = process.env, exists = (candidate) => {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}) {
  const p = pathApi(platform);
  const out = [];
  if (platform === "win32") {
    for (const base of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"]]) {
      if (!base) continue;
      out.push(p.join(base, "imput", "Helium", "Application", "chrome.exe"));
      out.push(p.join(base, "Helium", "Application", "chrome.exe"));
      out.push(p.join(base, "Google", "Chrome", "Application", "chrome.exe"));
      out.push(p.join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
      out.push(p.join(base, "Chromium", "Application", "chrome.exe"));
    }
    if (env.LOCALAPPDATA) {
      const base = env.LOCALAPPDATA;
      out.push(p.join(base, "imput", "Helium", "Application", "chrome.exe"));
      out.push(p.join(base, "Programs", "Helium", "Application", "chrome.exe"));
      out.push(p.join(base, "Helium", "Application", "chrome.exe"));
      out.push(p.join(base, "Google", "Chrome", "Application", "chrome.exe"));
      out.push(p.join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
      out.push(p.join(base, "Chromium", "Application", "chrome.exe"));
    }
  } else if (platform === "darwin") {
    out.push(
      "/Applications/Helium.app/Contents/MacOS/Helium",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    out.push(
      "/usr/bin/helium",
      "/usr/local/bin/helium",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
    );
  }
  return [...new Set(out)].filter(exists);
}

export function selectReusableTarget(targets, port) {
  if (!Array.isArray(targets)) return null;
  return targets.find((target) => {
    if (target?.type !== "page" || !target.webSocketDebuggerUrl) return false;
    try {
      parseGoogleYoutubeUrl(target.url);
      validateDebuggerWs(target.webSocketDebuggerUrl, port);
      return true;
    } catch {
      return false;
    }
  }) || null;
}

function defaultDataRoot(platform, env) {
  if (platform === "win32") return env.LOCALAPPDATA || env.APPDATA || os.homedir();
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support");
  return env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

function ensurePrivateDir(fsApi, dir) {
  fsApi.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { fsApi.chmodSync?.(dir, 0o700); } catch {}
  }
}

async function fetchJson(fetchFn, url, options = {}, timeoutMs = 2_500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { ...options, signal: controller.signal });
    if (!response?.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class CdpClient {
  constructor(wsUrl, expectedPort, { WebSocketClass = globalThis.WebSocket } = {}) {
    this.wsUrl = validateDebuggerWs(wsUrl, expectedPort);
    this.expectedPort = expectedPort;
    this.WebSocketClass = WebSocketClass;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    if (typeof this.WebSocketClass !== "function") throw new Error("YouTube Easy requires Node.js 22 or newer with WebSocket support.");
    await new Promise((resolve, reject) => {
      const ws = new this.WebSocketClass(this.wsUrl);
      const timer = setTimeout(() => reject(new Error("Timed out connecting to the local browser debugger.")), 5_000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Local browser debugger connection failed."));
      });
      ws.addEventListener("message", (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.id) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error.message || "Browser debugger error."));
          else pending.resolve(message.result || {});
          return;
        }
        const handlers = this.listeners.get(message.method);
        if (handlers) for (const handler of handlers) handler(message.params || {});
      });
      ws.addEventListener("close", () => {
        for (const pending of this.pending.values()) pending.reject(new Error("Browser debugger connection closed."));
        this.pending.clear();
      });
    });
  }

  send(method, params = {}) {
    if (!this.ws) throw new Error("Browser debugger WebSocket is not connected.");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) || new Set();
    handlers.add(handler);
    this.listeners.set(method, handlers);
    return () => handlers.delete(handler);
  }

  async evaluate(expression, { returnByValue = true, userGesture = false } = {}) {
    try { new Function(String(expression)); }
    catch (error) { throw new Error(`YouTube Easy generated an invalid browser script: ${error.message}`); }
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue,
      userGesture,
    });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed.";
      throw new Error(description);
    }
    return returnByValue ? result.result?.value : result.result;
  }

  async setFileInputFiles(selector, files) {
    if (typeof selector !== "string" || !selector) throw new Error("A file input selector is required.");
    if (!Array.isArray(files) || !files.length || files.some((file) => typeof file !== "string" || !file)) {
      throw new Error("At least one local file path is required.");
    }
    const expression = `(() => {
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      if (nodes.length !== 1) throw new Error("Expected exactly one file input, found " + nodes.length + ".");
      if (!(nodes[0] instanceof HTMLInputElement) || nodes[0].type !== "file") throw new Error("Selected element is not a file input.");
      return nodes[0];
    })()`;
    const evaluated = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: false, userGesture: true });
    if (evaluated.exceptionDetails || !evaluated.result?.objectId) {
      const count = evaluated.result?.value?.count;
      throw new Error(Number.isInteger(count)
        ? `Expected exactly one file input, found ${count}.`
        : "Expected exactly one file input, but the browser could not resolve it.");
    }
    await this.send("DOM.setFileInputFiles", { objectId: evaluated.result.objectId, files });
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

export class YouTubeBrowser {
  constructor({
    stateDir,
    platform = process.platform,
    env = process.env,
    fsApi = fs,
    spawnFn = spawn,
    fetchFn = fetch,
    WebSocketClass = globalThis.WebSocket,
    candidateProvider,
    sleepFn = sleep,
  } = {}) {
    this.platform = platform;
    this.env = env;
    this.fs = fsApi;
    this.spawn = spawnFn;
    this.fetch = fetchFn;
    this.WebSocketClass = WebSocketClass;
    this.sleep = sleepFn;
    this.stateDir = path.resolve(stateDir || env.YOUTUBE_EASY_STATE_DIR || path.join(defaultDataRoot(platform, env), "ChatOnSteroids", "YouTubeEasy"));
    this.profileDir = path.join(this.stateDir, "browser-profile");
    this.portFile = path.join(this.profileDir, "DevToolsActivePort");
    this.candidateProvider = candidateProvider || (() => browserCandidates(platform, env));
    ensurePrivateDir(this.fs, this.stateDir);
    ensurePrivateDir(this.fs, this.profileDir);
  }

  readDebugPort() {
    try {
      const first = this.fs.readFileSync(this.portFile, "utf8").split(/\r?\n/, 1)[0]?.trim();
      const port = Number(first);
      return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
    } catch {
      return null;
    }
  }

  async findRunningPort() {
    const port = this.readDebugPort();
    if (!port) return null;
    const info = await fetchJson(this.fetch, `http://127.0.0.1:${port}/json/version`);
    if (!info?.webSocketDebuggerUrl) return null;
    try {
      validateDebuggerWs(info.webSocketDebuggerUrl, port);
      return port;
    } catch {
      return null;
    }
  }

  async start() {
    const running = await this.findRunningPort();
    if (running) return running;
    try { this.fs.unlinkSync(this.portFile); } catch {}
    ensurePrivateDir(this.fs, this.profileDir);
    const candidates = this.candidateProvider();
    if (!candidates.length) throw new Error("Could not find Helium, Google Chrome, Microsoft Edge, or Chromium.");
    const args = [
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${this.profileDir}`,
      "--disable-extensions",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      "about:blank",
    ];
    const child = this.spawn(candidates[0], args, { detached: true, stdio: "ignore", windowsHide: false });
    child.unref?.();
    for (let i = 0; i < 80; i++) {
      const port = this.readDebugPort();
      if (port) {
        const info = await fetchJson(this.fetch, `http://127.0.0.1:${port}/json/version`, {}, 700);
        if (info?.webSocketDebuggerUrl) {
          validateDebuggerWs(info.webSocketDebuggerUrl, port);
          return port;
        }
      }
      await this.sleep(250);
    }
    throw new Error("Browser started, but YouTube Easy could not connect to its dedicated local debugger.");
  }

  async listTargets(port) {
    const targets = await fetchJson(this.fetch, `http://127.0.0.1:${port}/json/list`);
    return Array.isArray(targets) ? targets : [];
  }

  async createPage(port, url) {
    const safe = parseGoogleYoutubeUrl(url).href;
    const target = await fetchJson(this.fetch, `http://127.0.0.1:${port}/json/new?${encodeURIComponent(safe)}`, { method: "PUT" }, 4_000);
    if (!target?.webSocketDebuggerUrl) throw new Error("Could not open a YouTube browser tab.");
    validateDebuggerWs(target.webSocketDebuggerUrl, port);
    parseGoogleYoutubeUrl(target.url || safe);
    return target;
  }

  async page(url = "https://studio.youtube.com/") {
    const safe = parseGoogleYoutubeUrl(url).href;
    const port = await this.start();
    const targets = await this.listTargets(port);
    let target = selectReusableTarget(targets, port);
    if (!target) target = await this.createPage(port, safe);
    const client = new CdpClient(target.webSocketDebuggerUrl, port, { WebSocketClass: this.WebSocketClass });
    await client.connect();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("DOM.enable");
    await client.send("Network.enable");
    await this.navigate(client, safe);
    return client;
  }

  async navigate(client, url) {
    const safe = parseGoogleYoutubeUrl(url).href;
    await client.send("Page.navigate", { url: safe });
    for (let i = 0; i < 80; i++) {
      const state = await client.evaluate("({ready: document.readyState, href: location.href})").catch(() => null);
      if (state && (state.ready === "interactive" || state.ready === "complete")) {
        parseGoogleYoutubeUrl(state.href);
        return state.href;
      }
      await this.sleep(250);
    }
    throw new Error("Timed out loading the Google/YouTube page.");
  }

  async closeDedicatedBrowser() {
    const port = await this.findRunningPort();
    if (!port) return false;
    const info = await fetchJson(this.fetch, `http://127.0.0.1:${port}/json/version`);
    if (!info?.webSocketDebuggerUrl) return false;
    const client = new CdpClient(info.webSocketDebuggerUrl, port, { WebSocketClass: this.WebSocketClass });
    try {
      await client.connect();
      await client.send("Browser.close").catch(() => {});
    } finally {
      client.close();
    }
    return true;
  }
}

let defaultBrowser;

export function getDefaultBrowser() {
  defaultBrowser ||= new YouTubeBrowser();
  return defaultBrowser;
}

export async function withYouTubePage(fn, { browser = getDefaultBrowser(), url } = {}) {
  const client = await browser.page(url);
  try { return await fn(client, browser); }
  finally { client.close(); }
}

export async function closeDedicatedBrowser(browser = getDefaultBrowser()) {
  return await browser.closeDedicatedBrowser();
}
