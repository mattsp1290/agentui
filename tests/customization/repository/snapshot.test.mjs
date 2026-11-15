import { EXTENSION_SDK_VERSION } from '@agentui/contracts/compatibility';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CustomizationError, readCustomizationSnapshot } from '@agentui/host/customization';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentui-snapshot-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const scratchParent = join(root, 'scratch');
  await mkdir(repo);
  git(repo, 'init', '--template=');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'user.name', 'Fixture');
  const commit = () => { git(repo, 'add', '.'); git(repo, 'commit', '--allow-empty', '-m', 'fixture'); return git(repo, 'rev-parse', 'HEAD'); };
  return { root, repo, scratchParent, commit, read: commit => readCustomizationSnapshot({ repository: repo, commit, scratchParent }) };
}
function callerState(repo) {
  return ['HEAD', 'refs', 'index', 'status'].map(key => {
    if (key === 'HEAD') return git(repo, 'symbolic-ref', 'HEAD') + git(repo, 'rev-parse', 'HEAD');
    if (key === 'refs') return git(repo, 'show-ref');
    if (key === 'index') return git(repo, 'ls-files', '--stage');
    return git(repo, 'status', '--porcelain=v1', '--untracked-files=all');
  });
}

test('empty commit and minimal package yield defaults and own disposable private directories', async t => {
  const f = await fixture(t);
  const empty = await f.read(f.commit());
  assert.equal(empty.customization, undefined);
  assert.deepEqual(await readdir(empty.directory), []);
  assert.equal((await stat(dirname(empty.directory))).mode & 0o777, 0o700);
  await empty.dispose();
  await empty.dispose();
  await writeFile(join(f.repo, 'package.json'), '{"private":true}');
  const minimal = await f.read(f.commit());
  assert.equal(minimal.customization, undefined);
  await minimal.dispose();
  assert.deepEqual(await readdir(f.scratchParent), []);
});

test('relative scratch parents keep all artifacts inside the disposable snapshot', async t => {
  for (const scratchParent of ['cache/sources', '../sources']) {
    const f = await fixture(t);
    const caller = join(f.root, 'caller');
    await mkdir(caller);
    await writeFile(join(f.repo, 'value'), 'committed');
    const commit = f.commit();
    const parent = resolve(caller, scratchParent);
    await mkdir(parent, { recursive: true });
    const before = (await readdir(f.root, { recursive: true })).sort();
    const previous = process.cwd();
    let snapshot;
    try {
      process.chdir(caller);
      snapshot = await readCustomizationSnapshot({ repository: f.repo, commit, scratchParent });
      assert.deepEqual(await readdir(dirname(snapshot.directory)), ['source']);
      assert.equal(isAbsolute(snapshot.directory), true);
      assert.equal(await readFile(join(snapshot.directory, 'value'), 'utf8'), 'committed');
      process.chdir(f.root);
      await snapshot.dispose();
      assert.deepEqual((await readdir(f.root, { recursive: true })).sort(), before);
      process.chdir(caller);
      await assert.rejects(readCustomizationSnapshot({ repository: f.repo, commit: 'a'.repeat(40), scratchParent }),
        error => error instanceof CustomizationError && ['unknown-commit', 'retrieval-failed'].includes(error.code));
      assert.deepEqual(await readdir(parent), []);
      assert.deepEqual((await readdir(f.root, { recursive: true })).sort(), before);
    } finally {
      process.chdir(previous);
      await snapshot?.dispose();
    }
  }
});

test('backslash repository input is rejected without creating scratch artifacts', async t => {
  const f = await fixture(t);
  await assert.rejects(readCustomizationSnapshot({ repository: 'https://ghp_SECRET\\@github.com/me/repo',
    commit: 'a'.repeat(40), scratchParent: f.scratchParent }), error => {
    assert.equal(error.code, 'invalid-input');
    assert.equal(error.message, 'Expected a local path or file, SSH, or HTTPS repository without embedded credentials.');
    assert.equal('cause' in error || 'stderr' in error, false);
    return true;
  });
  assert.deepEqual(await readdir(f.root), ['repo']);
});

test('exact raw committed bytes exclude dirty/untracked files and preserve caller state', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from([0, 255, 13, 10, 42]);
  await writeFile(join(f.repo, 'bytes'), bytes);
  await writeFile(join(f.repo, 'version'), '$Format:%H$\n');
  await writeFile(join(f.repo, '.gitattributes'), 'version export-subst\nbytes export-ignore\n');
  const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 100\n';
  await writeFile(join(f.repo, 'lfs'), pointer);
  await writeFile(join(f.repo, 'run'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  const commit = f.commit();
  await writeFile(join(f.repo, 'bytes'), 'dirty');
  await writeFile(join(f.repo, 'untracked'), 'outside commit');
  await writeFile(join(f.repo, '.git/FETCH_HEAD'), 'caller fetch marker\n');
  const before = callerState(f.repo);
  const index = await readFile(join(f.repo, '.git/index'));
  const [one, two] = await Promise.all([f.read(commit.toUpperCase()), f.read(commit)]);
  assert.equal(one.commit, commit);
  assert.notEqual(one.directory, two.directory);
  assert.deepEqual(await readFile(join(one.directory, 'bytes')), bytes);
  assert.equal(await readFile(join(one.directory, 'version'), 'utf8'), '$Format:%H$\n');
  assert.equal(await readFile(join(one.directory, 'lfs'), 'utf8'), pointer);
  assert.equal((await stat(join(one.directory, 'run'))).mode & 0o100, 0o100);
  await assert.rejects(readFile(join(one.directory, 'untracked')), { code: 'ENOENT' });
  assert.deepEqual(callerState(f.repo), before);
  assert.deepEqual(await readFile(join(f.repo, '.git/index')), index);
  assert.equal(await readFile(join(f.repo, '.git/FETCH_HEAD'), 'utf8'), 'caller fetch marker\n');
  await one.dispose();
  assert.deepEqual(await readFile(join(two.directory, 'bytes')), bytes);
  await two.dispose();
});

test('dependency-free desktop template loads its committed source map without dist', async t => {
  const f = await fixture(t);
  const template = fileURLToPath(new URL('../../../templates/customization/', import.meta.url));
  await cp(template, f.repo, { recursive: true });
  const snapshot = await f.read(f.commit());
  assert.deepEqual(snapshot.customization.local.manifest.entries, [{ kind: 'desktop', module: './dist/desktop.js' }]);
  assert.equal(snapshot.customization.local.sources.get('./dist/desktop.js'), './desktop/index.tsx');
  assert.equal(snapshot.customization.shared, './shared/prompts.ts');
  await assert.rejects(stat(join(snapshot.directory, 'dist')), { code: 'ENOENT' });
  await snapshot.dispose();
});

test('unneeded malformed lockfiles do not prevent defaults or dependency-free customization', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'shared.ts'), 'export const label = "Notes";\n');
  await writeFile(join(f.repo, 'package-lock.json'), '{malformed lockfile');
  for (const pkg of [
    { dependencies: { unrelated: '1.0.0' } },
    { dependencies: { unrelated: '1.0.0' }, agentui: {} },
    { agentui: { shared: './shared.ts' } },
  ]) {
    await writeFile(join(f.repo, 'package.json'), JSON.stringify(pkg));
    const snapshot = await f.read(f.commit());
    assert.deepEqual(snapshot.customization, pkg.agentui?.shared ? { shared: './shared.ts', extensions: [] } : undefined);
    assert.equal(await readFile(join(snapshot.directory, 'package-lock.json'), 'utf8'), '{malformed lockfile');
    await snapshot.dispose();
  }
  await writeFile(join(f.repo, 'package.json'), JSON.stringify({
    packageManager: 'npm@11.19.1', dependencies: { required: '1.0.0' }, agentui: { shared: './shared.ts' },
  }));
  await assert.rejects(f.read(f.commit()), { code: 'invalid-package' });
  assert.deepEqual(await readdir(f.scratchParent), []);
});

test('invalid package, symlink and gitlink failures clean only their own snapshots', async t => {
  const f = await fixture(t);
  const valid = await f.read(f.commit());
  await writeFile(join(f.repo, 'package.json'), '{bad json');
  await assert.rejects(f.read(f.commit()), { code: 'invalid-package' });
  await rm(join(f.repo, 'package.json'));
  await symlink('/outside', join(f.repo, 'link'));
  await assert.rejects(f.read(f.commit()), { code: 'unsupported-tree-entry' });
  await rm(join(f.repo, 'link'));
  f.commit();
  git(f.repo, 'update-index', '--add', '--cacheinfo', `160000,${git(f.repo, 'rev-parse', 'HEAD')},submodule`);
  git(f.repo, 'commit', '-m', 'gitlink');
  await assert.rejects(f.read(git(f.repo, 'rev-parse', 'HEAD')), { code: 'unsupported-tree-entry' });
  assert.deepEqual(await readdir(f.scratchParent), [dirname(valid.directory).split('/').at(-1)]);
  await valid.dispose();
});

test('replacement refs and ambient Git selectors cannot redirect the snapshot', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'value'), 'original');
  const original = f.commit();
  await writeFile(join(f.repo, 'value'), 'replacement');
  const replacement = f.commit();
  git(f.repo, 'replace', original, replacement);
  const previous = { ...process.env };
  try {
    Object.assign(process.env, { GIT_DIR: '/missing/repo', GIT_WORK_TREE: '/missing/work', GIT_INDEX_FILE: join(f.root, 'must-not-create'),
      GIT_OBJECT_DIRECTORY: '/missing/objects', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/missing/alternates', GIT_COMMON_DIR: '/missing/common',
      GIT_NAMESPACE: 'wrong', GIT_REPLACE_REF_BASE: 'refs/replace', GIT_SHALLOW_FILE: '/missing/shallow' });
    const snapshot = await f.read(original);
    assert.equal(await readFile(join(snapshot.directory, 'value'), 'utf8'), 'original');
    await snapshot.dispose();
    await assert.rejects(stat(join(f.root, 'must-not-create')), { code: 'ENOENT' });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test('unknown commit, missing repository and unsafe input produce safe diagnostics', async t => {
  const f = await fixture(t);
  f.commit();
  await assert.rejects(f.read('a'.repeat(40)), error => error instanceof CustomizationError && ['unknown-commit', 'retrieval-failed'].includes(error.code));
  await assert.rejects(readCustomizationSnapshot({ repository: join(f.root, 'missing'), commit: 'a'.repeat(40), scratchParent: f.scratchParent }), { code: 'access' });
  for (const repository of ['--upload-pack=bad', 'ext::sh -c bad', 'http://host/repo', 'https://user:secret@host/repo']) {
    await assert.rejects(readCustomizationSnapshot({ repository, commit: 'a'.repeat(40), scratchParent: f.scratchParent }), error => {
      assert.equal(error.code, 'invalid-input');
      assert.equal(error.message.includes('secret'), false);
      assert.equal('stderr' in error, false);
      return true;
    });
  }
  await assert.rejects(f.read('HEAD'), { code: 'invalid-input' });
  assert.deepEqual(await readdir(f.scratchParent), []);
});

test('file URL retrieval preserves shared and external-only inputs', async t => {
  const f = await fixture(t);
  const extensions = [{ repository: 'ssh://git@example.org/team/widgets', commit: 'b'.repeat(40), subdirectory: 'packages/widgets' }];
  await writeFile(join(f.repo, 'shared.ts'), 'export const label = "Notes";\n');
  await writeFile(join(f.repo, 'package.json'), JSON.stringify({ agentui: { shared: './shared.ts', extensions } }));
  const snapshot = await readCustomizationSnapshot({ repository: new URL(`file://${f.repo}`).href, commit: f.commit(), scratchParent: f.scratchParent });
  assert.deepEqual(snapshot.customization, { shared: './shared.ts', extensions });
  await snapshot.dispose();
});

test('committed missing sources and disagreeing lockfiles fail before returning a snapshot', async t => {
  const f = await fixture(t);
  const extension = { namespace: 'personal', trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'desktop', module: './dist/desktop.js' }] };
  const pkg = { name: 'notes', version: '1.0.0', packageManager: 'npm@11.19.1', agentui: { extension, sources: { './dist/desktop.js': './missing.ts' } } };
  await writeFile(join(f.repo, 'package.json'), JSON.stringify(pkg));
  await assert.rejects(f.read(f.commit()), { code: 'invalid-package' });
  await writeFile(join(f.repo, 'missing.ts'), 'export default {};\n');
  await writeFile(join(f.repo, 'package.json'), JSON.stringify({ ...pkg, dependencies: { marked: '1.0.0' } }));
  await writeFile(join(f.repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'notes', version: '1.0.0', dependencies: { marked: '2.0.0' } } } }));
  await assert.rejects(f.read(f.commit()), { code: 'invalid-package' });
  assert.deepEqual(await readdir(f.scratchParent), []);
});

test('unsupported filename paths cannot escape materialization', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'bad\nname'), 'unrepresentable source path');
  await assert.rejects(f.read(f.commit()), { code: 'path' });
  assert.deepEqual(await readdir(f.scratchParent), []);
});
