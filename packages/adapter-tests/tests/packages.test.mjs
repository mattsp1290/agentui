import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { contractVersion } from '@agentui/contracts';
import { contractVersion as sdkVersion } from '@agentui/sdk';
import { createEventStream, hostRuntime } from '@agentui/host';
import { clientPlatform as desktop } from '@agentui/desktop';
import { clientPlatform as ios } from '@agentui/ios';

const root = new URL('../../../', import.meta.url);

test('emitted workspace packages resolve through public exports', async () => {
  assert.equal(contractVersion, 1);
  assert.equal(sdkVersion, contractVersion);
  assert.equal(hostRuntime, 'node');
  assert.equal(desktop, 'desktop');
  assert.equal(ios, 'ios');
  await import('@agentui/sdk/react');
  await import('@agentui/theme');
  await import('@agentui/theme/react');
  await import('@agentui/ui-primitives/desktop');
  await import('@agentui/adapter-tests');
});

test('host consumes real Switchboard bounded FIFO observation', async () => {
  const stream = createEventStream({ maxObservers: 2, capacity: 3 });
  const left = [];
  const right = [];
  const first = stream.subscribe((event) => { left.push(event); });
  const second = stream.subscribe((event) => { right.push(event); });
  assert.equal(first.kind, 'ok');
  assert.equal(second.kind, 'ok');
  assert.deepEqual(stream.publish('first'), { kind: 'published', enqueued: 2, disconnected: 0 });
  stream.publish('second');
  await setImmediate();
  assert.deepEqual(left, ['first', 'second']);
  assert.deepEqual(right, ['first', 'second']);
  first.value.dispose();
  stream.publish('third');
  await setImmediate();
  assert.deepEqual(left, ['first', 'second']);
  assert.deepEqual(right, ['first', 'second', 'third']);
  stream.close();
  assert.equal(await first.value.ended, 'disposed');
  assert.equal(await second.value.ended, 'closed');
  assert.deepEqual(stream.publish('after-close'), { kind: 'closed' });
});

test('package exports reject private implementation imports', async () => {
  for (const name of ['@agentui/contracts', '@agentui/sdk', '@agentui/host', '@agentui/theme', '@agentui/ui-primitives', '@mattsp1290/switchboard']) {
    await assert.rejects(import(`${name}/src/index.js`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
});

test('clients and customization declare no host runtime dependency', async () => {
  for (const path of ['packages/contracts', 'packages/sdk', 'packages/theme', 'packages/ui-primitives', 'apps/desktop', 'apps/ios']) {
    const pkg = JSON.parse(await readFile(new URL(`${path}/package.json`, root), 'utf8'));
    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    assert.equal(dependencies['@agentui/host'], undefined, path);
    assert.equal(dependencies['@mattsp1290/switchboard'], undefined, path);
  }
});
