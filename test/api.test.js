import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Store } from '../src/store.js';
import { createServer } from '../src/index.js';

async function makeApi(t, { pm2Path, selfExit, openTerminal } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'appdeck-api-'));
  const store = await new Store({ dataDir }).init();
  const server = await createServer({
    store,
    pm2Path: pm2Path ?? join(tmpdir(), 'no-pm2'),
    publicDir: null,
    selfExit: selfExit ?? (() => {}),
    elevate: false,
    startupHome: join(tmpdir(), 'no-such-home'),
    openTerminal: openTerminal ?? (() => true),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const api = {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
    fetch: (path, options) => fetch(base + path, options),
  };
  t.after(() => api.close());
  return api;
}

async function fakePm2(body) {
  const dir = await mkdtemp(join(tmpdir(), 'appdeck-fakepm2-'));
  await mkdir(join(dir, 'bin'));
  const script = join(dir, 'bin', 'pm2');
  await writeFile(script, body);
  await chmod(script, 0o755);
  return script;
}

const SAMPLE_APP = {
  name: '博客系统',
  description: '',
  dir: null,
  url: null,
  port: null,
  buttons: [],
};

test('GET /api/health returns ok', async (t) => {
  const api = await makeApi(t);
  const res = await api.fetch('/api/health');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
});

test('PUT /api/apps/:id is idempotent upsert, GET lists it', async (t) => {
  const api = await makeApi(t);
  for (let i = 0; i < 2; i++) {
    const res = await api.fetch('/api/apps/blog', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SAMPLE_APP),
    });
    assert.equal(res.status, 200);
  }
  const res = await api.fetch('/api/apps');
  const apps = await res.json();
  assert.equal(apps.length, 1);
  assert.equal(apps[0].id, 'blog');
  assert.equal(apps[0].name, '博客系统');
});

test('POST /api/apps generates unique server ids', async (t) => {
  const api = await makeApi(t);
  const res1 = await api.fetch('/api/apps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SAMPLE_APP),
  });
  assert.equal(res1.status, 201);
  const created = await res1.json();
  assert.ok(/^app-[0-9a-f]{6}$/.test(created.id));

  const res2 = await api.fetch('/api/apps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...SAMPLE_APP, name: '另一个' }),
  });
  assert.equal(res2.status, 201);
  assert.notEqual((await res2.json()).id, created.id);
  const apps = await (await api.fetch('/api/apps')).json();
  assert.equal(apps.length, 2);
});

test('GET /api/apps/:id/logs merges all buttons history, newest first', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...SAMPLE_APP, dir: tmpdir() }),
  });
  await api.fetch('/api/apps/blog/buttons/a', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'A', type: 'exec', command: 'true', shell: true }),
  });
  await api.fetch('/api/apps/blog/buttons/b', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'B', type: 'exec', command: 'sleep 1', shell: true }),
  });
  await api.fetch('/api/apps/blog/buttons/a/run', { method: 'POST' });
  await new Promise((r) => setTimeout(r, 300));
  await api.fetch('/api/apps/blog/buttons/b/run', { method: 'POST' });
  await new Promise((r) => setTimeout(r, 1500));
  const res = await api.fetch('/api/apps/blog/logs');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.entries.length, 2);
  assert.equal(body.entries[0].label, 'B');
  assert.equal(body.entries[1].label, 'A');
  assert.ok(body.entries[0].startedAt >= body.entries[1].startedAt);
});

test('GET /api/apps/:id/status probes port for online state', async (t) => {
  const net = await import('node:net');
  const tempServer = net.createServer();
  await new Promise((resolve) => tempServer.listen(0, '127.0.0.1', resolve));
  const { port } = tempServer.address();

  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...SAMPLE_APP, port }),
  });

  const online = await (await api.fetch('/api/apps/blog/status')).json();
  assert.equal(online.online, true);

  await new Promise((resolve) => tempServer.close(resolve));
  const offline = await (await api.fetch('/api/apps/blog/status')).json();
  assert.equal(offline.online, false);
});

test('GET /api/apps/:id/status without port returns online: null', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SAMPLE_APP),
  });
  const res = await (await api.fetch('/api/apps/blog/status')).json();
  assert.equal(res.online, null);
});

test('GET /api/apps: pinned first ordered by pin time desc (latest pin on top)', async (t) => {
  const api = await makeApi(t);
  const base = { ...SAMPLE_APP };
  await api.fetch('/api/apps/a', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, name: 'A' }) });
  await api.fetch('/api/apps/b', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, name: 'B' }) });
  await api.fetch('/api/apps/c', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, name: 'C' }) });

  // 初始顺序 a, b, c
  let apps = await (await api.fetch('/api/apps')).json();
  assert.deepEqual(apps.map((x) => x.id), ['a', 'b', 'c']);

  // 先置顶 c，再置顶 a（a 更新，应排 c 前）
  await api.fetch('/api/apps/c', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: true }) });
  await new Promise((r) => setTimeout(r, 30));
  await api.fetch('/api/apps/a', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: true }) });

  apps = await (await api.fetch('/api/apps')).json();
  const ids = apps.map((x) => x.id);
  // a 最新置顶 → 最前；c 次之；b 未置顶在最后
  assert.deepEqual(ids, ['a', 'c', 'b']);

  // 重新置顶 c → c 排到最前
  await new Promise((r) => setTimeout(r, 30));
  await api.fetch('/api/apps/c', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: true }) });
  apps = await (await api.fetch('/api/apps')).json();
  assert.deepEqual(apps.map((x) => x.id), ['c', 'a', 'b']);

  // 取消置顶 a → 非置顶组末尾
  await api.fetch('/api/apps/a', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: false }) });
  apps = await (await api.fetch('/api/apps')).json();
  assert.deepEqual(apps.map((x) => x.id), ['c', 'a', 'b']);
});

test('PATCH app supports pinned field', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(SAMPLE_APP) });
  const res = await api.fetch('/api/apps/blog', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: true }) });
  assert.equal(res.status, 200);
  const app = await (await api.fetch('/api/apps/blog')).json();
  assert.equal(app.pinned, true);
});

test('GET /api/apps/:id returns app, 404 when missing', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SAMPLE_APP),
  });
  const found = await api.fetch('/api/apps/blog');
  assert.equal(found.status, 200);
  assert.equal((await found.json()).name, '博客系统');
  const missing = await api.fetch('/api/apps/nope');
  assert.equal(missing.status, 404);
});

test('PATCH partially updates app', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SAMPLE_APP),
  });
  const res = await api.fetch('/api/apps/blog', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '新名字' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, '新名字');
  const after = await (await api.fetch('/api/apps/blog')).json();
  assert.equal(after.name, '新名字');
});

test('PUT app rejects invalid id', async (t) => {
  const api = await makeApi(t);
  const res = await api.fetch('/api/apps/Bad Id', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SAMPLE_APP),
  });
  assert.equal(res.status, 400);
});

test('DELETE /api/apps/:id removes app', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SAMPLE_APP),
  });
  assert.equal((await api.fetch('/api/apps/blog', { method: 'DELETE' })).status, 200);
  assert.equal((await api.fetch('/api/apps/blog')).status, 404);
});

test('PUT button is idempotent upsert', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SAMPLE_APP),
  });
  const button = { label: '部署', type: 'exec', command: 'echo hi', shell: true };
  for (let i = 0; i < 2; i++) {
    const res = await api.fetch('/api/apps/blog/buttons/deploy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(button),
    });
    assert.equal(res.status, 200);
  }
  const app = await (await api.fetch('/api/apps/blog')).json();
  assert.equal(app.buttons.length, 1);
  assert.equal(app.buttons[0].id, 'deploy');
  assert.equal(app.buttons[0].shell, true);
});

test('PUT button rejects bad type, allows empty command', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SAMPLE_APP),
  });
  const badType = await api.fetch('/api/apps/blog/buttons/x', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'x', type: 'weird', command: 'ls', shell: true }),
  });
  assert.equal(badType.status, 400);
  const noCommand = await api.fetch('/api/apps/blog/buttons/y', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'y', type: 'exec', shell: true }),
  });
  assert.equal(noCommand.status, 200);
  assert.equal((await noCommand.json()).command, null);
});

test('run returns 400 when command or dir missing', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SAMPLE_APP),
  });
  await api.fetch('/api/apps/blog/buttons/start', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: '启动', type: 'exec', shell: true }),
  });
  const res = await api.fetch('/api/apps/blog/buttons/start/run', { method: 'POST' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /请先配置/);
});

test('PATCH and DELETE button work', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SAMPLE_APP),
  });
  await api.fetch('/api/apps/blog/buttons/b', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: '备份', type: 'exec', command: 'echo b', shell: true }),
  });
  const patch = await api.fetch('/api/apps/blog/buttons/b', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: '备份数据库' }),
  });
  assert.equal(patch.status, 200);
  assert.equal((await patch.json()).label, '备份数据库');
  assert.equal((await api.fetch('/api/apps/blog/buttons/b', { method: 'DELETE' })).status, 200);
  const app = await (await api.fetch('/api/apps/blog')).json();
  assert.equal(app.buttons.length, 0);
});

async function poll(fn, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('poll timeout');
}

test('exec run: 202 accepted, logs get output+exitCode persisted', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...SAMPLE_APP, dir: tmpdir() }),
  });
  await api.fetch('/api/apps/blog/buttons/hello', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: '你好', type: 'exec', command: 'node -e "console.log(\'你好世界\')"', shell: true }),
  });
  const run = await api.fetch('/api/apps/blog/buttons/hello/run', { method: 'POST' });
  assert.equal(run.status, 202);
  const accepted = await run.json();
  assert.equal(accepted.state, 'running');
  assert.ok(accepted.runId);

  const entry = await poll(async () => {
    const logs = await (await api.fetch('/api/apps/blog/buttons/hello/logs')).json();
    return logs[0] ?? null;
  });
  assert.equal(entry.exitCode, 0);
  assert.equal(entry.success, true);
  assert.match(entry.output, /你好世界/);
});

test('run concurrent returns 409, then works after finish', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...SAMPLE_APP, dir: tmpdir() }),
  });
  await api.fetch('/api/apps/blog/buttons/slow', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: '慢', type: 'exec', command: 'sleep 1', shell: true }),
  });
  const first = api.fetch('/api/apps/blog/buttons/slow/run', { method: 'POST' });
  await new Promise((r) => setTimeout(r, 100));
  const second = await api.fetch('/api/apps/blog/buttons/slow/run', { method: 'POST' });
  assert.equal(second.status, 409);
  assert.equal((await first).status, 202);
  await poll(async () => {
    const logs = await (await api.fetch('/api/apps/blog/buttons/slow/logs')).json();
    return logs[0] ?? null;
  });
  const status = await (await api.fetch('/api/apps/blog/buttons/slow/status')).json();
  assert.equal(status.state, 'idle');
  assert.equal(status.lastResult.exitCode, 0);
});

test('cancel stops a running exec', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...SAMPLE_APP, dir: tmpdir() }),
  });
  await api.fetch('/api/apps/blog/buttons/long', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: '长任务', type: 'exec', command: 'sleep 60', shell: true }),
  });
  const run = api.fetch('/api/apps/blog/buttons/long/run', { method: 'POST' });
  await new Promise((r) => setTimeout(r, 200));
  const status = await (await api.fetch('/api/apps/blog/buttons/long/status')).json();
  assert.equal(status.state, 'running');
  const cancel = await api.fetch('/api/apps/blog/buttons/long/cancel', { method: 'POST' });
  assert.equal(cancel.status, 200);
  assert.equal((await run).status, 202);
  const entry = await poll(async () => {
    const logs = await (await api.fetch('/api/apps/blog/buttons/long/logs')).json();
    return logs[0] ?? null;
  });
  assert.equal(entry.killed, true);
});

test('export and import roundtrip', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SAMPLE_APP),
  });
  const exported = await (await api.fetch('/api/export')).json();
  assert.equal(exported.apps.length, 1);
  assert.equal((await api.fetch('/api/apps/blog', { method: 'DELETE' })).status, 200);
  const imported = await api.fetch('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(exported),
  });
  assert.equal(imported.status, 200);
  assert.equal((await (await api.fetch('/api/apps')).json()).length, 1);
});

test('GET /api/system/status reports pm2 missing', async (t) => {
  const api = await makeApi(t);
  const res = await (await api.fetch('/api/system/status')).json();
  assert.equal(res.daemon, false);
  assert.equal(res.startup, false);
  assert.equal(res.pm2Installed, false);
});

test('POST /api/system/daemon returns 503 when pm2 missing', async (t) => {
  const api = await makeApi(t);
  const res = await api.fetch('/api/system/daemon', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(res.status, 503);
});

test('POST /api/system/startup returns 503 when pm2 missing', async (t) => {
  const api = await makeApi(t);
  const res = await api.fetch('/api/system/startup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(res.status, 503);
});

test('POST /api/system/daemon disable: calls pm2 stop (no auto-restart) then save', async (t) => {
  const script = await fakePm2(`#!/bin/sh
printf '%s\\n' "$@" >> "$(dirname "$0")/args.txt"
`);
  const api = await makeApi(t, { pm2Path: script });
  const res = await api.fetch('/api/system/daemon', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.enabled, false);
  await new Promise((r) => setTimeout(r, 200));
  const log = await readFile(join(dirname(script), 'args.txt'), 'utf8');
  assert.ok(log.includes('stop') || log.includes('delete'));
  assert.doesNotMatch(log, /restart/);
});

test('POST /api/system/daemon enable: starts app-deck then self-exits', async (t) => {
  let exited = false;
  const script = await fakePm2('#!/bin/sh\nexit 0\n');
  const api = await makeApi(t, { pm2Path: script, selfExit: () => (exited = true) });
  const res = await api.fetch('/api/system/daemon', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.enabled, true);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(exited, true);
});

test('POST /api/system/startup returns manual sudo command', async (t) => {
  const script = await fakePm2('#!/bin/sh\necho "sudo env PATH=\\$PATH pm2 startup launchd -u x"\n');
  const api = await makeApi(t, { pm2Path: script });
  const res = await api.fetch('/api/system/startup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.enabled, true);
  assert.match(body.manual, /^sudo /);
});

test('POST /api/apps/:id/open-terminal opens terminal in app dir', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...SAMPLE_APP, dir: '/tmp' }),
  });

  const res = await api.fetch('/api/apps/blog/open-terminal', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.dir, '/tmp');
});

test('POST /api/apps/:id/open-terminal returns 400 when dir is missing', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/nodir', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...SAMPLE_APP, id: 'nodir', dir: null }),
  });

  const res = await api.fetch('/api/apps/nodir/open-terminal', { method: 'POST' });
  assert.equal(res.status, 400);
});

test('POST /api/apps/:id/open-terminal returns 404 when app does not exist', async (t) => {
  const api = await makeApi(t);
  const res = await api.fetch('/api/apps/missing/open-terminal', { method: 'POST' });
  assert.equal(res.status, 404);
});

test('GET /api/apps/:id/buttons/:btn/stream returns SSE stream', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...SAMPLE_APP, dir: tmpdir() }),
  });
  await api.fetch('/api/apps/blog/buttons/streamtest', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: '流式', type: 'exec', command: 'node -e "console.log(\'line1\'); setTimeout(() => console.log(\'line2\'), 100)"', shell: true }),
  });

  // Start run
  await api.fetch('/api/apps/blog/buttons/streamtest/run', { method: 'POST' });

  // Connect to stream
  const res = await api.fetch('/api/apps/blog/buttons/streamtest/stream');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /line1|line2/);
});

test('DELETE /api/apps/:id/logs clears all app logs', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...SAMPLE_APP, dir: tmpdir() }),
  });
  await api.fetch('/api/apps/blog/buttons/b1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'b1', type: 'exec', command: 'node -e "console.log(\'b1\')"', shell: true }),
  });
  await api.fetch('/api/apps/blog/buttons/b1/run', { method: 'POST' });
  await new Promise((r) => setTimeout(r, 200));

  const before = await (await api.fetch('/api/apps/blog/logs')).json();
  assert.ok(before.entries.length > 0);

  const del = await api.fetch('/api/apps/blog/logs', { method: 'DELETE' });
  assert.equal(del.status, 200);

  const after = await (await api.fetch('/api/apps/blog/logs')).json();
  assert.equal(after.entries.length, 0);
});

test('GET /api/agent-guide returns agent guide document', async (t) => {
  const api = await makeApi(t);
  const res = await api.fetch('/api/agent-guide');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.content.includes('# AI 接入指南与 API 文档'));
  assert.ok(body.content.includes('outputFormat'));
});

test('GET /api/aiusage backward-compatible alias returns agent guide document', async (t) => {
  const api = await makeApi(t);
  const res = await api.fetch('/api/aiusage');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.content.includes('# AI 接入指南与 API 文档'));
  assert.ok(body.content.includes('outputFormat'));
});

test('PUT button supports outputFormat (text/json/markdown) and rejects invalid format', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SAMPLE_APP),
  });

  // Valid formats
  for (const fmt of ['text', 'json', 'markdown']) {
    const res = await api.fetch(`/api/apps/blog/buttons/btn-${fmt}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: fmt, type: 'exec', outputFormat: fmt, command: 'echo 1', shell: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.outputFormat, fmt);
  }

  // Default format is text
  const resDef = await api.fetch('/api/apps/blog/buttons/btn-default', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'default', type: 'exec', command: 'echo 1', shell: true }),
  });
  assert.equal(resDef.status, 200);
  assert.equal((await resDef.json()).outputFormat, 'text');

  // Invalid format rejected
  const resBad = await api.fetch('/api/apps/blog/buttons/btn-bad', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'bad', type: 'exec', outputFormat: 'invalid_format', command: 'echo 1', shell: true }),
  });
  assert.equal(resBad.status, 400);
});

test('exec run persists outputFormat in logs history', async (t) => {
  const api = await makeApi(t);
  await api.fetch('/api/apps/blog', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...SAMPLE_APP, dir: tmpdir() }),
  });
  await api.fetch('/api/apps/blog/buttons/json-btn', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'JSON Probe', type: 'exec', outputFormat: 'json', command: 'echo "{\\"ok\\":true}"', shell: true }),
  });

  await api.fetch('/api/apps/blog/buttons/json-btn/run', { method: 'POST' });
  await new Promise((r) => setTimeout(r, 200));

  const logs = await (await api.fetch('/api/apps/blog/logs')).json();
  assert.ok(logs.entries.length > 0);
  const entry = logs.entries.find((e) => e.buttonId === 'json-btn');
  assert.ok(entry);
  assert.equal(entry.outputFormat, 'json');
});


