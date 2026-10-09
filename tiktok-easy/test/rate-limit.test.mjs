import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archive = path.join(root, "tiktok-easy-v0.1.2.mcpb");
const sourceArchive = path.join(root, "tiktok-easy-v0.1.2-source.zip");

function fromZip(archivePath, name) {
  const result = spawnSync("tar", ["-xOf", archivePath, name], { encoding: null, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiktok-shared-limit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = path.join(dir, "runtime");
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}\n');
  for (const name of ["store", "social-rate-limit", "file-lock"]) {
    fs.writeFileSync(path.join(runtime, `${name}.js`), fromZip(archive, `app/dist/runtime/${name}.js`));
  }
  const worker = path.join(dir, "worker.mjs");
  fs.writeFileSync(worker, `
    import { reserveAction, markTikTokRateLimited } from "./runtime/social-rate-limit.js";
    const [mode, operation, header, accountArg] = process.argv.slice(2);
    const account = accountArg || "test-account";
    if (mode === "throttle") {
      markTikTokRateLimited(account, Number(operation), header);
      process.stdout.write(JSON.stringify({ noted: true }));
    } else {
      process.stdout.write(JSON.stringify(reserveAction(account, "tiktok", operation || "post")));
    }
  `);
  return { dir, worker, dataDir: path.join(dir, "state") };
}

function run(worker, dataDir, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, ...args], {
      env: { ...process.env, TIKTOK_MCP_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`Worker ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
}

test("v0.1.2 package and source contain the fixed post-lock admission and response listener", () => {
  assert.ok(fs.existsSync(archive));
  const source = fromZip(sourceArchive, "src/runtime/tiktok-operations.ts").toString("utf8");
  const browser = fromZip(sourceArchive, "src/runtime/social-runtime.ts").toString("utf8");
  const rate = fromZip(archive, "app/dist/runtime/store.js").toString("utf8");
  const post = source.slice(source.indexOf("export async function postVideo"), source.indexOf("export interface TikTokFollowRequest"));
  assert.ok(post.indexOf('const { page, close } = session;') >= 0);
  assert.ok(post.indexOf('const blocked = gate(req.account_id, "post")') > post.indexOf('const { page, close } = session;'));
  assert.ok(post.indexOf('const blocked = gate(req.account_id, "post")') < post.indexOf('await post.locator.click'));
  for (const operation of ["post", "follow", "like", "delete"]) {
    assert.equal((source.match(new RegExp(`const blocked = gate\\(req\\.account_id, "${operation}"\\)`, "g")) || []).length, 1);
  }
  assert.match(rate, /reserveTikTokAction/);
  assert.match(browser, /page\.on\("response"/);
  assert.match(browser, /markTikTokRateLimited/);
  assert.match(browser, /__tiktokLimiterFailure/);
  assert.match(browser, /COOLDOWN PERSISTENCE FAILED/);
  assert.match(browser, /void page\.close\(\)/);
  assert.match(browser, /assertTikTokReadAllowed\(opts\.accountId\)/);
  assert.doesNotMatch(browser, /AutomationControlled|monitor_\(web\|browser\)|mon\\\.tiktokv/);
});

test("competing independent MCP processes consume exactly one account reservation", async (t) => {
  const { worker, dataDir } = fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => run(worker, dataDir, "reserve", "post")));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok && r.retry_after_ms > 0).length, 7);
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
  assert.equal(state.actions.filter((row) => row.account_id === "test-account").length, 1);
});

test("account aliases that share a browser profile also share admission and cooldown", async (t) => {
  const { worker, dataDir } = fixture(t);
  const first = await run(worker, dataDir, "reserve", "follow", "", "same/name");
  const second = await run(worker, dataDir, "reserve", "like", "", "same_name");
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  await run(worker, dataDir, "throttle", "429", "90", "same/name");
  const denied = await run(worker, dataDir, "reserve", "post", "", "same_name");
  assert.ok(denied.retry_after_ms >= 80_000);
});

test("three submitted attempts exhaust 24-hour cap even across process restarts", async (t) => {
  const { worker, dataDir } = fixture(t);
  fs.mkdirSync(dataDir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(dataDir, "state.json"), JSON.stringify({
    version: 1, accounts: [], operations: [], metrics: [],
    actions: Array.from({ length: 3 }, (_, i) => ({ account_id: "test-account", operation: "post", acted_at: now - 150_000 - i * 60_000 })),
  }));
  const denied = await run(worker, dataDir, "reserve", "post");
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /3 post attempts/);
  assert.ok(denied.retry_after_ms > 0 && denied.retry_after_ms < 86_400_000);
});

test("429 Retry-After persists across independent processes without a second attempt", async (t) => {
  const { worker, dataDir } = fixture(t);
  await run(worker, dataDir, "throttle", "429", "120");
  const denied = await Promise.all(Array.from({ length: 3 }, () => run(worker, dataDir, "reserve", "post")));
  assert.ok(denied.every((entry) => entry.ok === false && entry.retry_after_ms > 110_000));
  assert.ok(denied.every((entry) => /cooldown/i.test(entry.reason)));
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
  assert.equal(state.actions.length, 0, "rejected calls must not reserve new actions");
});

test("503 and malformed Retry-After establish protective fallback; later headers never shorten cooldown", async (t) => {
  const { worker, dataDir } = fixture(t);
  await run(worker, dataDir, "throttle", "429", "90");
  await run(worker, dataDir, "throttle", "503", "bad-value");
  const denied = await run(worker, dataDir, "reserve", "like");
  assert.equal(denied.ok, false);
  assert.ok(denied.retry_after_ms >= 80_000);
});
