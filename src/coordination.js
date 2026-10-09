import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_WAIT_MS = 90_000;
const POLL_MS = 80;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeName(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { fs.chmodSync(dir, 0o700); } catch {}
  }
}

function atomicJsonWrite(file, value) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function rmQuiet(target) {
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 }); } catch {}
}

export function statePaths(root) {
  const coordinationDir = path.join(root, "coordination");
  return {
    coordinationDir,
    locksDir: path.join(coordinationDir, "locks"),
    writesDir: path.join(coordinationDir, "writes"),
    accountsDir: path.join(coordinationDir, "accounts"),
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
  if (!root) throw new Error("coordination root is required");
  const { locksDir } = statePaths(root);
  ensureDir(locksDir);
  const lockKey = safeName(`${namespace}\n${key}`);
  const lockDir = path.join(locksDir, `${namespace}-${lockKey}.lock`);
  const metaFile = path.join(lockDir, "lease.json");
  const owner = `${process.pid}-${crypto.randomBytes(12).toString("hex")}`;
  const deadline = Date.now() + waitMs;

  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      const now = Date.now();
      let lease = {
        owner,
        pid: process.pid,
        namespace,
        keyHash: lockKey,
        createdAt: now,
        heartbeatAt: now,
        leaseMs,
        ...metadata,
      };
      atomicJsonWrite(metaFile, lease);

      let released = false;
      const heartbeatMs = Math.max(250, Math.floor(leaseMs / 3));
      const timer = setInterval(() => {
        if (released) return;
        const current = readJson(metaFile);
        if (!current || current.owner !== owner) return;
        lease = { ...current, heartbeatAt: Date.now() };
        try { atomicJsonWrite(metaFile, lease); } catch {}
      }, heartbeatMs);
      timer.unref?.();

      return {
        owner,
        lockDir,
        update(extra = {}) {
          const current = readJson(metaFile);
          if (!current || current.owner !== owner) return false;
          lease = { ...current, ...extra, heartbeatAt: Date.now() };
          atomicJsonWrite(metaFile, lease);
          return true;
        },
        release() {
          if (released) return;
          released = true;
          clearInterval(timer);
          const current = readJson(metaFile);
          if (current?.owner === owner) rmQuiet(lockDir);
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const current = readJson(metaFile);
    let stale = false;
    if (!current) {
      try {
        const stat = fs.statSync(lockDir);
        stale = Date.now() - stat.mtimeMs > leaseMs;
      } catch {
        continue;
      }
    } else {
      const heartbeat = Number(current.heartbeatAt || current.createdAt || 0);
      const currentLeaseMs = Math.max(1_000, Number(current.leaseMs || leaseMs));
      stale = Date.now() - heartbeat > currentLeaseMs;
    }

    if (stale) {
      const quarantine = `${lockDir}.stale-${process.pid}-${crypto.randomBytes(5).toString("hex")}`;
      try {
        fs.renameSync(lockDir, quarantine);
        rmQuiet(quarantine);
        continue;
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "EEXIST" || error?.code === "EPERM") {
          await sleep(POLL_MS);
          continue;
        }
        throw error;
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${namespace} coordination lock.`);
    }
    await sleep(POLL_MS);
  }
}

export async function withLease(options, fn) {
  const lease = await acquireLease(options);
  try { return await fn(lease); }
  finally { lease.release(); }
}

const REDDIT_MIN_REQUEST_GAP_MS = 2_500;
const REDDIT_MIN_WRITE_GAP_MS = 12_000;
const REDDIT_MAX_INLINE_WAIT_MS = 8_000;
const REDDIT_DEFAULT_COOLDOWN_MS = 60_000;
const REDDIT_MAX_COOLDOWN_MS = 24 * 60 * 60 * 1_000;

function boundedDelayMs(value, max = REDDIT_MAX_COOLDOWN_MS) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.ceil(n), max) : null;
}

export function retryAfterMs(value, now = Date.now()) {
  if (value == null || String(value).trim() === "") return null;
  const raw = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) return boundedDelayMs(Number(raw) * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? boundedDelayMs(Math.max(0, date - now)) : null;
}

function redditErrorDelayMs(response) {
  const errors = response?.data?.json?.errors;
  if (!Array.isArray(errors)) return null;
  for (const entry of errors) {
    if (!Array.isArray(entry) || String(entry[0]).toUpperCase() !== "RATELIMIT") continue;
    const text = String(entry.slice(1).join(" "));
    const match = text.match(/(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?|days?)/i);
    if (!match) return REDDIT_DEFAULT_COOLDOWN_MS;
    const scale = /^day/i.test(match[2]) ? 86_400_000 : /^hour/i.test(match[2]) ? 3_600_000
      : /^minute/i.test(match[2]) ? 60_000 : 1_000;
    return boundedDelayMs(Number(match[1]) * scale) ?? REDDIT_DEFAULT_COOLDOWN_MS;
  }
  return null;
}

export function redditResponseCooldown(response, now = Date.now()) {
  const headers = response?.rateLimit || {};
  const retryMs = retryAfterMs(headers.retryAfter, now);
  const remaining = headers.remaining == null || String(headers.remaining).trim() === ""
    ? null : Number(headers.remaining);
  const resetMs = headers.reset == null || String(headers.reset).trim() === ""
    ? null : boundedDelayMs(Number(headers.reset) * 1_000);
  const apiCooldown = redditErrorDelayMs(response);
  let cooldownMs = apiCooldown || 0;
  if (response?.status === 429) cooldownMs = Math.max(cooldownMs, REDDIT_DEFAULT_COOLDOWN_MS);
  if (response?.status === 503) cooldownMs = Math.max(cooldownMs, 15_000);
  if (response?.status === 429 || response?.status === 503 || apiCooldown !== null) {
    cooldownMs = Math.max(cooldownMs, retryMs ?? 0);
  }
  if (Number.isFinite(remaining) && remaining <= 2 && resetMs !== null) {
    cooldownMs = Math.max(cooldownMs, resetMs + 1_000);
  }
  let extraGapMs = 0;
  if (Number.isFinite(remaining) && remaining > 2 && remaining <= 10 && resetMs !== null) {
    extraGapMs = Math.min(30_000, Math.ceil(resetMs / (remaining - 1)));
  }
  return { cooldownMs: Math.min(cooldownMs, REDDIT_MAX_COOLDOWN_MS), extraGapMs,
    throttled: response?.status === 429 || response?.status === 503 || apiCooldown !== null };
}

export class RedditCooldownError extends Error {
  constructor(waitMs, { knownNotApplied = true, unavailable = false } = {}) {
    super(`Reddit is ${unavailable ? "temporarily unavailable" : "rate-limiting requests"}. Retry in about ${Math.ceil(waitMs / 1_000)} seconds; the shared cooldown is being respected.`);
    this.name = "RedditCooldownError";
    // A 503 response to a write may have arrived after the operation was applied.
    this.knownNotApplied = knownNotApplied;
    this.retryAfterMs = waitMs;
  }
}

/** Serializes Reddit HTTP requests across MCP processes using the same local profile. */
export async function coordinatedRedditRequest({ root, request, gapMs = REDDIT_MIN_REQUEST_GAP_MS,
  write = false, writeGapMs = REDDIT_MIN_WRITE_GAP_MS,
  maxWaitMs = write ? 16_000 : REDDIT_MAX_INLINE_WAIT_MS }) {
  return await withLease({ root, namespace: "reddit-request", key: "browser-profile",
    leaseMs: 45_000, waitMs: 120_000 }, async () => {
    const stateFile = path.join(statePaths(root).coordinationDir, "reddit-requests.json");
    const state = readJson(stateFile) || {};
    const waitMs = Math.max(0, Number(state.cooldownUntil || 0) - Date.now(),
      Number(state.nextRequestAt || 0) - Date.now(),
      write ? Number(state.lastWriteRequestAt || 0) + writeGapMs - Date.now() : 0,
      Number(state.lastRequestAt || 0) + gapMs - Date.now());
    if (waitMs > maxWaitMs) throw new RedditCooldownError(waitMs);
    if (waitMs) await sleep(waitMs);
    const dispatchedAt = Date.now();
    const dispatchState = {
      ...state, lastRequestAt: dispatchedAt,
      ...(write ? { lastWriteRequestAt: dispatchedAt } : {}),
    };
    atomicJsonWrite(stateFile, dispatchState);

    const response = await request();
    const policy = redditResponseCooldown(response);
    const nextState = {
      ...dispatchState,
      cooldownUntil: Math.max(Number(state.cooldownUntil || 0), Date.now() + policy.cooldownMs),
      nextRequestAt: Date.now() + policy.extraGapMs,
    };
    atomicJsonWrite(stateFile, nextState);
    if (policy.throttled) throw new RedditCooldownError(policy.cooldownMs,
      { knownNotApplied: response?.status !== 503, unavailable: response?.status === 503 });
    return response;
  });
}

function writeRecordPath(root, account, fingerprint) {
  const { writesDir } = statePaths(root);
  ensureDir(writesDir);
  return path.join(writesDir, `${safeName(`${account}\n${fingerprint}`)}.json`);
}

function accountStatePath(root, account) {
  const { accountsDir } = statePaths(root);
  ensureDir(accountsDir);
  return path.join(accountsDir, `${safeName(account)}.json`);
}

function normalizeResult(result) {
  if (typeof result === "string") return { message: result };
  if (!result || typeof result !== "object") return { message: String(result ?? "") };
  return {
    message: String(result.message || ""),
    ...(result.fullname ? { fullname: String(result.fullname) } : {}),
    ...(result.permalink ? { permalink: String(result.permalink) } : {}),
  };
}

export class KnownWriteFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "KnownWriteFailure";
    this.knownNotApplied = true;
  }
}

export class UncertainWriteError extends Error {
  constructor(message) {
    super(message);
    this.name = "UncertainWriteError";
    this.uncertain = true;
  }
}

export function formatWriteOutcome(outcome) {
  if (!outcome || typeof outcome !== "object") return String(outcome ?? "");
  if (outcome.status === "uncertain") {
    return `UNCERTAIN: ${outcome.message || "Reddit Easy cannot determine whether the write completed."} No automatic retry was performed because that could create a duplicate.`;
  }
  const result = outcome.result || {};
  let text = result.message || "Reddit write completed.";
  if (outcome.status === "reused") text += " (Reused the persisted result; no second write was sent.)";
  return text;
}

async function reconcileExisting({ reconcile, record }) {
  if (!reconcile || !record?.sentAt) return { status: "unknown" };
  try {
    const result = await reconcile(record);
    if (!result || !["found", "not_found", "unknown"].includes(result.status)) return { status: "unknown" };
    return result;
  } catch {
    return { status: "unknown" };
  }
}

export async function coordinatedWrite({
  root,
  account,
  fingerprint,
  intent,
  operation,
  reconcile,
  duplicateWindowMs = 10 * 60 * 1000,
  writeGapMs = 3_500,
  leaseMs = DEFAULT_LEASE_MS,
}) {
  if (!account || !fingerprint) throw new Error("account and fingerprint are required");
  const lockKey = `${account}\n${fingerprint}`;

  return await withLease({
    root,
    namespace: "write",
    key: lockKey,
    leaseMs,
    waitMs: Math.max(DEFAULT_WAIT_MS, leaseMs * 4),
    metadata: { accountHash: safeName(account), fingerprint },
  }, async (lease) => {
    const recordFile = writeRecordPath(root, account, fingerprint);
    const now = Date.now();
    let previous = readJson(recordFile);

    if (previous?.status === "success" && now - Number(previous.completedAt || 0) < duplicateWindowMs) {
      return { status: "reused", result: normalizeResult(previous.result), persisted: true };
    }

    if (previous?.sentAt && previous.status !== "success" && !previous.knownNotApplied) {
      lease.update({ phase: "reconciling-stale" });
      const rec = await reconcileExisting({ reconcile, record: previous });
      if (rec.status === "found") {
        const result = normalizeResult(rec.result);
        atomicJsonWrite(recordFile, {
          ...previous,
          status: "success",
          completedAt: Date.now(),
          reconciledAt: Date.now(),
          result,
        });
        return { status: "reused", result, persisted: true, reconciled: true };
      }
      if (rec.status !== "not_found") {
        const uncertain = {
          ...previous,
          status: "uncertain",
          uncertainAt: Date.now(),
          message: "A previous process may already have sent this Reddit write, and reconciliation could not prove the outcome.",
        };
        atomicJsonWrite(recordFile, uncertain);
        return { status: "uncertain", message: uncertain.message };
      }
    }

    const startedAt = Date.now();
    let record = {
      schema: 1,
      account,
      fingerprint,
      status: "pending",
      startedAt,
      sentAt: null,
      intent,
      owner: lease.owner,
    };
    atomicJsonWrite(recordFile, record);
    lease.update({ phase: "pending" });

    await withLease({
      root,
      namespace: "account-write",
      key: account,
      leaseMs,
      waitMs: Math.max(DEFAULT_WAIT_MS, leaseMs * 4),
      metadata: { accountHash: safeName(account) },
    }, async (accountLease) => {
      const stateFile = accountStatePath(root, account);
      const state = readJson(stateFile) || {};
      const since = Date.now() - Number(state.lastWriteAt || 0);
      if (since < writeGapMs) await sleep(writeGapMs - since);
      const dispatchAt = Date.now();
      atomicJsonWrite(stateFile, { ...state, accountHash: safeName(account), lastWriteAt: dispatchAt });
      record = { ...record, sentAt: dispatchAt, status: "pending" };
      atomicJsonWrite(recordFile, record);
      lease.update({ phase: "sent", sentAt: dispatchAt });
      accountLease.update({ phase: "dispatch", sentAt: dispatchAt });
    });

    try {
      const rawResult = await operation(record);
      const result = normalizeResult(rawResult);
      const success = {
        ...record,
        status: "success",
        completedAt: Date.now(),
        result,
      };
      atomicJsonWrite(recordFile, success);
      lease.update({ phase: "success" });
      return { status: "success", result, persisted: true };
    } catch (error) {
      if (error?.knownNotApplied) {
        atomicJsonWrite(recordFile, {
          ...record,
          status: "failed",
          sentAt: null,
          knownNotApplied: true,
          failedAt: Date.now(),
          message: error.message,
        });
        throw error;
      }

      lease.update({ phase: "reconciling-error" });
      const rec = await reconcileExisting({ reconcile, record });
      if (rec.status === "found") {
        const result = normalizeResult(rec.result);
        atomicJsonWrite(recordFile, {
          ...record,
          status: "success",
          completedAt: Date.now(),
          reconciledAt: Date.now(),
          result,
        });
        return { status: "success", result, persisted: true, reconciled: true };
      }
      if (rec.status === "not_found") {
        atomicJsonWrite(recordFile, {
          ...record,
          status: "failed",
          failedAt: Date.now(),
          message: error?.message || "Write failed before Reddit applied it.",
        });
        throw error;
      }

      const message = `Reddit Easy lost certainty after the write may have been sent: ${error?.message || "unknown transport failure"}`;
      atomicJsonWrite(recordFile, {
        ...record,
        status: "uncertain",
        uncertainAt: Date.now(),
        message,
      });
      return { status: "uncertain", message };
    }
  });
}
