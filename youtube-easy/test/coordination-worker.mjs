import fs from "node:fs";
import {
  acquireLease,
  coordinatedWrite,
  withProfileLease,
} from "../src/coordination.js";

const [mode, root, externalFile] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function append(prefix = "external") {
  fs.appendFileSync(externalFile, `${prefix}:${process.pid}:${Date.now()}\n`);
}

function has(prefix = "external") {
  try { return fs.readFileSync(externalFile, "utf8").split(/\r?\n/).some((line) => line.startsWith(`${prefix}:`)); }
  catch { return false; }
}

const base = {
  root,
  account: "UC_TEST_CHANNEL",
  fingerprint: "upload:fingerprint-1",
  intent: { action: "upload_video", title: "Race test" },
  leaseMs: 250,
  waitMs: 5_000,
  duplicateWindowMs: 60_000,
  writeGapMs: 0,
};

async function normalOperation({ persist }) {
  append();
  persist({ videoId: "vid_existing", studioUrl: "https://studio.youtube.com/video/vid_existing/edit", publicUrl: "https://youtu.be/vid_existing" });
  await sleep(120);
  return {
    message: "Uploaded",
    videoId: "vid_existing",
    studioUrl: "https://studio.youtube.com/video/vid_existing/edit",
    publicUrl: "https://youtu.be/vid_existing",
    channelId: "UC_TEST_CHANNEL",
    verified: { title: "Race test", visibility: "private" },
  };
}

async function normalReconcile() {
  return has()
    ? { status: "found", result: { message: "Found existing upload", videoId: "vid_existing", studioUrl: "https://studio.youtube.com/video/vid_existing/edit", publicUrl: "https://youtu.be/vid_existing" } }
    : { status: "not_found" };
}

switch (mode) {
  case "race":
  case "reuse": {
    const result = await coordinatedWrite({ ...base, operation: normalOperation, reconcile: normalReconcile });
    process.stdout.write(JSON.stringify(result));
    break;
  }
  case "profile": {
    const result = await withProfileLease(root, async () => {
      const start = Date.now();
      await sleep(220);
      return { start, end: Date.now() };
    }, { leaseMs: 300, waitMs: 5_000 });
    process.stdout.write(JSON.stringify(result));
    break;
  }
  case "hold-lock": {
    await acquireLease({ root, namespace: "profile", key: "browser-profile", leaseMs: 150, waitMs: 2_000 });
    process.stdout.write("locked\n");
    setInterval(() => {}, 1_000);
    break;
  }
  case "recover-lock": {
    const lease = await acquireLease({ root, namespace: "profile", key: "browser-profile", leaseMs: 150, waitMs: 2_000 });
    lease.release();
    process.stdout.write("recovered");
    break;
  }
  case "crash-found": {
    await coordinatedWrite({
      ...base,
      operation: async ({ persist }) => {
        persist({ videoId: "vid_early", studioUrl: "https://studio.youtube.com/video/vid_early/edit", publicUrl: "https://youtu.be/vid_early" });
        append();
        process.exit(23);
      },
      reconcile: normalReconcile,
    });
    break;
  }
  case "crash-miss": {
    await coordinatedWrite({
      ...base,
      operation: async () => process.exit(24),
      reconcile: async () => ({ status: "not_found" }),
    });
    break;
  }
  case "retry-miss": {
    const result = await coordinatedWrite({
      ...base,
      operation: normalOperation,
      reconcile: async () => ({ status: "not_found" }),
    });
    process.stdout.write(JSON.stringify(result));
    break;
  }
  case "uncertain": {
    const result = await coordinatedWrite({
      ...base,
      operation: async () => {
        append("maybe");
        throw new Error("browser disconnected after click");
      },
      reconcile: async () => ({ status: "unknown" }),
    });
    process.stdout.write(JSON.stringify(result));
    break;
  }
  default:
    throw new Error(`unknown mode ${mode}`);
}
