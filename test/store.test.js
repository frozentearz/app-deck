import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, HISTORY_LIMIT } from '../src/store.js';

async function makeStore() {
  const dataDir = await mkdtemp(join(tmpdir(), 'appdeck-'));
  return new Store({ dataDir });
}

test('listApps returns empty array on fresh store', async () => {
  const store = await makeStore();
  assert.deepEqual(store.listApps(), []);
});

test('upsertApp persists across restart (idempotent upsert)', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'appdeck-'));
  const app = { id: 'blog', name: '博客系统', description: '', dir: null, url: null, port: null, buttons: [] };

  const store1 = await new Store({ dataDir }).init();
  store1.upsertApp(structuredClone(app));
  await store1.save();
  store1.upsertApp(structuredClone(app));
  await store1.save();

  const store2 = await new Store({ dataDir }).init();
  assert.deepEqual(store2.listApps(), [app]);
});

test('addHistory persists across restart, independent of app data', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'appdeck-'));
  const app = { id: 'blog', name: '博客', description: '', dir: null, url: null, port: null, buttons: [{ id: 'deploy', label: '部署', type: 'exec', command: 'echo hi', cwd: null, shell: true }] };

  const store1 = await new Store({ dataDir }).init();
  store1.upsertApp(structuredClone(app));
  await store1.save();
  store1.addHistory('blog', 'deploy', { id: 'h1', startedAt: 1, finishedAt: 2, exitCode: 0, success: true, summary: 'hi\n', output: 'hi\n' });
  await store1.saveHistory();
  store1.upsertApp(structuredClone(app));
  await store1.save();

  const store2 = await new Store({ dataDir }).init();
  const history = store2.listHistory('blog', 'deploy');
  assert.equal(history.length, 1);
  assert.equal(history[0].exitCode, 0);
  assert.equal(history[0].summary, 'hi\n');
});

test('history capped at HISTORY_LIMIT, oldest dropped', async () => {
  const store = await makeStore();
  for (let i = 1; i <= HISTORY_LIMIT + 10; i++) {
    store.addHistory('a', 'b', { id: `h${i}`, startedAt: i, finishedAt: i, exitCode: 0, success: true, summary: '', output: '' });
  }
  assert.equal(store.listHistory('a', 'b').length, HISTORY_LIMIT);
  assert.equal(store.listHistory('a', 'b')[0].id, `h${HISTORY_LIMIT + 10}`);
  assert.equal(store.listHistory('a', 'b').at(-1).id, `h${11}`);
});

test('deleteApp removes app; deleteButton removes button', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'appdeck-'));
  const app = { id: 'x', name: 'X', description: '', dir: null, url: null, port: null, buttons: [{ id: 'b1', label: 'B1', type: 'exec', command: 'true', cwd: null, shell: true }] };
  const store = await new Store({ dataDir }).init();
  store.upsertApp(structuredClone(app));
  await store.save();
  store.deleteButton('x', 'b1');
  await store.save();
  store.deleteApp('x');
  await store.save();

  const store2 = await new Store({ dataDir }).init();
  assert.deepEqual(store2.listApps(), []);
});

test('listApps returns clones, not internal references', async () => {
  const store = await makeStore();
  store.upsertApp({ id: 'x', name: 'X', description: '', dir: null, url: null, port: null, buttons: [] });
  const listed = store.listApps();
  listed[0].name = 'Y';
  assert.equal(store.listApps()[0].name, 'X');
});
