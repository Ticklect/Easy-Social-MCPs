import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

async function callMcp(entry, name, env) {
  const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out calling ${name}`)), 5000);
      let buf = "";
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        if (!buf.includes("\n")) return;
        clearTimeout(timeout);
        try { resolve(JSON.parse(buf.slice(0, buf.indexOf("\n")))); } catch (error) { reject(error); }
      });
      child.once("error", reject);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }) + "\n");
    });
  } finally {
    child.kill();
  }
}

test("Reddit and X open a tab in the connected browser, without launching a separate browser", async () => {
  const calls = [];
  let port = 0;
  const server = http.createServer((req, res) => {
    calls.push([req.method, req.url]);
    res.setHeader("content-type", "application/json");
    if (req.url === "/json/version") return res.end(JSON.stringify({
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/current`,
    }));
    if (req.url.startsWith("/json/new?")) return res.end(JSON.stringify({
      url: decodeURIComponent(req.url.slice("/json/new?".length)),
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/new`,
    }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  const root = fileURLToPath(new URL("..", import.meta.url));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "easy-social-browser-"));
  try {
    for (const [entry, name, state] of [
      [path.join(root, "src/index.js"), "reddit_login", "REDDIT_EASY_STATE_DIR"],
      [path.join(root, "x-easy/src/index.js"), "x_login", "X_EASY_STATE_DIR"],
    ]) {
      const message = await callMcp(entry, name, {
        EASY_SOCIAL_BROWSER_DEBUG_PORT: String(port),
        [state]: path.join(tmp, name),
      });
      assert.equal(message.result?.isError, undefined, JSON.stringify(message));
    }
    assert.equal(calls.filter(([method, url]) => method === "PUT" && url.startsWith("/json/new?")).length, 2);
    assert.equal(calls.filter(([method, url]) => method === "GET" && url === "/json/version").length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
