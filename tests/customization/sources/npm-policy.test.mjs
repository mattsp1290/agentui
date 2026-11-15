import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { CustomizationError } from '@agentui/host/customization';
import { manager, write, fixture, shared, reference, lockFor, registry } from './source-support.mjs';

test('lock drift, missing entries, malformed entries and unsupported npm sources reject as a unit', async t => {
  for (const variant of ['drift', 'missing', 'malformed', 'transitive', 'git', 'credentials', 'unpinned', 'nested-shrinkwrap']) {
    const f = await fixture(t);
    const repo = await f.repository(variant);
    const pkg = { name: 'notes', version: '1.0.0', packageManager: manager, dependencies: { value: '1.0.0' } };
    const lock = lockFor(pkg, { 'node_modules/value': { ...registry } });
    if (variant === 'drift') lock.packages[''].dependencies = { value: '2.0.0' };
    if (variant === 'missing') delete lock.packages['node_modules/value'];
    if (variant === 'malformed') lock.packages['node_modules/value'] = null;
    if (variant === 'transitive') lock.packages['node_modules/value'].dependencies = { missing: '1.0.0' };
    if (variant === 'git') { pkg.dependencies.value = 'github:owner/repository'; lock.packages[''].dependencies = pkg.dependencies; }
    if (variant === 'credentials') lock.packages['node_modules/value'].resolved = 'https://user:SECRET@example.invalid/value.tgz';
    if (variant === 'unpinned') delete lock.packages['node_modules/value'].integrity;
    if (variant === 'nested-shrinkwrap') lock.packages['node_modules/value'].hasShrinkwrap = true;
    await shared(repo, '', pkg);
    await write(repo.directory, 'package-lock.json', lock);
    await assert.rejects(f.read(reference(repo, repo.commit())), error => error instanceof CustomizationError && error.code === 'invalid-package' && !error.message.includes('SECRET'));
    assert.deepEqual(await readdir(f.scratchParent), []);
  }
});

for (const [marker, value] of [['bundleDependencies', ['child']], ['bundleDependencies', true], ['bundledDependencies', ['child']], ['bundledDependencies', true], ['inBundle', true], ['inBundle', 'true']]) {
  test(`installed lock entries reject active ${marker} ${JSON.stringify(value)} independently`, async t => {
    const f = await fixture(t);
    const repo = await f.repository('bundled');
    const pkg = { name: 'notes', version: '1.0.0', packageManager: manager, dependencies: { value: '1.0.0' } };
    await shared(repo, '', pkg);
    await write(repo.directory, 'package-lock.json', lockFor(pkg, { 'node_modules/value': { ...registry, [marker]: value } }));
    await assert.rejects(f.read(reference(repo, repo.commit())), { code: 'invalid-package', message: 'Bundled npm dependencies are unsupported.' });
    assert.deepEqual(await readdir(f.scratchParent), []);
  });
}

test('installed lock entries retain support for inert bundle metadata', async t => {
  const f = await fixture(t);
  const repo = await f.repository('inert-bundle-metadata');
  const pkg = { name: 'notes', version: '1.0.0', packageManager: manager, dependencies: { value: '1.0.0' } };
  await shared(repo, '', pkg);
  for (const metadata of [{}, { bundleDependencies: false, bundledDependencies: [] }, { bundleDependencies: [], bundledDependencies: false, inBundle: false }]) {
    await write(repo.directory, 'package-lock.json', lockFor(pkg, { 'node_modules/value': { ...registry, ...metadata } }));
    const result = await f.read(reference(repo, repo.commit()));
    assert.equal(result.root.npm.kind, 'locked');
    await result.dispose();
  }
  assert.deepEqual(await readdir(f.scratchParent), []);
});

test('selected and owning npm shrinkwrap files fail closed despite a valid package lock', async t => {
  for (const name of ['npm-shrinkwrap.json', 'NPM-SHRINKWRAP.JSON', 'NpM-ShRiNkWrAp.JsOn']) {
    for (const variant of ['standalone', 'owner', 'selected']) await t.test(`${variant}/${name}`, async t => {
      const f = await fixture(t);
      const repo = await f.repository(variant);
      const workspace = variant !== 'standalone';
      const pkg = { name: 'root', version: '1.0.0', packageManager: manager,
        ...(workspace ? { workspaces: ['packages/foo'] } : { dependencies: { value: '1.0.0' } }) };
      const entries = workspace ? { 'packages/foo': { name: 'foo', version: '1.0.0' }, 'node_modules/foo': { link: true, resolved: 'packages/foo' } } : { 'node_modules/value': registry };
      await write(repo.directory, 'package.json', pkg);
      await shared(repo, workspace ? 'packages/foo' : '', workspace ? { name: 'foo', version: '1.0.0' } : pkg);
      await write(repo.directory, 'package-lock.json', lockFor(pkg, entries));
      const shrinkwrap = lockFor(pkg, { 'node_modules/unsafe': { version: '1.0.0', resolved: 'git+ssh://example.invalid/unsafe' } });
      await write(repo.directory, variant === 'selected' ? `packages/foo/${name}` : name, shrinkwrap);
      await assert.rejects(f.read(reference(repo, repo.commit(), workspace ? 'packages/foo' : undefined)), { code: 'invalid-package' });
      assert.deepEqual(await readdir(f.scratchParent), []);
    });
  }
});

test('manifest and lock filename aliases cannot establish a locked npm context', async t => {
  for (const name of ['PACKAGE.JSON', 'PaCkAgE.JsOn', 'PACKAGE-LOCK.JSON', 'PaCkAgE-LoCk.JsOn']) await t.test(name, async t => {
    const f = await fixture(t);
    const repo = await f.repository('control-alias');
    const pkg = { name: 'root', version: '1.0.0', packageManager: manager,
      dependencies: { value: '1.0.0' }, agentui: { shared: './source.ts' } };
    const manifestAlias = name.toLowerCase() === 'package.json';
    await write(repo.directory, manifestAlias ? name : 'package.json', pkg);
    await write(repo.directory, manifestAlias ? 'package-lock.json' : name, lockFor(pkg, { 'node_modules/value': registry }));
    await write(repo.directory, 'source.ts', 'export const value = 1;\n');
    const input = reference(repo, repo.commit());
    if (manifestAlias) {
      const result = await f.read(input);
      assert.deepEqual(result.root.npm, { kind: 'absent' });
      assert.equal(result.root.customization, undefined);
      await result.dispose();
    } else {
      await assert.rejects(f.read(input), { code: 'invalid-package' });
    }
    assert.deepEqual(await readdir(f.scratchParent), []);
  });
});
