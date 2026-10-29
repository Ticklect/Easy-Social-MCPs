// Read-only Windows measurement of process scanning. No browser CDP, network,
// profile mutations or social-site interactions. Usage:
//   node scripts/bench-warm-process-ipc.mjs
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { WarmPowerShellProcessScanner } from './bench-warm-process-ipc-client.mjs';
import { listAlreadyOpenDebuggers } from '../src/open-browser-discovery.js';

if (process.platform !== 'win32') throw new Error('Windows-only benchmark');
const workerScript = fileURLToPath(new URL('./bench-warm-process-ipc-worker.ps1', import.meta.url));
const settings = { timeoutMs: 6000, idleMs: 5000 };
const round = (number) => Number(number.toFixed(2));
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.ceil(sorted.length * fraction) - 1]);
};
const summary = (items, key) => {
  const vals = items.map((item) => item[key]).filter((v) => Number.isFinite(v));
  return vals.length ? { p50: percentile(vals, 0.5), p95: percentile(vals, 0.95) } : null;
};

async function capture(action) {
  const cpuBefore = process.cpuUsage();
  const rssBefore = process.memoryUsage().rss;
  const began = performance.now();
  const response = await action();
  const used = process.cpuUsage(cpuBefore);
  return {
    elapsedMs: performance.now() - began,
    nodeCpuMs: (used.user + used.system) / 1000,
    nodeRssDeltaMb: (process.memoryUsage().rss - rssBefore) / 1048576,
    childCpuMs: response?.cpuMs,
    childRssMb: response?.rssMb,
    processCount: response?.ports?.length ?? response?.length ?? 0,
  };
}

function format(samples) {
  return {
    samples: samples.length, elapsedMs: summary(samples, 'elapsedMs'), nodeCpuMs: summary(samples, 'nodeCpuMs'),
    childScanCpuMs: summary(samples, 'childCpuMs'), childRssMb: summary(samples, 'childRssMb'),
    nodeRssDeltaMb: summary(samples, 'nodeRssDeltaMb'),
    observedPortCounts: [...new Set(samples.map((x) => x.processCount))],
  };
}

async function measure(label, operation, samples = 20) {
  const records = [];
  for (let i = 0; i < samples; i++) records.push(await capture(operation));
  return { label, first5: format(records.slice(0, 5)), all20: format(records) };
}

const base = await measure('existing current cold synchronous scanner', () => listAlreadyOpenDebuggers());
const cold = await measure('identical prototype algorithm, fresh PowerShell process for every request', async () => {
  const client = new WarmPowerShellProcessScanner(settings);
  try { return await client.scan(); }
  finally { client.close(); }
});

const startup = [];
for (let i = 0; i < 5; i++) {
  const client = new WarmPowerShellProcessScanner(settings);
  try { startup.push(await capture(() => client.scan())); }
  finally { client.close(); }
}

const warmClient = new WarmPowerShellProcessScanner(settings);
let warm;
let startupScan;
let spawns;
try {
  startupScan = await capture(() => warmClient.scan());
  warm = await measure('persistent PowerShell, fresh CIM+owner enumeration every IPC request', () => warmClient.scan());
  spawns = warmClient.spawns;
} finally {
  warmClient.close();
}

console.log(JSON.stringify({
  measuredAt: new Date().toISOString(), node: process.version,
  workerScript, baseline: base, prototypeCold: cold,
  prototypeStartupFiveIndependentProcesses: format(startup), persistentFirstScan: format([startupScan]),
  prototypeWarm: warm, persistentProcessSpawns: spawns,
  interpretation: [
    'All scans observe local processes only; CPU/RSS of other running apps are not measured.',
    'childScanCpuMs excludes PowerShell startup. Existing synchronous scanner does not expose child CPU or RSS.',
    'Warm process keeps a PowerShell RSS allocation until idle shutdown and requires lifecycle management.',
    'Current implementation has five browser-name filters; this prototype has eight, and rejects unsafe reparse-point paths.',
    'Windows startup noise and browser process changes can alter measured percentiles.',
  ],
}, null, 2));
