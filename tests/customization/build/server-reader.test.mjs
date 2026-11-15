import assert from 'node:assert/strict';
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parseServerCustomizationArtifact, readServerCustomizationArtifact } from '@agentui/host/customization';
import { setup, expectation, resigned } from './server-support.mjs';

const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)])) : value;

test('reader rejects altered inventory, links, compatibility, and caller pins without executing code', async t => {
  const f = await setup(t);
  const built = await f.build();
  const expected = expectation(built.manifest);
  const read = (directory, pinned = expected) => readServerCustomizationArtifact({ directory, expected: pinned });
  for (const [name, mutate] of [
    ['tampered byte', directory => writeFile(join(directory, 'entries.mjs'), "throw new Error('must not execute')")],
    ['missing byte', directory => rm(join(directory, 'entries.mjs'))],
    ['extra byte', directory => writeFile(join(directory, 'extra'), 'unexpected')],
    ['extra directory', directory => mkdir(join(directory, 'extra'))],
    ['asset symlink', async directory => { await rm(join(directory, 'entries.mjs')); await symlink(join(built.directory, 'entries.mjs'), join(directory, 'entries.mjs')); }],
    ['manifest symlink', async directory => { await rm(join(directory, 'customization.json')); await symlink(join(built.directory, 'customization.json'), join(directory, 'customization.json')); }],
  ]) {
    await t.test(name, async () => {
      const directory = join(f.root, name.replaceAll(' ', '-'));
      await cp(built.directory, directory, { recursive: true });
      await mutate(directory);
      await assert.rejects(read(directory), { name: 'CustomizationError', code: 'invalid-artifact', message: 'Invalid server customization artifact.' });
    });
  }
  for (const field of ['artifactId', 'sdkVersion', 'nodeVersion', 'nodeModules', 'abiIdentity']) {
    await t.test(`wrong expected ${field}`, () => assert.rejects(read(built.directory, { ...expected, [field]: field === 'artifactId' || field === 'abiIdentity' ? '0'.repeat(64) : 'wrong' })));
  }
  await symlink(built.directory, join(f.root, 'symlink-root'));
  await assert.rejects(read(join(f.root, 'symlink-root')));
  const reordered = reverseKeys(built.manifest);
  assert.deepEqual(parseServerCustomizationArtifact(reordered), built.manifest);
  await writeFile(join(built.directory, 'customization.json'), JSON.stringify(reordered));
  assert.deepEqual((await read(built.directory)).manifest, built.manifest);
});

test('parser validates provenance, graph order, entry map and canonical artifact identity', async t => {
  const f = await setup(t);
  const { manifest } = await f.build();
  for (const mutate of [
    value => { value.packages[0].inputs.files[0].sha256 = '0'.repeat(64); },
    value => { value.packages[0].identity = '0'.repeat(64); },
    value => { value.packages[0].commit = 'not-a-commit'; },
    value => { value.packages[0].extensions.push({ packageIdentity: value.root, commit: value.packages[0].commit }); },
    value => { value.entries[0].index = 1; },
    value => { value.entries[0].module = './wrong'; },
    value => { value.assets.push(value.assets[0]); },
    value => { value.assets[0].path = '../escape'; },
    value => { value.extra = true; },
  ]) {
    const changed = resigned(manifest, mutate);
    assert.throws(() => parseServerCustomizationArtifact(changed), { code: 'invalid-artifact' });
  }
  const changed = resigned(manifest, value => { value.packages[0].commit = '0'.repeat(40); });
  await writeFile(join(f.root, 'artifact', 'customization.json'), JSON.stringify(changed));
  await assert.rejects(readServerCustomizationArtifact({ directory: join(f.root, 'artifact'), expected: expectation(manifest) }));
});
