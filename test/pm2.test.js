import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pm2 } from '../src/pm2.js';

async function fakePm2(body) {
  const dir = await mkdtemp(join(tmpdir(), 'appdeck-fakepm2-'));
  await mkdir(join(dir, 'bin'));
  const script = join(dir, 'bin', 'pm2');
  await writeFile(script, body);
  await chmod(script, 0o755);
  return { script, dir };
}

const RECORD_ARGS = `#!/bin/sh
printf '%s\\n' "$@" > "$(dirname "$0")/args.txt"
`;

test('isInstalled false when pm2 missing from PATH', async () => {
  const pm2 = new Pm2({ pm2Path: join(tmpdir(), 'definitely-not-exists', 'pm2') });
  assert.equal(await pm2.isInstalled(), false);
});

test('start passes script name and args to pm2 CLI', async () => {
  const { script, dir } = await fakePm2(RECORD_ARGS);
  const pm2 = new Pm2({ pm2Path: script });
  await pm2.start({ name: 'app-deck', script: 'src/index.js', cwd: '/x' });
  const args = await readFile(join(dir, 'bin', 'args.txt'), 'utf8');
  assert.ok(args.includes('start'));
  assert.ok(args.includes('src/index.js'));
  assert.ok(args.includes('--name'));
  assert.ok(args.includes('app-deck'));
});

test('status parses jlist into online/offline', async () => {
  const { script } = await fakePm2(`#!/bin/sh
echo '[{"name":"blog","pm2_env":{"status":"online","pm_id":0,"restart_time":2}},{"name":"gone","pm2_env":{"status":"stopped","pm_id":1,"restart_time":5}}]'
`);
  const pm2 = new Pm2({ pm2Path: script });
  const status = await pm2.status('blog');
  assert.equal(status.online, true);
  assert.equal(status.restarts, 2);
  const offline = await pm2.status('gone');
  assert.equal(offline.online, false);
  const missing = await pm2.status('nope');
  assert.equal(missing.online, false);
});

test('startup returns manual sudo command from text output', async () => {
  const { script } = await fakePm2(`#!/bin/sh
echo "[PM2] Init System found: launchd"
echo "sudo env PATH=\\$PATH:/opt/homebrew/bin pm2 startup launchd -u frazier --hp /Users/frazier"
`);
  const pm2 = new Pm2({ pm2Path: script });
  const res = await pm2.startup();
  assert.equal(res.ok, true);
  assert.match(res.manual, /^sudo /);
});

test('start passes --no-autorestart and --no-treekill to pm2 CLI', async () => {
  const { script, dir } = await fakePm2(RECORD_ARGS);
  const pm2 = new Pm2({ pm2Path: script });
  await pm2.start({ name: 'app-deck', script: 'src/index.js', cwd: '/x' });
  const args = await readFile(join(dir, 'bin', 'args.txt'), 'utf8');
  assert.ok(args.includes('--no-autorestart'));
  assert.ok(args.includes('--no-treekill'));
});

test('stop/delete/save call the right subcommands', async () => {
  const { script, dir } = await fakePm2(RECORD_ARGS);
  const pm2 = new Pm2({ pm2Path: script });
  for (const [method, arg] of [['stop', 'blog'], ['delete', 'blog']]) {
    await pm2[method](arg);
    const args = await readFile(join(dir, 'bin', 'args.txt'), 'utf8');
    assert.ok(args.trim().startsWith(method), `${method}: ${args}`);
  }
  await pm2.save();
  assert.equal((await readFile(join(dir, 'bin', 'args.txt'), 'utf8')).trim(), 'save');
});

test('unstartup surfaces manual sudo command from output', async () => {
  const { script } = await fakePm2(`#!/bin/sh
echo "[PM2] Init System found: systemd"
echo "sudo env PATH=\\$PATH pm2 unstartup systemd -u root --hp /root"
`);
  const pm2 = new Pm2({ pm2Path: script });
  const res = await pm2.unstartup();
  assert.equal(res.ok, true);
  assert.match(res.manual, /^sudo /);
});

test('startupStatus detects launchd plist on macOS (no side effects)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'appdeck-home-'));
  const pm2 = new Pm2({ pm2Path: join(tmpdir(), 'no-pm2') });
  assert.equal(pm2.startupStatus({ home, user: 'frazier', platform: 'darwin' }), false);
  const agentsDir = join(home, 'Library', 'LaunchAgents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, 'pm2.frazier.plist'), '<plist/>');
  assert.equal(pm2.startupStatus({ home, user: 'frazier', platform: 'darwin' }), true);
});
