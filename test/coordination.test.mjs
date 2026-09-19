import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("./coordination-worker.mjs", import.meta.url));

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "reddit-easy-coordination-"));
}

function run(mode, root, externalFile, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, mode, root, externalFile], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (!allowFailure && code !== 0) return reject(new Error(`${mode} failed code=${code} signal=${signal} stderr=${stderr}`));
      resolve({ code, signal, stdout: stdout.trim(), stderr, child });
    });
  });
}

function countExternal(file, prefix = "external:") {
  try { return fs.readFileSync(file, "utf8").split(/\r?\n/).filter((x) => x.startsWith(prefix)).length; }
  catch { return 0; }
}

test("two independent processes racing the same write allow one external write", async () => {
  const root = tempRoot();
  const external = path.join(root, "external.log");
  const [a, b] = await Promise.all([run("race", root, external), run("race", root, external)]);
  assert.equal(countExternal(external), 1);
  const statuses = [JSON.parse(a.stdout).status, JSON.parse(b.stdout).status].sort();
  assert.deepEqual(statuses, ["reused", "success"]);
});

test("persisted success is reused by a later independent process", async () => {
  const root = tempRoot();
  const external = path.join(root, "external.log");
  const first = JSON.parse((await run("reuse", root, external)).stdout);
  const second = JSON.parse((await run("reuse", root, external)).stdout);
  assert.equal(first.status, "success");
  assert.equal(second.status, "reused");
  assert.equal(second.result.fullname, "t1_created");
  assert.equal(countExternal(external), 1);
});

test("stale lease is recovered after the owning process dies", async () => {
  const root = tempRoot();
  const external = path.join(root, "external.log");
  const child = spawn(process.execPath, [worker, "hold-lock", root, external], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      if (buf.includes("locked")) resolve();
    });
    child.on("error", reject);
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 450));
  const recovered = await run("recover-lock", root, external);
  assert.match(recovered.stdout, /recovered/);
});

test("crash after external write reconciles instead of sending again", async () => {
  const root = tempRoot();
  const external = path.join(root, "external.log");
  const crashed = await run("crash", root, external, { allowFailure: true });
  assert.notEqual(crashed.code, 0);
  assert.equal(countExternal(external), 1);
  await new Promise((resolve) => setTimeout(resolve, 450));
  const second = JSON.parse((await run("race", root, external)).stdout);
  assert.equal(second.status, "reused");
  assert.equal(second.reconciled, true);
  assert.equal(second.result.fullname, "t1_existing");
  assert.equal(countExternal(external), 1);
});

test("unknown outcome is explicit uncertain and is not retried", async () => {
  const root = tempRoot();
  const external = path.join(root, "external.log");
  const first = JSON.parse((await run("uncertain", root, external)).stdout);
  assert.equal(first.status, "uncertain");
  const second = JSON.parse((await run("uncertain", root, external)).stdout);
  assert.equal(second.status, "uncertain");
  assert.equal(countExternal(external, "maybe:"), 1);
});

test("browser-profile lease serializes two independent processes", async () => {
  const root = tempRoot();
  const external = path.join(root, "profile.log");
  const [a, b] = await Promise.all([run("profile", root, external), run("profile", root, external)]);
  const ia = JSON.parse(a.stdout);
  const ib = JSON.parse(b.stdout);
  const overlap = Math.min(ia.end, ib.end) - Math.max(ia.start, ib.start);
  assert.ok(overlap <= 0, `profile leases overlapped by ${overlap}ms`);
});
