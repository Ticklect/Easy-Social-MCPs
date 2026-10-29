// Deterministic child-process simulation for testing the Node IPC controller.
// No browser, CIM, filesystem or network operations.
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  const behavior = request.rows?.[0]?.mock;
  if (behavior === 'exit') process.exit(23);
  if (behavior === 'delay') {
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  if (behavior === 'stale') {
    process.stdout.write(`${JSON.stringify({ id: 'some-other-generation:19', ok: true, ports: [12345] })}\n`);
  }
  const ports = behavior === 'invalid' ? [65536] : [19001];
  process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, ports, cpuMs: 0, rssMb: 10, scanMs: 0, pid: process.pid })}\n`);
}
