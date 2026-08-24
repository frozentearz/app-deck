import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
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

  async start({ name = PM2_NAME, script = 'src/index.js', cwd = process.cwd(), args = [], noAutorestart = true, noTreekill = true } = {}) {
    const cliArgs = ['start', script, '--name', name, '--cwd', cwd];
    if (noAutorestart) cliArgs.push('--no-autorestart');
    if (noTreekill) cliArgs.push('--no-treekill');
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
    const online = proc.pm2_env?.status === 'online';
    return {
      online,
      restarts: proc.pm2_env?.restart_time ?? 0,
      uptime: online ? (proc.pm2_env?.pm_uptime ?? null) : null,
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

  /** macOS：pm2 强制要求 root 才执行 startup，绕过它：自己写 launchd plist + launchctl load（用户级，无需 sudo） */
  async startupElevated() {
    if (process.platform !== 'darwin') {
      const { manual } = await this.startup();
      return { ok: false, manual };
    }
    const pm2Bin = await this._resolvePm2Bin();
    const user = userInfo().username;
    const home = homedir();
    const plistPath = join(home, 'Library', 'LaunchAgents', `pm2.${user}.plist`);
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>pm2.${user}</string>
    <key>UserName</key>
    <string>${user}</string>
    <key>KeepAlive</key>
    <true/>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/sh</string>
      <string>-c</string>
      <string>${pm2Bin} resurrect</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${process.env.PATH}</string>
      <key>PM2_HOME</key>
      <string>${home}/.pm2</string>
    </dict>
  </dict>
</plist>
`;
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(plistPath, plist);
    await runCli('/bin/launchctl', ['load', '-w', plistPath], { timeoutMs: 30000 });
    return { ok: true, manual: null };
  }

  /** macOS：launchctl unload + 删 plist（用户级，无需 sudo） */
  async unstartupElevated() {
    if (process.platform !== 'darwin') {
      const { manual } = await this.unstartup();
      return { ok: false, manual };
    }
    const user = userInfo().username;
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', `pm2.${user}.plist`);
    if (existsSync(plistPath)) {
      await runCli('/bin/launchctl', ['unload', '-w', plistPath], { timeoutMs: 30000 });
      await unlink(plistPath);
    }
    return { ok: true, manual: null };
  }

  async _resolvePm2Bin() {
    if (this.pm2Path !== 'pm2') return this.pm2Path;
    const { stdout } = await runCli('/usr/bin/which', ['pm2']);
    return stdout.trim() || 'pm2';
  }

  startupStatus({ home = homedir(), user = userInfo().username, platform = process.platform } = {}) {
    if (platform === 'darwin') {
      return existsSync(join(home, 'Library', 'LaunchAgents', `pm2.${user}.plist`));
    }
    return false;
  }
}

export { PM2_NAME };
