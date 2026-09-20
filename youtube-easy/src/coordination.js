import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_LEASE_MS = 45_000;
const DEFAULT_WAIT_MS = 120_000;
const POLL_MS = 60;

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
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
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
  };
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
      atomicJsonWrite(leaseFile, record);
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
  }, fn);
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
