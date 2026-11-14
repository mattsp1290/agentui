import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = new URL('../../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const json = (path) => JSON.parse(read(path));

test('iOS type declarations and native package use the same locked runtime versions', () => {
  const platform = json('apps/ios/package.json');
  const native = json('apps/ios/native/package.json');
  const lock = json('apps/ios/native/package-lock.json');
  for (const dependency of ['react', 'react-native']) {
    assert.equal(native.dependencies[dependency], platform.dependencies[dependency]);
  }
  for (const group of ['dependencies', 'devDependencies']) {
    assert.deepEqual(lock.packages[''][group], native[group]);
    for (const [dependency, version] of Object.entries(native[group])) {
      assert.equal(lock.packages[`node_modules/${dependency}`].version, version);
    }
  }
  const hermes = lock.packages['node_modules/hermes-compiler'].version;
  assert.ok(read('apps/ios/native/ios/Podfile.lock').includes(`:tag: hermes-v${hermes}\n`));
});

test('iOS launcher rejects malformed simulator IDs before preparing dependencies', { skip: process.platform !== 'darwin' }, () => {
  for (const input of ['not-a-simulator', 'g'.repeat(36), 'a'.repeat(35), 'a'.repeat(37), '']) {
    const result = spawnSync('/bin/sh', ['agentui-ios', input], { cwd: root, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Supply a simulator UDID/);
    assert.equal(result.stdout, '');
  }
});
