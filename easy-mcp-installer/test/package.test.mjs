import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function zipNames(file) {
  const data = fs.readFileSync(file);
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(end, -1);
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  const names = [];
  for (let index = 0; index < count; index++) {
    assert.equal(data.readUInt32LE(offset), 0x02014b50);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    names.push(data.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

test("build creates a portable installer ZIP and matching checksum", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "easy-mcp-installer-build-"));
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "build.mjs"), "--out", output], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const archive = path.join(output, "easy-mcp-installer-v0.1.0.zip");
  const checksum = `${archive}.sha256`;
  assert.deepEqual(zipNames(archive), ["install-easy-mcp.mjs", "LICENSE", "package.json", "README.md"]);
  const hash = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  assert.equal(fs.readFileSync(checksum, "utf8"), `${hash}  easy-mcp-installer-v0.1.0.zip\n`);
});

test("release workflow tests all desktop platforms and refuses overwrite", () => {
  const workflow = fs.readFileSync(path.join(root, "..", ".github", "workflows", "build-easy-mcp-installer.yml"), "utf8");
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /macos-latest/);
  assert.match(workflow, /ubuntu-latest/);
  assert.match(workflow, /tags:\s*\["easy-mcp-installer-v\*"\]/);
  assert.match(workflow, /already exists.*refusing to overwrite/is);
  assert.doesNotMatch(workflow, /--clobber/);
});
