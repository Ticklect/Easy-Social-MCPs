/** Benchmark actual bundled TikTok profile-identity helper against mock CDP delays. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { extractZip } from "../test/zip.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, ".work", "worker3-profile-benchmark");
const archive = path.join(root, "tiktok-easy-v0.1.6.mcpb");
const count = 31;
const mockRoundTripMs = 25;

if (fs.existsSync(fixture)) throw new Error("Refusing to overwrite an existing benchmark fixture");
fs.mkdirSync(fixture, { recursive: true });
try {
  extractZip(archive, fixture);
  const { signedInProfileName } = await import(pathToFileURL(
    path.join(fixture, "app", "dist", "runtime", "social-runtime.js")).href);
  const times = [];
  for (let i = 0; i < count; i++) {
    const events = [];
    const page = { locator(selector) {
      assert.equal(selector, 'a[data-e2e="nav-profile"]');
      return { first: () => ({
        async isVisible(options) {
          assert.equal(options.timeout, 10_000);
          events.push("visible-start");
          await new Promise((resolve) => setTimeout(resolve, mockRoundTripMs));
          events.push("visible-end");
          return true;
        },
        async getAttribute(attribute, options) {
          assert.equal(attribute, "href");
          assert.equal(options.timeout, 5_000);
          events.push("href-start");
          await new Promise((resolve) => setTimeout(resolve, mockRoundTripMs));
          events.push("href-end");
          return "/@real_creator";
        },
      }) };
    } };
    const start = performance.now();
    assert.equal(await signedInProfileName(page), "real_creator");
    times.push(performance.now() - start);
    assert.equal(events.length, 4);
  }
  times.sort((a, b) => a - b);
  const percentile = (p) => Number(times[Math.ceil(p * count) - 1].toFixed(2));
  console.log(JSON.stringify({ samples: count, mocked_cdp_roundtrip_ms: mockRoundTripMs,
    p50_ms: percentile(0.5), p95_ms: percentile(0.95),
    min_ms: Number(times[0].toFixed(2)), max_ms: Number(times.at(-1).toFixed(2)),
  }, null, 2));
} finally {
  const resolved = path.resolve(fixture);
  const expected = path.resolve(root, ".work", "worker3-profile-benchmark");
  if (resolved !== expected || !resolved.startsWith(path.resolve(root, ".work") + path.sep)) {
    throw new Error("Unsafe benchmark cleanup path");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
