import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
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
  assert.equal(native.engines.node, read('.node-version').trim());
  assert.equal(`npm@${native.engines.npm}`, json('package.json').packageManager);
  for (const dependency of ['@agentui/theme', '@agentui/ui-primitives']) {
    assert.equal(platform.dependencies[dependency], json(`packages/${dependency.slice('@agentui/'.length)}/package.json`).version);
    assert.equal(json('package-lock.json').packages['apps/ios'].dependencies[dependency], platform.dependencies[dependency]);
  }
  const hermes = lock.packages['node_modules/hermes-compiler'].version;
  assert.ok(read('apps/ios/native/ios/Podfile.lock').includes(`:tag: hermes-v${hermes}\n`));
});

test('all iOS entry points reject malformed or extra simulator arguments before preparation', () => {
  const invalidArguments = [[], ['not-a-simulator'], ['g'.repeat(36)], ['-'.repeat(36)],
    ['a'.repeat(35)], ['a'.repeat(37)], [''],
    ['8C8C1971-6462-4016-BE9B-DBBBD9DCB0C6', 'extra']];
  for (const entry of ['agentui-ios', 'apps/ios/native/run.sh', 'apps/ios/native/verify.sh']) {
    for (const args of invalidArguments) {
      const result = spawnSync('/bin/bash', [entry, ...args], { cwd: root, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 1, `${entry} ${args}: ${result.stderr}`);
      assert.match(result.stderr, /Supply one simulator UDID/);
      assert.equal(result.stdout, '');
    }
  }
});

test('simulator UUID parsing accepts either case and returns the canonical uppercase identifier', () => {
  for (const input of ['8c8c1971-6462-4016-be9b-dbbbd9dcb0c6', '8C8C1971-6462-4016-BE9B-DBBBD9DCB0C6']) {
    const result = spawnSync('/bin/bash', ['-c', 'source apps/ios/native/common.sh; require_simulator "$1"', 'parse', input],
      { cwd: root, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '8C8C1971-6462-4016-BE9B-DBBBD9DCB0C6');
  }
});

test('native build source snapshots track build inputs and ignore unrelated review changes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'agentui-ios-source-'));
  try {
    mkdirSync(join(fixture, 'apps/ios/native'), { recursive: true });
    mkdirSync(join(fixture, 'reviews'));
    writeFileSync(join(fixture, 'apps/ios/native/common.sh'), read('apps/ios/native/common.sh'));
    writeFileSync(join(fixture, 'apps/ios/native/input.txt'), 'initial');
    writeFileSync(join(fixture, 'README.md'), 'initial');
    const git = (args) => execFileSync('git', args, { cwd: fixture, stdio: 'pipe' });
    git(['init', '--quiet']);
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
    const snapshot = () => execFileSync('/bin/bash', ['-c', 'set -euo pipefail; source apps/ios/native/common.sh; ios_source_snapshot'],
      { cwd: fixture, encoding: 'utf8' });
    const before = snapshot();
    writeFileSync(join(fixture, 'README.md'), 'unrelated change');
    writeFileSync(join(fixture, 'reviews/result.md'), 'unrelated review');
    assert.equal(snapshot(), before);
    writeFileSync(join(fixture, 'apps/ios/native/input.txt'), 'changed build input');
    assert.notEqual(snapshot(), before);
    writeFileSync(join(fixture, 'apps/ios/native/input.txt'), 'initial');
    writeFileSync(join(fixture, 'apps/ios/native/new-input.txt'), 'new build input');
    assert.notEqual(snapshot(), before);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
