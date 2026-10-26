import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { stopCanaryChild } from '../scripts/subprocess-cleanup.mjs';

function start(source: string) {
  return spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
}

test('canary cleanup waits for a live child and removes its exit listener', { timeout: 5_000 }, async () => {
  const child = start(`setInterval(() => {}, 1000); console.log('ready');`);
  try {
    await once(child.stdout!, 'data');
    const listeners = child.listenerCount('exit');
    await stopCanaryChild(child, { graceMs: 500, killMs: 500 });
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(child.listenerCount('exit'), listeners);
    await stopCanaryChild(child);
  } finally { child.kill('SIGKILL'); }
});

test('canary cleanup recognizes a child that already exited by signal', { timeout: 5_000 }, async () => {
  const child = start(`setInterval(() => {}, 1000); console.log('ready');`);
  try {
    await once(child.stdout!, 'data');
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(child.exitCode, null);
    await stopCanaryChild(child, { graceMs: 2_000, killMs: 2_000 });
    assert.equal(child.listenerCount('exit'), 0);
  } finally { child.kill('SIGKILL'); }
});

test('canary cleanup handles unsuccessful spawn and absent child', { timeout: 5_000 }, async () => {
  await stopCanaryChild(undefined);
  const child = spawn('liyuan-nonexistent-canary-executable', [], { stdio: 'ignore' });
  await once(child, 'error');
  await stopCanaryChild(child);
  assert.equal(child.listenerCount('exit'), 0);
});

test('canary cleanup escalates a server that ignores SIGTERM and waits for SIGKILL', {
  timeout: 5_000, skip: process.platform === 'win32' ? 'Windows forcibly terminates on SIGTERM' : false,
}, async () => {
  const child = start(`process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready');`);
  try {
    await once(child.stdout!, 'data');
    await stopCanaryChild(child, { graceMs: 50, killMs: 500 });
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(child.listenerCount('exit'), 0);
  } finally { child.kill('SIGKILL'); }
});

test('successful cleanup leaves no grace timer keeping the runner alive', { timeout: 5_000 }, async () => {
  const helper = new URL('../scripts/subprocess-cleanup.mjs', import.meta.url).href;
  const runner = start(`
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { stopCanaryChild } from ${JSON.stringify(helper)};
    const child = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000); console.log('ready')"], { stdio: ['ignore', 'pipe', 'ignore'] });
    await once(child.stdout, 'data');
    await stopCanaryChild(child, { graceMs: 30_000 });
    console.log('cleaned');
  `);
  let output = '';
  runner.stdout!.on('data', chunk => { output += chunk; });
  const watchdog = setTimeout(() => runner.kill('SIGKILL'), 3_000);
  try {
    const [code, signal] = await once(runner, 'exit');
    assert.equal(signal, null, 'runner must exit naturally without waiting for the grace timer');
    assert.equal(code, 0);
    assert.match(output, /cleaned/);
  } finally { clearTimeout(watchdog); runner.kill('SIGKILL'); }
});
