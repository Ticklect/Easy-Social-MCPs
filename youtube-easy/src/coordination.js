import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_LEASE_MS = 45_000;
const DEFAULT_WAIT_MS = 120_000;
const POLL_MS = 60;
const READ_GAP_MS = 1_250;
const WRITE_GAP_MS = 3_500;
const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1_000;
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRY_COUNT = 12;
const renameDelay = new Int32Array(new SharedArrayBuffer(4));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { fs.chmodSync(dir, 0o700); } catch {}
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function atomicJsonWrite(file, value) {
  ensurePrivateDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    // Windows can briefly reject replacement while another process reads the
    // destination or antivirus scans the file. Keep the old complete record
    // available until the rename succeeds; never fall back to a direct write.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temp, file);
        break;
      } catch (error) {
        if (!RENAME_RETRY_CODES.has(error?.code) || attempt >= RENAME_RETRY_COUNT - 1) throw error;
        Atomics.wait(renameDelay, 0, 0, Math.min(15 * (attempt + 1), 75));
      }
    }
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch {}
  }
}

function removeQuiet(target) {
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 }); } catch {}
}

export function isProcessAlive(pid, killFn = process.kill) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try { killFn(value, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

export function coordinationPaths(root) {
  const base = path.join(root, "coordination");
  return {
    base,
    locks: path.join(base, "locks"),
    writes: path.join(base, "writes"),
    accounts: path.join(base, "accounts"),
    profileTraffic: path.join(base, "profile-traffic.json"),
  };
}

function profileTrafficFile(root) {
  const paths = coordinationPaths(root);
  ensurePrivateDir(paths.base);
  return paths.profileTraffic;
}

function readProfileTraffic(root) {
  const file = profileTrafficFile(root);
  const value = readJson(file);
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (fs.existsSync(file)) throw new Error("Shared YouTube pacing state is unreadable; browser access stopped.");
  return {};
}

function updateProfileTraffic(root, changes) {
  const file = profileTrafficFile(root);
  const previous = readProfileTraffic(root);
  const next = { ...previous, ...changes };
  atomicJsonWrite(file, next);
  return next;
}

function retryAfterDelay(value, now) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds * 1_000), MAX_COOLDOWN_MS);
  const date = Date.parse(text);
  return Number.isFinite(date) && date > now ? Math.min(date - now, MAX_COOLDOWN_MS) : null;
}

// Only YouTube's own document and API responses count. An unrelated image or
// Google service error must not suppress a channel write.
export function noteYouTubeResponse(root, { response, type } = {}, now = Date.now()) {
  const status = Number(response?.status);
  if (![429, 500, 502, 503, 504].includes(status)) return null;
  if (!["Document", "XHR", "Fetch"].includes(type)) return null;
  let url;
  try { url = new URL(response.url); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !(host === "youtube.com" || host.endsWith(".youtube.com"))) return null;

  const headers = response.headers && typeof response.headers === "object" ? response.headers : {};
  const retryAfter = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  // A tiny (or zero) Retry-After must never suppress the local protective
  // floor: otherwise repeated 429s can immediately trigger another request.
  const minimumDelay = status === 429 ? 60_000 : 15_000;
  const delay = Math.max(minimumDelay, retryAfterDelay(retryAfter, now) ?? 0);
  const previous = readProfileTraffic(root);
  const cooldownUntil = Math.max(Number(previous.cooldownUntil || 0), now + delay);
  const longestCooldown = cooldownUntil > Number(previous.cooldownUntil || 0);
  updateProfileTraffic(root, { cooldownUntil, status: longestCooldown ? status : previous.status, observedAt: longestCooldown ? now : previous.observedAt, host: longestCooldown ? host : previous.host });
  return { status, cooldownUntil };
}

function checkProfileCooldown(state, now) {
  const cooldownUntil = Number(state?.cooldownUntil || 0);
  if (cooldownUntil <= now) return;
  const remaining = Math.ceil((cooldownUntil - now) / 1_000);
  const error = new Error(`YouTube returned HTTP ${state.status || 429}; the shared browser profile is cooling down for ${remaining} more seconds. No automatic retry was attempted.`);
  error.code = "YOUTUBE_COOLDOWN";
  error.cooldownUntil = cooldownUntil;
  throw error;
}

async function paceProfile(root, options) {
  const currentGap = options.pacingMs ?? (options.pacingKind === "write" ? WRITE_GAP_MS : READ_GAP_MS);
  if (!Number.isFinite(currentGap) || currentGap < 0 || currentGap > 60_000) throw new Error("Invalid profile pacing interval.");
  const state = readProfileTraffic(root);
  checkProfileCooldown(state, Date.now());
  const previousGap = Number(state.gapMs || 0);
  if (!Number.isFinite(previousGap) || previousGap < 0 || previousGap > 60_000) throw new Error("Shared YouTube pacing interval is invalid; browser access stopped.");
  const interval = Math.max(currentGap, previousGap);
  const waitUntil = Number(state.lastActivityAt || 0) + interval;
  if (waitUntil > Date.now()) await sleep(waitUntil - Date.now());
  checkProfileCooldown(readProfileTraffic(root), Date.now());
  updateProfileTraffic(root, { lastActivityAt: Date.now(), gapMs: currentGap });
}

export async function acquireLease({
  root,
  namespace,
  key,
  leaseMs = DEFAULT_LEASE_MS,
  waitMs = DEFAULT_WAIT_MS,
  metadata = {},
}) {
  if (!root || !namespace || !key) throw new Error("root, namespace, and key are required for a lease.");
  const { locks } = coordinationPaths(root);
  ensurePrivateDir(locks);
  const keyHash = hash(`${namespace}\n${key}`);
  const lockDir = path.join(locks, `${namespace}-${keyHash}.lock`);
  const leaseFile = path.join(lockDir, "lease.json");
  const owner = `${process.pid}-${crypto.randomBytes(12).toString("hex")}`;
  const deadline = Date.now() + waitMs;

  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      const now = Date.now();
      let record = {
        schema: 1,
        owner,
        pid: process.pid,
        namespace,
        keyHash,
        createdAt: now,
        heartbeatAt: now,
        leaseMs,
        ...metadata,
      };
      try { atomicJsonWrite(leaseFile, record); }
      catch (error) {
        // No lease was returned and no action may have run. Release the newly
        // created directory rather than leaving a phantom lock until expiry.
        removeQuiet(lockDir);
        throw error;
      }
      let released = false;
      const heartbeat = setInterval(() => {
        if (released) return;
        const current = readJson(leaseFile);
        if (!current || current.owner !== owner) return;
        record = { ...current, heartbeatAt: Date.now() };
        try { atomicJsonWrite(leaseFile, record); } catch {}
      }, Math.max(50, Math.floor(leaseMs / 3)));
      heartbeat.unref?.();

      return {
        owner,
        lockDir,
        update(extra = {}) {
          const current = readJson(leaseFile);
          if (!current || current.owner !== owner) return false;
          record = { ...current, ...extra, heartbeatAt: Date.now() };
          atomicJsonWrite(leaseFile, record);
          return true;
        },
        release() {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          const current = readJson(leaseFile);
          if (current?.owner === owner) removeQuiet(lockDir);
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const current = readJson(leaseFile);
    let stale = false;
    if (current) {
      const heartbeatAt = Number(current.heartbeatAt || current.createdAt || 0);
      const activeLeaseMs = Math.max(100, Number(current.leaseMs || leaseMs));
      stale = Date.now() - heartbeatAt > activeLeaseMs && !isProcessAlive(current.pid);
    } else {
      try { stale = Date.now() - fs.statSync(lockDir).mtimeMs > Math.max(100, leaseMs); }
      catch { continue; }
    }

    if (stale) {
      const quarantine = `${lockDir}.stale-${process.pid}-${crypto.randomBytes(5).toString("hex")}`;
      try {
        fs.renameSync(lockDir, quarantine);
        removeQuiet(quarantine);
        continue;
      } catch (error) {
        if (["ENOENT", "EEXIST", "EPERM", "EACCES"].includes(error?.code)) {
          await sleep(POLL_MS);
          continue;
        }
        throw error;
      }
    }

    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${namespace} coordination lock.`);
    await sleep(POLL_MS);
  }
}

export async function withLease(options, fn) {
  const lease = await acquireLease(options);
  try { return await fn(lease); }
  finally { lease.release(); }
}

export async function withProfileLease(root, fn, options = {}) {
  return await withLease({
    root,
    namespace: "profile",
    key: "browser-profile",
    leaseMs: options.leaseMs || DEFAULT_LEASE_MS,
    waitMs: options.waitMs || DEFAULT_WAIT_MS,
    metadata: options.metadata || {},
  }, async (lease) => {
    if (options.skipPacing) return await fn(lease);
    await paceProfile(root, options);
    try { return await fn(lease); }
    finally {
      updateProfileTraffic(root, { lastActivityAt: Date.now(), gapMs: options.pacingMs ?? (options.pacingKind === "write" ? WRITE_GAP_MS : READ_GAP_MS) });
    }
  });
}

function writeFile(root, account, fingerprint) {
  const { writes } = coordinationPaths(root);
  ensurePrivateDir(writes);
  return path.join(writes, `${hash(`${account}\n${fingerprint}`)}.json`);
}

function accountFile(root, account) {
  const { accounts } = coordinationPaths(root);
  ensurePrivateDir(accounts);
  return path.join(accounts, `${hash(account)}.json`);
}

function boundedString(value, max = 20_000) {
  if (value === undefined || value === null) return undefined;
  return String(value).slice(0, max);
}

export function normalizeWriteResult(value) {
  const source = value && typeof value === "object" ? value : { message: value };
  const result = {};
  for (const key of ["message", "videoId", "studioUrl", "publicUrl", "channelId", "commentId"]) {
    const normalized = boundedString(source[key], key === "message" ? 20_000 : 2_000);
    if (normalized !== undefined) result[key] = normalized;
  }
  if (source.verified && typeof source.verified === "object" && !Array.isArray(source.verified)) {
    result.verified = {};
    for (const [key, item] of Object.entries(source.verified)) {
      if (typeof item === "string") result.verified[key] = item.slice(0, 10_000);
      else if (typeof item === "boolean" || typeof item === "number" || item === null) result.verified[key] = item;
      else if (Array.isArray(item) && item.every((entry) => typeof entry === "string")) result.verified[key] = item.map((entry) => entry.slice(0, 1_000));
    }
  }
  if (!result.message) result.message = "YouTube Studio write completed.";
  return result;
}

export class KnownNotAppliedError extends Error {
  constructor(message) {
    super(message);
    this.name = "KnownNotAppliedError";
    this.knownNotApplied = true;
  }
}

export class DraftPreservedError extends Error {
  constructor(message, result = {}) {
    super(message);
    this.name = "DraftPreservedError";
    this.draftPreserved = true;
    this.result = result;
  }
}

export function formatWriteOutcome(outcome) {
  if (!outcome || typeof outcome !== "object") return String(outcome ?? "");
  if (outcome.status === "uncertain") {
    const message = String(outcome.message || "The outcome could not be determined.").replace(/^UNCERTAIN:\s*/i, "");
    return `UNCERTAIN: ${message} No automatic retry was performed because that could duplicate a YouTube write.`;
  }
  let message = outcome.result?.message || "YouTube Studio write completed.";
  if (outcome.status === "reused") message += " (Reused the persisted result; no second write was sent.)";
  return message;
}

async function reconcileSafely(reconcile, record) {
  if (typeof reconcile !== "function" || !record?.sentAt) return { status: "unknown" };
  try {
    const value = await reconcile(record);
    if (!value || !["found", "not_found", "unknown"].includes(value.status)) return { status: "unknown" };
    return value;
  } catch {
    return { status: "unknown" };
  }
}

function uncertainRecord(record, detail) {
  const message = `UNCERTAIN: ${detail}`;
  return { ...record, status: "uncertain", uncertainAt: Date.now(), message };
}

export function readPersistedWrite(root, account, fingerprint) {
  return readJson(writeFile(root, account, fingerprint));
}

export async function coordinatedWrite({
  root,
  account,
  fingerprint,
  intent,
  operation,
  reconcile,
  duplicateWindowMs = 10 * 60 * 1_000,
  writeGapMs = 3_500,
  leaseMs = DEFAULT_LEASE_MS,
  waitMs = DEFAULT_WAIT_MS,
}) {
  if (!root || !account || !fingerprint) throw new Error("root, account, and fingerprint are required.");
  if (typeof operation !== "function") throw new Error("operation must be a function.");
  const recordPath = writeFile(root, account, fingerprint);

  return await withLease({
    root,
    namespace: "write",
    key: `${account}\n${fingerprint}`,
    leaseMs,
    waitMs,
    metadata: { accountHash: hash(account), fingerprintHash: hash(fingerprint) },
  }, async (lease) => {
    const now = Date.now();
    let previous = readJson(recordPath);
    if (previous?.status === "success" && now - Number(previous.completedAt || 0) < duplicateWindowMs) {
      return { status: "reused", result: normalizeWriteResult(previous.result), persisted: true };
    }
    if (previous?.status === "draft_preserved" && now - Number(previous.completedAt || 0) < duplicateWindowMs) {
      return { status: "draft_preserved", result: normalizeWriteResult(previous.result), persisted: true, reused: true };
    }

    if (previous?.sentAt && previous.status !== "success") {
      lease.update({ phase: "reconciling-previous" });
      const reconciled = await reconcileSafely(reconcile, previous);
      if (reconciled.status === "found") {
        const result = normalizeWriteResult({ ...(previous.partialResult || {}), ...(reconciled.result || {}) });
        previous = { ...previous, status: "success", completedAt: Date.now(), reconciledAt: Date.now(), result };
        atomicJsonWrite(recordPath, previous);
        return { status: "reused", result, persisted: true, reconciled: true };
      }
      if (reconciled.status !== "not_found") {
        previous = uncertainRecord(previous, "A previous process may already have completed this YouTube write, and Studio reconciliation could not prove the outcome.");
        atomicJsonWrite(recordPath, previous);
        return { status: "uncertain", message: previous.message, persisted: true };
      }
    }

    let record = {
      schema: 1,
      account,
      fingerprintHash: hash(fingerprint),
      status: "pending",
      startedAt: Date.now(),
      sentAt: null,
      intent,
      owner: lease.owner,
      partialResult: {},
    };
    atomicJsonWrite(recordPath, record);
    lease.update({ phase: "pending" });

    await withLease({
      root,
      namespace: "account-write",
      key: account,
      leaseMs,
      waitMs,
      metadata: { accountHash: hash(account) },
    }, async (accountLease) => {
      const statePath = accountFile(root, account);
      const state = readJson(statePath) || {};
      if (fs.existsSync(statePath) && (!Number.isFinite(state.lastWriteAt) || state.lastWriteAt < 0)) {
        throw new Error("Shared YouTube account pacing state is unreadable; write stopped before dispatch.");
      }
      const elapsed = Date.now() - Number(state.lastWriteAt || 0);
      if (elapsed < writeGapMs) await sleep(writeGapMs - elapsed);
      const sentAt = Date.now();
      atomicJsonWrite(statePath, { accountHash: hash(account), lastWriteAt: sentAt });
      record = { ...record, sentAt, status: "pending" };
      atomicJsonWrite(recordPath, record);
      lease.update({ phase: "sent", sentAt });
      accountLease.update({ phase: "dispatch", sentAt });
    });

    const persist = (patch) => {
      const normalized = normalizeWriteResult(patch);
      record = { ...record, partialResult: { ...(record.partialResult || {}), ...normalized }, progressAt: Date.now() };
      atomicJsonWrite(recordPath, record);
      lease.update({ phase: "progress", videoId: normalized.videoId });
      return record.partialResult;
    };

    try {
      const result = normalizeWriteResult(await operation({ record, persist }));
      const merged = normalizeWriteResult({ ...(record.partialResult || {}), ...result });
      record = { ...record, status: "success", completedAt: Date.now(), result: merged };
      atomicJsonWrite(recordPath, record);
      lease.update({ phase: "success", videoId: merged.videoId });
      return { status: "success", result: merged, persisted: true };
    } catch (error) {
      if (error?.draftPreserved) {
        const result = normalizeWriteResult({ ...(record.partialResult || {}), ...(error.result || {}), message: error.message });
        record = { ...record, status: "draft_preserved", completedAt: Date.now(), result };
        atomicJsonWrite(recordPath, record);
        lease.update({ phase: "draft-preserved", videoId: result.videoId });
        return { status: "draft_preserved", result, persisted: true };
      }
      if (error?.knownNotApplied) {
        record = { ...record, status: "failed", failedAt: Date.now(), message: error.message };
        atomicJsonWrite(recordPath, record);
        throw error;
      }

      lease.update({ phase: "reconciling-error" });
      const reconciled = await reconcileSafely(reconcile, record);
      if (reconciled.status === "found") {
        const result = normalizeWriteResult({ ...(record.partialResult || {}), ...(reconciled.result || {}) });
        record = { ...record, status: "success", completedAt: Date.now(), reconciledAt: Date.now(), result };
        atomicJsonWrite(recordPath, record);
        return { status: "success", result, persisted: true, reconciled: true };
      }
      if (reconciled.status === "not_found") {
        record = { ...record, status: "failed", failedAt: Date.now(), message: error?.message || "Studio write did not apply." };
        atomicJsonWrite(recordPath, record);
        throw error;
      }

      record = uncertainRecord(record, `YouTube Easy lost certainty after the action may have been sent: ${error?.message || "unknown browser failure"}.`);
      atomicJsonWrite(recordPath, record);
      return { status: "uncertain", message: record.message, persisted: true };
    }
  });
}
