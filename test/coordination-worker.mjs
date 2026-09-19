import fs from "node:fs";
import path from "node:path";
import { coordinatedWrite, withLease } from "../src/coordination.js";

const [mode, root, externalFile] = process.argv.slice(2);
const account = "race_account";
const fingerprint = "same-write-fingerprint";

function append(line) {
  fs.mkdirSync(path.dirname(externalFile), { recursive: true });
  fs.appendFileSync(externalFile, line + "\n");
}

function lines() {
  try { return fs.readFileSync(externalFile, "utf8").trim().split(/\r?\n/).filter(Boolean); }
  catch { return []; }
}

async function raceWrite({ crash = false, unknown = false } = {}) {
  const outcome = await coordinatedWrite({
    root,
    account,
    fingerprint,
    intent: { type: "comment", parentId: "t3_parent", text: "same body" },
    duplicateWindowMs: 10 * 60 * 1000,
    writeGapMs: 25,
    leaseMs: 350,
    reconcile: async () => {
      if (unknown) return { status: "unknown" };
      const found = lines().find((line) => line.startsWith("external:"));
      return found
        ? { status: "found", result: { message: "existing comment", fullname: "t1_existing", permalink: "https://www.reddit.com/r/test/comments/a/b/existing/" } }
        : { status: "not_found" };
    },
    operation: async () => {
      append(`external:${process.pid}`);
      await new Promise((resolve) => setTimeout(resolve, 180));
      if (crash) process.exit(17);
      return { message: "created comment", fullname: "t1_created", permalink: "https://www.reddit.com/r/test/comments/a/b/created/" };
    },
  });
  process.stdout.write(JSON.stringify(outcome));
}

if (mode === "race" || mode === "reuse") {
  await raceWrite();
} else if (mode === "crash") {
  await raceWrite({ crash: true });
} else if (mode === "uncertain") {
  const outcome = await coordinatedWrite({
    root,
    account,
    fingerprint: "uncertain-fingerprint",
    intent: { type: "comment", text: "uncertain" },
    writeGapMs: 1,
    leaseMs: 350,
    reconcile: async () => ({ status: "unknown" }),
    operation: async () => {
      append(`maybe:${process.pid}`);
      throw new Error("simulated transport loss");
    },
  });
  process.stdout.write(JSON.stringify(outcome));
} else if (mode === "hold-lock") {
  await withLease({ root, namespace: "write", key: "stale-key", leaseMs: 250, waitMs: 1000 }, async () => {
    process.stdout.write("locked\n");
    await new Promise(() => {});
  });
} else if (mode === "recover-lock") {
  await withLease({ root, namespace: "write", key: "stale-key", leaseMs: 250, waitMs: 2500 }, async () => {
    process.stdout.write("recovered\n");
  });
} else if (mode === "profile") {
  await withLease({ root, namespace: "profile", key: "browser-profile", leaseMs: 600, waitMs: 5000 }, async () => {
    const start = Date.now();
    append(`start:${process.pid}:${start}`);
    await new Promise((resolve) => setTimeout(resolve, 220));
    const end = Date.now();
    append(`end:${process.pid}:${end}`);
    process.stdout.write(JSON.stringify({ start, end }));
  });
} else {
  throw new Error("unknown worker mode");
}
