import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { makeServer, PORT } from "../server.mjs";
import { YouTubeBrowser } from "../../youtube-easy/src/browser.js";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function mcpTool(entry, tool, temp) {
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      LOCALAPPDATA: temp,
      APPDATA: temp,
      XDG_DATA_HOME: temp,
      EASY_SOCIAL_BROWSER_MODE: "existing",
      EASY_SOCIAL_BROWSER_DEBUG_PORT: "",
      REDDIT_EASY_STATE_DIR: path.join(temp, "reddit"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const response = await new Promise((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error(`${tool} timed out`)), 15_000);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (!output.includes("\n")) return;
        clearTimeout(timeout);
        try { resolve(JSON.parse(output.slice(0, output.indexOf("\n")))); } catch (error) { reject(error); }
      });
      child.once("error", reject);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: tool, arguments: {} } }) + "\n");
    });
    assert.equal(response.result?.isError, undefined, JSON.stringify(response));
    return response.result;
  } finally { child.kill(); }
}

test("Reddit, X and YouTube automatically discover a paired existing browser without a CDP environment variable", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "easy-social-auto-"));
  const directory = path.join(temp, "ChatOnSteroids", "EasySocialBrowserBridge");
  const bridge = makeServer({ port: PORT, directory });
  await bridge.start();
  const key = fs.readFileSync(bridge.keyPath, "utf8");
  const origin = `chrome-extension://${"a".repeat(32)}`;
  const extension = new WebSocket(`ws://127.0.0.1:${PORT}/extension?key=${key}&browserId=${"b".repeat(32)}`, { origin });
  const opened = [];
  let signedIn = true;
  const commands = [];
  extension.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "list") extension.send(JSON.stringify({ id: message.id, result: opened }));
    if (message.type === "open") {
      const tab = { id: opened.length + 11, url: message.url, title: "Social tab" };
      opened.push(tab);
      extension.send(JSON.stringify({ id: message.id, result: tab }));
    }
    if (message.type === "command") {
      commands.push(message);
      const tab = opened.find(({ id }) => id === message.tabId);
      const expression = message.params?.expression || "";
      let value;
      if (message.method === "Page.navigate") {
        if (tab) tab.url = message.params.url;
      } else if (expression.includes("pathOrUrl, options, timeoutMs")) {
        // Page-local Reddit /api/me.json response. No cookies are read or mirrored.
        value = { ok: true, status: 200, data: { data: signedIn
          ? { name: "signed_in_redditor", modhash: "fixture" } : {} } };
      } else if (expression.includes("AppTabBar_Profile_Link")) {
        // X detects its visible signed-in profile control, never auth cookies.
        value = signedIn ? { loggedIn: true, handle: "signed_in_handle" }
          : { loggedIn: false, handle: null };
      } else if (expression === "location.href") {
        value = tab?.url || "";
      } else if (expression === "document.readyState") {
        value = "complete";
      } else if (expression.includes('input[name="uh"]')) {
        value = null;
      }
      extension.send(JSON.stringify({ id: message.id, result: value === undefined
        ? {} : { result: { value } } }));
    }
  });
  try {
    await new Promise((resolve, reject) => { extension.once("open", resolve); extension.once("error", reject); });
    const reddit = await mcpTool(path.join(root, "src/index.js"), "reddit_login", temp);
    assert.match(JSON.stringify(reddit), /Reusing the signed-in Reddit session/);
    const x = await mcpTool(path.join(root, "x-easy/src/index.js"), "x_login", temp);
    assert.match(JSON.stringify(x), /Reusing the signed-in X session/);
    const youtube = new YouTubeBrowser({
      stateDir: path.join(temp, "youtube"),
      env: { LOCALAPPDATA: temp, XDG_DATA_HOME: temp, EASY_SOCIAL_BROWSER_MODE: "existing" },
    });
    assert.equal(await youtube.start(), PORT);
    assert.equal(youtube.usingExternalBrowser, true);
    assert.deepEqual(opened.map((tab) => new URL(tab.url).hostname), ["www.reddit.com", "x.com"]);
    assert.ok(commands.some((command) => command.method === "Runtime.evaluate"),
      "Plugins must actually inspect the signed-in page through the existing browser");
    assert.ok(!commands.some((command) => /get(?:All)?Cookies/.test(command.method)),
      "Signed-in detection must not extract cookies");
    signedIn = false;
    const guest = await mcpTool(path.join(root, "src/index.js"), "reddit_login", temp);
    assert.match(JSON.stringify(guest), /No signed-in Reddit session was accessible/);
    assert.equal(opened.at(-1).url, "https://www.reddit.com/login/");
  } finally {
    extension.close();
    await bridge.stop();
  }
});
