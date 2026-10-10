import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 60_000;

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function directory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try { fs.chmodSync(dir, 0o700); } catch {}
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeJson(file, value) {
  directory(path.dirname(file));
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  try { fs.renameSync(temp, file); }
  finally { try { fs.rmSync(temp, { force: true }); } catch {} }
}

/** An old heartbeat is not proof of a dead owner: the event loop may be paused. */
export function isProcessAlive(pid, kill = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true; // Unknown owner: fail closed.
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM means alive but inaccessible; unknown probe errors are unsafe to reap.
    return true;
  }
}

function ownerPid(record) {
  if (Number.isSafeInteger(record?.pid) && record.pid > 0) return record.pid;
  // Compatibility with v0.1.1 locks created before the explicit pid field.
  const match = /^(\d+)-[0-9a-f]+$/.exec(String(record?.owner || ""));
  return match ? Number(match[1]) : null;
}

function deadLease(record, leaseMs) {
  if (!record || typeof record.owner !== "string") return false;
  const heartbeatAt = Number(record.heartbeatAt);
  if (!Number.isFinite(heartbeatAt)) return false;
  const limit = Math.max(1_000, Number(record.leaseMs) || leaseMs);
  return Date.now() - heartbeatAt > limit && !isProcessAlive(ownerPid(record));
}

/** Filesystem directory creation is atomic across Node processes. */
export async function withLease(root, namespace, key, fn, { waitMs = 120_000, leaseMs = 45_000 } = {}) {
  const folder = path.join(root, "coordination", "locks", `${namespace}-${hash(key)}.lock`);
  directory(path.dirname(folder));
  const metadata = path.join(folder, "lease.json");
  const reclaim = `${folder}.reaping`;
  const reclaimMetadata = path.join(reclaim, "owner.json");
  const owner = `${process.pid}-${crypto.randomBytes(12).toString("hex")}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    // A dead-owner reaper holds this claim until it has quarantined the
    // previous generation. New owners must not race the rename.
    if (fs.existsSync(reclaim)) {
      const currentReaper = readJson(reclaimMetadata);
      // A crash just after mkdir, before owner.json is written, can leave an
      // ownerless claim. Give its creator a generous grace period; never
      // reclaim a claim with a demonstrably live PID, however old it becomes.
      let abandonedOwnerlessClaim = false;
      if (!currentReaper) {
        try {
          abandonedOwnerlessClaim = Date.now() - fs.statSync(reclaim).mtimeMs >= Math.max(5_000, leaseMs * 2);
        } catch { /* Claim may already have been removed. */ }
      }
      if (abandonedOwnerlessClaim || (currentReaper?.owner && !isProcessAlive(ownerPid(currentReaper)))) {
        const staleClaim = `${reclaim}.stale-${owner}`;
        try {
          fs.renameSync(reclaim, staleClaim);
          fs.rmSync(staleClaim, { recursive: true, force: true });
          continue;
        } catch (error) {
          if (!["ENOENT", "EEXIST", "EPERM", "EACCES"].includes(error?.code)) throw error;
        }
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for X ${namespace} coordination.`);
      await sleep(100);
      continue;
    }
    try {
      fs.mkdirSync(folder, { mode: 0o700 });
      try {
        if (fs.existsSync(reclaim)) {
          const error = new Error("X lease reclamation is in progress.");
          error.code = "RECLAIM_IN_PROGRESS";
          throw error;
        }
        writeJson(metadata, { owner, pid: process.pid, heartbeatAt: Date.now(), leaseMs });
      }
      catch (error) { fs.rmSync(folder, { recursive: true, force: true }); throw error; }
      const heartbeat = setInterval(() => {
        if (readJson(metadata)?.owner !== owner) return;
        try { writeJson(metadata, { owner, pid: process.pid, heartbeatAt: Date.now(), leaseMs }); } catch {}
      }, Math.max(250, Math.floor(leaseMs / 3)));
      heartbeat.unref?.();
      try { return await fn(); }
      finally {
        clearInterval(heartbeat);
        if (readJson(metadata)?.owner === owner) fs.rmSync(folder, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "RECLAIM_IN_PROGRESS") throw error;
    }
    const current = readJson(metadata);
    // Unreadable/ownerless metadata is not proof that a creator is dead.
    // Never steal an unknown or live process's lock based on age alone.
    if (deadLease(current, leaseMs)) {
      const quarantine = `${folder}.stale-${owner}`;
      let claimed = false;
      try {
        fs.mkdirSync(reclaim, { mode: 0o700 });
        claimed = true;
        writeJson(reclaimMetadata, { owner, pid: process.pid, createdAt: Date.now() });
        const latest = readJson(metadata);
        if (readJson(reclaimMetadata)?.owner === owner &&
            latest?.owner === current.owner && deadLease(latest, leaseMs)) {
          fs.renameSync(folder, quarantine);
          fs.rmSync(quarantine, { recursive: true, force: true });
          continue;
        }
      } catch (error) {
        if (!["ENOENT", "EEXIST", "EPERM", "EACCES"].includes(error?.code)) throw error;
      } finally {
        const claimOwner = readJson(reclaimMetadata)?.owner;
        if (claimed && (!claimOwner || claimOwner === owner)) {
          fs.rmSync(reclaim, { recursive: true, force: true });
        }
      }
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for X ${namespace} coordination.`);
    await sleep(100);
  }
}

export function retryAfterMs(value, now = Date.now()) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.min(MAX_COOLDOWN_MS, Math.ceil(Number(raw) * 1000));
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)) return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(MAX_COOLDOWN_MS, Math.max(0, at - now)) : null;
}

const requestsFile = (root) => path.join(root, "coordination", "requests.json");

function assertCooldown(state) {
  const wait = Number(state?.cooldownUntil || 0) - Date.now();
  if (wait > 0) throw new Error(`X requested a cooldown. Retry in about ${Math.ceil(wait / 1000)} seconds.`);
}

/** Call before a browser navigation/scroll that may generate X requests. Must hold profile lease. */
export async function paceRead(root, { gapMs = 3_000, maxWaitMs = 8_000 } = {}) {
  const file = requestsFile(root);
  let state = readJson(file) || {};
  assertCooldown(state);
  const wait = Math.max(0, Number(state.lastReadAt || 0) + gapMs - Date.now());
  if (wait > maxWaitMs) throw new Error(`X request pacing is active. Retry in about ${Math.ceil(wait / 1000)} seconds.`);
  if (wait) await sleep(wait);
  state = readJson(file) || {};
  assertCooldown(state);
  writeJson(file, { ...state, lastReadAt: Date.now() });
}

/** Observe first-party HTTP throttling; never store URLs, headers, cookies or account secrets. */
export function noteHttpResponse(root, { status, retryAfter, reset } = {}) {
  if (status !== 429 && status !== 503) return false;
  const explicit = retryAfterMs(retryAfter);
  const resetEpochMs = Number(reset) * 1_000 - Date.now();
  const resetMs = reset == null || String(reset).trim() === "" || !Number.isFinite(resetEpochMs)
    ? null : Math.min(MAX_COOLDOWN_MS, Math.max(0, resetEpochMs));
  const duration = Math.min(MAX_COOLDOWN_MS,
    Math.max(status === 429 ? DEFAULT_COOLDOWN_MS : 15_000, explicit || 0, resetMs || 0));
  const file = requestsFile(root);
  const state = readJson(file) || {};
  writeJson(file, { ...state, cooldownUntil: Math.max(Number(state.cooldownUntil || 0), Date.now() + duration) });
  return true;
}

function writeFile(root, account, fingerprint) {
  return path.join(root, "coordination", "writes", `${hash(account)}-${hash(fingerprint)}.json`);
}

function accountFile(root, account) {
  return path.join(root, "coordination", "accounts", `${hash(account)}.json`);
}

/** Serialize an account's writes across processes; record intent before any browser click. */
export async function coordinatedXWrite({
  root, account, fingerprint, operation,
  windowMs = 60 * 60_000, maxAttempts = 6,
  duplicateMs = 10 * 60_000, minGapMs = 30_000, jitterMs = 30_000, maxWaitMs = 12_000,
}) {
  if (!account || !fingerprint) throw new Error("An X account and write fingerprint are required.");
  return await withLease(root, "account-write", account, async () => {
    const file = writeFile(root, account, fingerprint);
    const previous = readJson(file);
    if (previous?.status === "uncertain" || previous?.status === "pending" && previous?.sentAt) {
      return `UNCERTAIN: A previous X action may have completed. Check X before attempting it again; X Easy did not repeat it.`;
    }
    if (previous?.status === "success" && Date.now() - Number(previous.completedAt || 0) < duplicateMs) {
      return previous.result + " (Reused the prior confirmed result; no duplicate action was sent.)";
    }
    const stateFile = accountFile(root, account);
    let dispatched = false;
    const markAttempt = async () => {
      if (dispatched) return;
      const state = readJson(stateFile) || {};
      assertCooldown(readJson(requestsFile(root)) || {});
      const now = Date.now();
      const attempts = Array.isArray(state.attempts)
        ? state.attempts.filter((t) => Number.isFinite(t) && now - t < windowMs && now >= t) : [];
      if (attempts.length >= maxAttempts) {
        const wait = attempts[0] + windowMs - now;
        throw new Error(`X Easy limits each account to ${maxAttempts} write attempts per hour. Retry in about ${Math.ceil(wait / 1000)} seconds.`);
      }
      const wait = Math.max(0, Number(state.nextWriteAt || 0) - now);
      if (wait > maxWaitMs) throw new Error(`X write pacing is active. Retry in about ${Math.ceil(wait / 1000)} seconds.`);
      // Windows timers (and event-loop scheduling) may resume a few ms before
      // the requested deadline. The actual click gate must honor the
      // persisted nextWriteAt, not merely the requested sleep duration.
      const deadline = Number(state.nextWriteAt || 0);
      while (Date.now() < deadline) await sleep(Math.max(1, deadline - Date.now()));
      assertCooldown(readJson(requestsFile(root)) || {});
      const at = Date.now();
      const jitter = jitterMs ? crypto.randomInt(jitterMs + 1) : 0;
      // Record potential send before executing any click, including its uncertain aftermath.
      writeJson(stateFile, { attempts: [...attempts, at], nextWriteAt: at + minGapMs + jitter });
      writeJson(file, { status: "pending", sentAt: at });
      dispatched = true;
    };
    try {
      const result = String(await operation(markAttempt));
      // A first-party 429/503 observed while the UI was submitting invalidates
      // a purely DOM-based success signal (e.g. composer disappearance).
      if (dispatched && Number(readJson(requestsFile(root))?.cooldownUntil || 0) > Date.now()) {
        writeJson(file, { status: "uncertain", sentAt: Date.now() });
        return "UNCERTAIN: X returned a throttle/unavailable response while this action was being submitted. Verify its outcome on X; no automatic retry was made.";
      }
      writeJson(file, { status: "success", result, completedAt: Date.now(), sentAt: dispatched ? Date.now() : null });
      return result;
    } catch (error) {
      if (dispatched) {
        writeJson(file, { status: "uncertain", sentAt: Date.now() });
        return "UNCERTAIN: X did not confirm the action after a possible submission. Check X before retrying; X Easy will not automatically repeat it.";
      }
      // A failure before markAttempt is proven to have caused no click.
      throw error;
    }
  });
}
