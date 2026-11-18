import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { readArtifactBytes } from '../../../apps/host/build/tsc/artifact.js';
import { fixture, tarball, write } from './preparation-support.mjs';

test('locked CommonJS dependencies bundle static nested require calls', { timeout: 30_000 }, async t => {
  const f = await fixture(t), repo = await f.repository('commonjs');
  const dependency = await tarball(f, repo, 'value', '1.0.0', { type: 'commonjs' }, {
    'index.js': "module.exports = { value: require('./nested.cjs'), dual: require('dual'), state: require('react').useState, sdk: require('@agentui/sdk').checkExtensionEntrypoint, create: require('@agentui/sdk/tools').createFrontendToolGeneration };",
    'nested.cjs': "function value() { return new.target; } module.exports = 'committed CommonJS value';",
  });
  const dual = await tarball(f, repo, 'dual', '1.0.0', { exports: { import: './esm.js', require: './cjs.cjs' } }, {
    'esm.js': "export default 'import branch';",
    'cjs.cjs': "module.exports = 'require branch';",
  });
  const dependencies = { value: dependency.resolved, dual: dual.resolved };
  await write(repo.directory, 'package.json', {
    name: 'fixture', version: '1.0.0', type: 'module', packageManager: 'npm@11.19.1', dependencies,
    agentui: { extension: { namespace: 'commonjs', trust: 'full', sdkVersion: '0.13.0',
      entries: [{ kind: 'desktop', module: './desktop.js' }] }, sources: { './desktop.js': './index.ts' } },
  });
  await write(repo.directory, 'package-lock.json', {
    name: 'fixture', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'fixture', version: '1.0.0', dependencies }, 'node_modules/value': dependency, 'node_modules/dual': dual },
  });
  await write(repo.directory, 'index.ts', `import value from 'value'; import dual from 'dual';
    import {useState} from 'react'; import {checkExtensionEntrypoint} from '@agentui/sdk';
    import {createFrontendToolGeneration} from '@agentui/sdk/tools';
    if(value.value !== 'committed CommonJS value' || value.dual !== 'require branch' || dual !== 'import branch' || value.state !== useState || value.sdk !== checkExtensionEntrypoint || value.create !== createFrontendToolGeneration || !import.meta.url) throw new Error('Incorrect CommonJS value');
    export default {kind:'desktop',sdkVersion:'0.13.0',activate(){return {modules:[],value,dispose(){}}}};`);
  const out = join(f.root, 'artifact');
  execFileSync(process.execPath, ['scripts/build-local-customization.mjs', '--repository', repo.directory,
    '--commit', repo.commit(), '--out', out], { encoding: 'utf8', stdio: 'pipe' });
  const { files } = readArtifactBytes(out, 'browser-development');
  assert.match([...files.values()].map(bytes => bytes.toString()).join('\n'), /committed CommonJS value/u);
});

for (const [name, body] of [
  ['computed', 'require(globalThis.moduleName)'],
  ['extra argument', "require('./nested.cjs', sideEffect())"],
  ['constructor', "new require('./nested.cjs')"],
  ['optional', "require?.('./nested.cjs')"],
  ['built-in', "require('node:fs')"],
  ['missing package', "require('unavailable-package')"],
  ['absolute path', "require('/etc/passwd')"],
  ['outside path', "require('../../../../outside.js')"],
]) test(`CommonJS dependency rejects ${name} loading`, { timeout: 30_000 }, async t => {
  const f = await fixture(t), repo = await f.repository('commonjs');
  const dependency = await tarball(f, repo, 'value', '1.0.0', { type: 'commonjs' }, { 'index.js': `module.exports = ${body};` });
  const dependencies = { value: dependency.resolved };
  await write(repo.directory, 'package.json', { name: 'fixture', version: '1.0.0', type: 'module', packageManager: 'npm@11.19.1', dependencies,
    agentui: { extension: { namespace: 'commonjs', trust: 'full', sdkVersion: '0.13.0', entries: [{ kind: 'desktop', module: './desktop.js' }] }, sources: { './desktop.js': './index.ts' } } });
  await write(repo.directory, 'package-lock.json', { name: 'fixture', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'fixture', version: '1.0.0', dependencies }, 'node_modules/value': dependency } });
  await write(repo.directory, 'index.ts', "import value from 'value'; export default {kind:'desktop',sdkVersion:'0.13.0',activate(){return {modules:[],value,dispose(){}}}};");
  const out = join(f.root, 'artifact');
  assert.throws(() => execFileSync(process.execPath, ['scripts/build-local-customization.mjs', '--repository', repo.directory,
    '--commit', repo.commit(), '--out', out], { encoding: 'utf8', stdio: 'pipe' }), /Unsupported|contained customization source/);
  assert.equal(existsSync(out), false);
  assert.deepEqual(readdirSync(f.root).filter(name => name.startsWith('.agentui-build-')), []);
});
