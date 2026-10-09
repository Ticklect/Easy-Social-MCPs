import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireLease } from "../src/coordination.js";

const worker = fileURLToPath(new URL("./coordination-worker.mjs", import.meta.url));

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "youtube-easy-coordination-"));
}

function run(mode, root, externalFile, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, mode, root, externalFile], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (!allowFailure && code !== 0) return reject(new Error(`${mode} failed code=${code} signal=${signal} stderr=${stderr}`));
      resolve({ code, signal, stdout: stdout.trim(), stderr });
    });
  });
}

function count(file, prefix = "external:") {
  try { return fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.startsWith(prefix)).length; }
  catch { return 0; }
}

test("two independent processes racing one upload invoke the external operation once", async () => {
  const root = tempRoot();
  const external = path.join(root, "external.log");
  const [a, b] = await Promise.all([run("race", root, external), run("race", root, external)]);
  assert.equal(count(external), 1);
  assert.deepEqual([JSON.parse(a.stdout).status, JSON.parse(b.stdout).status].sort(), ["reused", "success"]);
});

test("successful video identifiers and URLs persist for reuse by another process", async () => {
  const root = tempRoot();
  const external = path.join(root, "external.log");
  const first = JSON.parse((await run("reuse", root, external)).stdout);
  const second = JSON.parse((await run("reuse", root, external)).stdout);
  assert.equal(first.status, "success");
  assert.equal(second.status, "reused");
  assert.equal(second.result.videoId, "vid_existing");
  assert.equal(second.result.studioUrl, "https://studio.youtube.com/video/vid_existing/edit");
  assert.equal(second.result.publicUrl, "https://youtu.be/vid_existing");
  assert.equal(count(external), 1);
});

test("browser profile lease serializes independent processes", async () => {
  const root = tempRoot();
  const external = path.join(root, "profile.log");
  const [a, b] = await Promise.all([run("profile", root, external), run("profile", root, external)]);
  const ia = JSON.parse(a.stdout);
  const ib = JSON.parse(b.stdout);
  assert.ok(Math.min(ia.end, ib.end) - Math.max(ia.start, ib.start) <= 0);
});

test("stale filesystem lease is recovered after its owning process dies", async () => {
  const root = tempRoot();
  const external = path.join(root, "stale.log");
  const child = spawn(process.execPath, [worker, "hold-lock", root, external], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
      if (output.includes("locked")) resolve();
    });
    child.on("error", reject);
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.match((await run("recover-lock", root, external)).stdout, /recovered/);
});

test("an old heartbeat never steals a lease from a live owner process", async () => {
  const root = tempRoot();
  const lease = await acquireLease({ root, namespace: "live", key: "same", leaseMs: 100, waitMs: 500 });
  const leaseFile = path.join(lease.lockDir, "lease.json");
  const record = JSON.parse(fs.readFileSync(leaseFile, "utf8"));
  fs.writeFileSync(leaseFile, JSON.stringify({ ...record, heartbeatAt: Date.now() - 10_000 }));
  await assert.rejects(
    acquireLease({ root, namespace: "live", key: "same", leaseMs: 100, waitMs: 80 }),
    /Timed out/,
  );
  lease.release();
});

test("crash after upload dispatch reconciles found video without a duplicate", async () => {
  const root = tempRoot();
  const external = path.join(root, "found.log");
  const crashed = await run("crash-found", root, external, { allowFailure: true });
  assert.notEqual(crashed.code, 0);
  assert.equal(count(external), 1);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const second = JSON.parse((await run("race", root, external)).stdout);
  assert.equal(second.status, "reused");
  assert.equal(second.reconciled, true);
  assert.equal(second.result.videoId, "vid_existing");
  assert.equal(count(external), 1);
});

test("definite not-found reconciliation permits one safe retry", async () => {
  const root = tempRoot();
  const external = path.join(root, "miss.log");
  const crashed = await run("crash-miss", root, external, { allowFailure: true });
  assert.notEqual(crashed.code, 0);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const retried = JSON.parse((await run("retry-miss", root, external)).stdout);
  assert.equal(retried.status, "success");
  assert.equal(count(external), 1);
});

test("ambiguous outcome persists UNCERTAIN and never retries", async () => {
  const root = tempRoot();
  const external = path.join(root, "uncertain.log");
  const first = JSON.parse((await run("uncertain", root, external)).stdout);
  const second = JSON.parse((await run("uncertain", root, external)).stdout);
  assert.equal(first.status, "uncertain");
  assert.equal(second.status, "uncertain");
  assert.match(first.message, /^UNCERTAIN:/);
  assert.equal(count(external, "maybe:"), 1);
});

test("transient Windows rename sharing errors are retried without releasing or duplicating the lease", async () => {
  const root = tempRoot();
  const originalRename = fs.renameSync;
  let injected = 0;
  try {
    fs.renameSync = (from, to) => {
      if (String(to).endsWith("lease.json") && injected < 4) {
        injected++;
        const error = new Error("Sharing violation during atomic metadata replacement");
        error.code = ["EPERM", "EACCES", "EBUSY", "EPERM"][injected - 1];
        throw error;
      }
      return originalRename(from, to);
    };
    const lease = await acquireLease({ root, namespace: "rename-retry", key: "same", leaseMs: 1_000, waitMs: 1_000 });
    assert.equal(injected, 4);
    assert.equal(lease.update({ phase: "dispatch" }), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lease.lockDir, "lease.json"), "utf8")).phase, "dispatch");
    assert.equal(fs.readdirSync(lease.lockDir).some((name) => name.endsWith(".tmp")), false);
    lease.release();
    assert.equal(fs.existsSync(lease.lockDir), false);
  } finally {
    fs.renameSync = originalRename;
  }
});

test("permanent metadata rename failure fails closed and leaves no phantom lock or temp file", async () => {
  const root = tempRoot();
  const originalRename = fs.renameSync;
  let failures = 0;
  try {
    fs.renameSync = (from, to) => {
      if (String(to).endsWith("lease.json")) {
        failures++;
        const error = new Error("Persistent sharing violation");
        error.code = "EPERM";
        throw error;
      }
      return originalRename(from, to);
    };
    await assert.rejects(acquireLease({ root, namespace: "rename-failure", key: "same", leaseMs: 1_000, waitMs: 1_000 }), /Persistent sharing violation/);
    assert.equal(failures, 12);
  } finally {
    fs.renameSync = originalRename;
  }
  const locks = path.join(root, "coordination", "locks");
  assert.deepEqual(fs.readdirSync(locks), []);
  const lease = await acquireLease({ root, namespace: "rename-failure", key: "same", leaseMs: 1_000, waitMs: 1_000 });
  lease.release();
});
