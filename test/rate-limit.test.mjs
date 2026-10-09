import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  coordinatedRedditRequest,
  coordinatedWrite,
  KnownWriteFailure,
  redditResponseCooldown,
  retryAfterMs,
} from "../src/coordination.js";

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reddit-easy-rate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ok = { ok: true, status: 200, rateLimit: {} };

test("parses Retry-After in both seconds and HTTP-date forms", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  assert.equal(retryAfterMs("2.5", now), 2500);
  assert.equal(retryAfterMs("Fri, 09 Oct 2026 12:01:00 GMT", now), 60_000);
  assert.equal(retryAfterMs("invalid", now), null);
});

test("respects low remaining budget and rejects Reddit JSON RATELIMIT errors", () => {
  assert.equal(redditResponseCooldown({ status: 200, rateLimit: { remaining: "0", reset: "8" } }).cooldownMs, 9_000);
  assert.equal(redditResponseCooldown({ status: 200, rateLimit: { remaining: "8", reset: "120" } }).extraGapMs, Math.ceil(120_000 / 7));
  const soft = redditResponseCooldown({ status: 200, data: { json: { errors: [["RATELIMIT", "try again in 3 minutes", "ratelimit"]] } } });
  assert.equal(soft.cooldownMs, 3 * 60_000);
  assert.equal(soft.throttled, true);
});

test("all reads share a minimum dispatch gap, including concurrent calls", async (t) => {
  const root = tempRoot(t);
  const dispatched = [];
  const run = () => coordinatedRedditRequest({ root, gapMs: 80, maxWaitMs: 500, request: async () => {
    dispatched.push(Date.now());
    return ok;
  } });
  await Promise.all([run(), run(), run()]);
  assert.equal(dispatched.length, 3);
  for (let i = 1; i < dispatched.length; i++) {
    assert.ok(dispatched[i] - dispatched[i - 1] >= 68, `gap=${dispatched[i] - dispatched[i - 1]}ms`);
  }
});

test("write spacing is enforced at actual HTTP dispatch rather than before preparation", async (t) => {
  const root = tempRoot(t);
  const dispatches = [];
  const sendWrite = () => coordinatedRedditRequest({ root, gapMs: 0, write: true, writeGapMs: 110,
    maxWaitMs: 500, request: async () => { dispatches.push(Date.now()); return ok; } });
  await Promise.all([sendWrite(), sendWrite(), sendWrite()]);
  assert.equal(dispatches.length, 3);
  assert.ok(dispatches[1] - dispatches[0] >= 97);
  assert.ok(dispatches[2] - dispatches[1] >= 97);
});

test("HTTP 429 persists a shared cooldown and rejects repeat calls without dispatch", async (t) => {
  const root = tempRoot(t);
  let calls = 0;
  await assert.rejects(coordinatedRedditRequest({ root, gapMs: 0, request: async () => {
    calls++;
    return { ok: false, status: 429, rateLimit: { retryAfter: "120" } };
  } }), (e) => e.name === "RedditCooldownError" && e.retryAfterMs >= 120_000 && e.knownNotApplied);

  const worker = fileURLToPath(new URL("./rate-limit-worker.mjs", import.meta.url));
  const blocked = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, root], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  assert.equal(blocked.error, "RedditCooldownError");
  assert.ok(blocked.retryAfterMs >= 110_000);
  assert.equal(calls, 1);
});

test("quota exhaustion and 503 Retry-After also prevent immediate follow-up calls", async (t) => {
  const root = tempRoot(t);
  let calls = 0;
  await coordinatedRedditRequest({ root, gapMs: 0, request: async () => {
    calls++;
    return { ok: true, status: 200, rateLimit: { remaining: "0", reset: "25" } };
  } });
  await assert.rejects(coordinatedRedditRequest({ root, gapMs: 0, maxWaitMs: 0, request: async () => {
    calls++;
    return ok;
  } }), /rate-limiting requests/);
  assert.equal(calls, 1);

  const secondRoot = tempRoot(t);
  await assert.rejects(coordinatedRedditRequest({ root: secondRoot, gapMs: 0, request: async () => {
    return { ok: false, status: 503, rateLimit: { retryAfter: "19" } };
  } }), (e) => e.name === "RedditCooldownError" && e.knownNotApplied === false);
  await assert.rejects(coordinatedRedditRequest({ root: secondRoot, gapMs: 0, maxWaitMs: 0, request: async () => ok }), /temporarily unavailable|rate-limiting requests/);

  const thirdRoot = tempRoot(t);
  await assert.rejects(coordinatedRedditRequest({ root: thirdRoot, gapMs: 0,
    request: async () => ({ ok: false, status: 503 }) }), /temporarily unavailable/);
  await assert.rejects(coordinatedRedditRequest({ root: thirdRoot, gapMs: 0, maxWaitMs: 0,
    request: async () => ok }), /rate-limiting requests/);
});

test("known rejected write does not reconcile when the same operation is retried", async (t) => {
  const root = tempRoot(t);
  let writes = 0;
  let reconciles = 0;
  const config = { root, account: "testAccount", fingerprint: "testFingerprint", intent: { type: "post" },
    writeGapMs: 0, reconcile: async () => { reconciles++; return { status: "unknown" }; },
    operation: async () => {
      writes++;
      if (writes === 1) throw new KnownWriteFailure("HTTP 429");
      return { message: "posted" };
    },
  };
  await assert.rejects(coordinatedWrite(config), /HTTP 429/);
  const retry = await coordinatedWrite(config);
  assert.equal(retry.status, "success");
  assert.equal(reconciles, 0);
  assert.equal(writes, 2);
});

test("ambiguous failed write remains subject to reconciliation on retry", async (t) => {
  const root = tempRoot(t);
  let reconciles = 0;
  let sends = 0;
  const config = {
    root, account: "anotherAccount", fingerprint: "anotherFingerprint", intent: { type: "post" },
    writeGapMs: 0, reconcile: async () => { reconciles++; return { status: "not_found" }; },
    operation: async () => { sends++; if (sends === 1) throw new Error("Lost browser response");
      return { message: "confirmed" }; },
  };
  await assert.rejects(coordinatedWrite(config), /Lost browser response/);
  assert.equal(reconciles, 1);
  const result = await coordinatedWrite(config);
  assert.equal(result.status, "success");
  assert.equal(reconciles, 2);
  assert.equal(sends, 2);
});
