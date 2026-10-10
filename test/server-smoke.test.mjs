import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

test("packaged runtime loads and advertises Reddit tools over MCP", async () => {
  const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
  let timeout;
  try {
    const replies = new Promise((resolve, reject) => {
      const messages = new Map();
      let buffer = "";
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const message = JSON.parse(line);
          messages.set(message.id, message);
          if (messages.has(1) && messages.has(2)) resolve(messages);
        }
      });
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`MCP exited before reply (code ${code})`)));
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    const messages = await Promise.race([
      replies,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("MCP response timeout")), 5_000); }),
    ]);
    assert.equal(messages.get(1).result.serverInfo.version, "0.3.3");
    assert.equal(messages.get(2).result.tools.length, 22);
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
});
