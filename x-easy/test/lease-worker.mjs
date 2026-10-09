import fs from "node:fs";
import { withLease } from "../src/coordination.js";

const [mode, root, activity] = process.argv.slice(2);
try {
  await withLease(root, "live-process", "same-profile", async () => {
    process.stdout.write("acquired\n");
    await new Promise((resolve) => setImmediate(resolve)); // Flush the signal.
    if (mode === "crash") process.exit(51);
    if (mode === "pause-live") {
      // Simulates a busy/paused event loop: the heartbeat timer cannot run,
      // even though the owner is still alive and its critical section active.
      const until = Date.now() + 2_000;
      while (Date.now() < until) {}
      fs.appendFileSync(activity, "owner-completed\n");
    }
  }, { leaseMs: 150, waitMs: mode === "probe" ? 300 : 5_000 });
  process.stdout.write("released\n");
} catch (error) {
  process.stderr.write(String(error?.stack || error));
  process.exitCode = 1;
}
