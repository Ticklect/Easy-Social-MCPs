import fs from "node:fs";

function replaceOnce(s, from, to, label) {
  if (!s.includes(from)) throw new Error("Missing patch target: " + label);
  return s.replace(from, to);
}

// --rate-only upgrades an already-patched v0.1.1 source archive. The default
// path still applies the entire pinned-upstream adaptation before this patch.
if (!process.argv.includes("--rate-only")) {
{
  const p = "src/runtime/file-lock.ts";
  const source = [
    'import { randomUUID } from "node:crypto";',
    'import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    '',
    'type LockOptions = { timeoutMs?: number; pollMs?: number };',
    'const syncWait = new Int32Array(new SharedArrayBuffer(4));',
    'const PROCESS_INSTANCE_ID = randomUUID().replaceAll("-", "");',
    '',
    'function ownerPath(lockDir: string): string {',
    '  return join(lockDir, "owner.json");',
    '}',
    '',
    'function reclaimRootPath(lockDir: string): string {',
    '  return `${lockDir}.reaping`;',
    '}',
    '',
    'const OWNERLESS_GRACE_MS = 30_000;',
    'const RECLAIM_CLAIM_STALE_MS = 5_000;',
    '',
    'function ownerPid(lockDir: string): number | null {',
    '  try {',
    '    const parsed = JSON.parse(readFileSync(ownerPath(lockDir), "utf8")) as { pid?: unknown };',
    '    const pid = Number(parsed.pid);',
    '    return Number.isInteger(pid) && pid > 0 ? pid : null;',
    '  } catch {',
    '    return null;',
    '  }',
    '}',
    '',
    'function isProcessAlive(pid: number): boolean {',
    '  if (pid === process.pid) return true;',
    '  try {',
    '    process.kill(pid, 0);',
    '    return true;',
    '  } catch (error: any) {',
    '    return error?.code !== "ESRCH";',
    '  }',
    '}',
    '',
    'function reclaimInProgress(lockDir: string): boolean {',
    '  const root = reclaimRootPath(lockDir);',
    '  let claims;',
    '  try {',
    '    claims = readdirSync(root, { withFileTypes: true });',
    '  } catch (error: any) {',
    '    if (error?.code === "ENOENT") return false;',
    '    return true;',
    '  }',
    '  let active = false;',
    '  for (const claim of claims) {',
    '    if (!claim.isDirectory()) { active = true; continue; }',
    '    const claimPath = join(root, claim.name);',
    '    let expired = false;',
    '    try { expired = Date.now() - statSync(claimPath).mtimeMs >= RECLAIM_CLAIM_STALE_MS; }',
    '    catch { continue; }',
    '    if (expired) {',
    '      try { rmSync(claimPath, { recursive: true, force: true }); }',
    '      catch { active = true; }',
    '      continue;',
    '    }',
    '    const match = /^(\\d+)-([0-9a-f]{32})-/.exec(claim.name);',
    '    const pid = Number(match?.[1]);',
    '    const processInstanceId = match?.[2];',
    '    if (!Number.isInteger(pid) || pid <= 0 || !processInstanceId) { active = true; continue; }',
    '    if (pid !== process.pid && isProcessAlive(pid)) { active = true; continue; }',
    '    if (pid === process.pid && processInstanceId === PROCESS_INSTANCE_ID) { active = true; continue; }',
    '    try { rmSync(claimPath, { recursive: true, force: true }); }',
    '    catch { active = true; }',
    '  }',
    '  return active;',
    '}',
    '',
    'function createReclaimClaim(lockDir: string): string {',
    '  const root = reclaimRootPath(lockDir);',
    '  mkdirSync(root, { recursive: true, mode: 0o700 });',
    '  const claimDir = join(root, `${process.pid}-${PROCESS_INSTANCE_ID}-${randomUUID()}`);',
    '  mkdirSync(claimDir, { mode: 0o700 });',
    '  return claimDir;',
    '}',
    '',
    'function oldEnoughToReapOwnerless(lockDir: string): boolean {',
    '  try { return Date.now() - statSync(lockDir).mtimeMs >= OWNERLESS_GRACE_MS; }',
    '  catch { return false; }',
    '}',
    '',
    'function tryAcquire(lockDir: string): boolean {',
    '  mkdirSync(dirname(lockDir), { recursive: true, mode: 0o700 });',
    '  if (reclaimInProgress(lockDir)) return false;',
    '  try {',
    '    mkdirSync(lockDir, { mode: 0o700 });',
    '  } catch (error: any) {',
    '    if (error?.code === "EEXIST" || error?.code === "EPERM") return false;',
    '    throw error;',
    '  }',
    '  if (reclaimInProgress(lockDir)) {',
    '    try { rmSync(lockDir, { recursive: true, force: true }); } catch {}',
    '    return false;',
    '  }',
    '  try {',
    '    writeFileSync(ownerPath(lockDir), JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });',
    '    return true;',
    '  } catch (error) {',
    '    try { rmSync(lockDir, { recursive: true, force: true }); } catch {}',
    '    throw error;',
    '  }',
    '}',
    '',
    'function reapDeadOwner(lockDir: string): void {',
    '  const initialPid = ownerPid(lockDir);',
    '  if (initialPid !== null ? isProcessAlive(initialPid) : !oldEnoughToReapOwnerless(lockDir)) return;',
    '  const claimDir = createReclaimClaim(lockDir);',
    '  try {',
    '    const currentPid = ownerPid(lockDir);',
    '    if (currentPid !== null ? isProcessAlive(currentPid) : !oldEnoughToReapOwnerless(lockDir)) return;',
    '    const quarantinePath = join(claimDir, "lock");',
    '    try { renameSync(lockDir, quarantinePath); }',
    '    catch (error: any) {',
    '      if (["ENOENT", "EPERM", "EACCES", "EBUSY"].includes(error?.code)) return;',
    '      throw error;',
    '    }',
    '  } finally {',
    '    try { rmSync(claimDir, { recursive: true, force: true }); } catch {}',
    '  }',
    '}',
    '',
    'function releaseLock(lockDir: string): void {',
    '  try {',
    '    const parsed = JSON.parse(readFileSync(ownerPath(lockDir), "utf8")) as { pid?: unknown };',
    '    if (Number(parsed.pid) !== process.pid) return;',
    '  } catch {',
    '    return;',
    '  }',
    '  rmSync(lockDir, { recursive: true, force: true });',
    '}',
    '',
    'export function acquireFileLockSync(lockDir: string, options: LockOptions = {}): () => void {',
    '  const timeoutMs = options.timeoutMs ?? 10_000;',
    '  const pollMs = options.pollMs ?? 25;',
    '  const deadline = Date.now() + timeoutMs;',
    '  while (true) {',
    '    if (tryAcquire(lockDir)) return () => releaseLock(lockDir);',
    '    reapDeadOwner(lockDir);',
    '    if (Date.now() >= deadline) throw new Error(`Timed out waiting for TikTok Easy lock: ${lockDir}`);',
    '    Atomics.wait(syncWait, 0, 0, pollMs);',
    '  }',
    '}',
    '',
    'export async function acquireFileLock(lockDir: string, options: LockOptions = {}): Promise<() => void> {',
    '  const timeoutMs = options.timeoutMs ?? 30_000;',
    '  const pollMs = options.pollMs ?? 50;',
    '  const deadline = Date.now() + timeoutMs;',
    '  while (true) {',
    '    if (tryAcquire(lockDir)) return () => releaseLock(lockDir);',
    '    reapDeadOwner(lockDir);',
    '    if (Date.now() >= deadline) throw new Error(`Timed out waiting for TikTok Easy lock: ${lockDir}`);',
    '    await new Promise((resolve) => setTimeout(resolve, pollMs));',
    '  }',
    '}',
    '',
    'export function withFileLockSync<T>(lockDir: string, fn: () => T, options: LockOptions = {}): T {',
    '  const release = acquireFileLockSync(lockDir, options);',
    '  try { return fn(); } finally { release(); }',
    '}',
    '',
  ].join("\n");
  fs.writeFileSync(p, source);
}

{
  const p = "src/runtime/social-runtime.ts";
  let s = fs.readFileSync(p, "utf8");
  s = replaceOnce(
    s,
    'import { profileDir } from "./store.js";',
    'import { profileDir } from "./store.js";\nimport { acquireFileLock } from "./file-lock.js";',
    "profile filesystem lock import"
  );
  s = replaceOnce(
    s,
    'candidates.push(\n      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),',
    'candidates.push(\n      join(programFiles, "imput", "Helium", "Application", "chrome.exe"),\n      join(programFiles, "Helium", "Application", "chrome.exe"),\n      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),',
    "Windows Program Files browser list"
  );
  s = replaceOnce(
    s,
    'if (local) candidates.push(\n      join(local, "Google", "Chrome", "Application", "chrome.exe"),',
    'if (local) candidates.push(\n      join(local, "imput", "Helium", "Application", "chrome.exe"),\n      join(local, "Programs", "Helium", "Application", "chrome.exe"),\n      join(local, "Helium", "Application", "chrome.exe"),\n      join(local, "Google", "Chrome", "Application", "chrome.exe"),',
    "Windows LocalAppData browser list"
  );
  s = replaceOnce(
    s,
    'candidates.push(\n      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",',
    'candidates.push(\n      "/Applications/Helium.app/Contents/MacOS/Helium",\n      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",',
    "macOS browser list"
  );
  s = replaceOnce(
    s,
    'candidates.push(\n      "/usr/bin/google-chrome",',
    'candidates.push(\n      "/usr/bin/helium", "/usr/local/bin/helium",\n      "/usr/bin/google-chrome",',
    "Linux browser list"
  );
  s = s.replaceAll("Chrome/Edge/Brave.", "Helium/Chrome/Edge/Brave.");
  s = replaceOnce(
    s,
    '  await previous;\n  return () => {\n    release();\n    if (accountLocks.get(accountId) === tail) accountLocks.delete(accountId);\n  };',
    '  await previous;\n  let releaseFileLock: (() => void) | undefined;\n  try {\n    releaseFileLock = await acquireFileLock(`${profileDir(accountId)}.lock`, { timeoutMs: 30_000, pollMs: 50 });\n  } catch (error) {\n    release();\n    if (accountLocks.get(accountId) === tail) accountLocks.delete(accountId);\n    throw error;\n  }\n  return () => {\n    try { releaseFileLock?.(); } finally {\n      release();\n      if (accountLocks.get(accountId) === tail) accountLocks.delete(accountId);\n    }\n  };',
    "cross-process profile lock"
  );
  s = replaceOnce(
    s,
    '  browserPath?: string;\n',
    '',
    "remove launch browserPath option"
  );
  s = replaceOnce(
    s,
    '  const browserPath = opts.browserPath || process.env.TIKTOK_BROWSER_PATH || installedBrowser();',
    '  const browserPath = process.env.TIKTOK_BROWSER_PATH || installedBrowser();',
    "operator-only browser path"
  );
  fs.writeFileSync(p, s);
}

{
  const p = "src/runtime/store.ts";
  let s = fs.readFileSync(p, "utf8");
  s = replaceOnce(
    s,
    'import { join, resolve } from "node:path";',
    'import { join, resolve } from "node:path";\nimport { withFileLockSync } from "./file-lock.js";',
    "state filesystem lock import"
  );
  s = replaceOnce(
    s,
    'function update(mutator: (state: LocalState) => void): void {\n  const state = readState();\n  mutator(state);\n  writeState(state);\n}',
    'function update(mutator: (state: LocalState) => void): void {\n  withFileLockSync(join(dataDir(), "locks", "state.lock"), () => {\n    const state = readState();\n    mutator(state);\n    writeState(state);\n  });\n}',
    "cross-process state update lock"
  );
  fs.writeFileSync(p, s);
}

{
  const p = "src/runtime/local-runtime.ts";
  let s = fs.readFileSync(p, "utf8");
  s = replaceOnce(s, '  browser_path?: string;\n', '', "remove connect browser_path type");
  s = replaceOnce(s, '        browserPath: input.browser_path,\n', '', "remove connect browser path forwarding");
  fs.writeFileSync(p, s);
}

{
  const p = "src/server.ts";
  let s = fs.readFileSync(p, "utf8");
  s = replaceOnce(
    s,
    '      browser_path: z.string().optional().describe("Optional Chrome/Edge/Brave executable path"),\n',
    '',
    "remove browser_path tool input"
  );
  const marker = '  addTool(server, "tiktok_connect_status", {';
  const at = s.indexOf(marker);
  if (at < 0) throw new Error("Missing tiktok_connect_status marker");
  const alias = [
    '  addTool(server, "tiktok_login", {',
    '    title: "Log into TikTok",',
    '    description: "Easy default-account QR login. No TikTok API keys are required.",',
    '    inputSchema: {',
    '      country: z.string().length(2).optional(),',
    '      timeout_seconds: z.number().int().min(30).max(900).optional(),',
    '    },',
    '  }, (args) => runtime.connect({',
    '    account_id: "default",',
    '    country: args.country,',
    '    timeout_seconds: args.timeout_seconds,',
    '  }));',
    '',
    ''
  ].join("\n");
  s = s.slice(0, at) + alias + s.slice(at);
  s = replaceOnce(
    s,
    '{ name: "ai.palmyr/tiktok", title: "TikTok MCP", version: "0.3.1" }',
    '{ name: "tiktok-easy", title: "TikTok Easy", version: "0.1.1" }',
    "server identity"
  );
  fs.writeFileSync(p, s);
}


{
  const p = "src/tests/local.test.ts";
  let t = fs.readFileSync(p, "utf8");
  t = replaceOnce(
    t,
    'import { mkdtemp, rm } from "node:fs/promises";',
    'import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";',
    "filesystem lock test imports"
  );
  t = replaceOnce(
    t,
    'import { listAccounts, upsertAccount } from "../runtime/store.js";',
    'import { listAccounts, upsertAccount } from "../runtime/store.js";\nimport { acquireFileLock } from "../runtime/file-lock.js";',
    "filesystem lock test runtime import"
  );
  t = replaceOnce(t, 'test("exposes 16 local tools with no payment fields"', 'test("exposes 17 local tools with no payment fields"', "tool-count test title");
  t = replaceOnce(t, "assert.equal(listed.tools.length, 16);", "assert.equal(listed.tools.length, 17);", "tool-count assertion");
  t = replaceOnce(
    t,
    '    assert.ok(listed.tools.every((tool) => !(tool.inputSchema.properties as Record<string, unknown> | undefined)?.payment));',
    '    assert.ok(listed.tools.every((tool) => !(tool.inputSchema.properties as Record<string, unknown> | undefined)?.payment));\n    const connect = listed.tools.find((tool) => tool.name === "tiktok_connect");\n    assert.ok(connect);\n    assert.ok(!Object.prototype.hasOwnProperty.call(connect.inputSchema.properties || {}, "browser_path"));',
    "browser_path schema regression"
  );
  const testMarker = 'test("persists local accounts and sparse analytics without hosted automation calls", () => {';
  const testAt = t.indexOf(testMarker);
  if (testAt < 0) throw new Error("Missing local persistence test marker");
  const lockRegression = [
    'test("recovers an abandoned ownerless filesystem lock after the creation grace period", async () => {',
    '  const lockDir = join(dir, "locks", "abandoned.lock");',
    '  await mkdir(lockDir, { recursive: true });',
    '  const old = new Date(Date.now() - 120_000);',
    '  await utimes(lockDir, old, old);',
    '  const release = await acquireFileLock(lockDir, { timeoutMs: 500, pollMs: 10 });',
    '  release();',
    '});',
    '',
    '',
  ].join("\n");
  t = t.slice(0, testAt) + lockRegression + t.slice(testAt);
  fs.writeFileSync(p, t);
}
}

// v0.1.2: shared account admission and persisted platform throttling.
// Keep this implementation in the checked-in upstream patch so builds cannot
// silently package the old pre-lock gate from the immutable v0.1.1 archive.
{
  const p = "src/server.ts";
  fs.writeFileSync(p, replaceOnce(fs.readFileSync(p, "utf8"),
    'title: "TikTok Easy", version: "0.1.1"',
    'title: "TikTok Easy", version: "0.1.2"', "TikTok 0.1.2 server version"));
}
{
  const p = "src/runtime/store.ts";
  let s = fs.readFileSync(p, "utf8");
  s = replaceOnce(s, '  actions: ActionRecord[];\n}', '  actions: ActionRecord[];\n  cooldowns?: Record<string, number>;\n}', "cooldown schema");
  s = replaceOnce(s, 'import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";',
    'import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";\nimport { createHash } from "node:crypto";', "post intent hashing");
  s = replaceOnce(s, '  updated_at: string;\n}\n\nexport interface StoredMetric',
    '  updated_at: string;\n  post_fingerprint?: string;\n  owner_pid?: number;\n}\n\nexport interface StoredMetric', "post intent operation metadata");
  s = replaceOnce(s, '  cooldowns?: Record<string, number>;\n}',
    '  cooldowns?: Record<string, number>;\n  post_intents?: Record<string, PostIntentEntry>;\n}', "durable post intents schema");
  s = replaceOnce(s, '    actions: Array.isArray(parsed.actions) ? parsed.actions : [],', '    actions: Array.isArray(parsed.actions) ? parsed.actions : [],\n    cooldowns: parsed.cooldowns && typeof parsed.cooldowns === "object" ? parsed.cooldowns : {},', "persist cooldown state");
  s = replaceOnce(s, '    cooldowns: parsed.cooldowns && typeof parsed.cooldowns === "object" ? parsed.cooldowns : {},',
    '    cooldowns: parsed.cooldowns && typeof parsed.cooldowns === "object" ? parsed.cooldowns : {},\n    post_intents: parsed.post_intents && typeof parsed.post_intents === "object" ? parsed.post_intents : {},', "persist post intent ledger");
  s = replaceOnce(s, '    if (index >= 0) state.operations[index] = operation;',
    '    if (operation.name === "post" && operation.post_fingerprint && operation.account_id) {\n      state.post_intents ??= {};\n      state.post_intents[postIntentKey(operation.account_id, operation.post_fingerprint)] = {\n        operation_id: operation.id, status: operation.status, created_at: operation.created_at,\n        updated_at: operation.updated_at, owner_pid: operation.owner_pid,\n        error: operation.error, error_code: operation.error_code, result: operation.result,\n      };\n    }\n    if (index >= 0) state.operations[index] = operation;', "update ledger with post status");
  s += `

interface PostIntentEntry {
  operation_id: string;
  status: OperationStatus;
  created_at: string;
  updated_at: string;
  owner_pid?: number;
  error?: string;
  error_code?: string;
  result?: unknown;
}

function postIntentKey(accountId: string, fingerprint: string): string {
  return createHash("sha256").update(rateLimitAccountKey(accountId) + "\\n" + fingerprint).digest("hex");
}

function postOwnerAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error?.code !== "ESRCH"; }
}

/** A durable cross-process post-intent claim. Crashed owner or ambiguous
 * result never triggers another external post for the same media/fields.
 * Explicit pre-dispatch failures can be requested again without guesswork.
 */
export function reserveTikTokPostOperation(candidate: LocalOperation, fingerprint: string):
  { operation: LocalOperation; reused: boolean } {
  if (!candidate.account_id || candidate.name !== "post") throw new Error("Post intent requires an account and post operation");
  const key = postIntentKey(candidate.account_id, fingerprint);
  let outcome!: { operation: LocalOperation; reused: boolean };
  update((state) => {
    state.post_intents ??= {};
    const previous = state.post_intents[key];
    // Never repeat a click whose acknowledgement may have been lost. Only
    // failures known to occur before browser mutation are retryable.
    const safeRetry = previous?.status === "failed" &&
      ["LAUNCH_FAILED", "RATE_LIMITED_PROTECTIVE"].includes(previous.error_code || "");
    const ageMs = previous ? Date.now() - Date.parse(previous.created_at) : 0;
    if (previous && !safeRetry && Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 24 * 3_600_000) {
      let operation = state.operations.find((item) => item.id === previous.operation_id);
      if (!operation) {
        operation = { id: previous.operation_id, name: "post", account_id: candidate.account_id,
          status: previous.status, input: {}, created_at: previous.created_at,
          updated_at: previous.updated_at, owner_pid: previous.owner_pid,
          post_fingerprint: fingerprint, error: previous.error,
          error_code: previous.error_code, result: previous.result };
        state.operations.push(operation);
        if (state.operations.length > 2_000) state.operations.splice(0, state.operations.length - 2_000);
      }
      if (["pending", "running"].includes(operation.status) && !postOwnerAlive(previous.owner_pid)) {
        operation.status = "failed";
        operation.error_code = "UNCERTAIN";
        operation.error = "Previous TikTok post may have been submitted before its process exited. Verify on TikTok manually; duplicate post blocked.";
        operation.updated_at = new Date().toISOString();
        state.post_intents[key] = { ...previous, status: "failed", error_code: operation.error_code,
          error: operation.error, updated_at: operation.updated_at };
      }
      if (operation.status === "failed" && !["LAUNCH_FAILED", "RATE_LIMITED_PROTECTIVE", "UNCERTAIN"].includes(operation.error_code || "")) {
        operation.error_code = "UNCERTAIN";
        operation.error = "A previous identical post returned an unverified failure. Check TikTok manually before retrying; duplicate submission blocked.";
        operation.updated_at = new Date().toISOString();
        state.post_intents[key] = { ...previous, status: "failed", error_code: operation.error_code,
          error: operation.error, updated_at: operation.updated_at };
      }
      outcome = { operation: { ...operation }, reused: true };
      return;
    }
    const operation: LocalOperation = { ...candidate, post_fingerprint: fingerprint, owner_pid: process.pid };
    state.operations.push(operation);
    if (state.operations.length > 2_000) state.operations.splice(0, state.operations.length - 2_000);
    state.post_intents[key] = { operation_id: operation.id, status: operation.status,
      created_at: operation.created_at, updated_at: operation.updated_at,
      owner_pid: operation.owner_pid };
    outcome = { operation, reused: false };
  });
  return outcome;
}

/** Cross-process atomic reservation. Every admitted operation consumes one
 * slot before it can click a mutating control; even a crash/ambiguous result
 * cannot silently refund the attempt. The state lock protects check + write.
 * A browser/profile lock also remains held by the caller while operating.
 */
// Browser profile paths sanitize account IDs; key budgets by the same effective
// profile name so aliases cannot accidentally obtain independent quotas.
function rateLimitAccountKey(accountId: string): string {
  const key = accountId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80).toLowerCase();
  if (!key) throw new Error("Invalid TikTok rate-limit account ID");
  return key;
}

type RateGate = { ok: boolean; reason?: string; retry_after_ms?: number };

function assessTikTokAction(state: LocalState, key: string, operation: string, now: number): RateGate {
  const cooldownMs = Math.max(0, Number(state.cooldowns?.[key] || 0) - now);
  if (cooldownMs > 0) {
    return { ok: false, reason: "TikTok has requested a cooldown for this account.", retry_after_ms: cooldownMs };
  }
  const rows = state.actions.filter((row) => rateLimitAccountKey(row.account_id) === key)
    .sort((a, b) => b.acted_at - a.acted_at);
  const sinceLast = rows.length ? now - rows[0].acted_at : Infinity;
  if (sinceLast < 30_000) {
    return { ok: false, reason: "Wait 30 seconds between account actions.", retry_after_ms: 30_000 - sinceLast };
  }
  const rule = operation === "post" ? { max: 3, ms: 86_400_000 } :
    operation === "follow" ? { max: 20, ms: 3_600_000 } :
    operation === "like" ? { max: 60, ms: 3_600_000 } : null;
  if (rule) {
    const counted = rows.filter((row) => row.operation === operation && row.acted_at > now - rule.ms);
    if (counted.length >= rule.max) {
      const oldest = Math.min(...counted.map((row) => row.acted_at));
      return { ok: false, reason: "Protective account cap reached (" + rule.max + " " + operation + " attempts).",
        retry_after_ms: Math.max(1, oldest + rule.ms - now) };
    }
  }
  return { ok: true };
}

/** Read-only best-effort preflight; never consumes a reservation. */
export function previewTikTokAction(accountId: string, operation: string): RateGate {
  return assessTikTokAction(readState(), rateLimitAccountKey(accountId), operation, Date.now());
}

export function reserveTikTokAction(accountId: string, operation: string): RateGate {
  const key = rateLimitAccountKey(accountId);
  let result: RateGate = { ok: false };
  update((state) => {
    const now = Date.now();
    result = assessTikTokAction(state, key, operation, now);
    if (!result.ok) return;
    state.actions = state.actions.filter((row) => row.acted_at > now - 48 * 3_600_000);
    state.actions.push({ account_id: key, operation, acted_at: now });
  });
  return result;
}

/** Never launch a normal browser/read session while TikTok has asked to pause.
 * Login recovery explicitly opts out; mutations must still reserve separately.
 */
export function assertTikTokReadAllowed(accountId: string): void {
  const key = rateLimitAccountKey(accountId);
  const delay = Math.max(0, Number(readState().cooldowns?.[key] || 0) - Date.now());
  if (delay > 0) {
    const error = new Error("TikTok account is cooling down; wait about " + Math.ceil(delay / 1000) + " seconds before browsing.") as
      Error & { error_code: string; retry_after_ms: number };
    error.error_code = "RATE_LIMITED_PROTECTIVE";
    error.retry_after_ms = delay;
    throw error;
  }
}

/** Account-wide cooldown survives process restarts. Retry-After may be numeric
 * seconds or an HTTP date; unknown/malformed values use a conservative floor.
 */
export function markTikTokRateLimited(accountId: string, status: number, header?: string | null): void {
  const key = rateLimitAccountKey(accountId);
  const now = Date.now();
  let delay = status === 503 ? 30_000 : 60_000;
  if (header) {
    const value = header.trim();
    const seconds = /^\\d+(?:\\.\\d+)?$/.test(value) ? Number(value) : NaN;
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
    if (Number.isFinite(ms) && ms >= 0) delay = Math.max(delay, ms);
  }
  delay = Math.min(delay, 24 * 3_600_000);
  update((state) => {
    state.cooldowns ??= {};
    state.cooldowns[key] = Math.max(Number(state.cooldowns[key] || 0), Date.now() + delay);
  });
}
`;
  fs.writeFileSync(p, s);
}

{
  const p = "src/runtime/social-rate-limit.ts";
  let s = fs.readFileSync(p, "utf8");
  s = replaceOnce(s, 'import { appendAction, readActions } from "./store.js";',
    'import { appendAction, readActions, previewTikTokAction, reserveTikTokAction, markTikTokRateLimited, assertTikTokReadAllowed } from "./store.js";', "rate limit store import");
  const oldGateStart = s.indexOf('export function checkRateLimit(');
  const oldGateEnd = s.indexOf('\n}\n', oldGateStart);
  if (oldGateStart < 0 || oldGateEnd < 0) throw new Error("Missing old read-only TikTok rate gate");
  s = s.slice(0, oldGateStart) + 'export function checkRateLimit(accountId: string, _platform: "tiktok", operation: string): RateLimitResult {\n  return previewTikTokAction(accountId, operation);\n}' + s.slice(oldGateEnd + 2);
  s += '\n/** Preflight checks do not reserve capacity; only the mutation gate does. */\nexport function reserveAction(accountId: string, _platform: "tiktok", operation: string): RateLimitResult {\n  return reserveTikTokAction(accountId, operation);\n}\nexport { markTikTokRateLimited, assertTikTokReadAllowed };\n';
  fs.writeFileSync(p, s);
}

{
  const p = "src/runtime/tiktok-operations.ts";
  let s = fs.readFileSync(p, "utf8");
  s = replaceOnce(s, 'import { checkRateLimit, recordAction } from "./social-rate-limit.js";',
    'import { checkRateLimit, reserveAction, markTikTokRateLimited } from "./social-rate-limit.js";', "reserve operation import");
  s = replaceOnce(s, '  const rl = checkRateLimit(accountId, "tiktok", operation);',
    '  const rl = reserveAction(accountId, "tiktok", operation);', "atomic reserve gate");
  const regex = /  const blocked = gate\(req\.account_id, "(post|follow|like|delete|profile)"\);\n  if \(blocked\) return blocked;\n/g;
  const names = [];
  s = s.replace(regex, (_, operation) => { names.push(operation); return ""; });
  if (names.join(",") !== "post,follow,like,delete,profile,profile") throw new Error("Unexpected TikTok gate sites: " + names.join(","));
  const preflightText = (operation) => `  const preflight = checkRateLimit(req.account_id, "tiktok", "${operation}");\n  if (!preflight.ok) return { success: false, error: preflight.reason || "Rate limited",\n    error_code: "RATE_LIMITED_PROTECTIVE", retry_after_ms: preflight.retry_after_ms };\n\n`;
  s = replaceOnce(s, '  let video: { filePath: string; cleanup: () => void };',
    preflightText("post") + '  let video: { filePath: string; cleanup: () => void };', "early video media preflight");
  s = replaceOnce(s, '  let image;\n  try {\n    image = await materializeImage(req);',
    preflightText("profile") + '  let image;\n  try {\n    image = await materializeImage(req);', "early avatar media preflight");
  // Admission is as close as practical to the irreversible UI action, while
  // still inside the browser-session try/finally and profile filesystem lock.
  // Reserving at session open would allow a 10-minute upload to consume its
  // gap long before the actual click, so queued jobs could fire too close.
  function beforeMutation(marker, operation, label) {
    s = replaceOnce(s, marker,
      `    const blocked = gate(req.account_id, "${operation}");\n    if (blocked) return blocked;\n` + marker, label);
  }
  beforeMutation('    // Submit — intercept TikTok\'s /aweme/v1/web/aweme/post/ API call', "post", "post submit admission");
  beforeMutation('    console.error(`[tiktok] follow button resolved via ${follow.strategy}`);', "follow", "follow click admission");
  beforeMutation('    console.error(`[tiktok] like button resolved via ${like.strategy}`);', "like", "like click admission");
  beforeMutation('    await confirm.click({ timeout: 6000 });', "delete", "delete confirmation admission");
  beforeMutation('    await save.click({ timeout: 8000 });', "profile", "profile Save admission");
  beforeMutation('    await fileInput.setInputFiles(image.filePath);', "profile", "avatar upload admission");
  const actions = (s.match(/    recordAction\(req\.account_id, "tiktok", /g) || []).length;
  if (actions !== 9) throw new Error("Unexpected success-only action count: " + actions);
  s = s.replace(/^\s*recordAction\(req\.account_id, "tiktok", "(?:post|follow|like|delete|profile)"\);\n/gm, "\n");
  s = replaceOnce(s, '  const statusCode = typeof json?.status_code === "number" ? json.status_code : undefined;',
    '  const statusCode = typeof json?.status_code === "number" ? json.status_code : undefined;\n  if (status === 429 || status === 503 || (statusCode !== undefined && statusCode >= 10000 && statusCode < 20000)) {\n    const accountId = (page as any).__tiktokRateLimitAccountId;\n    if (accountId) markTikTokRateLimited(accountId, status, await resp.headerValue("retry-after").catch(() => null));\n  }', "TikTok API cooldown");
  s = s.replace(" *   1. Opens a stealth Chromium session", " *   1. Opens a normal Chromium session");
  s = s.replace(' * every op goes through `checkRateLimit()` before the browser even boots.',
    ' * each mutation reserves one attempt only after the cross-process profile lock.');
  fs.writeFileSync(p, s);
}

{
  const p = "src/runtime/social-runtime.ts";
  let s = fs.readFileSync(p, "utf8");
  s = replaceOnce(s, 'import { acquireFileLock } from "./file-lock.js";',
    'import { acquireFileLock } from "./file-lock.js";\nimport { markTikTokRateLimited, assertTikTokReadAllowed } from "./social-rate-limit.js";', "rate handling import");
  s = replaceOnce(s, 'export interface LaunchLocalContextOptions {\n  accountId: string;',
    'export interface LaunchLocalContextOptions {\n  accountId: string;\n  /** QR login recovery is explicitly allowed even during an account cooldown. */\n  bypassCooldown?: boolean;', "login-only cooldown bypass option");
  s = replaceOnce(s,
    'export async function launchLocalContext(opts: LaunchLocalContextOptions): Promise<LocalContext> {\n  const release = await lockAccount(opts.accountId);',
    'export async function launchLocalContext(opts: LaunchLocalContextOptions): Promise<LocalContext> {\n  // Fast fail before browser startup and recheck after waiting on the profile\n  // lock, since a different process may have received 429 in the meantime.\n  if (!opts.bypassCooldown) assertTikTokReadAllowed(opts.accountId);\n  const release = await lockAccount(opts.accountId);\n  try { if (!opts.bypassCooldown) assertTikTokReadAllowed(opts.accountId); }\n  catch (error) { release(); throw error; }', "read-session cooldown admission");
  s = replaceOnce(s, '"--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check",',
    '"--no-first-run", "--no-default-browser-check",', "remove browser automation masking");
  const telemetryStart = s.indexOf('    if (/mon\\.tiktokv');
  const telemetryEnd = s.indexOf('    if (!loadMedia', telemetryStart);
  if (telemetryStart < 0 || telemetryEnd < 0 || telemetryEnd - telemetryStart > 400) {
    throw new Error("Missing monitoring route suppression block");
  }
  s = s.slice(0, telemetryStart) + s.slice(telemetryEnd);
  s = replaceOnce(s, '    const url = request.url();\n', '', "remove unused telemetry URL");
  const cooldownListener = [
    '    (page as any).__tiktokRateLimitAccountId = opts.accountId;',
    '    page.on("response", (response) => {',
    '      const status = response.status();',
    '      if (status !== 429 && status !== 503) return;',
    '      let host: string;',
    '      try { host = new URL(response.url()).hostname.toLowerCase(); }',
    '      catch { return; /* malformed response URL, not a persistence failure */ }',
    '      if (host !== "tiktok.com" && !host.endsWith(".tiktok.com") &&',
    '          host !== "tiktokv.com" && !host.endsWith(".tiktokv.com")) return;',
    '      const persistFailure = (error: unknown) => {',
    '        (page as any).__tiktokLimiterFailure = error;',
    '        console.error("[tiktok] COOLDOWN PERSISTENCE FAILED; closing browser session to stop actions:", error);',
    '        void page.close().catch(() => {});',
    '      };',
    '      try { markTikTokRateLimited(opts.accountId, status); }',
    '      catch (error) { persistFailure(error); return; }',
    '      void response.headerValue("retry-after").then((header) => {',
    '        if (!header) return;',
    '        try { markTikTokRateLimited(opts.accountId, status, header); }',
    '        catch (error) { persistFailure(error); }',
    '      }).catch(() => {}); // fallback cooldown was already persisted',
    '    });',
    '    trackPendingRequests(page);',
  ].join("\n");
  s = replaceOnce(s, '    trackPendingRequests(page);', cooldownListener, "fail-closed response cooldown listener");
  fs.writeFileSync(p, s);
}

{
  const p = "src/runtime/local-runtime.ts";
  let s = fs.readFileSync(p, "utf8");
  s = replaceOnce(s, '        background: true,\n      });',
    '        background: true,\n        bypassCooldown: true, // QR login recovery, not an ordinary feed/read session\n      });', "explicit QR login cooldown bypass");
  s = replaceOnce(s, 'import { randomUUID } from "node:crypto";',
    'import { createHash, randomUUID } from "node:crypto";\nimport { closeSync, openSync, readSync, statSync } from "node:fs";\nimport { resolve } from "node:path";',
    "local deterministic media fingerprinting imports");
  s = replaceOnce(s, '  putOperation,\n  upsertAccount,',
    '  putOperation,\n  reserveTikTokPostOperation,\n  upsertAccount,', "post intent claim import");
  const fingerprintHelper = [
    '/** Hash the actual local file bytes so renaming the same video does not',
    ' * create a second post intent. Only a SHA-256 digest enters persisted state.',
    ' * Never retain raw video/base64, account credentials, or signed URL tokens.',
    ' */',
    'function postMediaFingerprint(input: Record<string, unknown>): string {',
    '  const digest = createHash("sha256");',
    '  if (typeof input.video_path === "string" && input.video_path) {',
    '    const name = resolve(input.video_path);',
    '    try {',
    '      const stat = statSync(name);',
    '      if (!stat.isFile()) throw new Error("Not a regular video file");',
    '      const fd = openSync(name, "r");',
    '      try {',
    '        const buffer = Buffer.allocUnsafe(1024 * 1024);',
    '        let n: number;',
    '        while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, n));',
    '      } finally { closeSync(fd); }',
    '    } catch (error: any) { throw new Error("Unable to fingerprint local TikTok video: " + (error?.message || String(error))); }',
    '  } else if (typeof input.video_base64 === "string") {',
    '    digest.update("base64:");',
    '    digest.update(input.video_base64.trim());',
    '  } else if (typeof input.video_url === "string") {',
    '    digest.update("url:");',
    '    digest.update(input.video_url.trim());',
    '  } else {',
    '    digest.update("missing-video");',
    '  }',
    '  return digest.digest("hex");',
    '}',
    '',
    'function postIntentFingerprint(input: Record<string, unknown>): string {',
    '  const data = {',
    '    media_sha256: postMediaFingerprint(input),',
    '    caption: String(input.caption ?? "").trim(),',
    '    privacy: input.privacy ?? 0,',
    '    allow_comments: input.allow_comments ?? true,',
    '    allow_duet: input.allow_duet ?? true,',
    '    allow_stitch: input.allow_stitch ?? true,',
    '    schedule_at: typeof input.schedule_at === "string" ? input.schedule_at.trim() : null,',
    '  };',
    '  return createHash("sha256").update(JSON.stringify(data)).digest("hex");',
    '}',
    '',
    '',
  ].join("\n");
  s = replaceOnce(s, 'type OperationResult = TikTokOpResult<any>;\n',
    'type OperationResult = TikTokOpResult<any>;\n\n' + fingerprintHelper, "post intent fingerprint helper");
  s = replaceOnce(s, '    const operation: LocalOperation = {\n      id,\n      name,\n      account_id: accountId,',
    '    let operation: LocalOperation = {\n      id,\n      name,\n      account_id: accountId,', "mutable claimed operation");
  s = replaceOnce(s, '      updated_at: now,\n    };\n    putOperation(operation);\n    void (async () => {\n      operation.status = "running";',
    '      updated_at: now,\n    };\n    if (name === "post") {\n      const claim = reserveTikTokPostOperation(operation, postIntentFingerprint(input));\n      if (claim.reused) {\n        return { operation_id: claim.operation.id, status: claim.operation.status, reused: true,\n          poll_with: "tiktok_operation_status",\n          ...(claim.operation.error_code ? { error_code: claim.operation.error_code, error: claim.operation.error } : {}),\n        };\n      }\n      operation = claim.operation;\n    } else {\n      putOperation(operation);\n    }\n    void (async () => {\n      operation.status = "running";',
    "atomic post-intent claim before async worker");
  fs.writeFileSync(p, s);
}
