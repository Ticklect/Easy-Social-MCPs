import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const canonical = (data) => Buffer.from(data.toString("utf8").replace(/\r\n/g, "\n"), "utf8");

function zipEntries(file) {
  const data = fs.readFileSync(file);
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(end, -1, "ZIP end record");
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(data.readUInt32LE(offset), 0x02014b50, "central directory entry");
    const size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, data.subarray(start, start + size));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function smoke(entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`packaged smoke timed out: ${stderr}`)); }, 5_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      if (code !== 0 || lines.length !== 2) {
        reject(new Error(`packaged MCP expected 2 replies; got ${lines.length} (exit=${code}, signal=${signal}). stderr=${stderr}`));
        return;
      }
      resolve(lines.map(JSON.parse));
    });
    // Keep stdin open until both async MCP responses have been flushed.
    // Closing stdin immediately races server shutdown on faster CI runners.
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    child.stdout.on("data", () => {
      if (stdout.split(/\r?\n/).filter(Boolean).length >= 2) child.stdin.end();
    });
  });
}

test("build creates a self-contained MCPB, source ZIP, and matching SHA-256", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-easy-package-"));
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "build.mjs"), "--out", work], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);

  const mcpb = path.join(work, "youtube-easy-v0.1.4.mcpb");
  const source = path.join(work, "youtube-easy-v0.1.4-source.zip");
  const checksum = path.join(work, "youtube-easy-v0.1.4.mcpb.sha256");
  for (const file of [mcpb, source, checksum]) assert.equal(fs.statSync(file).isFile(), true, file);

  const entries = zipEntries(mcpb);
  for (const name of ["manifest.json", "package.json", "README.md", "SECURITY.md", "LICENSE", "THIRD_PARTY_LICENSES.md", "dist/server.js", "dist/browser.js", "dist/coordination.js", "dist/studio.js"]) {
    assert.equal(entries.has(name), true, name);
  }
  for (const name of fs.readdirSync(path.join(root, "src"))) {
    assert.deepEqual(entries.get(`dist/${name}`), canonical(fs.readFileSync(path.join(root, "src", name))), `packaged runtime ${name} must match checked-in source`);
  }
  assert.equal(JSON.parse(entries.get("manifest.json")).version, "0.1.4");
  assert.equal(JSON.parse(entries.get("manifest.json")).tools.length, 17);
  const sourceEntries = zipEntries(source);
  assert.equal(sourceEntries.has(".github/workflows/build-youtube-easy.yml"), true);
  assert.equal(sourceEntries.has("docs/youtube-easy-design.md"), true);
  assert.equal(sourceEntries.has("docs/youtube-easy-plan.md"), true);

  const actualHash = crypto.createHash("sha256").update(fs.readFileSync(mcpb)).digest("hex");
  assert.match(fs.readFileSync(checksum, "utf8"), new RegExp(`^${actualHash}  youtube-easy-v0\\.1\\.4\\.mcpb\\s*$`));

  const unpack = path.join(work, "unpack");
  for (const [name, bytes] of entries) {
    const target = path.join(unpack, ...name.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  const responses = await smoke(path.join(unpack, "dist", "server.js"));
  assert.equal(responses.find((item) => item.id === 1).result.serverInfo.version, "0.1.4");
  assert.equal(responses.find((item) => item.id === 2).result.tools.length, 17);

  // Reproduce realpath/argv mismatches such as macOS /var -> /private/var.
  const alias = path.join(work, "alias");
  try {
    fs.symlinkSync(unpack, alias, process.platform === "win32" ? "junction" : "dir");
    const aliased = await smoke(path.join(alias, "dist", "server.js"));
    assert.equal(aliased.find((item) => item.id === 1).result.serverInfo.version, "0.1.4");
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
  }
});

test("release workflow is immutable and tag-triggered", () => {
  const workflow = fs.readFileSync(path.join(root, "..", ".github", "workflows", "build-youtube-easy.yml"), "utf8");
  assert.match(workflow, /tags:\s*\["youtube-easy-v\*"\]/);
  assert.doesNotMatch(workflow, /--clobber/);
  assert.match(workflow, /already exists.*Refusing to overwrite/is);
});
