import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { coordinatedXWrite, isProcessAlive, noteHttpResponse, paceRead, retryAfterMs, withLease } from "../src/coordination.js";

function rootFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "x-easy-safe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Retry-After requires a bounded valid form", () => {
  const at = Date.parse("2026-10-09T12:00:00Z");
  assert.equal(retryAfterMs(" 2.5 ", at), 2500);
  assert.equal(retryAfterMs("Fri, 09 Oct 2026 12:01:00 GMT", at), 60_000);
  for (const invalid of ["garbage", "NaN", "-2", "2h", "12abc", "1e3", "10000000000000000000000000000000"]) {
    if (invalid.startsWith("100")) assert.equal(retryAfterMs(invalid, at), 86_400_000);
    else assert.equal(retryAfterMs(invalid, at), null);
  }
});

test("first-party 429/503 observations persist cooldowns and block further browser steps", async (t) => {
  const root = rootFor(t);
  await paceRead(root, { gapMs: 0 });
  assert.equal(noteHttpResponse(root, { status: 400, retryAfter: "100" }), false);
  assert.equal(noteHttpResponse(root, { status: 429, retryAfter: "120" }), true);
  await assert.rejects(paceRead(root, { gapMs: 0 }), /cooldown/);
  const persisted = JSON.parse(fs.readFileSync(path.join(root, "coordination", "requests.json")));
  assert.ok(persisted.cooldownUntil > Date.now() + 110_000);
  const other = rootFor(t);
  noteHttpResponse(other, { status: 503, retryAfter: "invalid" });
  await assert.rejects(paceRead(other, { gapMs: 0 }), /cooldown/);
});

test("navigations are paced between uses of the same profile", async (t) => {
  const root = rootFor(t);
  const start = Date.now();
  await paceRead(root, { gapMs: 70 });
  await paceRead(root, { gapMs: 70 });
  assert.ok(Date.now() - start >= 60);
});

test("pre-click failure does not poison future same-intent attempt", async (t) => {
  const root = rootFor(t);
  const input = { root, account: "user-100", fingerprint: "pre-click", minGapMs: 0, jitterMs: 0 };
  await assert.rejects(coordinatedXWrite({ ...input, operation: async () => { throw new Error("composer missing"); } }), /composer missing/);
  const result = await coordinatedXWrite({ ...input, operation: async (mark) => { await mark(); return "posted"; } });
  assert.equal(result, "posted");
});

test("uncertain click cannot be automatically submitted again", async (t) => {
  const root = rootFor(t);
  const input = { root, account: "user-100", fingerprint: "uncertain", minGapMs: 0, jitterMs: 0 };
  let calls = 0;
  const first = await coordinatedXWrite({ ...input, operation: async (mark) => {
    await mark(); calls++; throw new Error("CDP dropped before confirmation");
  } });
  assert.match(first, /^UNCERTAIN:/);
  const again = await coordinatedXWrite({ ...input, operation: async () => { calls++; return "duplicate"; } });
  assert.match(again, /^UNCERTAIN:/);
  assert.equal(calls, 1);
});

test("429 observed during a UI write cannot be mistaken for a confirmed action", async (t) => {
  const root = rootFor(t);
  let clicks = 0;
  const config = { root, account: "user-101", fingerprint: "request-throttled", minGapMs: 0, jitterMs: 0 };
  const result = await coordinatedXWrite({ ...config, operation: async (mark) => {
    await mark();
    clicks++;
    noteHttpResponse(root, { status: 429, retryAfter: "120" });
    return "Posted to X.";
  } });
  assert.match(result, /^UNCERTAIN:/);
  const retry = await coordinatedXWrite({ ...config, operation: async () => { clicks++; return "unsafe retry"; } });
  assert.match(retry, /^UNCERTAIN:/);
  assert.equal(clicks, 1);
});

test("confirmed identical write reused and account attempts capped across fingerprints", async (t) => {
  const root = rootFor(t);
  let dispatched = 0;
  const base = { root, account: "user-200", maxAttempts: 2, minGapMs: 0, jitterMs: 0 };
  const send = (fingerprint) => coordinatedXWrite({ ...base, fingerprint,
    operation: async (mark) => { await mark(); dispatched++; return fingerprint; } });
  assert.equal(await send("A"), "A");
  assert.match(await send("A"), /Reused the prior/);
  assert.equal(await send("B"), "B");
  await assert.rejects(send("C"), /2 write attempts per hour/);
  assert.equal(dispatched, 2);
  const another = await coordinatedXWrite({ ...base, account: "user-201", fingerprint: "C",
    operation: async (mark) => { await mark(); return "account-separated"; } });
  assert.equal(another, "account-separated");
});

test("minimum write gap is measured just before click, not tool invocation", async (t) => {
  const root = rootFor(t);
  const base = { root, account: "user-300", minGapMs: 110, jitterMs: 0, maxWaitMs: 500 };
  const at = [];
  for (let i = 0; i < 3; i++) {
    await coordinatedXWrite({ ...base, fingerprint: String(i), operation: async (mark) => {
      await new Promise((resolve) => setTimeout(resolve, i === 1 ? 20 : 0));
      await mark();
      at.push(Date.now());
      return "ok";
    } });
  }
  assert.ok(at[1] - at[0] >= 100, String(at));
  assert.ok(at[2] - at[1] >= 100, String(at));
});

test("two distinct Node processes cannot duplicate one X click", async (t) => {
  const root = rootFor(t);
  const file = path.join(root, "clicks.log");
  const worker = fileURLToPath(new URL("./rate-worker.mjs", import.meta.url));
  const launch = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [worker, root, file], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (x) => { out += x; });
    p.stderr.on("data", (x) => { err += x; });
    p.on("error", reject);
    p.on("exit", (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  });
  const both = await Promise.all([launch(), launch()]);
  assert.deepEqual(both.map((x) => x.response?.includes("posted")).sort(), [true, true]);
  assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 1);
});

test("PID liveness is conservative when a process cannot be inspected", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(null), true, "Unknown PID must be treated as potentially alive");
  assert.equal(isProcessAlive(process.pid, () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); }), true);
  assert.equal(isProcessAlive(process.pid, () => { throw Object.assign(new Error("missing"), { code: "ESRCH" }); }), false);
  assert.equal(isProcessAlive(process.pid, () => { throw new Error("unexpected probe failure"); }), true);
});

function launchLeaseWorker(root, activity, mode) {
  const worker = fileURLToPath(new URL("./lease-worker.mjs", import.meta.url));
  const child = spawn(process.execPath, [worker, mode, root, activity], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const acquired = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (data) => {
      output += data;
      if (output.includes("acquired\n")) resolve();
    });
    child.once("exit", (code) => {
      if (!output.includes("acquired\n")) reject(new Error(`Lease owner exited early (${code})`));
    });
  });
  const completed = new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
  return { child, acquired, completed };
}

test("expired heartbeat cannot steal a lease from a live process whose event loop is paused", async (t) => {
  const root = rootFor(t);
  const activity = path.join(root, "lease-activity.log");
  const holder = launchLeaseWorker(root, activity, "pause-live");
  t.after(() => { try { holder.child.kill(); } catch {} });
  await holder.acquired;
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  await assert.rejects(
    withLease(root, "live-process", "same-profile", async () => {
      fs.appendFileSync(activity, "WRONG-SECOND-OWNER\n");
    }, { leaseMs: 150, waitMs: 250 }),
    /Timed out waiting/,
  );
  const outcome = await holder.completed;
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(fs.readFileSync(activity, "utf8"), "owner-completed\n");
  const result = await withLease(root, "live-process", "same-profile", async () => "safe-after-release",
    { leaseMs: 150, waitMs: 2_000 });
  assert.equal(result, "safe-after-release");
});

test("a dead owner can be reclaimed after heartbeat expiry without duplicating a live holder", async (t) => {
  const root = rootFor(t);
  const holder = launchLeaseWorker(root, path.join(root, "unused.log"), "crash");
  t.after(() => { try { holder.child.kill(); } catch {} });
  await holder.acquired;
  const outcome = await holder.completed;
  assert.equal(outcome.code, 51);
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  const result = await withLease(root, "live-process", "same-profile", async () => "recovered",
    { leaseMs: 150, waitMs: 2_000 });
  assert.equal(result, "recovered");
});

test("fresh ownerless reclaim claims stay exclusive; abandoned claims recover across processes", async (t) => {
  const root = rootFor(t);
  const lockDir = path.join(root, "coordination", "locks");
  const digest = crypto.createHash("sha256").update("same-profile").digest("hex");
  const claim = path.join(lockDir, `live-process-${digest}.lock.reaping`);
  fs.mkdirSync(claim, { recursive: true });

  // A different process must not take over a just-created claim whose writer
  // has not yet had time to populate owner.json.
  const fresh = launchLeaseWorker(root, path.join(root, "unused.log"), "probe");
  // A blocked probe is expected to exit without signalling "acquired".
  void fresh.acquired.catch(() => {});
  t.after(() => { try { fresh.child.kill(); } catch {} });
  const blocked = await fresh.completed;
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.stderr, /Timed out waiting/);
  assert.equal(fs.existsSync(claim), true);

  // Model a crash between mkdir and owner metadata persistence. Reclaim only
  // once the claim's conservative ownerless grace has genuinely elapsed.
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(claim, old, old);
  const survivor = launchLeaseWorker(root, path.join(root, "unused.log"), "recover-claim");
  t.after(() => { try { survivor.child.kill(); } catch {} });
  await survivor.acquired;
  const recovered = await survivor.completed;
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(fs.existsSync(claim), false);
});
