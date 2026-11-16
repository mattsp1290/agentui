import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { readArtifactBytes } from '../../../apps/host/build/tsc/artifact.js';
import { fixture, locked, tarball, write } from './preparation-support.mjs';

const extension = { extension: { namespace: 'workspace', trust: 'full', sdkVersion: '0.2.0', entries: [{ kind: 'desktop', module: './desktop.js' }] }, sources: { './desktop.js': './index.tsx' } };
const source = `import value from 'sibling'; import {useState} from 'react';
function Component(){const [text] = useState(value); return <p>{text}</p>}
export default {kind:'desktop',sdkVersion:'0.2.0',activate(){return {modules:[{id:'a',label:'A',component:Component}],dispose(){}}}};`;
const build = (repo, commit, out, subdirectory) => execFileSync(process.execPath, ['scripts/build-local-customization.mjs', '--repository', repo.directory, '--commit', commit, '--out', out, ...(subdirectory ? ['--subdirectory', subdirectory] : [])], { encoding: 'utf8', stdio: 'pipe' });

test('a linked workspace and locked dependency compile into the desktop app', { timeout: 60_000 }, async t => {
  const f = await fixture(t), repo = await f.repository('workspace');
  const root = { name: 'workspace-root', version: '1.0.0', private: true, packageManager: 'npm@11.19.1', workspaces: ['packages/*'] };
  const app = { name: 'custom', version: '1.0.0', type: 'module', dependencies: { sibling: '*' }, agentui: extension };
  const sibling = { name: 'sibling', version: '1.0.0', type: 'module', exports: './index.js' };
  await write(repo.directory, 'package.json', root);
  await write(repo.directory, 'packages/custom/package.json', app);
  await write(repo.directory, 'packages/custom/index.tsx', source);
  await write(repo.directory, 'packages/sibling/package.json', sibling);
  await write(repo.directory, 'packages/sibling/index.js', "export default 'linked workspace value';");
  await write(repo.directory, 'package-lock.json', { name: root.name, version: root.version, lockfileVersion: 3, packages: {
    '': root, 'packages/custom': { name: app.name, version: app.version, dependencies: app.dependencies },
    'packages/sibling': { name: sibling.name, version: sibling.version },
    'node_modules/custom': { resolved: 'packages/custom', link: true }, 'node_modules/sibling': { resolved: 'packages/sibling', link: true },
  } });
  build(repo, repo.commit(), join(f.root, 'output'), 'packages/custom');
  const artifact = readArtifactBytes(join(f.root, 'output'), 'browser-development');
  assert.match([...artifact.files.values()].map(bytes => bytes.toString()).join('\n'), /linked workspace value/);
  assert.equal(JSON.parse(artifact.files.get('customization-identity.json')).packages[0].npm.kind, 'locked');
});

test('a locked package is compiled from its verified installation', { timeout: 60_000 }, async t => {
  const f = await fixture(t), repo = await f.repository('locked');
  const { pkg } = await locked(f, repo);
  pkg.agentui = extension;
  await write(repo.directory, 'package.json', pkg);
  await write(repo.directory, 'index.tsx', source.replace("from 'sibling'", "from 'value'"));
  build(repo, repo.commit(), join(f.root, 'output'));
  const artifact = readArtifactBytes(join(f.root, 'output'), 'browser-development');
  assert.match([...artifact.files.values()].map(bytes => bytes.toString()).join('\n'), /value@1\.0\.0/);
  assert.equal(await readFile(join(repo.directory, 'index.tsx'), 'utf8'), source.replace("from 'sibling'", "from 'value'"));
});


for (const actualName of ['react', '@agentui/unlisted']) for (const scoped of [false, true]) test(`a package alias cannot bring ${actualName} into the graph${scoped ? ' through a nameless scope manifest' : ''}`, { timeout: 60_000 }, async t => {
  const f = await fixture(t), repo = await f.repository('alias');
  const alias = await tarball(f, repo, 'my-react', '1.0.0', { name: actualName, exports: scoped ? './dist/index.js' : './index.js' },
    scoped ? { 'dist/package.json': '{"type":"module"}', 'dist/index.js': "export default 'aliased';" } : {});
  const pkg = { name: 'fixture', version: '1.0.0', type: 'module', packageManager: 'npm@11.19.1', dependencies: { 'my-react': alias.resolved }, agentui: extension };
  await write(repo.directory, 'package.json', pkg);
  await write(repo.directory, 'package-lock.json', { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: {
    '': { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies },
    'node_modules/my-react': { ...alias, name: actualName },
  } });
  await write(repo.directory, 'index.tsx', source.replace("from 'sibling'", "from 'my-react'"));
  assert.throws(() => build(repo, repo.commit(), join(f.root, 'output')), /Duplicate shared customization dependency/);
});
