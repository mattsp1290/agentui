import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { resolveCustomizationSources } from '@agentui/host/customization';
import { prepareCustomizationSources } from '../../../scripts/prepare-customization-sources.mjs';
import { execute, files, fixture, locked, tarball, write } from './preparation-support.mjs';

const imported = async node => (await import(pathToFileURL(join(node.directory, 'index.mjs')).href)).default;
const absent = async path => assert.rejects(access(path), { code: 'ENOENT' });

test('preparation owns committed copies, preserves graph provenance and executable modes, and disposes independently', async t => {
  const f = await fixture(t);
  const repo = await f.repository('plain');
  await write(repo.directory, 'package.json', { agentui: { shared: './index.mjs' } });
  await write(repo.directory, 'index.mjs', 'export default 42;\n', true);
  const reference = repo.reference(repo.commit());
  await write(repo.directory, 'index.mjs', 'dirty');
  await write(repo.directory, 'untracked', 'dirty');
  await write(f.scratchParent, 'sentinel', 'keep');
  const resolved = await resolveCustomizationSources({ reference, scratchParent: f.scratchParent });
  const [one, two] = await Promise.all([f.prepare(reference), f.prepare(reference)]);
  t.after(() => Promise.all([resolved.dispose(), one.dispose(), two.dispose()]));
  assert.deepEqual(Object.keys(one).sort(), ['dispose', 'root']);
  assert.equal(one.root.identity, resolved.root.identity);
  assert.deepEqual(one.root.inputs, resolved.root.inputs);
  assert.deepEqual(one.root.customization, resolved.root.customization);
  assert.notEqual(one.root.directory, two.root.directory);
  assert.equal(await imported(one.root), 42);
  assert.equal((await stat(join(one.root.directory, 'index.mjs'))).mode & 0o777, 0o700);
  await absent(join(one.root.directory, 'untracked'));
  await one.dispose();
  await one.dispose();
  await absent(one.root.directory);
  assert.equal(await readFile(join(two.root.directory, 'index.mjs'), 'utf8'), 'export default 42;\n');
  assert.equal(await readFile(join(repo.directory, 'index.mjs'), 'utf8'), 'dirty');
  assert.equal(await readFile(join(f.scratchParent, 'sentinel'), 'utf8'), 'keep');
});

test('real npm installs all dependency groups, ignores ambient configuration and scripts, and restores committed npmrc bytes and modes', async t => {
  const f = await fixture(t);
  const repo = await f.repository('locked');
  const { pkg, lock } = await locked(f, repo);
  const configs = [['.npmrc', 'registry=http://127.0.0.1:1\nomit=dev\nignore-scripts=false\nforce=true\n', true],
    ['nested/.npmrc', 'userconfig=/unavailable/private/token\n', false]];
  for (const [path, bytes, executable] of configs) await write(repo.directory, path, bytes, executable);
  const reference = repo.reference(repo.commit());
  const original = new Map(await Promise.all((await files(repo.directory)).filter(path => !path.includes('/.git/')).map(async path => [path, await readFile(path)])));
  await write(repo.directory, 'package.json', { ...pkg, dependencies: { nonexistent: '*' } });
  await write(repo.directory, 'package-lock.json', 'dirty lock');
  await write(repo.directory, 'index.mjs', 'dirty source');
  await write(repo.directory, 'node_modules/value/index.js', 'dirty installation');
  const dirtyInputs = await Promise.all((await files(repo.directory)).filter(path => !path.includes('/.git/')).map(async path =>
    ({ path, bytes: await readFile(path), mode: (await stat(path)).mode })));
  const poison = { HOME: join(f.root, 'poison'), NODE_ENV: 'production', NODE_OPTIONS: '--invalid-preparation-option', NODE_PATH: '/unavailable/private/modules',
    NPM_CONFIG_USERCONFIG: join(f.root, 'poison/.npmrc'), npm_config_globalconfig: '/unavailable/private/global', NPM_CONFIG_OMIT: 'dev optional peer',
    NPM_CONFIG_REGISTRY: 'http://127.0.0.1:1', npm_config_ignore_scripts: 'false', HTTPS_PROXY: 'http://private:secret@127.0.0.1:1', npm_config_prefix: '/unavailable/private/prefix' };
  await write(f.root, 'poison/.npmrc', 'registry=http://127.0.0.1:1\nforce=true\n');
  const saved = Object.fromEntries(Object.keys(poison).map(key => [key, process.env[key]]));
  let prepared;
  try {
    Object.assign(process.env, poison);
    prepared = await f.prepare(reference);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  t.after(() => prepared.dispose());
  assert.deepEqual(await imported(prepared.root), ['value@1.0.0', 'development@1.0.0', 'optional@1.0.0', 'peer@1.0.0']);
  assert.equal(prepared.root.npm.kind, 'locked');
  assert.equal(prepared.root.npm.directory, prepared.root.directory);
  assert.equal(await readFile(join(prepared.root.directory, 'package-lock.json'), 'utf8'), JSON.stringify(lock));
  for (const file of prepared.root.inputs.files) {
    const bytes = await readFile(join(prepared.root.directory, file.path));
    assert.deepEqual(bytes, original.get(join(repo.directory, file.path)));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    assert.equal(Boolean((await stat(join(prepared.root.directory, file.path))).mode & 0o111), file.executable);
  }
  const preparedFiles = await files(prepared.root.directory);
  assert.equal(preparedFiles.some(path => /(?:root|dependency)-script-ran/u.test(path)), false);
  assert.equal(await readFile(join(repo.directory, 'package-lock.json'), 'utf8'), 'dirty lock');
  assert.equal(await readFile(join(repo.directory, 'node_modules/value/index.js'), 'utf8'), 'dirty installation');
  assert.equal(await readFile(join(f.root, 'poison/.npmrc'), 'utf8'), 'registry=http://127.0.0.1:1\nforce=true\n');
  for (const file of dirtyInputs) {
    assert.deepEqual(await readFile(file.path), file.bytes);
    assert.equal((await stat(file.path)).mode, file.mode);
  }
});

for (const name of ['.NPMRC', '.NpMrC']) {
  test(`real npm ignores and restores committed ${name} configuration`, async t => {
    const f = await fixture(t);
    const repo = await f.repository('config-alias');
    await locked(f, repo);
    const bytes = 'dry-run=true\n';
    const executable = name === '.NPMRC';
    await write(repo.directory, name, bytes, executable);
    const reference = repo.reference(repo.commit());
    t.diagnostic(`case-insensitive configuration lookup: ${await access(join(repo.directory, '.npmrc')).then(() => true, () => false)}`);
    const prepared = await f.prepare(reference);
    t.after(() => prepared.dispose());
    assert.deepEqual(await imported(prepared.root), ['value@1.0.0', 'development@1.0.0', 'optional@1.0.0', 'peer@1.0.0']);
    assert.equal((await readdir(prepared.root.directory)).includes(name), true);
    assert.equal(await readFile(join(prepared.root.directory, name), 'utf8'), bytes);
    assert.equal((await stat(join(prepared.root.directory, name))).mode & 0o777, executable ? 0o700 : 0o600);
    assert.equal(await readFile(join(repo.directory, name), 'utf8'), bytes);
  });
}

for (const name of ['npm-shrinkwrap.json', 'NPM-SHRINKWRAP.JSON', 'NpM-ShRiNkWrAp.JsOn']) {
  test(`conflicting committed ${name} is rejected before preparation can override the validated lock`, async t => {
    const f = await fixture(t);
    const repo = await f.repository('alternative-lock');
    const { pkg, lock } = await locked(f, repo);
    pkg.dependencies.value = '*';
    lock.packages[''].dependencies.value = '*';
    await write(repo.directory, 'package.json', pkg);
    await write(repo.directory, 'package-lock.json', lock);
    const alternative = structuredClone(lock);
    alternative.packages['node_modules/value'] = await tarball(f, repo, 'value', '2.0.0');
    await write(repo.directory, name, alternative);
    t.diagnostic(`case-insensitive shrinkwrap lookup: ${await access(join(repo.directory, 'npm-shrinkwrap.json')).then(() => true, () => false)}`);
    await assert.rejects(f.prepare(repo.reference(repo.commit())), { code: 'invalid-package' });
    assert.deepEqual(await readdir(f.scratchParent), []);
    assert.equal(await readFile(join(repo.directory, 'package-lock.json'), 'utf8'), JSON.stringify(lock));
    assert.equal(await readFile(join(repo.directory, name), 'utf8'), JSON.stringify(alternative));
  });
}

for (const inBundle of [true, undefined]) {
  test(`bundled tarball cannot replace a separately pinned child with inBundle ${inBundle === undefined ? 'omitted' : 'true'}`, async t => {
    const f = await fixture(t);
    const repo = await f.repository('bundled-tarball');
    const { lock } = await locked(f, repo);
    const parent = join(f.root, 'tar-value-1.0.0');
    await write(parent, 'package/package.json', { name: 'value', version: '1.0.0', dependencies: { child: '*' }, bundleDependencies: ['child'] });
    await write(parent, 'package/node_modules/child/package.json', { name: 'child', version: '2.0.0' });
    lock.packages['node_modules/value'].dependencies = { child: '*' };
    lock.packages['node_modules/value'].bundleDependencies = ['child'];
    lock.packages['node_modules/value/node_modules/child'] = { ...await tarball(f, repo, 'child', '1.0.0'), ...(inBundle === undefined ? {} : { inBundle }) };
    const archive = join(repo.directory, 'vendor/value-1.0.0.tgz');
    execute('tar', ['-czf', archive, '-C', parent, 'package'], f.root);
    lock.packages['node_modules/value'].integrity = 'sha512-' + createHash('sha512').update(await readFile(archive)).digest('base64');
    await write(repo.directory, 'package-lock.json', lock);
    await assert.rejects(f.prepare(repo.reference(repo.commit())).then(async prepared => {
      t.after(() => prepared.dispose());
      const installed = JSON.parse(await readFile(join(prepared.root.directory, 'node_modules/value/node_modules/child/package.json'), 'utf8'));
      t.diagnostic(`lock pins child 1.0.0; npm installed child ${installed.version}`);
      return prepared;
    }), { code: 'invalid-package', message: 'Bundled npm dependencies are unsupported.' });
    assert.deepEqual(await readdir(f.scratchParent), []);
    assert.equal(await readFile(join(repo.directory, 'package-lock.json'), 'utf8'), JSON.stringify(lock));
  });
}

for (const mode of ['unmarked-bundle', 'unexpected-child', 'version', 'optional-version', 'explicit-name', 'missing-manifest', 'malformed-manifest']) {
  test(`installed output rejects ${mode} against the qualified lock and cleans up`, async t => {
    const f = await fixture(t);
    const repo = await f.repository('installed-output');
    const { lock } = await locked(f, repo);
    const name = mode === 'optional-version' ? 'optional' : 'value';
    let manifest = {};
    const contents = {};
    if (mode === 'unmarked-bundle' || mode === 'unexpected-child') {
      contents['node_modules/child/package.json'] = { name: 'child', version: '2.0.0' };
      if (mode === 'unmarked-bundle') {
        manifest = { dependencies: { child: '*' }, bundleDependencies: ['child'] };
        lock.packages['node_modules/value'].dependencies = { child: '*' };
        lock.packages['node_modules/value/node_modules/child'] = await tarball(f, repo, 'child', '1.0.0');
      }
    } else if (mode.endsWith('version')) manifest.version = '2.0.0';
    else if (mode === 'explicit-name') lock.packages['node_modules/value'].name = 'locked-name';
    else if (mode === 'malformed-manifest') contents['package.json'] = '{';
    const archive = await tarball(f, repo, name, '1.0.0', manifest, contents);
    if (mode === 'missing-manifest') {
      execute('tar', ['-czf', join(repo.directory, 'vendor/value-1.0.0.tgz'), '-C', join(f.root, 'tar-value-1.0.0'), 'package/index.js'], f.root);
      archive.integrity = 'sha512-' + createHash('sha512').update(await readFile(join(repo.directory, 'vendor/value-1.0.0.tgz'))).digest('base64');
    }
    Object.assign(lock.packages[`node_modules/${name}`], archive);
    await write(repo.directory, 'package-lock.json', lock);
    await assert.rejects(f.prepare(repo.reference(repo.commit())).then(async prepared => {
      t.after(() => prepared.dispose());
      const location = mode === 'unmarked-bundle' || mode === 'unexpected-child' ? 'value/node_modules/child' : name;
      t.diagnostic(await readFile(join(prepared.root.directory, 'node_modules', location, 'package.json'), 'utf8').catch(error => error.code));
      return prepared;
    }), { code: 'install-failed', message: 'Could not install committed customization dependencies.' });
    assert.deepEqual(await readdir(f.scratchParent), []);
    assert.equal(await readFile(join(repo.directory, 'package-lock.json'), 'utf8'), JSON.stringify(lock));
  });
}

test('real npm permits omitted incompatible-platform optional packages', async t => {
  const f = await fixture(t);
  const repo = await f.repository('optional-platform');
  const { lock } = await locked(f, repo);
  const os = [process.platform === 'darwin' ? 'linux' : 'darwin'];
  Object.assign(lock.packages['node_modules/optional'], await tarball(f, repo, 'optional', '1.0.0', { os }), { os });
  await write(repo.directory, 'package-lock.json', lock);
  const prepared = await f.prepare(repo.reference(repo.commit()));
  t.after(() => prepared.dispose());
  await absent(join(prepared.root.directory, 'node_modules/optional'));
  assert.equal(JSON.parse(await readFile(join(prepared.root.directory, 'node_modules/value/package.json'), 'utf8')).version, '1.0.0');
});

for (const hasShrinkwrap of [undefined, false]) {
  test(`inert embedded shrinkwrap is supported with hasShrinkwrap ${hasShrinkwrap}`, async t => {
    const f = await fixture(t);
    const repo = await f.repository('inert-shrinkwrap');
    const { lock } = await locked(f, repo);
    Object.assign(lock.packages['node_modules/value'], await tarball(f, repo, 'value', '1.0.0', {}, {
      'npm-shrinkwrap.json': { lockfileVersion: 3, packages: { '': { dependencies: { injected: 'file:/missing.tgz' } } } },
    }), hasShrinkwrap === undefined ? {} : { hasShrinkwrap });
    await write(repo.directory, 'package-lock.json', lock);
    const prepared = await f.prepare(repo.reference(repo.commit()));
    t.after(() => prepared.dispose());
    await access(join(prepared.root.directory, 'node_modules/value/npm-shrinkwrap.json'));
    assert.deepEqual(await imported(prepared.root), ['value@1.0.0', 'development@1.0.0', 'optional@1.0.0', 'peer@1.0.0']);
  });
}

test('real npm stays within its selected owner beneath a caller workspace and a spaced scratch path', async t => {
  const f = await fixture(t);
  const repo = await f.repository('ancestor-workspace');
  await locked(f, repo);
  const caller = join(f.root, 'caller workspace');
  const scratchParent = join(caller, 'scratch with spaces');
  const manifest = '{\n  "name": "caller", "private": true, "workspaces": ["**"]\n}\n';
  const config = 'dry-run=true\n';
  await write(caller, 'package.json', manifest);
  await write(caller, '.npmrc', config);
  const prepared = await prepareCustomizationSources({ reference: repo.reference(repo.commit()), scratchParent });
  t.after(() => prepared.dispose());
  assert.deepEqual(await imported(prepared.root), ['value@1.0.0', 'development@1.0.0', 'optional@1.0.0', 'peer@1.0.0']);
  assert.equal(await readFile(join(caller, 'package.json'), 'utf8'), manifest);
  assert.equal(await readFile(join(caller, '.npmrc'), 'utf8'), config);
  await absent(join(caller, 'package-lock.json'));
  await absent(join(caller, 'node_modules'));
  await prepared.dispose();
  assert.deepEqual(await readdir(scratchParent), []);
});

test('external and repeated references preserve shared nodes and conflicting installed versions', async t => {
  const f = await fixture(t);
  const child = await f.repository('child');
  await locked(f, child, '2.0.0');
  const childReference = child.reference(child.commit());
  const root = await f.repository('root');
  const { pkg } = await locked(f, root);
  await write(root.directory, 'package.json', { ...pkg, agentui: { ...pkg.agentui, extensions: [childReference, childReference] } });
  const reference = root.reference(root.commit());
  const resolved = await resolveCustomizationSources({ reference, scratchParent: f.scratchParent });
  const prepared = await f.prepare(reference);
  t.after(() => Promise.all([prepared.dispose(), resolved.dispose()]));
  const [one, two] = prepared.root.extensions;
  assert.equal(one, two);
  assert.notEqual(one.npm.directory, prepared.root.npm.directory);
  assert.equal(prepared.root.identity, resolved.root.identity);
  assert.equal(prepared.root.npm.identity, resolved.root.npm.identity);
  assert.equal(one.npm.identity, resolved.root.extensions[0].npm.identity);
  assert.deepEqual(await imported(prepared.root), ['value@1.0.0', 'development@1.0.0', 'optional@1.0.0', 'peer@1.0.0']);
  assert.deepEqual(await imported(one), ['value@2.0.0', 'development@2.0.0', 'optional@2.0.0', 'peer@2.0.0']);
});

test('real npm prepares distinct owners in one acquisition with repeated selections and a shared diamond', async t => {
  const f = await fixture(t);
  const leaf = await f.repository('shared-leaf');
  await write(leaf.directory, 'package.json', { agentui: { shared: './index.mjs' } });
  await write(leaf.directory, 'index.mjs', 'export default 73;\n');
  const leafReference = leaf.reference(leaf.commit());
  const repo = await f.repository('standalone-owners');
  for (const [name, version] of [['left', '1.0.0'], ['right', '2.0.0']]) {
    const directory = join(repo.directory, name);
    const { pkg } = await locked(f, { directory }, version);
    await write(directory, 'package.json', { ...pkg, agentui: { ...pkg.agentui, extensions: [leafReference] } });
  }
  const commit = repo.commit();
  const references = ['left', 'right', 'left'].map(name => repo.reference(commit, name));
  const aggregate = await f.repository('aggregate');
  await write(aggregate.directory, 'package.json', { agentui: { extensions: references } });
  const prepared = await f.prepare(aggregate.reference(aggregate.commit()));
  t.after(() => prepared.dispose());
  const [left, right, repeated] = prepared.root.extensions;
  assert.equal(left, repeated);
  assert.equal(left.extensions[0], right.extensions[0]);
  assert.equal(left.repositoryDirectory, right.repositoryDirectory);
  assert.notEqual(left.repositoryDirectory, repo.directory);
  assert.equal(left.directory, join(left.repositoryDirectory, 'left'));
  assert.equal(right.directory, join(left.repositoryDirectory, 'right'));
  assert.notEqual(left.npm.identity, right.npm.identity);
  assert.equal(left.npm.directory, left.directory);
  assert.equal(right.npm.directory, right.directory);
  assert.notEqual(left.npm.directory, right.npm.directory);
  assert.deepEqual(await imported(left), ['value@1.0.0', 'development@1.0.0', 'optional@1.0.0', 'peer@1.0.0']);
  assert.deepEqual(await imported(right), ['value@2.0.0', 'development@2.0.0', 'optional@2.0.0', 'peer@2.0.0']);
  assert.equal(await imported(left.extensions[0]), 73);
  const paths = await files(f.scratchParent);
  const logs = await Promise.all(paths.filter(path => path.endsWith('debug-0.log')).map(path => readFile(path, 'utf8')));
  assert.equal(logs.filter(log => /verbose title npm ci\b/u.test(log)).length, 2);
  await prepared.dispose();
  await Promise.all([prepared.root.directory, left.repositoryDirectory, left.directory, right.directory, left.extensions[0].directory].map(absent));
  assert.deepEqual(await readdir(f.scratchParent), []);
});

test('real npm preserves scoped nested packages and explicit alias identities', async t => {
  const f = await fixture(t);
  const repo = await f.repository('scoped-nested-alias');
  const { pkg, lock } = await locked(f, repo);
  const child = await tarball(f, repo, '@fixture/child', '1.0.0', { bin: { 'fixture-child': './index.js' } });
  child.bin = { 'fixture-child': './index.js' };
  const alias = await tarball(f, repo, 'upstream', '1.0.0');
  pkg.dependencies.alias = alias.resolved;
  lock.packages[''].dependencies.alias = alias.resolved;
  lock.packages['node_modules/alias'] = { ...alias, name: 'upstream' };
  Object.assign(lock.packages['node_modules/value'], await tarball(f, repo, 'value', '1.0.0', { dependencies: { '@fixture/child': '*' } }),
    { dependencies: { '@fixture/child': '*' } });
  lock.packages['node_modules/value/node_modules/@fixture/child'] = child;
  await write(repo.directory, 'package.json', pkg);
  await write(repo.directory, 'package-lock.json', lock);
  const prepared = await f.prepare(repo.reference(repo.commit()));
  t.after(() => prepared.dispose());
  assert.equal(JSON.parse(await readFile(join(prepared.root.directory, 'node_modules/alias/package.json'), 'utf8')).name, 'upstream');
  assert.equal(JSON.parse(await readFile(join(prepared.root.directory, 'node_modules/value/node_modules/@fixture/child/package.json'), 'utf8')).version, '1.0.0');
  await access(join(prepared.root.directory, 'node_modules/value/node_modules/.bin/fixture-child'));
});

test('workspace packages share one npm owner, preserve versionless links and nested scopes, and stay separate', async t => {
  const f = await fixture(t);
  const repo = await f.repository('workspace');
  const script = "node -e \"require('fs').writeFileSync('workspace-script-ran', 'unsafe')\"";
  const root = { name: 'workspace-root', version: '1.0.0', private: true, packageManager: 'npm@11.19.1', workspaces: ['packages/*'] };
  const members = {};
  const child = await tarball(f, repo, '@fixture/child', '1.0.0');
  for (const name of ['one', 'two', 'sibling']) {
    const pkg = { name, type: 'module', exports: './index.mjs', scripts: { install: script },
      ...(name === 'sibling' ? { dependencies: { '@fixture/child': 'file:../../vendor/@fixture/child-1.0.0.tgz' } } :
        { version: '1.0.0', dependencies: { sibling: '*' }, agentui: { shared: './index.mjs' } }) };
    await write(repo.directory, `packages/${name}/package.json`, pkg);
    await write(repo.directory, `packages/${name}/index.mjs`, name === 'sibling' ? 'export default 73;\n' : "import value from 'sibling'; export default value;\n");
    const { type: _type, exports: _exports, scripts: _scripts, agentui: _agentui, ...entry } = pkg;
    members[`packages/${name}`] = entry;
    members[`node_modules/${name}`] = { resolved: `packages/${name}`, link: true };
  }
  members['packages/sibling/node_modules/@fixture/child'] = child;
  await write(repo.directory, 'package.json', root);
  await write(repo.directory, 'package-lock.json', { name: root.name, version: root.version, lockfileVersion: 3, packages: { '': root, ...members } });
  const memberCommit = repo.commit();
  const aggregate = await f.repository('aggregate');
  await write(aggregate.directory, 'package.json', { agentui: { extensions: [repo.reference(memberCommit, 'packages/one'), repo.reference(memberCommit, 'packages/two')] } });
  const reference = aggregate.reference(aggregate.commit());
  const [one, two] = await Promise.all([f.prepare(reference), f.prepare(reference)]);
  t.after(() => Promise.all([one.dispose(), two.dispose()]));
  const [a, b] = one.root.extensions;
  assert.equal(a.npm.directory, b.npm.directory);
  assert.notEqual(a.npm.identity, b.npm.identity);
  assert.notEqual(a.directory, b.directory);
  assert.notEqual(a.npm.directory, two.root.extensions[0].npm.directory);
  assert.equal(await imported(a), 73);
  assert.equal(await imported(b), 73);
  assert.equal(JSON.parse(await readFile(join(a.npm.directory, 'node_modules/sibling/package.json'), 'utf8')).version, undefined);
  assert.equal(JSON.parse(await readFile(join(a.npm.directory, 'packages/sibling/node_modules/@fixture/child/package.json'), 'utf8')).version, '1.0.0');
  const paths = await files(f.scratchParent);
  assert.equal(paths.some(path => path.endsWith('workspace-script-ran')), false);
  const logs = await Promise.all(paths.filter(path => path.endsWith('debug-0.log')).map(path => readFile(path, 'utf8')));
  assert.equal(logs.filter(log => /verbose title npm ci\b/u.test(log)).length, 2);
});

test('integrity failures remove their complete graph owner while preserving previous preparations and caller siblings', async t => {
  const f = await fixture(t);
  const repo = await f.repository('integrity');
  const { pkg, lock } = await locked(f, repo);
  const successful = await f.prepare(repo.reference(repo.commit()));
  t.after(() => successful.dispose());
  await write(f.scratchParent, 'sentinel', 'keep');
  const before = await readdir(f.scratchParent);
  const child = await f.repository('broken-child');
  const broken = await locked(f, child, '2.0.0');
  broken.lock.packages['node_modules/value'].integrity = 'sha512-' + Buffer.alloc(64, 42).toString('base64');
  await write(child.directory, 'package-lock.json', broken.lock);
  await write(repo.directory, 'package.json', { ...pkg, agentui: { ...pkg.agentui, extensions: [child.reference(child.commit())] } });
  const reference = repo.reference(repo.commit());
  await assert.rejects(f.prepare(reference), { code: 'install-failed', message: 'Could not install committed customization dependencies.' });
  assert.deepEqual(await readdir(f.scratchParent), before);
  assert.equal(await readFile(join(f.scratchParent, 'sentinel'), 'utf8'), 'keep');
  assert.equal(await readFile(join(repo.directory, 'package-lock.json'), 'utf8'), JSON.stringify(lock));
  assert.deepEqual(await imported(successful.root), ['value@1.0.0', 'development@1.0.0', 'optional@1.0.0', 'peer@1.0.0']);
});

for (const name of ['node_modules', 'NODE_MODULES', 'NoDe_MoDuLeS']) {
  test(`committed ${name} installations are refused outside selected packages without npm dependencies`, async t => {
    const f = await fixture(t);
    const repo = await f.repository('committed-install');
    await write(repo.directory, 'selected/package.json', { agentui: { shared: './index.mjs' } });
    await write(repo.directory, 'selected/index.mjs', 'export default 1;\n');
    await write(repo.directory, `unrelated/${name}/value/index.js`, 'committed installed bytes');
    await assert.rejects(f.prepare(repo.reference(repo.commit(), 'selected')), { code: 'invalid-package' });
    assert.deepEqual(await readdir(f.scratchParent), []);
  });
}

test('empty repositories remain usable', async t => {
  const f = await fixture(t);
  const empty = await f.repository('empty');
  const prepared = await f.prepare(empty.reference(empty.commit()));
  t.after(() => prepared.dispose());
  assert.equal((await stat(prepared.root.directory)).isDirectory(), true);
  assert.deepEqual(await readdir(prepared.root.directory), []);
  assert.deepEqual(prepared.root.npm, { kind: 'absent' });
});

test('nested npm provenance stays relative while resolved and prepared repository roots remap independently', async t => {
  const f = await fixture(t);
  const repo = await f.repository('nested-owner');
  const path = 'nested/owner';
  await locked(f, { directory: join(repo.directory, path) });
  const reference = repo.reference(repo.commit(), path);
  const resolved = await resolveCustomizationSources({ reference, scratchParent: f.scratchParent });
  const prepared = await f.prepare(reference);
  t.after(() => Promise.all([resolved.dispose(), prepared.dispose()]));
  assert.deepEqual(Object.keys(prepared).sort(), ['dispose', 'root']);
  for (const { root } of [resolved, prepared]) {
    assert.equal(root.npm.path, path);
    assert.equal(root.directory, join(root.repositoryDirectory, path));
    assert.equal(root.npm.directory, join(root.repositoryDirectory, root.npm.path));
    assert.equal(root.npm.lockfile.path, `${path}/package-lock.json`);
    for (const file of root.inputs.files) await access(join(root.repositoryDirectory, file.path));
  }
  assert.notEqual(resolved.root.repositoryDirectory, prepared.root.repositoryDirectory);
  assert.equal(resolved.root.npm.identity, prepared.root.npm.identity);
  assert.equal(resolved.root.identity, prepared.root.identity);
  assert.deepEqual(resolved.root.customization, prepared.root.customization);
  await resolved.dispose();
  assert.deepEqual(await imported(prepared.root), ['value@1.0.0', 'development@1.0.0', 'optional@1.0.0', 'peer@1.0.0']);
});
