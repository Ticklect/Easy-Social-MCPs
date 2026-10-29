/** Offline, repeatable discovery latency benchmark. No real browser access. */
import { performance } from "node:perf_hooks";
import { discoverOpenBrowserPort } from "./browser-discovery-v0.1.6.ts";

const samples = 31;
const candidateCount = 6;
const simulatedProbeMs = 25;
const processes = Array.from({ length: candidateCount }, (_, i) => ({
  pid: 1000 + i,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  port: 9000 + i,
}));

const getVersion = async (port) => {
  await new Promise((resolve) => setTimeout(resolve, simulatedProbeMs));
  return {
    Browser: "Chrome/145.0.0.0",
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/session-${port}`,
  };
};

const durations = [];
for (let i = 0; i < samples; i++) {
  const start = performance.now();
  try {
    await discoverOpenBrowserPort({ processes, getVersion });
    throw new Error("Multiple browser sessions should always be rejected");
  } catch (error) {
    if (!/Multiple already-open browser debug sessions/.test(error.message)) throw error;
  }
  durations.push(performance.now() - start);
}

durations.sort((a, b) => a - b);
const percentile = (p) => durations[Math.ceil(p * samples) - 1];
process.stdout.write(JSON.stringify({
  candidates: candidateCount,
  simulated_probe_ms: simulatedProbeMs,
  samples,
  p50_ms: Math.round(percentile(0.5) * 100) / 100,
  p95_ms: Math.round(percentile(0.95) * 100) / 100,
  min_ms: Math.round(durations[0] * 100) / 100,
  max_ms: Math.round(durations.at(-1) * 100) / 100,
}, null, 2) + "\n");
