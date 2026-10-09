import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

test("packaged runtime exposes every original X tool without opening a browser", async () => {
  const child = spawn(process.execPath, [path.join(root, "dist", "index.js")], {
    cwd: root, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let seen = [];
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for X MCP tools/list")), 5_000);
      child.once("error", reject);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString("utf8");
        while (output.includes("\n")) {
          const i = output.indexOf("\n");
          const line = output.slice(0, i);
          output = output.slice(i + 1);
          if (line) seen.push(JSON.parse(line));
        }
        if (seen.some((message) => message.id === 2)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    });
    assert.equal(seen.find((x) => x.id === 1)?.result?.serverInfo?.version, manifest.version);
    assert.deepEqual(seen.find((x) => x.id === 2).result.tools.map((x) => x.name).sort(),
      manifest.tools.map((x) => x.name).sort());
  } finally {
    child.kill();
  }
});

function archiveEntries(filename) {
  const content = fs.readFileSync(filename);
  const entries = new Map();
  let offset = 0;
  while (content.readUInt32LE(offset) === 0x04034b50) {
    const compression = content.readUInt16LE(offset + 8);
    assert.equal(compression, 0, "MCPB should use deterministic uncompressed entries");
    const size = content.readUInt32LE(offset + 18);
    const filenameLength = content.readUInt16LE(offset + 26);
    const extraLength = content.readUInt16LE(offset + 28);
    const name = content.toString("utf8", offset + 30, offset + 30 + filenameLength);
    const contentAt = offset + 30 + filenameLength + extraLength;
    entries.set(name, content.subarray(contentAt, contentAt + size));
    offset = contentAt + size;
  }
  return entries;
}

test("MCPB ships the exact current dist and manifest, source archive includes tests", () => {
  const version = manifest.version;
  const bundle = archiveEntries(path.join(root, `x-easy-v${version}.mcpb`));
  const source = archiveEntries(path.join(root, `x-easy-v${version}-source.zip`));
  for (const name of ["dist/index.js", "dist/coordination.js", "manifest.json", "package.json", "README.md", "SECURITY.md"]) {
    assert.deepEqual(bundle.get(name), fs.readFileSync(path.join(root, name)), name);
  }
  assert.deepEqual(source.get("src/index.js"), fs.readFileSync(path.join(root, "src", "index.js")));
  assert.deepEqual(source.get("test/rate-limit.test.mjs"), fs.readFileSync(path.join(root, "test", "rate-limit.test.mjs")));
});
