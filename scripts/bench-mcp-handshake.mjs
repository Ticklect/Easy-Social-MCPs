// Read-only MCP stdio startup and control-plane benchmark: initialize,
// tools/list and ping. Never calls any social-platform tool or opens a browser.
// Run: node scripts/bench-mcp-handshake.mjs --samples=8
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const opt = process.argv.find((value) => value.startsWith('--samples='));
const samples = opt ? Number(opt.split('=')[1]) : 8;
if (!Number.isInteger(samples) || samples < 2 || samples > 30) throw new Error('--samples must be 2..30');

const entries = [
  ['reddit', path.join(root, 'dist', 'index.js')],
  ['x', path.join(root, 'x-easy', 'dist', 'index.js')],
  ['youtube', path.join(root, 'youtube-easy', 'src', 'server.js')],
];
function quantile(values, q) {
  const ordered = [...values].sort((a, b) => a - b);
  return Number(ordered[Math.ceil(q * ordered.length) - 1].toFixed(2));
}
const summarize = (values) => ({ p50_ms: quantile(values, 0.5), p95_ms: quantile(values, 0.95) });

async function sample(entry, controlMethod) {
  const start = performance.now();
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const waiting = new Map();
  let buffer = '';
  let nextId = 0;
  let done = false;
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-500); });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    for (let end; (end = buffer.indexOf('\n')) !== -1;) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let reply;
      try { reply = JSON.parse(line); } catch { continue; }
      const pending = waiting.get(reply.id);
      if (pending) {
        waiting.delete(reply.id);
        reply.error ? pending.reject(Error(reply.error.message)) : pending.resolve(reply);
      }
    }
  });
  let rejectClosed;
  const unexpectedlyClosed = new Promise((_, reject) => { rejectClosed = reject; });
  child.on('error', (error) => rejectClosed(error));
  child.on('exit', (code) => { if (!done) rejectClosed(Error(`MCP exited ${code} before handshake: ${stderr}`)); });
  const timeout = setTimeout(() => rejectClosed(Error(`MCP handshake timed out: ${stderr}`)), 5000);
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const initialized = await Promise.race([send('initialize', { protocolVersion: '2024-11-05' }), unexpectedlyClosed]);
    if (!initialized.result?.serverInfo) throw new Error('Initialize reply missing serverInfo');
    const listed = await Promise.race([send('tools/list'), unexpectedlyClosed]);
    if (!Array.isArray(listed.result?.tools)) throw new Error('Tools reply missing definitions');
    const coldMs = performance.now() - start;
    const pingTimes = [];
    for (let n = 0; n < 25; n++) {
      const before = performance.now();
      await Promise.race([send(controlMethod), unexpectedlyClosed]);
      pingTimes.push(performance.now() - before);
    }
    return { coldMs, pingTimes, tools: listed.result.tools.length };
  } finally {
    done = true;
    clearTimeout(timeout);
    for (const pending of waiting.values()) pending.reject(Error('MCP benchmark ended'));
    child.stdin.end();
    child.kill();
  }
}

const result = [];
for (const [name, entry] of entries) {
  const startCpu = process.cpuUsage();
  const startRss = process.memoryUsage().rss;
  const starts = [];
  const pings = [];
  let tools;
  for (let i = 0; i < samples; i++) {
    const measured = await sample(entry, name === 'youtube' ? 'tools/list' : 'ping');
    starts.push(measured.coldMs);
    pings.push(...measured.pingTimes);
    tools = measured.tools;
  }
  const used = process.cpuUsage(startCpu);
  result.push({ name, tools, startup_with_tools_list: summarize(starts), warm_control: summarize(pings),
    parent_cpu_ms: Number(((used.user + used.system) / 1000).toFixed(2)),
    parent_rss_delta_kib: Number(((process.memoryUsage().rss - startRss) / 1024).toFixed(2)) });
}
console.log(JSON.stringify({ samples, note: 'Warm control is ping for Reddit/X and tools/list for YouTube. CPU and RSS cover benchmark parent only; cold startup measures child Node process and module initialization', result }, null, 2));
