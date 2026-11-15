import assert from 'node:assert/strict';
import { cp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parseServerCustomizationArtifact, readServerCustomizationArtifact, serverCustomizationArtifactId } from '@agentui/host/customization';
import { setup, expectation, write, extension, validSource } from './server-support.mjs';

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
      await assert.rejects(read(directory), /Invalid server customization artifact/u);
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
    value => { value.packages[0].extensions.push(value.root); },
    value => { value.entries[0].index = 1; },
    value => { value.entries[0].module = './wrong'; },
    value => { value.assets.push(value.assets[0]); },
    value => { value.assets[0].path = '../escape'; },
    value => { value.extra = true; },
  ]) {
    const changed = structuredClone(manifest);
    mutate(changed);
    const { artifactId: _, ...body } = changed;
    changed.artifactId = serverCustomizationArtifactId(body);
    assert.throws(() => parseServerCustomizationArtifact(changed));
  }
  const changed = structuredClone(manifest);
  changed.packages[0].commit = '0'.repeat(40);
  const { artifactId: _, ...body } = changed;
  changed.artifactId = serverCustomizationArtifactId(body);
  await writeFile(join(f.root, 'artifact', 'customization.json'), JSON.stringify(changed));
  await assert.rejects(readServerCustomizationArtifact({ directory: join(f.root, 'artifact'), expected: expectation(manifest) }));
});

test('supports shared module declarations and canonicalizes a symlinked output parent', async t => {
  const f = await setup(t);
  const agentui = extension('fixture');
  agentui.extension.entries.push({ kind: 'desktop', module: './server.mjs' });
  await write(f.repo.directory, 'package.json', { agentui });
  await mkdir(join(f.root, 'physical'));
  await symlink(join(f.root, 'physical'), join(f.root, 'alias'));
  const built = await f.build(undefined, 'alias/artifact');
  assert.equal(built.directory, await realpath(join(f.root, 'physical/artifact')));
  assert.equal(built.manifest.packages[0].local.sources.length, 1);
});

test('only one concurrent publisher owns a fresh output and failed overwrite preserves it', async t => {
  const f = await setup(t);
  const commit = f.repo.commit();
  const results = await Promise.allSettled([f.build(commit), f.build(commit)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failed = results.find(result => result.status === 'rejected');
  assert.equal(failed.reason.code, 'output-exists');
  const manifest = JSON.parse(await readFile(join(f.root, 'artifact/customization.json'), 'utf8'));
  await readServerCustomizationArtifact({ directory: join(f.root, 'artifact'), expected: expectation(manifest) });
});

test('rejects unsupported native addons and lazy CommonJS builtin loading', async t => {
  for (const source of ["import './addon.node';" + validSource,
    `export default {kind:'server',sdkVersion:'1',activate(){return require('node:fs')}};`]) {
    const f = await setup(t, source);
    await write(f.repo.directory, 'addon.node', 'not a native module');
    await assert.rejects(f.build(), { code: 'build-failed' });
  }
});
