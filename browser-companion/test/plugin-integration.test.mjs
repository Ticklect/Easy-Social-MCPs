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
      const timeout = setTimeout(() => reject(new Error(`${tool} timed out`)), 4500);
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
  extension.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "list") extension.send(JSON.stringify({ id: message.id, result: opened }));
    if (message.type === "open") {
      const tab = { id: opened.length + 11, url: message.url, title: "Social tab" };
      opened.push(tab);
      extension.send(JSON.stringify({ id: message.id, result: tab }));
    }
  });
  try {
    await new Promise((resolve, reject) => { extension.once("open", resolve); extension.once("error", reject); });
    await mcpTool(path.join(root, "src/index.js"), "reddit_login", temp);
    await mcpTool(path.join(root, "x-easy/src/index.js"), "x_login", temp);
    const youtube = new YouTubeBrowser({
      stateDir: path.join(temp, "youtube"),
      env: { LOCALAPPDATA: temp, XDG_DATA_HOME: temp, EASY_SOCIAL_BROWSER_MODE: "existing" },
    });
    assert.equal(await youtube.start(), PORT);
    assert.equal(youtube.usingExternalBrowser, true);
    assert.deepEqual(opened.map((tab) => new URL(tab.url).hostname), ["www.reddit.com", "x.com"]);
  } finally {
    extension.close();
    await bridge.stop();
  }
});
