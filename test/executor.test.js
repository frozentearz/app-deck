import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Executor } from '../src/executor.js';

function runOnce(command, { cwd, shell = true } = {}) {
  return new Promise((resolve) => {
    const ex = new Executor({ command, cwd, shell });
    ex.on('finished', (result) => resolve(result));
    ex.start();
  });
}

test('collects stdout and exit code', async () => {
  const result = await runOnce('node -e "console.log(\'hello\'); process.exit(3)"');
  assert.equal(result.exitCode, 3);
  assert.match(result.output, /hello/);
  assert.equal(result.success, false);
});

test('success when exit code 0', async () => {
  const result = await runOnce('node -e "console.log(\'ok\')"');
  assert.equal(result.exitCode, 0);
  assert.equal(result.success, true);
});

test('cancel kills process tree quickly', async () => {
  const ex = new Executor({ command: 'sh -c "sleep 30 & sleep 30 & wait"', shell: true });
  const finished = new Promise((resolve) => ex.on('finished', resolve));
  ex.start();
  await new Promise((r) => setTimeout(r, 300));
  ex.cancel();
  const result = await finished;
  assert.equal(result.killed, true);
  assert.ok(result.durationMs < 8000);
});

test('emits data event on stdout chunk', async () => {
  const ex = new Executor({ command: 'node -e "process.stdout.write(\'chunk1\'); process.stdout.write(\'chunk2\')"', shell: true });
  const chunks = [];
  ex.on('data', ({ chunk }) => chunks.push(chunk));
  const finished = new Promise((resolve) => ex.on('finished', resolve));
  ex.start();
  const res = await finished;
  assert.equal(res.exitCode, 0);
  assert.equal(chunks.join(''), 'chunk1chunk2');
});
