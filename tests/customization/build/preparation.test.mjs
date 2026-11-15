import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { resolveCustomizationSources } from '@agentui/host/customization';
import { files, fixture, locked, write } from './preparation-support.mjs';

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

test('workspace packages share one npm owner and import linked siblings while independent preparations stay separate', async t => {
  const f = await fixture(t);
  const repo = await f.repository('workspace');
  const script = "node -e \"require('fs').writeFileSync('workspace-script-ran', 'unsafe')\"";
  const root = { name: 'workspace-root', version: '1.0.0', private: true, packageManager: 'npm@11.19.1', workspaces: ['packages/*'] };
  const members = {};
  for (const name of ['one', 'two', 'sibling']) {
    const pkg = { name, version: '1.0.0', type: 'module', exports: './index.mjs', scripts: { install: script },
      ...(name === 'sibling' ? {} : { dependencies: { sibling: '1.0.0' }, agentui: { shared: './index.mjs' } }) };
    await write(repo.directory, `packages/${name}/package.json`, pkg);
    await write(repo.directory, `packages/${name}/index.mjs`, name === 'sibling' ? 'export default 73;\n' : "import value from 'sibling'; export default value;\n");
    const { type: _type, exports: _exports, scripts: _scripts, agentui: _agentui, ...entry } = pkg;
    members[`packages/${name}`] = entry;
    members[`node_modules/${name}`] = { resolved: `packages/${name}`, link: true };
  }
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

test('committed installations are refused even outside selected packages and empty repositories remain usable', async t => {
  const f = await fixture(t);
  const repo = await f.repository('committed-install');
  await write(repo.directory, 'selected/package.json', { agentui: { shared: './index.mjs' } });
  await write(repo.directory, 'selected/index.mjs', 'export default 1;\n');
  await write(repo.directory, 'unrelated/node_modules/value/index.js', 'committed installed bytes');
  await assert.rejects(f.prepare(repo.reference(repo.commit(), 'selected')), { code: 'invalid-package' });
  assert.deepEqual(await readdir(f.scratchParent), []);
  const empty = await f.repository('empty');
  const prepared = await f.prepare(empty.reference(empty.commit()));
  t.after(() => prepared.dispose());
  assert.equal((await stat(prepared.root.directory)).isDirectory(), true);
  assert.deepEqual(await readdir(prepared.root.directory), []);
  assert.deepEqual(prepared.root.npm, { kind: 'absent' });
});
