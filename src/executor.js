import { spawn } from 'node:child_process';

const SUMMARY_LIMIT = 200;
const OUTPUT_LIMIT = 64 * 1024;

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const gbkDecoder = new TextDecoder('gbk');

export function decodeBuffer(buffer) {
  if (typeof buffer === 'string') return buffer;
  try {
    return utf8Decoder.decode(buffer);
  } catch {
    try {
      return gbkDecoder.decode(buffer);
    } catch {
      return buffer.toString();
    }
  }
}

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

  off(event, fn) {
    if (!this.listeners[event]) return this;
    this.listeners[event] = this.listeners[event].filter((f) => f !== fn);
    return this;
  }

  emit(event, payload) {
    for (const fn of this.listeners[event] ?? []) fn(payload);
  }

  start() {
    if (this.state !== 'idle') throw new Error('executor already started');
    this.state = 'running';
    this.startedAt = Date.now();
    const options = {
      cwd: this.cwd ?? undefined,
      shell: this.shell,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        LANG: 'zh_CN.UTF-8',
        LC_ALL: 'zh_CN.UTF-8',
      },
    };
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
    const text = decodeBuffer(chunk);
    this.output += text;
    if (this.output.length > OUTPUT_LIMIT) {
      this.output = this.output.slice(-OUTPUT_LIMIT);
    }
    this.emit('data', { chunk: text, fullOutput: this.output });
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
