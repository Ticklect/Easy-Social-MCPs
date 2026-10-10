import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import test from "node:test";

const packageDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageDir, "..");
const expectedVersion = "0.1.3";
const archivePath = path.join(packageDir, `easy-social-mcps-v${expectedVersion}.zip`);
const checksumPath = `${archivePath}.sha256`;

const expectedBundleSources = new Map(["reddit-easy", "x-easy", "tiktok-easy", "youtube-easy"].map((name) => {
  const dir = name === "reddit-easy" ? repoRoot : path.join(repoRoot, name);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const file = `${name}-v${manifest.version}.mcpb`;
  return [file, path.join(dir, file)];
}));

function readZipEntries(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(eocd, -1, "ZIP end-of-central-directory record is missing");
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, "invalid central-directory entry");
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `invalid local header for ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(start, start + compressedSize);
    const data = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
    assert.ok(data, `unsupported compression method ${method} for ${name}`);
    entries.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

test("all-in-one build packages the installer and exact released bytes for all four MCPs reproducibly", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "easy-social-mcps-build-"));
  const builtArchivePath = path.join(output, `easy-social-mcps-v${expectedVersion}.zip`);
  const builtChecksumPath = `${builtArchivePath}.sha256`;
  const first = spawnSync(process.execPath, ["scripts/build.mjs", "--out", output], { cwd: packageDir, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const firstArchive = fs.readFileSync(builtArchivePath);
  const second = spawnSync(process.execPath, ["scripts/build.mjs", "--out", output], { cwd: packageDir, encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const secondArchive = fs.readFileSync(builtArchivePath);
  assert.equal(sha256(secondArchive), sha256(firstArchive), "two builds must be byte-for-byte identical");
  assert.equal(sha256(fs.readFileSync(archivePath)), sha256(firstArchive), "committed all-in-one ZIP must match a clean rebuild");
  assert.equal(fs.readFileSync(checksumPath, "utf8"), fs.readFileSync(builtChecksumPath, "utf8"), "committed checksum must match a clean rebuild");

  const entries = readZipEntries(firstArchive);
  assert.deepEqual([...entries.keys()].sort(), [
    "LICENSE",
    "README.md",
    "SHA256SUMS.txt",
    "install-easy-mcp.mjs",
    "browser-companion/README.md",
    "browser-companion/server.mjs",
    "browser-companion/package.json",
    "browser-companion/package-lock.json",
    "browser-companion/extension/manifest.json",
    "browser-companion/extension/background.js",
    "browser-companion/extension/popup.html",
    "browser-companion/extension/popup.js",
    "browser-companion/test/bridge.test.mjs",
    ...expectedBundleSources.keys(),
  ].sort());
  const guide = entries.get("README.md").toString("utf8");
  const installLine = guide.split(/\r?\n/).find((line) => line.startsWith("node install-easy-mcp.mjs --host both ")) || "";
  for (const filename of expectedBundleSources.keys()) {
    assert.ok(installLine.includes(filename), `README install command must include ${filename}`);
  }
  assert.match(entries.get("install-easy-mcp.mjs").toString("utf8"), /Easy MCP Installer/);
  for (const name of ["LICENSE", "README.md", "SHA256SUMS.txt", "install-easy-mcp.mjs"]) {
    assert.equal(entries.get(name).includes(13), false, `${name} must use portable LF line endings`);
  }

  const checksumLines = entries.get("SHA256SUMS.txt").toString("utf8").trim().split(/\r?\n/).sort();
  const expectedChecksumLines = [];
  for (const [name, source] of expectedBundleSources) {
    const expected = fs.readFileSync(source);
    assert.equal(sha256(entries.get(name)), sha256(expected), `${name} must match its released repository artifact`);
    const pluginEntries = readZipEntries(expected);
    assert.ok(pluginEntries.has("manifest.json"), `${name} must contain a plugin manifest`);
    const nestedManifest = JSON.parse(pluginEntries.get("manifest.json").toString("utf8"));
    assert.equal(name, `${nestedManifest.name}-v${nestedManifest.version}.mcpb`, `${name} must match the packaged identity and version`);
    expectedChecksumLines.push(`${sha256(expected)}  ${name}`);
  }
  expectedChecksumLines.push(`${sha256(entries.get("install-easy-mcp.mjs"))}  install-easy-mcp.mjs`);
  assert.deepEqual(checksumLines, expectedChecksumLines.sort());

  const outerHash = sha256(firstArchive);
  assert.equal(fs.readFileSync(builtChecksumPath, "utf8"), `${outerHash}  easy-social-mcps-v${expectedVersion}.zip\n`);
});

test("all-in-one release gate validates the installer and exact release version", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "build-easy-social-mcps.yml"), "utf8");
  assert.match(workflow, /npm --prefix easy-mcp-installer run check/);
  assert.match(workflow, /npm --prefix easy-mcp-installer test/);
  assert.match(workflow, /package\.json/);
  assert.match(workflow, /easy-social-mcps-v\$VERSION/);

  const installerWorkflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "build-easy-mcp-installer.yml"), "utf8");
  assert.match(installerWorkflow, /package\.json/);
  assert.match(installerWorkflow, /easy-mcp-installer-v\$VERSION/);
});

test("published component releases refuse to overwrite existing immutable assets", () => {
  const reddit = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "publish-reddit-v031.yml"), "utf8");
  assert.doesNotMatch(reddit, /gh release upload[^\n]*--clobber/);
  assert.match(reddit, /already exists.*refus/i);
  assert.ok(
    reddit.indexOf("gh release view") < reddit.indexOf("git add reddit-easy.mcpb"),
    "v0.3.1 immutable-release guard must run before committing generated artifacts",
  );

  const legacy = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "publish-easy-releases.yml"), "utf8");
  assert.doesNotMatch(legacy, /gh release upload[^\n]*reddit-easy-v0\.3\.0[^\n]*--clobber/);
  const legacyGuard = legacy.indexOf('gh release view "$tag"');
  assert.ok(
    legacyGuard >= 0 && legacyGuard < legacy.indexOf("git add src/index.js"),
    "v0.3.0 immutable-release guard must run before committing generated artifacts",
  );
});
