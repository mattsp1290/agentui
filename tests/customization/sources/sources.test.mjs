import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { CustomizationError, readCustomizationSnapshot, resolveCustomizationSources } from '@agentui/host/customization';

const manager = 'npm@11.19.1';
const digest = value => createHash('sha256').update(value).digest('hex');
const integrity = 'sha512-' + Buffer.alloc(64, 42).toString('base64');
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function write(directory, path, value) {
  await mkdir(dirname(join(directory, path)), { recursive: true });
  await writeFile(join(directory, path), typeof value === 'string' ? value : JSON.stringify(value));
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentui-sources-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scratchParent = join(root, 'scratch');
  const repository = async name => {
    const directory = join(root, name);
    await mkdir(directory);
    git(directory, 'init', '--template=');
    git(directory, 'config', 'user.email', 'fixture@example.invalid');
    git(directory, 'config', 'user.name', 'Fixture');
    const commit = () => { git(directory, 'add', '.'); git(directory, 'commit', '--allow-empty', '-m', 'fixture'); return git(directory, 'rev-parse', 'HEAD'); };
    return { directory, commit };
  };
  const read = reference => resolveCustomizationSources({ reference, scratchParent });
  return { root, scratchParent, repository, read };
}
async function shared(repo, path = '', extra = {}) {
  await write(repo.directory, join(path, 'source.ts'), 'export const value = 1;\n');
  await write(repo.directory, join(path, 'package.json'), { ...extra, agentui: { shared: './source.ts', ...extra.agentui } });
}
const reference = (repo, commit, subdirectory) => ({ repository: repo.directory, commit, ...(subdirectory === undefined ? {} : { subdirectory }) });
function lockFor(pkg, entries = {}) {
  const { agentui: _agentui, packageManager: _packageManager, ...root } = pkg;
  return { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': root, ...entries } };
}
const registry = { version: '1.0.0', resolved: 'https://registry.npmjs.org/value/-/value-1.0.0.tgz', integrity };

test('root defaults, selected missing packages, selectors and floating commits clean their owner', async t => {
  const f = await fixture(t);
  const repo = await f.repository('defaults');
  const commit = repo.commit();
  const result = await f.read(reference(repo, commit));
  assert.equal(result.root.customization, undefined);
  assert.deepEqual(result.root.npm, { kind: 'absent' });
  await result.dispose();
  for (const [ref, code] of [
    [reference(repo, commit, 'missing'), 'invalid-package'],
    [reference(repo, commit, '../escape'), 'path'],
    [reference(repo, 'HEAD'), 'invalid-input'],
  ]) await assert.rejects(f.read(ref), { code });
  assert.deepEqual(await readdir(f.scratchParent), []);
});

test('standalone locks, raw content and identities use only immutable committed inputs', async t => {
  const f = await fixture(t);
  const repo = await f.repository('standalone');
  const pkg = { name: 'notes', version: '1.0.0', packageManager: manager, dependencies: { value: '1.0.0' } };
  await shared(repo, '', pkg);
  const lock = lockFor(pkg, { 'node_modules/value': registry });
  await write(repo.directory, 'package-lock.json', lock);
  await write(repo.directory, '.gitattributes', 'source.ts export-subst\n');
  await writeFile(join(repo.directory, 'executable'), 'raw', { mode: 0o755 });
  const commit = repo.commit();
  const before = git(repo.directory, 'show-ref');
  await write(repo.directory, 'source.ts', 'dirty');
  await write(repo.directory, 'untracked', 'dirty');
  const one = await f.read(reference(repo, commit));
  const two = await f.read(reference(repo, commit.toUpperCase()));
  assert.equal(one.root.identity, two.root.identity);
  assert.equal(one.root.inputs.identity, two.root.inputs.identity);
  assert.equal(one.root.npm.identity, two.root.npm.identity);
  assert.notEqual(one.root.directory, two.root.directory);
  assert.equal(one.root.npm.kind, 'locked');
  assert.equal(one.root.npm.lockfile.path, 'package-lock.json');
  assert.equal(one.root.npm.lockfile.sha256, digest(JSON.stringify(lock)));
  assert.equal(await readFile(join(one.root.directory, 'source.ts'), 'utf8'), 'export const value = 1;\n');
  assert.equal(one.root.inputs.files.some(file => file.path === 'untracked'), false);
  assert.equal(one.root.inputs.files.find(file => file.path === 'executable').executable, true);
  assert.equal((await stat(join(one.root.directory, 'executable'))).mode & 0o100, 0o100);
  assert.equal(git(repo.directory, 'show-ref'), before);
  await one.dispose();
  assert.equal(await readFile(join(two.root.directory, 'source.ts'), 'utf8'), 'export const value = 1;\n');
  await two.dispose();
  await write(repo.directory, 'package-lock.json', JSON.stringify(lock, null, 2));
  const changed = await f.read(reference(repo, repo.commit()));
  assert.notEqual(changed.root.identity, one.root.identity);
  assert.notEqual(changed.root.npm.identity, one.root.npm.identity);
  await changed.dispose();
  assert.deepEqual(await readdir(f.scratchParent), []);
});

test('actual npm workspace lock selects package metadata and preserves sibling import inputs', async t => {
  const f = await fixture(t);
  const repo = await f.repository('workspace');
  await write(repo.directory, 'package.json', { name: 'root', version: '1.0.0', packageManager: manager,
    workspaces: ['packages/*'], agentui: { shared: './missing-root-input' } });
  await shared(repo, 'packages/foo', { name: 'foo', version: '1.2.3' });
  await write(repo.directory, 'packages/util.ts', 'export const util = 42;\n');
  await write(repo.directory, 'package-lock.json', await readFile(new URL('./npm-workspace-lock.json', import.meta.url), 'utf8'));
  const result = await f.read(reference(repo, repo.commit(), 'packages/foo'));
  assert.equal(result.root.customization.shared, './source.ts');
  assert.equal(result.root.npm.directory, dirname(dirname(result.root.directory)));
  assert.equal(result.root.npm.workspaces[0].path, 'packages/foo/package.json');
  assert.equal(result.root.inputs.files.some(file => file.path === 'packages/util.ts'), true);
  assert.equal(await readFile(join(result.root.directory, '../util.ts'), 'utf8'), 'export const util = 42;\n');
  await result.dispose();
});

test('nested pinned sources preserve order and share duplicate and diamond packages', async t => {
  const f = await fixture(t);
  const leaf = await f.repository('leaf');
  await shared(leaf);
  const leafRef = reference(leaf, leaf.commit());
  const a = await f.repository('a');
  await shared(a, '', { agentui: { extensions: [leafRef] } });
  const aRef = reference(a, a.commit());
  const b = await f.repository('b');
  await shared(b, '', { agentui: { extensions: [leafRef] } });
  const bRef = reference(b, b.commit());
  const root = await f.repository('root');
  await shared(root, '', { agentui: { extensions: [aRef, bRef, aRef] } });
  const result = await f.read(reference(root, root.commit()));
  const [first, second, third] = result.root.extensions;
  assert.equal(first, third);
  assert.equal(first.extensions[0], second.extensions[0]);
  assert.deepEqual(result.root.extensions.map(child => child.commit), [aRef.commit, bRef.commit, aRef.commit]);
  const owner = dirname(dirname(result.root.directory));
  assert.equal((await readdir(owner)).length, 4);
  assert.deepEqual(await readdir(dirname(first.directory)), ['source']);
  await result.dispose();
});

test('relative child repositories use captured invocation directory and concurrent owners stay independent', async t => {
  const f = await fixture(t);
  const leaf = await f.repository('relative-leaf');
  await shared(leaf);
  const root = await f.repository('relative-root');
  const leafRef = { repository: relative(process.cwd(), leaf.directory), commit: leaf.commit() };
  await shared(root, '', { agentui: { extensions: [leafRef] } });
  const ref = reference(root, root.commit());
  const [one, two] = await Promise.all([f.read(ref), f.read(ref)]);
  assert.equal(one.root.extensions[0].commit, leafRef.commit);
  assert.notEqual(one.root.extensions[0].directory, two.root.extensions[0].directory);
  await one.dispose();
  await one.dispose();
  assert.equal(await readFile(join(two.root.extensions[0].directory, 'source.ts'), 'utf8'), 'export const value = 1;\n');
  await two.dispose();
});

test('failure in final descendant cleans acquired sources and keeps an unrelated owner alive', async t => {
  const f = await fixture(t);
  const leaf = await f.repository('valid');
  await shared(leaf);
  const valid = reference(leaf, leaf.commit());
  const keeper = await f.read(valid);
  const missing = await f.repository('empty');
  const root = await f.repository('root');
  await shared(root, '', { agentui: { extensions: [valid, reference(missing, missing.commit())] } });
  await assert.rejects(f.read(reference(root, root.commit())), { code: 'invalid-package' });
  assert.equal((await readdir(f.scratchParent)).length, 1);
  assert.equal(await readFile(join(keeper.root.directory, 'source.ts'), 'utf8'), 'export const value = 1;\n');
  await keeper.dispose();
  assert.deepEqual(await readdir(f.scratchParent), []);
});

test('lock drift, missing entries, malformed entries and unsupported npm sources reject as a unit', async t => {
  for (const variant of ['drift', 'missing', 'malformed', 'transitive', 'git', 'credentials', 'unpinned']) {
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
    await shared(repo, '', pkg);
    await write(repo.directory, 'package-lock.json', lock);
    await assert.rejects(f.read(reference(repo, repo.commit())), error => error instanceof CustomizationError && error.code === 'invalid-package' && !error.message.includes('SECRET'));
    assert.deepEqual(await readdir(f.scratchParent), []);
  }
});

test('contained local tarball inputs retain bytes while local escapes and mismatched lock targets reject', async t => {
  const f = await fixture(t);
  const repo = await f.repository('local');
  const pkg = { name: 'notes', version: '1.0.0', packageManager: manager, dependencies: { value: 'file:vendor/value.tgz' } };
  const lock = lockFor(pkg, { 'node_modules/value': { version: '1.0.0', resolved: 'file:vendor/value.tgz', integrity } });
  await shared(repo, '', pkg);
  await write(repo.directory, 'vendor/value.tgz', 'committed-tarball-bytes');
  await write(repo.directory, 'package-lock.json', lock);
  const result = await f.read(reference(repo, repo.commit()));
  assert.deepEqual(result.root.npm.localInputs.map(file => file.path), ['vendor/value.tgz']);
  assert.equal(result.root.npm.localInputs[0].sha256, digest('committed-tarball-bytes'));
  await result.dispose();
  for (const spec of ['file:../outside.tgz', 'file:/outside.tgz', 'file:vendor/other.tgz', 'link:vendor/value.tgz']) {
    pkg.dependencies.value = spec;
    lock.packages[''].dependencies = pkg.dependencies;
    await shared(repo, '', pkg);
    await write(repo.directory, 'package-lock.json', lock);
    await assert.rejects(f.read(reference(repo, repo.commit())), error => ['path', 'invalid-package'].includes(error.code));
    assert.deepEqual(await readdir(f.scratchParent), []);
  }
});

test('ambiguous npm owners, unsupported workspace patterns and conflicting manager pins reject', async t => {
  for (const variant of ['own-lock', 'nested-owner', 'pattern', 'overlap', 'manager']) {
    const f = await fixture(t);
    const repo = await f.repository(variant);
    const member = variant === 'nested-owner' ? 'packages/nested/foo' : 'packages/foo';
    await write(repo.directory, 'package.json', { name: 'root', version: '1.0.0', packageManager: manager,
      workspaces: variant === 'pattern' ? ['packages/**'] : variant === 'overlap' ? ['packages/*', 'packages/foo'] : [member] });
    await shared(repo, member, { name: 'foo', version: '1.2.3', ...(variant === 'manager' ? { packageManager: 'pnpm@9' } : {}) });
    const lock = JSON.parse(await readFile(new URL('./npm-workspace-lock.json', import.meta.url), 'utf8'));
    if (variant === 'own-lock') await write(repo.directory, `${member}/package-lock.json`, {});
    if (variant === 'nested-owner') await write(repo.directory, 'packages/package.json', { workspaces: ['nested/foo'] });
    await write(repo.directory, 'package-lock.json', lock);
    await assert.rejects(f.read(reference(repo, repo.commit(), member)), { code: 'invalid-package' });
    assert.deepEqual(await readdir(f.scratchParent), []);
  }
});

test('symlinks and credential helper diagnostics cannot escape or survive failed acquisition', async t => {
  const f = await fixture(t);
  const repo = await f.repository('links');
  await shared(repo);
  await symlink('/outside', join(repo.directory, 'link'));
  await assert.rejects(f.read(reference(repo, repo.commit())), { code: 'unsupported-tree-entry' });
  const helper = join(f.root, 'ssh-helper');
  await writeFile(helper, '#!/bin/sh\necho "HOST_CREDENTIAL_SECRET helper stderr" >&2\nexit 1\n', { mode: 0o700 });
  const previous = process.env.GIT_SSH_COMMAND;
  try {
    process.env.GIT_SSH_COMMAND = helper;
    await assert.rejects(f.read({ repository: 'ssh://git@example.invalid/private', commit: 'a'.repeat(40) }), error => {
      assert.equal(error instanceof CustomizationError, true);
      assert.equal(error.message.includes('HOST_CREDENTIAL_SECRET'), false);
      assert.equal('cause' in error || 'stderr' in error, false);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = previous;
  }
  assert.deepEqual(await readdir(f.scratchParent), []);
});

test('normalized file URL aliases produce stable content identities', async t => {
  const f = await fixture(t);
  const repo = await f.repository('aliases');
  await shared(repo);
  const commit = repo.commit();
  const one = await f.read(reference(repo, commit));
  const two = await f.read({ repository: pathToFileURL(repo.directory).href, commit });
  assert.equal(one.root.identity, two.root.identity);
  assert.equal(one.root.inputs.identity, two.root.inputs.identity);
  await Promise.all([one.dispose(), two.dispose()]);
});

test('edge declarations and package expansion have graph-wide bounds', async t => {
  const f = await fixture(t);
  const leaf = await f.repository('packages');
  for (let index = 0; index < 65; index++) await shared(leaf, `packages/p${index}`);
  const commit = leaf.commit();
  const root = await f.repository('root');
  await shared(root, '', { agentui: { extensions: Array.from({ length: 65 }, (_, index) => reference(leaf, commit, `packages/p${index}`)) } });
  await assert.rejects(f.read(reference(root, root.commit())), { code: 'resource-limit' });
  await shared(root, '', { agentui: { extensions: Array.from({ length: 257 }, () => reference(leaf, commit, 'packages/p0')) } });
  await assert.rejects(f.read(reference(root, root.commit())), { code: 'resource-limit' });
  assert.deepEqual(await readdir(f.scratchParent), []);
});

test('selected workspace links retain sibling inputs without activating sibling customization', async t => {
  const f = await fixture(t);
  const repo = await f.repository('sibling-workspace');
  const root = { name: 'root', version: '1.0.0', packageManager: manager, workspaces: { packages: ['packages/*'] } };
  const foo = { name: 'foo', version: '1.0.0', dependencies: { bar: 'file:../bar' }, peerDependencies: { optional: '^1' }, peerDependenciesMeta: { optional: { optional: true } } };
  const bar = { name: 'bar', version: '2.0.0' };
  await write(repo.directory, 'package.json', root);
  await shared(repo, 'packages/foo', foo);
  await write(repo.directory, 'packages/bar/package.json', { ...bar, agentui: { shared: './missing-source' } });
  await write(repo.directory, 'packages/bar/input.ts', 'sibling-input');
  const { name: _name, ...fooEntry } = foo;
  const lock = lockFor(root, { 'packages/foo': fooEntry, 'packages/bar': { version: bar.version },
    'node_modules/foo': { resolved: 'packages/foo', link: true }, 'node_modules/bar': { resolved: 'packages/bar', link: true } });
  await write(repo.directory, 'package-lock.json', lock);
  const result = await f.read(reference(repo, repo.commit(), 'packages/foo'));
  assert.equal(result.root.extensions.length, 0);
  assert.deepEqual(result.root.npm.workspaces.map(file => file.path), ['packages/bar/package.json', 'packages/foo/package.json']);
  assert.equal(result.root.npm.localInputs.some(file => file.path === 'packages/bar/input.ts'), true);
  await result.dispose();
  await write(repo.directory, 'packages/bar/package.json', { ...bar, version: '3.0.0' });
  await assert.rejects(f.read(reference(repo, repo.commit(), 'packages/foo')), { code: 'invalid-package' });
});

test('actual npm outside-link lock and fabricated parent pins reject separate installation contexts', async t => {
  const f = await fixture(t);
  const repo = await f.repository('local-directory');
  const pkg = { name: 'notes', version: '1.0.0', packageManager: manager, dependencies: { value: 'file:../local' } };
  await shared(repo, 'extension', pkg);
  await write(repo.directory, 'local/package.json', { name: 'value', version: '2.0.0', dependencies: { transitive: 'file:../transitive' } });
  await write(repo.directory, 'transitive/package.json', { name: 'transitive', version: '1.0.0' });
  const lock = JSON.parse(await readFile(new URL('./npm-outside-link-lock.json', import.meta.url), 'utf8'));
  for (const variant of ['actual', 'parent-pin', 'target-pin']) {
    if (variant === 'parent-pin') lock.packages['node_modules/transitive'] = registry;
    if (variant === 'target-pin') lock.packages['../local/node_modules/transitive'] = registry;
    await write(repo.directory, 'extension/package-lock.json', lock);
    await assert.rejects(f.read(reference(repo, repo.commit(), 'extension')), { code: 'invalid-package' });
    assert.deepEqual(await readdir(f.scratchParent), []);
  }
});

test('non-workspace directory links reject even when dependency-free or inside the npm root', async t => {
  const f = await fixture(t);
  const repo = await f.repository('non-workspace');
  const pkg = { name: 'notes', version: '1.0.0', packageManager: manager, dependencies: { value: 'file:local' } };
  await shared(repo, '', pkg);
  await write(repo.directory, 'local/package.json', { name: 'value', version: '2.0.0' });
  await write(repo.directory, 'package-lock.json', lockFor(pkg, { local: { name: 'value', version: '2.0.0' }, 'node_modules/value': { resolved: 'local', link: true } }));
  await assert.rejects(f.read(reference(repo, repo.commit())), { code: 'invalid-package' });
  assert.deepEqual(await readdir(f.scratchParent), []);
});

test('root no-op metadata preserves defaults despite unrelated npm workspace configuration', async t => {
  const f = await fixture(t);
  const repo = await f.repository('no-op');
  for (const agentui of [undefined, {}, { extensions: [] }]) {
    await write(repo.directory, 'package.json', { workspaces: ['unsupported/**'], dependencies: 'unused malformed metadata', agentui });
    const result = await f.read(reference(repo, repo.commit()));
    assert.equal(result.root.customization, undefined);
    assert.deepEqual(result.root.npm, { kind: 'absent' });
    await result.dispose();
  }
});

test('inherited SSH access retrieves committed bytes and retains no credential or Git metadata', async t => {
  const f = await fixture(t);
  const repo = await f.repository('ssh-success');
  await shared(repo);
  const commit = repo.commit();
  const helper = join(f.root, 'ssh-success-helper');
  await writeFile(helper, '#!/bin/sh\n[ "$AGENTUI_TEST_CREDENTIAL" = "HOST_CREDENTIAL_SECRET" ] || exit 1\nexec git-upload-pack "$AGENTUI_TEST_REPOSITORY"\n', { mode: 0o700 });
  const prior = { ssh: process.env.GIT_SSH_COMMAND, credential: process.env.AGENTUI_TEST_CREDENTIAL, repository: process.env.AGENTUI_TEST_REPOSITORY };
  try {
    Object.assign(process.env, { GIT_SSH_COMMAND: helper, AGENTUI_TEST_CREDENTIAL: 'HOST_CREDENTIAL_SECRET', AGENTUI_TEST_REPOSITORY: repo.directory });
    const [one, two] = await Promise.all([f.read({ repository: 'ssh://git@example.invalid/private', commit }), f.read({ repository: 'ssh://git@example.invalid/private', commit })]);
    for (const result of [one, two]) {
      assert.deepEqual(await readdir(dirname(result.root.directory)), ['source']);
      assert.equal(result.root.inputs.files.some(file => file.path.includes('.git')), false);
      const ownerFiles = await readdir(dirname(dirname(result.root.directory)), { recursive: true, withFileTypes: true });
      for (const file of ownerFiles.filter(file => file.isFile())) {
        assert.equal((await readFile(join(file.parentPath, file.name), 'utf8')).includes('HOST_CREDENTIAL_SECRET'), false);
      }
    }
    await one.dispose();
    assert.equal(await readFile(join(two.root.directory, 'source.ts'), 'utf8'), 'export const value = 1;\n');
    await two.dispose();
  } finally {
    for (const [key, value] of [['GIT_SSH_COMMAND', prior.ssh], ['AGENTUI_TEST_CREDENTIAL', prior.credential], ['AGENTUI_TEST_REPOSITORY', prior.repository]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.deepEqual(await readdir(f.scratchParent), []);
});


test('required transitive peers require a pinned npm peer location and optional peers may be absent', async t => {
  for (const variant of ['missing', 'nested-only', 'pinned', 'optional', 'unsafe-source', 'unpinned-peer', 'scoped-nested-only', 'scoped-pinned']) {
    await t.test(variant, async t => {
      const f = await fixture(t);
      const repo = await f.repository(variant);
      const name = variant.startsWith('scoped') ? '@scope/value' : 'value';
      const pkg = { name: 'notes', version: '1.0.0', packageManager: manager, dependencies: { [name]: '1.0.0' } };
      const entry = { ...registry, peerDependencies: { peer: variant === 'unsafe-source' ? 'git+ssh://example.invalid/peer' : '^1' } };
      if (variant === 'optional') entry.peerDependenciesMeta = { peer: { optional: true } };
      const entries = { [`node_modules/${name}`]: entry };
      if (variant.endsWith('nested-only')) entries[`node_modules/${name}/node_modules/peer`] = registry;
      if (['pinned', 'unsafe-source', 'unpinned-peer', 'scoped-pinned'].includes(variant)) entries['node_modules/peer'] = { ...registry };
      if (variant === 'unpinned-peer') delete entries['node_modules/peer'].integrity;
      await shared(repo, '', pkg);
      await write(repo.directory, 'package-lock.json', lockFor(pkg, entries));
      const ref = reference(repo, repo.commit());
      if (['pinned', 'optional', 'scoped-pinned'].includes(variant)) {
        const result = await f.read(ref);
        assert.equal(result.root.npm.kind, 'locked');
        await result.dispose();
      } else await assert.rejects(f.read(ref), { code: 'invalid-package' });
      assert.deepEqual(await readdir(f.scratchParent), []);
    });
  }
});

test('dependency-free actual npm lock preserves file identity without requiring a manager pin', async t => {
  const f = await fixture(t);
  const repo = await f.repository('empty-lock');
  await shared(repo, '', { name: 'notes', version: '1.0.0' });
  const lock = await readFile(new URL('./npm-empty-lock.json', import.meta.url), 'utf8');
  await write(repo.directory, 'package-lock.json', lock);
  const ref = reference(repo, repo.commit());
  const snapshot = await readCustomizationSnapshot({ ...ref, scratchParent: f.scratchParent });
  assert.equal(snapshot.customization.shared, './source.ts');
  await snapshot.dispose();
  const result = await f.read(ref);
  assert.deepEqual(result.root.npm, { kind: 'absent' });
  assert.equal(result.root.inputs.files.find(file => file.path === 'package-lock.json').sha256, digest(lock));
  await result.dispose();
  assert.deepEqual(await readdir(f.scratchParent), []);
});

test('workspace patterns, lock entries and declarations have fixed analysis caps', async t => {
  for (const variant of ['patterns', 'duplicates', 'entries', 'declarations']) {
    await t.test(variant, async t => {
      const f = await fixture(t);
      const repo = await f.repository(variant);
      const pkg = { name: 'notes', version: '1.0.0', packageManager: manager, dependencies: { value: '1.0.0' } };
      if (variant === 'patterns') pkg.workspaces = Array.from({ length: 257 }, (_, index) => `none${index}/*`);
      if (variant === 'duplicates') pkg.workspaces = ['none/*', 'none/*'];
      const entries = { 'node_modules/value': { ...registry } };
      if (variant === 'entries') for (let index = 0; index < 10000; index++) entries[`node_modules/p${index}`] = registry;
      if (variant === 'declarations') entries['node_modules/value'].peerDependencies = Object.fromEntries(Array.from({ length: 50001 }, (_, index) => [`p${index}`, '1']));
      await shared(repo, '', pkg);
      await write(repo.directory, 'package-lock.json', lockFor(pkg, entries));
      await assert.rejects(f.read(reference(repo, repo.commit())), { code: variant === 'duplicates' ? 'invalid-package' : 'resource-limit' });
      assert.deepEqual(await readdir(f.scratchParent), []);
    });
  }
});

test('package-analysis deadline applies inside workspace and lock loops over a real snapshot', async t => {
  const { readCommittedRepository } = await import('../../../packages/host/dist/customization/repository.js');
  const { selectPackage } = await import('../../../packages/host/dist/customization/packages.js');
  for (const variant of ['workspace', 'lock']) await t.test(variant, async t => {
    const f = await fixture(t);
    const repo = await f.repository('deadline');
    const pkg = { name: 'notes', version: '1.0.0', packageManager: manager };
    if (variant === 'workspace') pkg.workspaces = Array.from({ length: 100 }, (_, index) => `none${index}/*`);
    else pkg.dependencies = { value: '1' };
    await shared(repo, '', pkg);
    if (variant === 'lock') await write(repo.directory, 'package-lock.json', lockFor(pkg, Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`node_modules/p${index}`, registry]))));
    const tree = await readCommittedRepository({ ...reference(repo, repo.commit()), scratchParent: f.scratchParent });
    try {
      let checks = 0;
      const allowance = { get deadline() { return ++checks < 40 ? Infinity : 0; } };
      await assert.rejects(selectPackage(tree, '', allowance), { code: 'resource-limit' });
      assert.ok(checks >= 40);
    } finally { await tree.dispose(); }
    assert.deepEqual(await readdir(f.scratchParent), []);
  });
});

test('absolute path aliases deduplicate before acquisition and encoded file URLs keep transport spelling', async t => {
  const f = await fixture(t);
  await t.test('encoded file URL', async () => {
    const leaf = await f.repository('leaf with spaces');
    await shared(leaf);
    const fileRef = { repository: pathToFileURL(leaf.directory).href, commit: leaf.commit() };
    const encoded = await f.read(fileRef);
    assert.equal(await readFile(join(encoded.root.directory, 'source.ts'), 'utf8'), 'export const value = 1;\n');
    await encoded.dispose();
  });
  await t.test('absolute aliases', async () => {
    const child = await f.repository('aliases-child');
    await shared(child);
    const commit = child.commit();
    const root = await f.repository('aliases-root');
    await shared(root, '', { agentui: { extensions: [child.directory, `${child.directory}/`, `${child.directory}/../aliases-child`, pathToFileURL(child.directory).href].map(repository => ({ repository, commit })) } });
    const result = await f.read(reference(root, root.commit()));
    assert.ok(result.root.extensions.every(child => child === result.root.extensions[0]));
    assert.equal((await readdir(dirname(dirname(result.root.directory)))).length, 2);
    await result.dispose();
  });
  assert.deepEqual(await readdir(f.scratchParent), []);
});

test('trusted remote parents authorize committed local descendants with inherited host Git access', async t => {
  const f = await fixture(t);
  const leaf = await f.repository('local-child');
  await shared(leaf);
  const child = { repository: relative(process.cwd(), leaf.directory), commit: leaf.commit() };
  const parent = await f.repository('remote-parent');
  await shared(parent, '', { agentui: { extensions: [child] } });
  const commit = parent.commit();
  const helper = join(f.root, 'remote-helper');
  await writeFile(helper, '#!/bin/sh\n[ "$AGENTUI_TEST_CREDENTIAL" = "HOST_CREDENTIAL_SECRET" ] || exit 1\nexec git-upload-pack "$AGENTUI_TEST_REPOSITORY"\n', { mode: 0o700 });
  const prior = { ...process.env };
  try {
    Object.assign(process.env, { GIT_SSH_COMMAND: helper, AGENTUI_TEST_CREDENTIAL: 'HOST_CREDENTIAL_SECRET', AGENTUI_TEST_REPOSITORY: parent.directory });
    const result = await f.read({ repository: 'ssh://git@example.invalid/parent', commit });
    assert.equal(result.root.extensions[0].commit, child.commit);
    assert.equal(await readFile(join(result.root.extensions[0].directory, 'source.ts'), 'utf8'), 'export const value = 1;\n');
    await result.dispose();
  } finally {
    for (const key of ['GIT_SSH_COMMAND', 'AGENTUI_TEST_CREDENTIAL', 'AGENTUI_TEST_REPOSITORY']) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
  assert.deepEqual(await readdir(f.scratchParent), []);
});


test('outside-link dependencies never fall back to the sibling extension node_modules', async t => {
  const f = await fixture(t);
  const repo = await f.repository('sibling-npm-root');
  const pkg = { name: 'notes', version: '1.0.0', packageManager: manager, dependencies: { value: 'file:../local' } };
  await shared(repo, 'extension', pkg);
  await write(repo.directory, 'local/package.json', { name: 'value', version: '2.0.0', dependencies: { transitive: '1.0.0' } });
  await write(repo.directory, 'extension/package-lock.json', lockFor(pkg, {
    '../local': { version: '2.0.0', dependencies: { transitive: '1.0.0' } },
    'node_modules/value': { resolved: '../local', link: true },
    'node_modules/transitive': registry,
  }));
  await assert.rejects(f.read(reference(repo, repo.commit(), 'extension')), { code: 'invalid-package' });
  assert.deepEqual(await readdir(f.scratchParent), []);
});

test('root and workspace peer contexts can use their own node_modules', async t => {
  for (const variant of ['root', 'workspace-nested', 'workspace-root']) await t.test(variant, async t => {
    const f = await fixture(t);
    const repo = await f.repository(variant);
    const pkg = { name: 'notes', version: '1.0.0', packageManager: manager };
    const entries = {};
    let subdirectory;
    if (variant === 'root') {
      pkg.peerDependencies = { peer: '1' };
      await shared(repo, '', pkg);
    } else {
      pkg.workspaces = ['packages/value'];
      await write(repo.directory, 'package.json', pkg);
      await shared(repo, 'packages/value', { name: 'value', version: '1.0.0', peerDependencies: { peer: '1' } });
      entries['packages/value'] = { version: '1.0.0', peerDependencies: { peer: '1' } };
      entries['node_modules/value'] = { resolved: 'packages/value', link: true };
      subdirectory = 'packages/value';
    }
    entries[variant === 'workspace-nested' ? 'packages/value/node_modules/peer' : 'node_modules/peer'] = registry;
    await write(repo.directory, 'package-lock.json', lockFor(pkg, entries));
    const result = await f.read(reference(repo, repo.commit(), subdirectory));
    assert.equal(result.root.npm.kind, 'locked');
    await result.dispose();
    assert.deepEqual(await readdir(f.scratchParent), []);
  });
});
