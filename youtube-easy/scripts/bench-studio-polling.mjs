// Deterministic mock of YouTube Studio mounting a selector after a delayed
// client-side render. No browser, account or network connection is involved.
// Run: node scripts/bench-studio-polling.mjs --samples=24
import { performance } from "node:perf_hooks";
import { StudioAdapter } from "../src/studio.js";

const sampleArg = process.argv.find((arg) => arg.startsWith("--samples="));
const samples = sampleArg ? Number(sampleArg.split("=")[1]) : 24;
if (!Number.isInteger(samples) || samples < 4 || samples > 100) throw new Error("Use --samples=4..100");
const transitionMs = [40, 130, 270, 540];
const cdpRttMs = 6;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentiles = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  return { p50: Number(sorted[Math.ceil(sorted.length * 0.5) - 1].toFixed(2)),
    p95: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2)) };
};

function createMockPage() {
  let available = false;
  let observers = new Set();
  let evals = 0;
  let selectors = 0;
  const document = {
    documentElement: {},
    querySelector(selector) {
      if (selector !== "#upload-input") throw new Error(`Unexpected selector ${selector}`);
      selectors++;
      return available ? { type: "file" } : null;
    },
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const client = {
    youtubeThrottle: null,
    async evaluate(script) {
      evals++;
      await sleep(cdpRttMs / 2);
      const result = await new Function("document", "MutationObserver", "setTimeout", "clearTimeout", `return (${script})`)(
        document, MutationObserver, setTimeout, clearTimeout);
      await sleep(cdpRttMs / 2);
      return result;
    },
  };
  return {
    client,
    mount() {
      available = true;
      for (const observer of [...observers]) observer.callback([{ type: "childList" }]);
    },
    counters: () => ({ evaluations: evals, selectorChecks: selectors, danglingObservers: observers.size }),
  };
}

async function measure(variant) {
  const durations = [];
  const evaluations = [];
  const selectorChecks = [];
  const cpu = [];
  const rss = [];
  for (let i = 0; i < samples; i++) {
    const page = createMockPage();
    const adapter = new StudioAdapter({ client: page.client });
    const scheduled = setTimeout(() => page.mount(), transitionMs[i % transitionMs.length]);
    const startedCpu = process.cpuUsage();
    const startedRss = process.memoryUsage().rss;
    const start = performance.now();
    try {
      if (variant === "legacy") {
        // Original 250ms polling semantics, held fixed for before/after.
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          if (page.client.youtubeThrottle) throw page.client.youtubeThrottle;
          const result = await page.client.evaluate('Boolean(document.querySelector("#upload-input"))').catch(() => null);
          if (page.client.youtubeThrottle) throw page.client.youtubeThrottle;
          if (result) break;
          await sleep(250);
        }
      } else {
        await adapter.waitFor('Boolean(document.querySelector("#upload-input"))', "upload input");
      }
      durations.push(performance.now() - start);
      const usedCpu = process.cpuUsage(startedCpu);
      cpu.push((usedCpu.user + usedCpu.system) / 1000);
      rss.push((process.memoryUsage().rss - startedRss) / 1024);
      const counts = page.counters();
      if (counts.danglingObservers !== 0) throw new Error("Leaked MutationObserver");
      evaluations.push(counts.evaluations);
      selectorChecks.push(counts.selectorChecks);
    } finally { clearTimeout(scheduled); }
  }
  return { variant, ...percentiles(durations), evaluations_p50: percentiles(evaluations).p50,
    evaluations_p95: percentiles(evaluations).p95,
    selector_checks_p50: percentiles(selectorChecks).p50,
    selector_checks_p95: percentiles(selectorChecks).p95,
    mock_cpu_p50_ms: percentiles(cpu).p50,
    mock_rss_delta_p50_kib: percentiles(rss).p50 };
}

console.log(JSON.stringify({ samples, transitions_ms: transitionMs, simulated_cdp_rtt_ms: cdpRttMs,
  results: [await measure("legacy"), await measure("adapter")] }, null, 2));
