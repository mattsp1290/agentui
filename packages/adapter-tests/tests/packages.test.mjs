import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { contractVersion } from '@agentui/contracts';
import { contractVersion as sdkVersion } from '@agentui/sdk';
import { createEventStream, hostRuntime } from '@agentui/host';
import { clientPlatform as desktop } from '@agentui/desktop';
import { clientPlatform as ios } from '@agentui/ios';

const root = new URL('../../../', import.meta.url);

test('host core import excludes the AG-UI projection and SDK', () => {
  const source = `
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const urls = [];
const hook = registerHooks({ resolve(specifier, context, next) {
  const value = next(specifier, context); urls.push(value.url); return value;
} });
const core = await import('@agentui/host');
hook.deregister();
assert.equal(core.hostRuntime, 'node');
assert.ok(urls.includes(import.meta.resolve('@mattsp1290/switchboard')), 'hook observed Switchboard core');
const forbidden = ['@mattsp1290/switchboard/agui', '@agentui/host/agui', '@ag-ui/core'].map(specifier => import.meta.resolve(specifier));
assert.ok(urls.every(url => !forbidden.includes(url) && !url.includes('/@ag-ui/')));
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});

test('emitted workspace packages resolve through public exports', async () => {
  assert.equal(contractVersion, 1);
  assert.equal(sdkVersion, contractVersion);
  assert.equal(hostRuntime, 'node');
  assert.equal(desktop, 'desktop');
  assert.equal(ios, 'ios');
  await import('@agentui/sdk/react');
  await import('@agentui/theme');
  await import('@agentui/protocol');
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
  for (const name of ['@agentui/contracts', '@agentui/protocol', '@agentui/sdk', '@agentui/host', '@agentui/theme', '@agentui/ui-primitives', '@mattsp1290/switchboard']) {
    await assert.rejects(import(`${name}/src/index.js`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
});

test('clients and customization declare no host runtime dependency', async () => {
  for (const path of ['packages/contracts', 'packages/protocol', 'packages/sdk', 'packages/theme', 'packages/ui-primitives', 'apps/desktop', 'apps/ios']) {
    const pkg = JSON.parse(await readFile(new URL(`${path}/package.json`, root), 'utf8'));
    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    assert.equal(dependencies['@agentui/host'], undefined, path);
    assert.equal(dependencies['@mattsp1290/switchboard'], undefined, path);
  }
});
