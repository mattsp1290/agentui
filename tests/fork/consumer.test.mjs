import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { verifyConsumerLock, verifyConsumerMetadata, verifyInstalled } from '../../scripts/lib/agui-fork/consumer.mjs';

const nativeVersions = { '@openai/codex-sdk': '0.167.1', '@openai/codex': '0.167.1', '@earendil-works/pi-agent-core': '1.5.0', '@earendil-works/pi-ai': '1.5.0', '@earendil-works/pi-coding-agent': '1.5.0', zod: '3.25.76' };
const packages = new Map(['core', 'proto', 'encoder', 'client', 'codex-sdk', 'pi'].map((name) => [`@ag-ui/${name}`, { filename: `${name}.tgz`, integrity: `sha512-${name}`, manifest: { name: `@ag-ui/${name}`, version: '1.0.0' } }]));
const corePath = 'node_modules/@ag-ui/core';
const optionalName = `@openai/codex-${process.platform}-${process.arch}`;
const digest = (body) => createHash('sha256').update(body).digest('hex');

function metadataFixture() {
  const manifest = { dependencies: { ...nativeVersions } };
  const lock = { packages: {} };
  for (const [name, packed] of packages) {
    const resolved = `file:../artifacts/${packed.filename}`;
    manifest.dependencies[name] = resolved;
    lock.packages[`node_modules/${name}`] = { resolved, integrity: packed.integrity };
  }
  lock.packages[''] = { dependencies: { ...manifest.dependencies } };
  for (const [name, version] of Object.entries(nativeVersions)) lock.packages[`node_modules/${name}`] = { version };
  for (const os of ['darwin', 'linux', 'win32']) for (const arch of ['arm64', 'x64']) {
    lock.packages[`node_modules/@openai/codex-${os}-${arch}`] = { optional: true, version: `0.167.1-${os}-${arch}` };
  }
  return { lock, manifest };
}

function temporary(context) {
  const folder = mkdtempSync(join(tmpdir(), 'agentui-consumer-test-'));
  context.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}
function writeJson(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body));
}
function installedFixture(context) {
  const folder = temporary(context);
  for (const [name, packed] of packages) writeJson(join(folder, 'node_modules', name, 'package.json'), packed.manifest);
  for (const [name, version] of Object.entries(nativeVersions)) writeJson(join(folder, 'node_modules', name, 'package.json'), { name, version });
  writeJson(join(folder, 'node_modules', optionalName, 'package.json'), { name: optionalName, version: `0.167.1-${process.platform}-${process.arch}` });
  const payload = join(folder, 'node_modules', optionalName, 'vendor/bin/codex');
  mkdirSync(dirname(payload), { recursive: true });
  writeFileSync(payload, 'controlled placeholder; never executed');
  return folder;
}

test('consumer metadata accepts a complete local package and native closure', () => {
  const { lock, manifest } = metadataFixture();
  assert.doesNotThrow(() => verifyConsumerMetadata(lock, manifest, packages));
});

for (const [label, mutate, error] of [
  ['alias', (lock) => { lock.packages['node_modules/alias'] = { ...lock.packages[corePath], name: '@ag-ui/core' }; }, /unexpected or repeated/u],
  ['nested package', (lock) => { lock.packages[`node_modules/wrapper/${corePath}`] = lock.packages[corePath]; delete lock.packages[corePath]; }, /nested or aliased/u],
  ['registry resolution', (lock) => { lock.packages[corePath].resolved = 'https://registry.npmjs.org/core.tgz'; }, /resolution/u],
  ['missing package', (lock) => { delete lock.packages[corePath]; }, /package set/u],
  ['changed integrity', (lock) => { lock.packages[corePath].integrity = 'sha512-other'; }, /integrity/u],
  ['root dependency drift', (lock) => { lock.packages[''].dependencies.zod = '4.0.0'; }, /root dependencies/u],
  ['native version drift', (lock) => { lock.packages['node_modules/@openai/codex-sdk'].version = '0.0.0'; }, /locked native version/u],
  ['optional payload removed', (lock) => { delete lock.packages['node_modules/@openai/codex-darwin-arm64']; }, /optional Codex payload/u],
  ['optional version drift', (lock) => { lock.packages['node_modules/@openai/codex-darwin-arm64'].version = '0.0.0'; }, /optional Codex payload version/u],
]) test(`consumer metadata rejects ${label}`, () => {
  const { lock, manifest } = metadataFixture();
  mutate(lock, manifest);
  assert.throws(() => verifyConsumerMetadata(lock, manifest, packages), error);
});

test('consumer files must match both pinned byte digests before structural verification', (context) => {
  const folder = temporary(context);
  const { lock, manifest } = metadataFixture();
  writeJson(join(folder, 'package-lock.json'), lock);
  writeJson(join(folder, 'package.json'), manifest);
  const verified = { packages, metadata: { qualification: { consumerLockSha256: digest(readFileSync(join(folder, 'package-lock.json'))), consumerPackageSha256: digest(readFileSync(join(folder, 'package.json'))) } } };
  assert.doesNotThrow(() => verifyConsumerLock(folder, verified));
  for (const [file, error] of [['package-lock.json', /lock digest/u], ['package.json', /manifest digest/u]]) {
    const path = join(folder, file);
    const original = readFileSync(path);
    writeFileSync(path, Buffer.concat([original, Buffer.from('\n')]));
    assert.throws(() => verifyConsumerLock(folder, verified), error);
    writeFileSync(path, original);
  }
});

test('installed verification accepts the exact package graph and optional payload presence', (context) => {
  assert.doesNotThrow(() => verifyInstalled(installedFixture(context), { packages }));
});

for (const [label, mutate, error] of [
  ['linked package', (folder) => { const target = join(folder, 'linked-core'); renameSync(join(folder, corePath), target); symlinkSync(target, join(folder, corePath), 'dir'); }, /linked AG-UI/u],
  ['nested package', (folder) => { writeJson(join(folder, 'node_modules/wrapper/package.json'), { name: 'wrapper' }); const target = join(folder, 'node_modules/wrapper', corePath); mkdirSync(dirname(target), { recursive: true }); renameSync(join(folder, corePath), target); }, /nested or aliased/u],
  ['aliased package', (folder) => { renameSync(join(folder, corePath), join(folder, 'node_modules/alias')); }, /nested or aliased/u],
  ['duplicate package', (folder) => { writeJson(join(folder, 'node_modules/wrapper/package.json'), { name: 'wrapper' }); writeJson(join(folder, 'node_modules/wrapper', corePath, 'package.json'), packages.get('@ag-ui/core').manifest); }, /unexpected or repeated/u],
  ['missing package', (folder) => { rmSync(join(folder, corePath), { recursive: true }); }, /package set/u],
  ['manifest drift', (folder) => { writeJson(join(folder, corePath, 'package.json'), { name: '@ag-ui/core', version: '0.0.0' }); }, /packed manifest/u],
  ['native version drift', (folder) => { writeJson(join(folder, 'node_modules/@openai/codex-sdk/package.json'), { version: '0.0.0' }); }, /installed native version/u],
  ['optional version drift', (folder) => { writeJson(join(folder, 'node_modules', optionalName, 'package.json'), { version: '0.0.0' }); }, /installed optional Codex/u],
  ['absent native payload', (folder) => { rmSync(join(folder, 'node_modules', optionalName, 'vendor/bin/codex')); }, /payload absent/u],
]) test(`installed verification rejects ${label}`, (context) => {
  const folder = installedFixture(context);
  mutate(folder);
  assert.throws(() => verifyInstalled(folder, { packages }), error);
});
