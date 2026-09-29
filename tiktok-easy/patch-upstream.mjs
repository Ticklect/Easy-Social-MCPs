import fs from "node:fs";

function replaceOnce(s, from, to, label) {
  if (!s.includes(from)) throw new Error("Missing patch target: " + label);
  return s.replace(from, to);
}

{
  const p = "src/runtime/file-lock.ts";
  const source = [
    'import { randomUUID } from "node:crypto";',
    'import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    '',
    'type LockOptions = { timeoutMs?: number; pollMs?: number };',
    'const syncWait = new Int32Array(new SharedArrayBuffer(4));',
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
    '    const match = /^(\\d+)-/.exec(claim.name);',
    '    const pid = Number(match?.[1]);',
    '    if (!Number.isInteger(pid) || pid <= 0 || isProcessAlive(pid)) { active = true; continue; }',
    '    try { rmSync(join(root, claim.name), { recursive: true, force: true }); }',
    '    catch { active = true; }',
    '  }',
    '  return active;',
    '}',
    '',
    'function createReclaimClaim(lockDir: string): string {',
    '  const root = reclaimRootPath(lockDir);',
    '  mkdirSync(root, { recursive: true, mode: 0o700 });',
    '  const claimDir = join(root, `${process.pid}-${randomUUID()}`);',
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
    '    try { rmSync(lockDir, { recursive: true, force: true }); } catch {}',
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
