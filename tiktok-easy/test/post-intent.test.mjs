import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpb = path.join(root, "tiktok-easy-v0.1.2.mcpb");

function prepare(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tiktok-post-idempotency-"));
  t.after(() => fs.rmSync(tmp, { force: true, recursive: true }));
  const unpacked = spawnSync("tar", ["-xf", mcpb, "-C", tmp], { encoding: "utf8" });
  assert.equal(unpacked.status, 0, unpacked.stderr);
  const runtimeDir = path.join(tmp, "app", "dist", "runtime");
  const mediaPath = path.join(tmp, "video.mp4");
  fs.writeFileSync(mediaPath, "safe-offline-fake-video-bytes\n");
  const marker = path.join(tmp, "external-simulated-post.log");
  const state = path.join(tmp, "state");
  const workerPath = path.join(tmp, "worker.mjs");
  const loaderPath = path.join(tmp, "offline-loader.mjs");
  const mocked = path.join(tmp, "offline-tiktok-operations.mjs");
  fs.writeFileSync(loaderPath, `
    import { pathToFileURL } from "node:url";
    const replacement = pathToFileURL(${JSON.stringify(mocked)}).href;
    export async function resolve(specifier, context, nextResolve) {
      if (specifier.endsWith("/tiktok-operations.js") || specifier === "./tiktok-operations.js") {
        return { url: replacement, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
  `);
  fs.writeFileSync(mocked, `
    import fs from "node:fs";
    export async function postVideo() {
      fs.appendFileSync(process.env.MOCK_POST_LOG, "attempted\\n");
      await new Promise((resolve) => setTimeout(resolve, 180));
      if (process.env.MOCK_POST_MODE === "crash") process.exit(42);
      if (process.env.MOCK_POST_MODE === "ambiguous") return { success: false, error_code: "UI_TIMEOUT", error: "Lost confirmation" };
      return { success: true, data: { video_id: "test-only" } };
    }
    export const analyzePosts = async () => ({ success: true });
    export const deleteVideo = async () => ({ success: true });
    export const followUser = async () => ({ success: true });
    export const likeVideo = async () => ({ success: true });
    export const updateAvatar = async () => ({ success: true });
    export const updateProfile = async () => ({ success: true });
  `);
  fs.writeFileSync(workerPath, `
    import { LocalTikTokRuntime } from "./app/dist/runtime/local-runtime.js";
    import { upsertAccount } from "./app/dist/runtime/store.js";
    upsertAccount({ id: process.env.MOCK_ACCOUNT || "test-account", status: "active" });
    const runtime = new LocalTikTokRuntime();
    const result = runtime.post({ account_id: process.env.MOCK_ACCOUNT || "test-account",
      caption: "An example offline post", video_path: process.env.MOCK_MEDIA });
    process.stdout.write(JSON.stringify(result) + "\\n");
  `);
  const readWorker = path.join(tmp, "read-worker.mjs");
  fs.writeFileSync(readWorker, `
    import { launchLocalContext } from "./app/dist/runtime/social-runtime.js";
    import { postVideo } from "./app/dist/runtime/tiktok-operations.js";
    try {
      if (process.argv[2] === "post") {
        const result = await postVideo({ account_id: "test-account", caption: "test", video_url: "https://example.invalid/video.mp4", cookies: [] });
        process.stdout.write(JSON.stringify(result));
      } else {
        await launchLocalContext({ accountId: "test-account" });
        process.stdout.write(JSON.stringify({ error: null }));
      }
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: String(e.message || e), code: e.error_code, retry: e.retry_after_ms }));
    }
  `);
  const limiterWorker = path.join(tmp, "cooldown-worker.mjs");
  fs.writeFileSync(limiterWorker, `
    import { markTikTokRateLimited } from "./app/dist/runtime/store.js";
    markTikTokRateLimited("test-account", 429, "100");
  `);
  return { tmp, state, marker, mediaPath, workerPath, loaderPath, readWorker, limiterWorker, runtimeDir };
}

function runWorker(f, { mode = "success", account = "test-account", video, mocked = true, allowFailure = false, worker = f.workerPath } = {}) {
  return new Promise((resolve, reject) => {
    const args = mocked ? ["--no-warnings", "--experimental-loader", pathToFileURL(f.loaderPath).href, worker] : [worker, mode];
    const child = spawn(process.execPath, args, {
      env: { ...process.env, TIKTOK_MCP_DATA_DIR: f.state, MOCK_MEDIA: video || f.mediaPath,
        MOCK_POST_LOG: f.marker, MOCK_POST_MODE: mode, MOCK_ACCOUNT: account },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (buffer) => { out += buffer.toString(); });
    child.stderr.on("data", (buffer) => { err += buffer.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0 && !allowFailure) return reject(new Error(`worker ${code}: ${err}`));
      try { resolve({ code, result: out.trim() ? JSON.parse(out.trim()) : null }); }
      catch (e) { reject(new Error(`invalid worker output: ${out}, ${err}, ${e}`)); }
    });
  });
}

function dispatched(f) {
  try { return fs.readFileSync(f.marker, "utf8").trim().split(/\r?\n/).filter(Boolean).length; }
  catch { return 0; }
}

test("LocalTikTokRuntime.post() reuses a durable ID across concurrent independent processes without executing a second post", async (t) => {
  const f = prepare(t);
  const [a, b] = await Promise.all([runWorker(f), runWorker(f)]);
  assert.equal(a.code, 0);
  assert.equal(b.code, 0);
  assert.equal(a.result.operation_id, b.result.operation_id);
  assert.ok([a.result, b.result].some((r) => r.reused === true));
  assert.equal(dispatched(f), 1);
  const again = await runWorker(f);
  assert.equal(again.result.operation_id, a.result.operation_id);
  assert.equal(again.result.reused, true);
  assert.equal(again.result.status, "done");
  assert.equal(dispatched(f), 1);
});

test("a crashed post job is marked UNCERTAIN and identical post is not re-executed", async (t) => {
  const f = prepare(t);
  const first = await runWorker(f, { mode: "crash", allowFailure: true });
  assert.equal(first.code, 42);
  assert.equal(dispatched(f), 1);
  const second = await runWorker(f);
  assert.equal(second.result.operation_id, first.result.operation_id);
  assert.equal(second.result.reused, true);
  assert.equal(second.result.error_code, "UNCERTAIN");
  assert.equal(dispatched(f), 1);
});

test("ambiguous failed acknowledgement is not silently retried", async (t) => {
  const f = prepare(t);
  const first = await runWorker(f, { mode: "ambiguous" });
  const second = await runWorker(f);
  assert.equal(second.result.operation_id, first.result.operation_id);
  assert.equal(second.result.error_code, "UNCERTAIN");
  assert.equal(dispatched(f), 1);
});

test("post intent hashes full local media even beyond 100 MiB; paths alone cannot cause reuse", async (t) => {
  const f = prepare(t);
  // A sparse test file avoids loading 100 MiB into test memory. Fingerprinting
  // is incremental and cannot fall back to hashing only the pathname/size.
  fs.truncateSync(f.mediaPath, 100 * 1024 * 1024 + 7);
  const first = await runWorker(f);
  assert.equal(first.result.reused, undefined);
  const copy = path.join(f.tmp, "renamed-video.mp4");
  fs.copyFileSync(f.mediaPath, copy);
  const sameBytes = await runWorker(f, { video: copy });
  assert.equal(sameBytes.result.reused, true);
  assert.equal(sameBytes.result.operation_id, first.result.operation_id);
  const fd = fs.openSync(f.mediaPath, "r+");
  try { fs.writeSync(fd, Buffer.from("Z"), 0, 1, 100 * 1024 * 1024 + 6); }
  finally { fs.closeSync(fd); }
  const changed = await runWorker(f);
  assert.notEqual(changed.result.operation_id, first.result.operation_id);
  assert.equal(dispatched(f), 2);
});

test("persisted 429 blocks subsequent read/browser and post-media session before network", async (t) => {
  const f = prepare(t);
  await runWorker(f, { mocked: false, worker: f.limiterWorker });
  const [read, post] = await Promise.all([
    runWorker(f, { mocked: false, worker: f.readWorker, mode: "read" }),
    runWorker(f, { mocked: false, worker: f.readWorker, mode: "post" }),
  ]);
  assert.match(read.result.error, /cooling down/);
  assert.equal(read.result.code, "RATE_LIMITED_PROTECTIVE");
  assert.ok(read.result.retry > 80_000);
  assert.equal(post.result.error_code, "RATE_LIMITED_PROTECTIVE");
  assert.equal(dispatched(f), 0);
});
