// Inert benchmark prototype. Never imported by an MCP runtime. The persistent
// child keeps PowerShell loaded, but does NOT cache process rows or owners.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./bench-warm-process-ipc-worker.ps1', import.meta.url));
const defaultArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
const validPort = (port) => Number.isInteger(port) && port >= 1 && port <= 65535;

export class WarmPowerShellProcessScanner {
  constructor({ command = 'powershell.exe', args = defaultArgs, timeoutMs = 4000, idleMs = 1000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isFinite(idleMs) || idleMs < 1) {
      throw new Error('timeoutMs and idleMs must be positive finite numbers');
    }
    this.command = command;
    this.args = [...args];
    this.timeoutMs = timeoutMs;
    this.idleMs = idleMs;
    this.session = randomUUID();
    this.sequence = 0;
    this.generation = 0;
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.idleTimer = null;
    this.closed = false;
    this.spawns = 0;
    this.shutdowns = 0;
    this.ignoredReplies = 0;
  }

  get pid() { return this.child?.pid || null; }

  _clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  _idle() {
    this._clearIdle();
    if (this.child && this.pending.size === 0) {
      this.idleTimer = setTimeout(() => this._stop(new Error('idle shutdown')), this.idleMs);
      this.idleTimer.unref?.();
    }
  }

  _stop(error) {
    this._clearIdle();
    const child = this.child;
    this.child = null;
    this.buffer = '';
    this.generation++;
    for (const [, job] of this.pending) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    this.pending.clear();
    if (child) {
      this.shutdowns++;
      child.kill();
    }
  }

  _start() {
    if (this.closed) throw new Error('scanner already closed');
    if (this.child) return;
    const generation = ++this.generation;
    const child = spawn(this.command, this.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.spawns++;
    this.buffer = '';
    child.stdout.on('data', (chunk) => {
      if (this.generation !== generation || this.child !== child) return;
      this.buffer += chunk.toString('utf8');
      if (this.buffer.length > 65536) {
        this._stop(new Error('oversized scanner reply'));
        return;
      }
      let newline;
      while ((newline = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        let response;
        try { response = JSON.parse(line); }
        catch { this._stop(new Error('invalid scanner reply')); return; }
        const job = this.pending.get(response?.id);
        if (!job || job.generation !== generation) {
          this.ignoredReplies++;
          continue;
        }
        this.pending.delete(response.id);
        clearTimeout(job.timer);
        if (response.ok !== true || !Array.isArray(response.ports) || response.ports.length > 32 ||
            response.ports.some((p) => !validPort(p)) || new Set(response.ports).size !== response.ports.length) {
          job.reject(new Error('scanner rejected request or returned invalid ports'));
          this._stop(new Error('invalid scanner result'));
          return;
        }
        job.resolve(response);
        this._idle();
      }
    });
    child.on('error', (error) => {
      if (this.generation === generation && this.child === child) this._stop(error);
    });
    child.on('exit', (code, signal) => {
      if (this.generation === generation && this.child === child) {
        this._stop(new Error(`scanner exited (${code ?? signal})`));
      }
    });
    child.stdin.on('error', (error) => {
      if (this.generation === generation && this.child === child) this._stop(error);
    });
    child.stderr.resume(); // Read and discard diagnostics; never log command lines.
  }

  scan({ rows } = {}) {
    this._clearIdle();
    this._start();
    const generation = this.generation;
    const id = `${this.session}:${generation}:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) this._stop(new Error('scanner request timed out'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, generation });
      // `rows` is used only by the explicit -Fixture worker launched in tests.
      const payload = JSON.stringify({ id, op: 'scan', ...(rows ? { rows } : {}) });
      try { this.child.stdin.write(`${payload}\n`); }
      catch (error) { this._stop(error); }
    });
  }

  close() {
    this.closed = true;
    this._stop(new Error('scanner closed'));
  }
}
