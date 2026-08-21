import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

const PM2_NAME = 'app-deck';

function runCli(pm2Path, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(pm2Path, args, { shell: false });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('pm2 command timed out'));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`pm2 not available: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export class Pm2 {
  constructor({ pm2Path = 'pm2' } = {}) {
    this.pm2Path = pm2Path;
  }

  async isInstalled() {
    try {
      await runCli(this.pm2Path, ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  _spawn(args) {
    return runCli(this.pm2Path, args);
  }

  async start({ name = PM2_NAME, script = 'src/index.js', cwd = process.cwd(), args = [], nodeArgs = [] } = {}) {
    const cliArgs = ['start', script, '--name', name, '--cwd', cwd];
    if (nodeArgs.length > 0) cliArgs.push('--node-args', nodeArgs.join(' '));
    if (args.length > 0) cliArgs.push('--', ...args);
    await this._spawn(cliArgs);
  }

  async stop(name = PM2_NAME) {
    await this._spawn(['stop', name]);
  }

  async delete(name = PM2_NAME) {
    await this._spawn(['delete', name]);
  }

  async save() {
    await this._spawn(['save']);
  }

  async list() {
    const { stdout } = await this._spawn(['jlist']);
    try {
      return JSON.parse(stdout);
    } catch {
      return [];
    }
  }

  async status(name) {
    const list = await this.list();
    const proc = list.find((p) => p.name === name);
    if (!proc) return { online: false, restarts: 0, name };
    return {
      online: proc.pm2_env?.status === 'online',
      restarts: proc.pm2_env?.restart_time ?? 0,
      name,
    };
  }

  async startup() {
    const { stdout, stderr } = await this._spawn(['startup']);
    const text = stdout + stderr;
    const manual = text.split('\n').find((l) => /^sudo /.test(l.trim()))?.trim() ?? null;
    return { ok: true, manual };
  }

  async unstartup() {
    const { stdout, stderr } = await this._spawn(['unstartup']);
    const text = stdout + stderr;
    const manual = text.split('\n').find((l) => /^sudo /.test(l.trim()))?.trim() ?? null;
    return { ok: true, manual };
  }

  startupStatus({ home = homedir(), user = userInfo().username, platform = process.platform } = {}) {
    if (platform === 'darwin') {
      return existsSync(join(home, 'Library', 'LaunchAgents', `pm2.${user}.plist`));
    }
    return false;
  }
}

export { PM2_NAME };
