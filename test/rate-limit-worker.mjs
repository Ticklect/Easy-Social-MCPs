import { coordinatedRedditRequest } from "../src/coordination.js";

try {
  await coordinatedRedditRequest({ root: process.argv[2], gapMs: 0, maxWaitMs: 0,
    request: async () => ({ ok: true, status: 200 }) });
  process.stdout.write(JSON.stringify({ error: null }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.name, retryAfterMs: error.retryAfterMs }));
}
