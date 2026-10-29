import test from "node:test";
import assert from "node:assert/strict";
import { runLifecycle } from "../scripts/bench-lifecycle.mjs";

test("300 deterministic socket reconnects and tab invalidations leave no retained live resources", async () => {
  const measured = await runLifecycle(300);
  assert.equal(measured.cycles, 300);
  assert.equal(measured.createdSockets, 301);
  assert.equal(measured.attachCalls, 300);
  assert.equal(measured.detachCalls, 300);
  assert.equal(measured.activeSockets + measured.activeIntervals + measured.activeTimeouts, 0);
  assert.equal(measured.activeDebuggers + measured.pendingWebSocketRequests + measured.pendingAttaches, 0);
  assert.equal(measured.watched, 0);
  assert.equal(measured.maxIntervals, 1);
  assert.equal(measured.chromeListeners, 8);
  assert.equal(measured.samples.length, 6);
});
