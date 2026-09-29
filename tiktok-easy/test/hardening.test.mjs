import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..");
const tiktokDir = path.join(root, "tiktok-easy");
const version = "0.1.1";
const sourceZip = path.join(tiktokDir, `tiktok-easy-v${version}-source.zip`);
const mcpb = path.join(tiktokDir, `tiktok-easy-v${version}.mcpb`);
const workflowPath = path.join(root, ".github", "workflows", "build-tiktok-easy.yml");
const packagerPath = path.join(tiktokDir, "scripts", "package-release.mjs");

function zipEntries(file) {
  const buffer = fs.readFileSync(file);
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(eocd, -1, `${path.basename(file)} is missing a ZIP end record`);
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, `invalid ZIP central entry ${index}`);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `invalid local ZIP header for ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(start, start + compressedSize);
    const data = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
    assert.ok(data, `unsupported ZIP compression method ${method} for ${name}`);
    entries.set(name.replaceAll("\\", "/"), data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function zipCentralMetadata(file) {
  const buffer = fs.readFileSync(file);
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(eocd, -1, `${path.basename(file)} is missing a ZIP end record`);
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const records = [];
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, `invalid ZIP central entry ${index}`);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    records.push({
      name: buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8").replaceAll("\\", "/"),
      dosTime: buffer.readUInt16LE(cursor + 12),
      dosDate: buffer.readUInt16LE(cursor + 14),
      externalAttributes: buffer.readUInt32LE(cursor + 38),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return records;
}

function text(entries, name) {
  const value = entries.get(name);
  assert.ok(value, `missing ${name}`);
  return value.toString("utf8");
}

function waitForLine(child, expected, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}; stdout=${output}`)), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.split(/\r?\n/).includes(expected)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (output.split(/\r?\n/).includes(expected)) return;
      clearTimeout(timer);
      reject(new Error(`Process exited ${code} before ${expected}; stdout=${output}`));
    });
  });
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null) {
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error(`Child already exited code=${child.exitCode} signal=${child.signalCode}`));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for child process")), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`Child exited code=${code} signal=${signal}`));
    });
  });
}

test("shipped TikTok connect tools do not expose a model-controlled browser executable path", () => {
  const source = zipEntries(sourceZip);
  const packaged = zipEntries(mcpb);
  assert.doesNotMatch(text(source, "src/server.ts"), /browser_path/);
  assert.doesNotMatch(text(source, "src/runtime/local-runtime.ts"), /input\.browser_path|browser_path\??:/);
  assert.doesNotMatch(text(packaged, "app/dist/server.js"), /browser_path/);
  assert.doesNotMatch(text(packaged, "app/dist/runtime/local-runtime.js"), /browser_path/);
});

test("TikTok hardening ships as immutable v0.1.1 rather than replacing v0.1.0", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(tiktokDir, "manifest.json"), "utf8"));
  assert.equal(manifest.version, version);
  const source = zipEntries(sourceZip);
  assert.match(text(source, "src/server.ts"), /version: "0\.1\.1"/);
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.match(workflow, /tag="tiktok-easy-v0\.1\.1"/);
  assert.match(workflow, /tiktok-easy-v0\.1\.1\.mcpb/);
  assert.ok(fs.existsSync(path.join(tiktokDir, "tiktok-easy-v0.1.0.mcpb")), "v0.1.0 MCPB must remain in the repository");
  assert.ok(fs.existsSync(path.join(tiktokDir, "tiktok-easy-v0.1.0-source.zip")), "v0.1.0 source ZIP must remain in the repository");
});

test("shipped TikTok runtime uses the cross-process lock in both state updates and persistent profiles", async () => {
  const source = zipEntries(sourceZip);
  const packaged = zipEntries(mcpb);
  const storeSource = text(source, "src/runtime/store.ts");
  const browserSource = text(source, "src/runtime/social-runtime.ts");
  assert.match(storeSource, /withFileLockSync/);
  assert.match(browserSource, /acquireFileLock/);

  const lockModule = packaged.get("app/dist/runtime/file-lock.js");
  assert.ok(lockModule, "packaged runtime must include app/dist/runtime/file-lock.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiktok-lock-test-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    fs.mkdirSync(runtimeDir);
    const modulePath = path.join(runtimeDir, "file-lock.js");
    const storePath = path.join(runtimeDir, "store.js");
    const workerPath = path.join(dir, "worker.mjs");
    const stateWorkerPath = path.join(dir, "state-worker.mjs");
    const lockPath = path.join(dir, "shared.lock");
    fs.writeFileSync(modulePath, lockModule);
    fs.writeFileSync(storePath, packaged.get("app/dist/runtime/store.js"));
    fs.writeFileSync(workerPath, `
      import { acquireFileLock } from ${JSON.stringify(pathToFileURL(modulePath).href)};
      const release = await acquireFileLock(process.env.LOCK_PATH, { timeoutMs: 4000, pollMs: 20 });
      console.log("locked");
      if (process.env.HOLD_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.HOLD_MS)));
      release();
      console.log("released");
    `);
    fs.writeFileSync(stateWorkerPath, `
      const { upsertAccount } = await import(${JSON.stringify(pathToFileURL(storePath).href)});
      upsertAccount({ id: process.argv[2], status: "active" });
    `);

    const holder = spawn(process.execPath, [workerPath], {
      env: { ...process.env, LOCK_PATH: lockPath, HOLD_MS: "450" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForLine(holder, "locked");

    const started = Date.now();
    const waiter = spawn(process.execPath, [workerPath], {
      env: { ...process.env, LOCK_PATH: lockPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForLine(waiter, "locked");
    const waitedMs = Date.now() - started;
    assert.ok(waitedMs >= 300, `second process acquired a held profile lock after only ${waitedMs}ms`);
    await Promise.all([waitForExit(holder), waitForExit(waiter)]);

    const stateDir = path.join(dir, "state");
    const stateWorkers = Array.from({ length: 16 }, (_, index) => spawn(process.execPath, [stateWorkerPath, `account-${index}`], {
      env: { ...process.env, TIKTOK_MCP_DATA_DIR: stateDir },
      stdio: "ignore",
    }));
    await Promise.all(stateWorkers.map((child) => waitForExit(child, 10_000)));
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    assert.deepEqual(
      state.accounts.map((account) => account.id).sort(),
      Array.from({ length: 16 }, (_, index) => `account-${index}`).sort(),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TikTok release publishing never clobbers an existing release asset", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.doesNotMatch(workflow, /gh release upload[^\n]*--clobber/);
  assert.match(workflow, /gh release download "\$tag"/);
  assert.match(workflow, /sha256sum --check/);
  const releaseGuard = workflow.indexOf('gh release view "$tag"');
  const artifactCommit = workflow.indexOf("git add tiktok-easy/tiktok-easy-v0.1.1.mcpb");
  assert.ok(releaseGuard >= 0 && artifactCommit >= 0 && releaseGuard < artifactCommit,
    "existing v0.1.1 release must be checked before artifact commit/push");
  assert.match(workflow, /- name: Commit artifacts\s+if: steps\.release_guard\.outputs\.exists != 'true'/,
    "existing v0.1.1 release must skip artifact commit/push after successful verification");
});

test("TikTok release packager is byte-for-byte deterministic and excludes node_modules .bin shims", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiktok-package-test-"));
  try {
    const packageRoot = path.join(dir, "package");
    const sourceRoot = path.join(dir, "source");
    const outA = path.join(dir, "out-a");
    const outB = path.join(dir, "out-b");
    fs.mkdirSync(path.join(packageRoot, "app", "dist"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "app", "node_modules", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "app", "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "manifest.json"), '{"version":"0.1.1"}\n');
    fs.writeFileSync(path.join(packageRoot, "app", "dist", "index.js"), "console.log('ok');\n");
    fs.writeFileSync(path.join(packageRoot, "app", "node_modules", "pkg", "index.js"), "export default 1;\n");
    fs.writeFileSync(path.join(packageRoot, "app", "node_modules", ".bin", "tool"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(packageRoot, "app", "node_modules", ".bin", "tool.cmd"), "@echo off\r\n");
    fs.writeFileSync(path.join(packageRoot, "app", "node_modules", ".bin", "tool.ps1"), "Write-Output ok\r\n");

    fs.mkdirSync(path.join(sourceRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "src", "index.ts"), "export {};\n");
    for (const name of ["package.json", "package-lock.json", "tsconfig.json", "README.md", "LICENSE", "SKILL.md", "server.json"]) {
      fs.writeFileSync(path.join(sourceRoot, name), `${name}\n`);
    }

    for (const [index, outDir] of [outA, outB].entries()) {
      if (index === 1) {
        const changedTime = new Date("2026-09-28T21:59:59Z");
        fs.writeFileSync(path.join(packageRoot, "app", "dist", "index.js"), "console.log('ok');\r\n");
        fs.writeFileSync(path.join(sourceRoot, "src", "index.ts"), "export {};\r\n");
        fs.utimesSync(path.join(packageRoot, "app", "dist", "index.js"), changedTime, changedTime);
        fs.utimesSync(path.join(sourceRoot, "src", "index.ts"), changedTime, changedTime);
      }
      const built = spawnSync(process.execPath, [
        packagerPath,
        "--package-root", packageRoot,
        "--source-root", sourceRoot,
        "--out-dir", outDir,
        "--version", version,
      ], { encoding: "utf8" });
      assert.equal(built.status, 0, built.stderr || built.stdout);
    }

    const aMcpb = fs.readFileSync(path.join(outA, `tiktok-easy-v${version}.mcpb`));
    const bMcpb = fs.readFileSync(path.join(outB, `tiktok-easy-v${version}.mcpb`));
    const aSource = fs.readFileSync(path.join(outA, `tiktok-easy-v${version}-source.zip`));
    const bSource = fs.readFileSync(path.join(outB, `tiktok-easy-v${version}-source.zip`));
    assert.deepEqual(aMcpb, bMcpb, "MCPB rebuilds must be byte-for-byte identical");
    assert.deepEqual(aSource, bSource, "source ZIP rebuilds must be byte-for-byte identical");

    const packaged = zipEntries(path.join(outA, `tiktok-easy-v${version}.mcpb`));
    assert.ok(packaged.has("app/node_modules/pkg/index.js"));
    assert.ok([...packaged.keys()].every((name) => !name.startsWith("app/node_modules/.bin/")));
    const metadata = zipCentralMetadata(path.join(outA, `tiktok-easy-v${version}.mcpb`));
    assert.ok(metadata.length > 0);
    assert.ok(metadata.every((record) => record.dosTime === 0 && record.dosDate === 33),
      "all ZIP entries must use 1980-01-01 00:00:00 DOS timestamps");
    assert.ok(metadata.every((record) => record.externalAttributes === ((0o100644 << 16) >>> 0)),
      "all ZIP entries must use fixed regular-file 0644 attributes");

    const workflow = fs.readFileSync(workflowPath, "utf8");
    assert.match(workflow, /node tiktok-easy\/scripts\/package-release\.mjs/);
    assert.doesNotMatch(workflow, /\bzip\s+-X\b/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TikTok MCPB checksum matches the shipped artifact", () => {
  const line = fs.readFileSync(`${mcpb}.sha256`, "utf8").trim();
  const expected = crypto.createHash("sha256").update(fs.readFileSync(mcpb)).digest("hex");
  assert.equal(line, `${expected}  tiktok-easy-v${version}.mcpb`);
});
