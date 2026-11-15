import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, cp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { readServerCustomizationArtifact } from '@agentui/host/customization';
import { qualifyServerCatalog, serverCustomizationAbi } from '../../../scripts/server-customization-abi.mjs';
import { locked, tarball } from './preparation-support.mjs';
import { setup, extension, expectation, validSource, write } from './server-support.mjs';

async function clean(f, absent = 'bad') {
  await assert.rejects(access(join(f.root, absent)));
  assert.deepEqual((await readdir(f.root)).filter(name => name.startsWith('.agentui-server-')), []);
}

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
  const abi = await serverCustomizationAbi();
  const program = `import {registerHooks} from 'node:module'; registerHooks({resolve(s,c,n){return s==='@agentui/sdk'?{url:${JSON.stringify(abi.imports['@agentui/sdk'])},shortCircuit:true}:n(s,c)}}); const {entries}=await import(${JSON.stringify(pathToFileURL(join(built.directory, 'entries.mjs')).href)}); process.stdout.write(entries[0].activate().value);`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' }), 'value@1.0.0');
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
  assert.equal(result.manifest.packages[0].extensions[0], result.manifest.packages[0].extensions[2]);
  assert.deepEqual(result.manifest.entries.map(entry => entry.index), [0, 1, 2, 3]);
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
    await assert.rejects(f.build(undefined, 'bad'), error => { assert.equal(error.code, code); assert.ok(!error.message.includes('SOURCE_SECRET')); return true; });
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
  await assert.rejects(f.build(undefined, 'bad'), { code: 'install-failed' });
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
  await assert.rejects(f.build(undefined, 'bad'));
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
  assert.equal(selected[0].npm.directory, '');
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
