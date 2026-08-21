import { spawn } from 'node:child_process';

const SUMMARY_LIMIT = 200;
const OUTPUT_LIMIT = 64 * 1024;

export class Executor {
  constructor({ command, cwd, shell = true }) {
    this.command = command;
    this.cwd = cwd;
    this.shell = shell;
    this.listeners = {};
    this.child = null;
    this.output = '';
    this.state = 'idle';
    this.cancelled = false;
    this.startedAt = 0;
  }

  on(event, fn) {
    (this.listeners[event] ??= []).push(fn);
    return this;
  }

  emit(event, payload) {
    for (const fn of this.listeners[event] ?? []) fn(payload);
  }

  start() {
    if (this.state !== 'idle') throw new Error('executor already started');
    this.state = 'running';
    this.startedAt = Date.now();
    const options = { cwd: this.cwd ?? undefined, shell: this.shell, env: process.env };
    if (process.platform !== 'win32') {
      options.detached = true;
    }
    this.child = spawn(this.command, options);
    this.emit('running', { startedAt: this.startedAt });
    this.child.stdout.on('data', (d) => this.collect(d));
    this.child.stderr.on('data', (d) => this.collect(d));
    this.child.on('error', (err) => this.collect(Buffer.from(`\n${err.message}\n`)));
    this.child.on('close', (code) => {
      const finishedAt = Date.now();
      const result = {
        exitCode: code,
        output: this.output,
        summary: this.output.slice(-SUMMARY_LIMIT),
        success: !this.cancelled && code === 0,
        killed: this.cancelled,
        startedAt: this.startedAt,
        finishedAt,
        durationMs: finishedAt - this.startedAt,
      };
      this.state = 'finished';
      this.emit('finished', result);
    });
    return this;
  }

  collect(chunk) {
    this.output += chunk.toString();
    if (this.output.length > OUTPUT_LIMIT) {
      this.output = this.output.slice(-OUTPUT_LIMIT);
    }
  }

  cancel() {
    if (!this.child || this.state !== 'running') return false;
    this.cancelled = true;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F']);
      } else {
        process.kill(-this.child.pid, 'SIGTERM');
      }
    } catch {
      // process already exited
    }
    return true;
  }

  get running() {
    return this.state === 'running';
  }
}
