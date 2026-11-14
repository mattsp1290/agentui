import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { contracts, createFakeFixture } from '@agentui/switchboard-qualification/testkit';

const root = new URL('../../../', import.meta.url);
const alias = '@agentui/switchboard-qualification';

for (const [name, contract] of Object.entries(contracts)) {
  test(`controlled qualification imports the upstream ${name} contract and official fake`, { timeout: 10_000 }, async (context) => {
    await contract(createFakeFixture, context.signal);
  });
}

test('controlled qualification retains a separate development archive and production pin', async () => {
  assert.deepEqual(Object.keys(contracts).sort(), ['events', 'interaction', 'sessions', 'uncertainty']);
  const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
  const manifest = await readJson('vendor/dev-qualification/switchboard.json');
  const consumer = await readJson('packages/adapter-tests/package.json');
  const host = await readJson('packages/host/package.json');
  const pin = await readJson('vendor/switchboard.json');
  const lock = await readJson('package-lock.json');
  assert.equal(manifest.dependencyAlias, alias);
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.consumerPackage, '@agentui/adapter-tests');
  const installedManifest = await readJson(`node_modules/${alias}/package.json`);
  assert.equal(installedManifest.license, manifest.license);
  assert.equal(installedManifest.exports['./testkit'].import, './dist/testkit/index.js');
  assert.equal(installedManifest.exports['./testkit'].types, './dist/testkit/index.d.ts');
  assert.match(await readFile(new URL(`node_modules/${alias}/LICENSE`, root), 'utf8'), /MIT License/u);
  assert.equal(manifest.sourceRevision, '71d204015f573e1399d8ba19a33a2d4b4067fa1a');
  assert.equal(manifest.sourceTree, 'a398efdf464b31141802751ecef081b9fb6f72c3');
  assert.equal(manifest.artifact, `switchboard-${manifest.sourceRevision}.tgz`);
  const archive = `vendor/dev-qualification/${manifest.artifact}`;
  const bytes = await readFile(new URL(archive, root));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256);
  assert.equal(consumer.devDependencies[alias], `file:../../${archive}`);
  assert.equal(consumer.dependencies[alias], undefined);
  for (const [path, packageInfo] of Object.entries(lock.packages)) {
    assert.equal(packageInfo.dependencies?.[alias], undefined, path);
    assert.equal(packageInfo.optionalDependencies?.[alias], undefined, path);
    assert.equal(packageInfo.peerDependencies?.[alias], undefined, path);
  }
  const installed = lock.packages[`node_modules/${alias}`];
  assert.equal(installed.name, '@mattsp1290/switchboard');
  assert.equal(installed.dev, true);
  assert.equal(installed.resolved, `file:${archive}`);
  assert.equal(installed.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
  assert.equal(pin.sourceRevision, '58c7922d8fade3617cc86fedcf41677f897025ef');
  assert.equal(pin.sha256, '15416f5505eb8c3f5b0e3236a48f879f873661e46d27a652ad845f08cb0b9421');
  assert.equal(host.dependencies['@mattsp1290/switchboard'], `file:../../vendor/${pin.artifact}`);
  assert.equal(lock.packages['node_modules/@mattsp1290/switchboard'].resolved, `file:vendor/${pin.artifact}`);
});

test('controlled qualification alias exposes public runtime imports and rejects private source imports', async () => {
  const core = await import(alias);
  assert.equal(typeof core.createDispatchOperation, 'function');
  assert.equal(typeof core.createEventStream, 'function');
  assert.equal(core.contracts, undefined);
  assert.equal(core.createFakeFixture, undefined);
  await assert.rejects(import('@mattsp1290/switchboard/testkit'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  for (const path of ['src/index.ts', 'src/testkit/index.ts', 'dist/testkit/index.js', 'dist/testkit/contracts.js', 'dist/testkit/fake.js']) {
    await assert.rejects(import(`${alias}/${path}`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
});
