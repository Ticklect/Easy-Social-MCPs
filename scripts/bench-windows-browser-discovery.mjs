// Benchmark only local, read-only Chromium process enumeration. No tabs are
// queried, browser connections are opened, or social requests are made.
// Run on Windows: node scripts/bench-windows-browser-discovery.mjs --samples=6
import { performance } from 'node:perf_hooks';
import { listAlreadyOpenDebuggers as reddit } from '../src/open-browser-discovery.js';
import { listAlreadyOpenDebuggers as x } from '../x-easy/src/open-browser-discovery.js';
import { listAlreadyOpenDebuggers as youtube } from '../youtube-easy/src/open-browser-discovery.js';

const argument = process.argv.find((item) => item.startsWith('--samples='));
const samples = argument ? Number(argument.split('=')[1]) : 6;
if (!Number.isInteger(samples) || samples < 2 || samples > 30) {
  throw new Error('Use --samples=2..30');
}

const percentile = (numbers, fraction) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(2));
};

async function measure(label, discover) {
  const latencyMs = [];
  const cpuMs = [];
  const rssDeltaKiB = [];
  const browserCounts = [];
  for (let i = 0; i < samples; i++) {
    const startCpu = process.cpuUsage();
    const startRss = process.memoryUsage().rss;
    const start = performance.now();
    const ports = discover();
    latencyMs.push(performance.now() - start);
    const used = process.cpuUsage(startCpu);
    cpuMs.push((used.user + used.system) / 1000);
    rssDeltaKiB.push((process.memoryUsage().rss - startRss) / 1024);
    browserCounts.push(ports.length);
  }
  if (browserCounts.some((count) => count !== browserCounts[0])) {
    console.error(`${label}: browser count changed between samples; latency may not be comparable`);
  }
  return {
    label,
    count: samples,
    p50_ms: percentile(latencyMs, 0.5),
    p95_ms: percentile(latencyMs, 0.95),
    cpu_p50_ms: percentile(cpuMs, 0.5),
    rss_delta_p50_kib: percentile(rssDeltaKiB, 0.5),
    debugger_count_first_sample: browserCounts[0],
  };
}

if (process.platform !== 'win32') {
  throw new Error('This benchmark requires Windows process discovery');
}

const results = [];
for (const [label, method] of [['reddit', reddit], ['x', x], ['youtube', youtube]]) {
  results.push(await measure(label, method));
}
console.log(JSON.stringify({ samples, note: 'CPU excludes work done in the spawned PowerShell process; RSS is Node process delta only', results }, null, 2));
