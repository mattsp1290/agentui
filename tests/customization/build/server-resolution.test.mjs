import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { tarball } from './preparation-support.mjs';
import { clean, valueFromCatalog, setup, extension, validSource, write } from './server-support.mjs';

async function dependencies(f, definitions) {
  const dependencies = {}, packages = {};
  for (const [name, manifest, contents] of definitions) {
    const entry = await tarball(f, f.repo, name, '1.0.0', manifest, contents);
    dependencies[name] = entry.resolved;
    packages[`node_modules/${name}`] = entry;
  }
  const root = { name: 'fixture', version: '1.0.0', dependencies };
  await write(f.repo.directory, 'package.json', { ...root, type: 'module', packageManager: 'npm@11.19.1', agentui: extension('fixture') });
  await write(f.repo.directory, 'package-lock.json', { name: root.name, version: root.version, lockfileVersion: 3, packages: { '': root, ...packages } });
}

test('retains Node import, require, and main semantics after locked sources are disposed', async t => {
  const f = await setup(t);
  await dependencies(f, [
    ['dual', { exports: { import: './import.js', require: './require.cjs' } }, {
      'import.js': "export default 'import-branch';", 'require.cjs': "module.exports='require-branch';",
    }],
    ['legacy', { exports: undefined, main: './main.cjs', module: './module.js' }, {
      'main.cjs': "module.exports='main-branch';", 'module.js': "export default 'module-branch';",
    }],
  ]);
  await write(f.repo.directory, 'caller.cjs', "module.exports={required:require('dual'),cjsMain:require('legacy')};");
  await write(f.repo.directory, 'index.ts', `import imported from 'dual'; import esmMain from 'legacy'; import called from './caller.cjs';
    ${validSource.replace('return {dispose(){}}', 'return {value:{imported,esmMain,...called},dispose(){}}')}`);
  const built = await f.build();
  await rm(f.repo.directory, { recursive: true });
  assert.deepEqual(await valueFromCatalog(built), { imported: 'import-branch', esmMain: 'main-branch', required: 'require-branch', cjsMain: 'main-branch' });
});

test('rejects explicit runtime loaders with lazy locked lookups and preserves previous bytes', async t => {
  const f = await setup(t);
  await dependencies(f, [['value', {}, {}]]);
  await write(f.repo.directory, 'index.ts', `import value from 'value'; ${validSource.replace('return {dispose(){}}', 'return {value,dispose(){}}')}`);
  const good = await f.build();
  const before = await Promise.all(['entries.mjs', 'customization.json'].map(path => readFile(join(good.directory, path))));
  assert.equal(await valueFromCatalog(good), 'value@1.0.0');
  for (const specifier of ['module', 'node:module']) {
    for (const [form, binding, call] of [
      ['direct', `import {createRequire} from '${specifier}'; const require=createRequire(import.meta.url);`, 'require'],
      ['alias', `import {createRequire as makeLoader} from '${specifier}'; const load=makeLoader(import.meta.url);`, 'load'],
      ['namespace', `import * as loaderApi from '${specifier}'; const load=loaderApi.createRequire(import.meta.url);`, 'load'],
    ]) {
      await t.test(`${specifier} ${form}`, async () => {
        const output = `bad-${specifier.replace(':', '-')}-${form}`;
        await write(f.repo.directory, 'index.ts', `${binding} ${validSource.replace('return {dispose(){}}', `return {value:${call}('value'),dispose(){}}`)}`);
        await assert.rejects(f.build(undefined, output), { code: 'build-failed', message: 'Could not compile server customization sources.' });
        assert.deepEqual(await Promise.all(['entries.mjs', 'customization.json'].map(path => readFile(join(good.directory, path)))), before);
        await clean(f, output);
      });
    }
  }
});

for (const [entry, transitive] of [['mts', 'cts'], ['cts', 'mts']]) {
  test(`publishes typed .${entry} entries with transitive .${transitive} sources`, async t => {
    const f = await setup(t);
    await write(f.repo.directory, 'package.json', { type: 'module', agentui: extension('fixture', { sources: { './server.mjs': `./entry.${entry}` } }) });
    await write(f.repo.directory, `entry.${entry}`, `import {value} from './helper.${transitive}'; const typed: number=value;
      ${validSource.replace('return {dispose(){}}', 'return {value:typed,dispose(){}}')}`);
    await write(f.repo.directory, `helper.${transitive}`, 'export const value: number=42;');
    const built = await f.build();
    assert.equal(built.manifest.entries.length, 1);
    await rm(f.repo.directory, { recursive: true });
    assert.equal(await valueFromCatalog(built), 42);
  });
}

test('rejects unsupported Node before reserving dependency-free output', async t => {
  const f = await setup(t);
  const commit = f.repo.commit();
  const supported = await f.build(commit);
  assert.equal(supported.manifest.packages[0].npm.kind, 'absent');
  const builder = new URL('../../../scripts/server-customization.mjs', import.meta.url).href;
  for (const version of ['24.21.9', '24.22.2', '25.0.0', '26.2.0']) {
    const out = join(f.root, `unsupported-${version}`, 'artifact');
    const program = `import {buildServerCustomization} from ${JSON.stringify(builder)};
      Object.defineProperty(process.versions,'node',{value:${JSON.stringify(version)}});
      try { await buildServerCustomization(${JSON.stringify({ reference: f.repo.reference(commit), out })}); process.exit(1); }
      catch(error) { process.stdout.write(JSON.stringify({code:error.code,message:error.message})); }`;
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' }));
    assert.deepEqual(result, { code: 'toolchain-mismatch', message: 'Server customization requires Node >=24.22.3 <25.' });
    await clean(f, `unsupported-${version}`);
  }
});
