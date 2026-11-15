import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { assertSupportedNode, supportedNodeMinimum, supportedNodeRange } from '@agentui/host/customization';
import { classifyHostSpecifier, serverCustomizationAbi } from '../../../scripts/server-customization-abi.mjs';
import { serverCatalogLinkage } from '../../../scripts/server-catalog-loader.mjs';
import { locked, tarball } from './preparation-support.mjs';
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
    assert.deepEqual(result, { code: 'toolchain-mismatch', message: 'Customization requires Node >=24.22.3 <25.' });
    await clean(f, `unsupported-${version}`);
  }
});

test('builder and locked preparation share the supported Node boundary and diagnostic', async t => {
  const f = await setup(t);
  await locked(f, f.repo);
  const reference = f.repo.reference(f.repo.commit());
  const builder = new URL('../../../scripts/server-customization.mjs', import.meta.url).href;
  const preparation = new URL('../../../scripts/prepare-customization-sources.mjs', import.meta.url).href;
  assert.doesNotThrow(() => assertSupportedNode(supportedNodeMinimum.join('.')));
  assert.doesNotThrow(() => assertSupportedNode('24.23.0'));
  for (const version of ['23.99.0', '24.21.99', '24.22.2', '25.0.0']) {
    const program = `import {buildServerCustomization} from ${JSON.stringify(builder)};
      import {prepareCustomizationSources} from ${JSON.stringify(preparation)};
      Object.defineProperty(process.versions,'node',{value:${JSON.stringify(version)}});
      const errors=[];
      for(const run of [()=>buildServerCustomization(${JSON.stringify({ reference, out: join(f.root, 'bad') })}),
        ()=>prepareCustomizationSources(${JSON.stringify({ reference, scratchParent: f.scratchParent })})]) {
        try { const result=await run(); await result.dispose?.(); process.exit(1); }
        catch(error) { errors.push({code:error.code,message:error.message}); }
      }
      process.stdout.write(JSON.stringify(errors));`;
    const errors = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' }));
    assert.deepEqual(errors, Array(2).fill({ code: 'toolchain-mismatch', message: `Customization requires Node ${supportedNodeRange}.` }));
    await clean(f);
  }
});

test('preserves the ABI and committed artifact bytes after a caller changes working directory', async t => {
  const f = await setup(t);
  const reference = f.repo.reference(f.repo.commit());
  const abi = new URL('../../../scripts/server-customization-abi.mjs', import.meta.url).href;
  const builder = new URL('../../../scripts/server-customization.mjs', import.meta.url).href;
  const program = `import assert from 'node:assert/strict';
    import {readFile} from 'node:fs/promises';
    import {join} from 'node:path';
    import {serverCustomizationAbi} from ${JSON.stringify(abi)};
    import {buildServerCustomization} from ${JSON.stringify(builder)};
    const reference=${JSON.stringify(reference)};
    const beforeAbi=await serverCustomizationAbi();
    const before=await buildServerCustomization({reference,out:${JSON.stringify(join(f.root, 'before'))}});
    process.chdir(${JSON.stringify(f.root)});
    const afterAbi=await serverCustomizationAbi();
    const after=await buildServerCustomization({reference,out:${JSON.stringify(join(f.root, 'after'))}});
    assert.equal(afterAbi.identity,beforeAbi.identity);
    assert.equal(after.manifest.artifactId,before.manifest.artifactId);
    for(const path of ['customization.json',...before.manifest.assets.map(asset=>asset.path)]) {
      assert.deepEqual(await readFile(join(after.directory,path)),await readFile(join(before.directory,path)));
    }`;
  execFileSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', stdio: 'pipe' });
});


test('uses the same host specifier policy in real catalog hooks', async t => {
  const f = await setup(t, `import {basename} from 'node:path'; ${validSource.replace('return {dispose(){}}', "return {value:basename('/fixture/allowed'),dispose(){}}")}`);
  const built = await f.build();
  const abi = await serverCustomizationAbi();
  for (const [specifier, kind] of [['@agentui/sdk', 'sdk'], ['fs', 'builtin'], ['node:path', 'builtin'],
    ['module', 'forbidden'], ['node:module', 'forbidden'], ['@agentui/contracts', 'package'], ['node:unknown', 'package'], ['ordinary', 'package']]) {
    assert.equal(classifyHostSpecifier(abi.imports, specifier), kind);
  }
  await write(f.root, 'outside.mjs', 'throw new Error("must not execute");');
  const forbidden = ['module', 'node:module', pathToFileURL(join(f.root, 'outside.mjs')).href];
  const { catalog, ...linkage } = serverCatalogLinkage({ directory: built.directory, manifest: built.manifest, abi });
  const hook = new URL('../../../scripts/server-catalog-loader.mjs', import.meta.url).href;
  const program = `import assert from 'node:assert/strict';
    import {registerServerCatalogHooks} from ${JSON.stringify(hook)};
    registerServerCatalogHooks(${JSON.stringify(linkage)});
    const {entries}=await import(${JSON.stringify(catalog)});
    assert.equal(entries[0].activate().value,'allowed');
    for (const specifier of ${JSON.stringify(forbidden)}) {
      await assert.rejects(import(specifier), {code:'ERR_UNSUPPORTED_CATALOG_IMPORT',message:'Unsupported catalog import'});
    }`;
  execFileSync(process.execPath, ['--input-type=module', '-e', program], { cwd: built.directory, encoding: 'utf8', stdio: 'pipe' });
});
