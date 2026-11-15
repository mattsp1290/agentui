import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, cp, mkdir, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { CustomizationError, parseServerCustomizationArtifact, readServerCustomizationArtifact } from '@agentui/host/customization';
import { serverCustomizationAbi } from '../../../scripts/server-customization-abi.mjs';
import { qualifyServerCatalog } from '../../../scripts/server-customization-qualifier.mjs';
import { execute, locked, tarball } from './preparation-support.mjs';
import { clean, resigned, valueFromCatalog, setup, extension, expectation, validSource, write } from './server-support.mjs';

test('builds stable committed server bytes, excludes dirty files, and retains verified assets', async t => {
  const f = await setup(t);
  const commit = f.repo.commit();
  await write(f.repo.directory, 'index.ts', 'not valid TypeScript');
  await write(f.repo.directory, 'dirty-secret', 'never capture');
  const first = await f.build(commit);
  const second = await f.build(commit, 'second');
  assert.equal(first.manifest.artifactId, second.manifest.artifactId);
  assert.equal(first.manifest.packages[0].commit, commit);
  assert.equal(first.manifest.entries.length, 1);
  assert.equal(Object.isFrozen(first.manifest.packages[0].local.manifest.entries), true);
  assert.ok(!first.manifest.packages[0].inputs.files.some(file => file.path === 'dirty-secret'));
  const verified = await readServerCustomizationArtifact({ directory: first.directory, expected: expectation(first.manifest) });
  const bytes = verified.readAsset('entries.mjs');
  bytes.fill(0);
  assert.notDeepEqual(verified.readAsset('entries.mjs'), bytes);
  await rm(first.directory, { recursive: true });
  assert.match(verified.readAsset('entries.mjs').toString(), /activate/);
  const stdout = execFileSync(process.execPath, ['scripts/build-server-customization.mjs', '--repository', f.repo.directory, '--commit', commit, '--out', join(f.root, 'cli')], { encoding: 'utf8' });
  assert.equal(JSON.parse(stdout).artifactId, first.manifest.artifactId);
});

test('bundles real locked dependencies while ignoring author build and compiler configuration', async t => {
  const f = await setup(t);
  const { pkg } = await locked(f, f.repo);
  pkg.agentui = extension('locked');
  pkg.scripts.build = 'exit 99';
  await write(f.repo.directory, 'package.json', pkg);
  await write(f.repo.directory, 'tsconfig.json', { compilerOptions: { jsxImportSource: 'missing', paths: { value: ['./missing'] } } });
  await write(f.repo.directory, 'vite.config.ts', "throw new Error('must not run')");
  await write(f.repo.directory, 'index.ts', `import value from 'value'; ${validSource.replace('return {dispose(){}}', 'return {value, dispose(){}}')}`);
  const built = await f.build();
  assert.equal(await valueFromCatalog(built), 'value@1.0.0');
  assert.equal(built.manifest.packages[0].npm.kind, 'locked');
  assert.match(built.manifest.packages[0].npm.identity, /^[a-f0-9]{64}$/u);
  await clean(f);
});

test('deduplicates external diamond and selected monorepo siblings in deterministic graph order', async t => {
  const f = await setup(t);
  const leaf = await f.repository('leaf');
  await write(leaf.directory, 'package.json', { agentui: extension('leaf') });
  await write(leaf.directory, 'index.ts', validSource);
  const leafRef = leaf.reference(leaf.commit());
  const mono = await f.repository('monorepo');
  for (const name of ['left', 'right']) {
    await write(mono.directory, `${name}/package.json`, { type: 'module', agentui: extension(name, { extensions: [leafRef] }) });
    await write(mono.directory, `${name}/index.ts`, validSource);
  }
  const commit = mono.commit();
  const refs = ['left', 'right', 'left'].map(name => mono.reference(commit, name));
  await write(f.repo.directory, 'package.json', { type: 'module', agentui: extension('fixture', { extensions: refs }) });
  const result = await f.build();
  assert.deepEqual(result.manifest.packages.map(pkg => pkg.local.manifest.namespace), ['fixture', 'left', 'leaf', 'right']);
  assert.deepEqual(result.manifest.packages[0].extensions[0], result.manifest.packages[0].extensions[2]);
  assert.deepEqual(result.manifest.entries.map(entry => entry.index), [0, 1, 2, 3]);
  const reordered = resigned(result.manifest, value => { [value.packages[1], value.packages[2]] = [value.packages[2], value.packages[1]]; });
  assert.throws(() => parseServerCustomizationArtifact(reordered), /Invalid server customization artifact/u);
});

test('retains every pinned commit while compiling identical child content once', async t => {
  const f = await setup(t, validSource.replace('return {dispose(){}}', 'return {value:globalThis.childLoads,dispose(){}}'));
  const child = await f.repository('child');
  await write(child.directory, 'package.json', { agentui: extension('child') });
  await write(child.directory, 'index.ts', `globalThis.childLoads=(globalThis.childLoads??0)+1; ${validSource}`);
  const first = child.commit(), second = child.commit();
  assert.notEqual(first, second);
  assert.equal(execute('git', ['rev-parse', `${first}^{tree}`], child.directory), execute('git', ['rev-parse', `${second}^{tree}`], child.directory));
  const build = async (commits, name) => {
    await write(f.repo.directory, 'package.json', { agentui: extension('fixture', { extensions: commits.map(commit => child.reference(commit)) }) });
    return f.build(undefined, name);
  };
  const initial = await build([first, first], 'initial');
  const built = await build([first, second], 'both');
  const [root, representative] = built.manifest.packages;
  assert.equal(built.manifest.packages.length, 2);
  assert.equal(built.manifest.entries.length, 2);
  assert.equal(representative.commit, first);
  assert.equal(representative.identity, initial.manifest.packages[1].identity);
  assert.deepEqual(root.extensions, [first, second].map(commit => ({ packageIdentity: representative.identity, commit })));
  assert.equal(await valueFromCatalog(built), 1);
  assert.deepEqual(await readFile(join(initial.directory, 'entries.mjs')), await readFile(join(built.directory, 'entries.mjs')));
  assert.notEqual(initial.manifest.artifactId, built.manifest.artifactId);
  const verified = await readServerCustomizationArtifact({ directory: built.directory, expected: expectation(built.manifest) });
  assert.deepEqual(verified.manifest, built.manifest);
  const changed = resigned(built.manifest, value => { value.packages[0].extensions[1].commit = first; });
  assert.notEqual(changed.artifactId, built.manifest.artifactId);
  assert.deepEqual(parseServerCustomizationArtifact(changed), changed);

  for (const [name, mutate] of [
    ['legacy string edge', value => { value.packages[0].extensions[0] = representative.identity; }],
    ['missing edge field', value => { delete value.packages[0].extensions[0].commit; }],
    ['extra edge field', value => { value.packages[0].extensions[0].subdirectory = ''; }],
    ['malformed edge identity', value => { value.packages[0].extensions[0].packageIdentity = 'bad'; }],
    ['malformed edge commit', value => { value.packages[0].extensions[0].commit = 'bad'; }],
    ['unknown edge target', value => { value.packages[0].extensions[0].packageIdentity = '0'.repeat(64); }],
    ['unreachable package', value => { value.packages[0].extensions = []; }],
    ['cycle', value => { value.packages[1].extensions.push({ packageIdentity: root.identity, commit: root.commit }); }],
    ['wrong package order', value => { value.packages.reverse(); }],
    ['unreferenced representative', value => { value.packages[1].commit = '0'.repeat(40); }],
    ['missing representative edge', value => { value.packages[0].extensions[0].commit = second; }],
  ]) {
    await t.test(name, () => {
      const invalid = resigned(built.manifest, mutate);
      assert.throws(() => parseServerCustomizationArtifact(invalid), /Invalid server customization artifact/u);
    });
  }
});

test('rejects duplicate namespaces across distinct graph packages', async t => {
  const f = await setup(t);
  const external = await f.repository('external');
  await write(external.directory, 'package.json', { agentui: extension('fixture') });
  await write(external.directory, 'index.ts', validSource);
  await write(f.repo.directory, 'package.json', { agentui: extension('fixture', { extensions: [external.reference(external.commit())] }) });
  await assert.rejects(f.build(undefined, 'bad'), { code: 'invalid-graph' });
  await clean(f);
});

for (const [name, source, code] of [
  ['wrong default', 'export default {};', 'entry-validation'],
  ['wrong kind', validSource.replace("kind:'server'", "kind:'desktop'"), 'entry-validation'],
  ['wrong SDK export', validSource.replace('sdkVersion:EXTENSION_SDK_VERSION', "sdkVersion:'wrong'"), 'entry-validation'],
  ['throwing top level', "throw new Error('SOURCE_SECRET');" + validSource, 'entry-validation'],
  ['unsettled top level await', 'await new Promise(()=>{});' + validSource, 'entry-validation'],
  ['bounded top level await', 'await new Promise(r=>setInterval(r,60000));' + validSource, 'entry-validation'],
  ['compile error', 'export default {', 'build-failed'],
  ['ambient dependency', "import 'esbuild';" + validSource, 'build-failed'],
  ['SDK subpath', "import '@agentui/sdk/tools';" + validSource, 'build-failed'],
  ['nonliteral dynamic import', "const name='esbuild'; await import(name);" + validSource, 'build-failed'],
]) {
  test(`rejects ${name} and preserves last good output`, async t => {
    const f = await setup(t);
    const good = await f.build();
    const previous = await readFile(join(good.directory, 'entries.mjs'));
    await write(f.repo.directory, 'index.ts', source);
    await assert.rejects(f.build(undefined, 'bad'), error => { assert.ok(error instanceof CustomizationError); assert.equal(error.code, code); assert.ok(!error.message.includes('SOURCE_SECRET')); return true; });
    assert.deepEqual(await readFile(join(good.directory, 'entries.mjs')), previous);
    await clean(f);
  });
}

test('rejects mismatched manifest SDK before any entry executes', async t => {
  const f = await setup(t);
  const pkg = { agentui: extension('fixture') };
  pkg.agentui.extension.sdkVersion = 'wrong';
  await write(f.repo.directory, 'package.json', pkg);
  await write(f.repo.directory, 'index.ts', "throw new Error('never execute');");
  await assert.rejects(f.build(undefined, 'bad'), { code: 'invalid-graph' });
  await clean(f);
});

test('install failure cleans owned staging and leaves a previous artifact intact', async t => {
  const f = await setup(t);
  const good = await f.build();
  const { pkg, lock } = await locked(f, f.repo);
  pkg.agentui = extension('fixture');
  lock.packages['node_modules/value'].integrity = 'sha512-' + 'A'.repeat(86) + '==';
  await write(f.repo.directory, 'package.json', pkg);
  await write(f.repo.directory, 'package-lock.json', lock);
  await assert.rejects(f.build(undefined, 'bad'), error => {
    assert.ok(error instanceof CustomizationError);
    assert.equal(error.code, 'install-failed');
    return true;
  });
  await access(join(good.directory, 'entries.mjs'));
  await clean(f);
});

test('refuses overwrites and does not remove somebody else\'s output', async t => {
  const f = await setup(t);
  const good = await f.build();
  const previous = await readFile(join(good.directory, 'customization.json'));
  await assert.rejects(f.build(), { code: 'output-exists' });
  assert.deepEqual(await readFile(join(good.directory, 'customization.json')), previous);
});

test('rejects mutation of emitted bytes during actual catalog qualification', async t => {
  const f = await setup(t, `import {writeFileSync} from 'node:fs'; writeFileSync(new URL('./entries.mjs',import.meta.url),'changed'); ${validSource}`);
  await assert.rejects(f.build(undefined, 'bad'), { code: 'artifact-changed' });
  await clean(f);
});

test('qualifies valid entries with bounded top-level logging', async t => {
  const f = await setup(t, `console.log('hello'); console.error('diagnostic'); ${validSource}`);
  await f.build();
});


test('bundles locked workspace imports across external members and qualifies relocated bytes after source disposal', async t => {
  const f = await setup(t);
  const repo = await f.repository('workspace');
  const root = { name: 'workspace-root', version: '1.0.0', private: true, packageManager: 'npm@11.19.1', workspaces: ['packages/*'] };
  const members = {};
  const child = await tarball(f, repo, '@fixture/child', '1.0.0');
  for (const name of ['one', 'two', 'sibling']) {
    const pkg = { name, type: 'module', exports: './index.mjs',
      ...(name === 'sibling' ? { dependencies: { '@fixture/child': 'file:../../vendor/@fixture/child-1.0.0.tgz' } } :
        { version: '1.0.0', dependencies: { sibling: '*' }, agentui: { ...extension(name), sources: { './server.mjs': './index.mjs' } } }) };
    await write(repo.directory, `packages/${name}/package.json`, pkg);
    await write(repo.directory, `packages/${name}/index.mjs`, name === 'sibling' ? "export {default} from '@fixture/child';" :
      `import value from 'sibling'; ${validSource.replace('return {dispose(){}}', 'return {value,dispose(){}}')}`);
    const { type: _type, exports: _exports, agentui: _agentui, ...entry } = pkg;
    members[`packages/${name}`] = entry;
    members[`node_modules/${name}`] = { resolved: `packages/${name}`, link: true };
  }
  members['packages/sibling/node_modules/@fixture/child'] = child;
  await write(repo.directory, 'package.json', root);
  await write(repo.directory, 'package-lock.json', { name: root.name, version: root.version, lockfileVersion: 3, packages: { '': root, ...members } });
  const commit = repo.commit();
  await write(f.repo.directory, 'package.json', { agentui: extension('fixture', { extensions: ['one', 'two'].map(name => repo.reference(commit, `packages/${name}`)) }) });
  const built = await f.build();
  const selected = built.manifest.packages.slice(1);
  assert.equal(selected[0].npm.path, '');
  assert.equal(selected[0].npm.lockfile.sha256, selected[1].npm.lockfile.sha256);
  assert.notEqual(selected[0].npm.identity, selected[1].npm.identity);
  assert.match(await readFile(join(built.directory, 'entries.mjs'), 'utf8'), /@fixture\/child@1\.0\.0/u);
  const relocated = join(f.root, 'relocated');
  await cp(built.directory, relocated, { recursive: true });
  await rm(f.repo.directory, { recursive: true });
  await rm(repo.directory, { recursive: true });
  await rm(built.directory, { recursive: true });
  await qualifyServerCatalog({ directory: await realpath(relocated), manifest: built.manifest, abi: await serverCustomizationAbi() });
});

test('preserves canonical source errors through build and CLI boundaries', async t => {
  const f = await setup(t);
  await assert.rejects(f.build('bad-commit', 'bad'), error => {
    assert.ok(error instanceof CustomizationError);
    assert.equal(error.code, 'invalid-input');
    return true;
  });
  await clean(f);
  assert.throws(() => execFileSync(process.execPath, ['scripts/build-server-customization.mjs', '--repository', f.repo.directory,
    '--commit', 'bad-commit', '--out', join(f.root, 'bad')], { encoding: 'utf8', stdio: 'pipe' }),
  error => { assert.equal(error.stderr.trim(), 'Expected a full immutable Git commit ID.'); return true; });
  await clean(f);
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

test('first depth-first edge owns the compiled representative when breadth-first order differs', async t => {
  const f = await setup(t, validSource.replace('return {dispose(){}}', 'return {value:globalThis.childLoads,dispose(){}}'));
  const child = await f.repository('shared-child');
  await write(child.directory, 'package.json', { agentui: extension('shared-child') });
  await write(child.directory, 'index.ts', `globalThis.childLoads=(globalThis.childLoads??0)+1; ${validSource}`);
  const first = child.commit(), later = child.commit();
  const parent = await f.repository('parent');
  await write(parent.directory, 'package.json', { agentui: extension('parent', { extensions: [child.reference(first)] }) });
  await write(parent.directory, 'index.ts', validSource);
  await write(f.repo.directory, 'package.json', { agentui: extension('fixture', { extensions: [parent.reference(parent.commit()), child.reference(later)] }) });
  const rootCommit = f.repo.commit();
  const built = await f.build(rootCommit);
  const [root, intermediate, representative] = built.manifest.packages;
  assert.deepEqual(built.manifest.packages.map(pkg => pkg.local.manifest.namespace), ['fixture', 'parent', 'shared-child']);
  assert.equal(root.commit, rootCommit);
  assert.equal(representative.commit, first);
  assert.deepEqual(intermediate.extensions, [{ packageIdentity: representative.identity, commit: first }]);
  assert.deepEqual(root.extensions[1], { packageIdentity: representative.identity, commit: later });
  assert.equal(await valueFromCatalog(built), 1);
  const breadthFirst = resigned(built.manifest, value => { value.packages[2].commit = later; });
  assert.throws(() => parseServerCustomizationArtifact(breadthFirst), { code: 'invalid-artifact' });
});

test('serializes nested npm paths without prepared absolute directories', async t => {
  const f = await setup(t);
  const path = 'nested/owner';
  const nested = { directory: join(f.repo.directory, path) };
  const { pkg } = await locked(f, nested);
  pkg.agentui = extension('nested');
  await write(nested.directory, 'package.json', pkg);
  await write(nested.directory, 'index.ts', validSource);
  const { buildServerCustomization } = await import('../../../scripts/server-customization.mjs');
  const built = await buildServerCustomization({ reference: f.repo.reference(f.repo.commit(), path), out: join(f.root, 'nested-artifact') });
  const npm = built.manifest.packages[0].npm;
  assert.equal(npm.path, path);
  assert.equal(Object.hasOwn(npm, 'directory'), false);
  const absolute = resigned(built.manifest, value => { value.packages[0].npm.directory = nested.directory; });
  assert.throws(() => parseServerCustomizationArtifact(absolute), { code: 'invalid-artifact' });
  const changed = resigned(built.manifest, value => { value.packages[0].npm.path = ''; });
  assert.throws(() => parseServerCustomizationArtifact(changed), { code: 'invalid-artifact' });
});
