import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCustomizationPackage as parsePackage, repositoryLocation } from '../../../packages/host/dist/customization/contract.js';

const oid = 'a'.repeat(40);
const files = new Set(['desktop.tsx', 'shared.ts']);
const manifest = { namespace: 'personal', trust: 'full', sdkVersion: '0.0.0', entries: [{ kind: 'desktop', module: './dist/desktop.js' }] };
const local = { extension: manifest, sources: { './dist/desktop.js': './desktop.tsx' } };
const parseCustomizationPackage = (input, files, lock) => parsePackage(input, files, { lock, packagePath: '', packageManager: input.packageManager });
const parse = (agentui, lock) => parseCustomizationPackage({ agentui }, files, lock);

test('absent metadata and empty metadata retain shipped defaults', () => {
  assert.equal(parseCustomizationPackage({}, files), undefined);
  assert.equal(parse({}), undefined);
});

test('absent and no-op customization retain defaults with unrelated dependency declarations', () => {
  for (const agentui of [undefined, {}, { extensions: [] }]) {
    assert.equal(parseCustomizationPackage({ dependencies: { unrelated: '1.0.0' }, agentui }, files), undefined);
  }
});

test('backslash repository URLs fail safely before Git or external reference retention', () => {
  const repository = 'https://ghp_SECRET\\@github.com/me/repo';
  const safeError = error => {
    assert.equal(error.code, 'invalid-input');
    assert.equal(error.message, 'Expected a local path or file, SSH, or HTTPS repository without embedded credentials.');
    assert.equal('cause' in error || 'stderr' in error, false);
    return true;
  };
  assert.throws(() => repositoryLocation(repository), safeError);
  assert.throws(() => parse({ extensions: [{ repository, commit: oid }] }), safeError);
});

test('one desktop source selects only desktop without requiring built output', () => {
  const source = parse(local);
  assert.deepEqual(source.local.manifest, manifest);
  assert.deepEqual([...source.local.sources], [['./dist/desktop.js', './desktop.tsx']]);
  assert.deepEqual(source.extensions, []);
});

test('multiple platform kinds can share one mapped source module', () => {
  const extension = { ...manifest, entries: [
    { kind: 'desktop', module: './dist/shared.js' },
    { kind: 'ios', module: './dist/shared.js' },
  ] };
  const source = parse({ extension, sources: { './dist/shared.js': './shared.ts' } });
  assert.deepEqual(source.local.manifest.entries, extension.entries);
  assert.deepEqual([...source.local.sources], [['./dist/shared.js', './shared.ts']]);
});

test('shared and external inputs survive without a local SDK manifest', () => {
  const extensions = [{ repository: 'git@example.org:me/widgets.git', commit: oid, subdirectory: 'packages/widgets' }];
  assert.deepEqual(parse({ shared: './shared.ts', extensions }), { shared: './shared.ts', extensions });
  assert.deepEqual(parse({ extensions }), { extensions });
});

test('source maps and shared inputs must identify contained committed regular files', () => {
  for (const agentui of [
    { sources: local.sources }, { extension: manifest },
    { ...local, sources: {} }, { ...local, sources: { ...local.sources, './extra.js': './shared.ts' } },
    { ...local, sources: { './dist/desktop.js': './missing.ts' } },
    { ...local, sources: { './dist/desktop.js': './../escape.ts' } },
    { shared: './missing.ts' }, { shared: '/outside' }, { shared: './.git/config' },
    { extensions: [{ repository: 'git@example.org:me/x', commit: 'main' }] },
    { extensions: [{ repository: 'https://token@example.org/x', commit: oid }] },
    { extensions: [{ repository: 'ext::sh', commit: oid }] },
    { extensions: [{ repository: '/repo', commit: oid, subdirectory: '../x' }] },
  ]) assert.throws(() => parse(agentui));
});

test('dependency declarations need agreeing npm v3 lock root metadata', () => {
  const pkg = { name: 'notes', version: '1.0.0', packageManager: 'npm@11.19.1', dependencies: { marked: '1.0.0' }, agentui: local };
  const lock = { lockfileVersion: 3, packages: { '': { name: 'notes', version: '1.0.0', dependencies: { marked: '1.0.0' } } } };
  assert.ok(parseCustomizationPackage(pkg, files, lock));
  assert.throws(() => parseCustomizationPackage(pkg, files));
  assert.throws(() => parseCustomizationPackage(pkg, files, { ...lock, lockfileVersion: 2 }));
  assert.throws(() => parseCustomizationPackage(pkg, files, { ...lock, packages: { '': { ...lock.packages[''], dependencies: { marked: '^2' } } } }));
  assert.throws(() => parseCustomizationPackage({ ...pkg, packageManager: 'pnpm@9' }, files, lock));
  assert.throws(() => parseCustomizationPackage(pkg, files, { ...lock, packages: { '': { ...lock.packages[''], devDependencies: { x: '1' } } } }));
  for (const agentui of [{ shared: './shared.ts' }, { extensions: [{ repository: '/repo', commit: oid }] }]) {
    assert.throws(() => parseCustomizationPackage({ ...pkg, agentui }, files), { code: 'invalid-package' });
    assert.ok(parseCustomizationPackage({ ...pkg, agentui }, files, lock));
  }
});
