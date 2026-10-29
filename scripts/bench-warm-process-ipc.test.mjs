import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WarmPowerShellProcessScanner } from './bench-warm-process-ipc-client.mjs';

const mock = fileURLToPath(new URL('./bench-warm-process-ipc-mock.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./bench-warm-process-ipc-worker.ps1', import.meta.url));
const fakeScanner = (overrides = {}) => new WarmPowerShellProcessScanner({
  command: process.execPath, args: [mock], timeoutMs: 2500, idleMs: 120, ...overrides,
});

test('concurrent requests receive only their own IDs and reuse one process', async (t) => {
  const client = fakeScanner();
  t.after(() => client.close());
  const responses = await Promise.all(Array.from({ length: 20 }, () => client.scan()));
  assert.equal(client.spawns, 1);
  assert.deepEqual(new Set(responses.map((item) => item.id)).size, 20);
  assert.ok(responses.every((item) => item.ports[0] === 19001));
});

test('unknown/stale IDs are ignored and do not resolve a pending scan', async (t) => {
  const client = fakeScanner();
  t.after(() => client.close());
  const reply = await client.scan({ rows: [{ mock: 'stale' }] });
  assert.deepEqual(reply.ports, [19001]);
  assert.equal(client.ignoredReplies, 1);
});

test('timeout invalidates all pending requests; subsequent scan starts a new child', async (t) => {
  const client = fakeScanner({ timeoutMs: 65 });
  t.after(() => client.close());
  const oldPid = await client.scan().then(() => client.pid);
  await assert.rejects(client.scan({ rows: [{ mock: 'delay' }] }), /timed out/);
  assert.equal(client.pid, null);
  const reply = await client.scan();
  assert.equal(reply.ports[0], 19001);
  assert.notEqual(client.pid, oldPid);
  assert.equal(client.spawns, 2);
});

test('unexpected process exit fails closed and recovers on the next request', async (t) => {
  const client = fakeScanner();
  t.after(() => client.close());
  await assert.rejects(client.scan({ rows: [{ mock: 'exit' }] }), /exited/);
  assert.deepEqual((await client.scan()).ports, [19001]);
  assert.equal(client.spawns, 2);
});

test('malformed port output fails closed and future requests get a new worker', async (t) => {
  const client = fakeScanner();
  t.after(() => client.close());
  await assert.rejects(client.scan({ rows: [{ mock: 'invalid' }] }), /invalid ports/);
  assert.deepEqual((await client.scan()).ports, [19001]);
  assert.equal(client.spawns, 2);
});

test('idle worker shuts down within bound, and close disables new scans', async () => {
  const client = fakeScanner({ idleMs: 55 });
  await client.scan();
  assert.ok(client.pid);
  await delay(110);
  assert.equal(client.pid, null);
  assert.equal(client.shutdowns, 1);
  await client.scan();
  assert.equal(client.spawns, 2);
  client.close();
  assert.throws(() => client.scan(), /already closed/);
});

test('fixture PS worker requires exact Windows owner and returns <=32 valid unique ports from each fresh request', {
  skip: process.platform !== 'win32', timeout: 12000,
}, async (t) => {
  const whoami = execFileSync('whoami', { encoding: 'utf8' }).trim();
  const index = whoami.lastIndexOf('\\');
  assert.ok(index > 0, `Expected DOMAIN\\USER from whoami`);
  const domain = whoami.slice(0, index);
  const user = whoami.slice(index + 1);
  const client = new WarmPowerShellProcessScanner({
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-Fixture'],
    timeoutMs: 5500, idleMs: 1000,
  });
  t.after(() => client.close());
  const row = (port, extra = {}) => ({ Name: 'chrome.exe', CommandLine: `chrome.exe --remote-debugging-port=${port}`, OwnerReturnValue: 0, OwnerDomain: domain, OwnerUser: user, ...extra });
  const rows = [
    row(1234, { OwnerUser: `wrong_${user}` }),
    row(1235, { OwnerReturnValue: 1 }),
    row(1236, { Name: 'random.exe' }),
    row(1237, { CommandLine: 'chrome.exe --type=renderer --remote-debugging-port=1237' }),
    row(1238, { CommandLine: 'chrome.exe --remote-debugging-address=0.0.0.0 --remote-debugging-port=1238' }),
    row(1239, { CommandLine: 'chrome.exe --remote-debugging-port=70000' }),
    ...Array.from({ length: 40 }, (_, i) => row(20001 + i)),
  ];
  const first = await client.scan({ rows });
  assert.deepEqual(first.ports, Array.from({ length: 32 }, (_, i) => 20001 + i));
  assert.equal(first.ports.length, 32);
  // Only a new synthetic snapshot, not cached rows from the first scan.
  assert.deepEqual((await client.scan({ rows: [row(30001), row(30001)] })).ports, [30001]);
  assert.equal(client.spawns, 1);
});

test('port=0 resolves only a local regular profile port file and rejects junctions, missing files and wrong owners', {
  skip: process.platform !== 'win32', timeout: 12000,
}, async (t) => {
  const name = execFileSync('whoami', { encoding: 'utf8' }).trim();
  const divider = name.lastIndexOf('\\');
  const domain = name.slice(0, divider);
  const user = name.slice(divider + 1);
  const folder = mkdtempSync(join(dirname(fixture), 'bench-warm-process-fixture-'));
  const profile = join(folder, 'profile');
  const alias = join(folder, 'junction');
  let client;
  t.after(async () => {
    client?.close();
    await delay(150); // Windows: let the child release its port-file handle.
    // Remove the junction itself before recursively removing this test folder.
    rmdirSync(alias);
    rmSync(folder, { recursive: true, force: true });
  });
  mkdirSync(profile);
  writeFileSync(join(profile, 'DevToolsActivePort'), '32100\n/devtools/browser/placeholder\n');
  symlinkSync(profile, alias, 'junction');
  client = new WarmPowerShellProcessScanner({
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-Fixture'],
    timeoutMs: 5500, idleMs: 1000,
  });
  const row = (userDir, userOverride = user) => ({
    Name: 'chrome.exe', OwnerDomain: domain, OwnerUser: userOverride, OwnerReturnValue: 0,
    CommandLine: `chrome.exe --remote-debugging-port=0 --user-data-dir="${userDir}"`,
  });
  assert.deepEqual((await client.scan({ rows: [row(profile)] })).ports, [32100]);
  assert.deepEqual((await client.scan({ rows: [row(alias)] })).ports, []);
  assert.deepEqual((await client.scan({ rows: [row(join(folder, 'absent'))] })).ports, []);
  assert.deepEqual((await client.scan({ rows: [row(profile, `wrong_${user}`)] })).ports, []);
  assert.deepEqual((await client.scan({ rows: [row('\\\\server\\share')] })).ports, []);
  assert.equal(client.spawns, 1);
});
