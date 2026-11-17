import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, tarball, write } from './preparation-support.mjs';

test('a locked package may contain an unexecuted global-detection fallback', { timeout: 30_000 }, async t => {
  const f = await fixture(t), repo = await f.repository('global-fallback');
  const dependency = await tarball(f, repo, 'value', '1.0.0', { type: 'commonjs' }, {
    'index.js': "var root = typeof self == 'object' && self || Function('return this')(); module.exports = root ? 'global ok' : 'missing global';",
  });
  const dependencies = { value: dependency.resolved };
  await write(repo.directory, 'package.json', {
    name: 'fixture', version: '1.0.0', type: 'module', packageManager: 'npm@11.19.1', dependencies,
    agentui: { extension: { namespace: 'global-fallback', trust: 'full', sdkVersion: '0.11.0',
      entries: [{ kind: 'desktop', module: './desktop.js' }] }, sources: { './desktop.js': './index.ts' } },
  });
  await write(repo.directory, 'package-lock.json', {
    name: 'fixture', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'fixture', version: '1.0.0', dependencies }, 'node_modules/value': dependency },
  });
  await write(repo.directory, 'index.ts', `import value from 'value';
    if(value !== 'global ok') throw new Error('Global detection failed');
    export default {kind:'desktop',sdkVersion:'0.11.0',activate(){return {modules:[],dispose(){}}}};`);
  const output = execFileSync(process.execPath, ['scripts/build-local-customization.mjs', '--repository', repo.directory,
    '--commit', repo.commit(), '--out', join(f.root, 'artifact')], { encoding: 'utf8', stdio: 'pipe' });
  assert.match(output, /"artifactId":"[a-f0-9]{64}"/u);
});
