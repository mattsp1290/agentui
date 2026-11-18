import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CustomizationError, desktopCustomizationIdentity, parseCommittedExtensionReference, parseCustomizationPackage, parseCustomizationSettings,
  parseGitExtensionReference, planCustomizationCatalog, serializeCustomizationSettings } from '@agentui/host/customization';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { fixture, git, reference, shared, write } from './source-support.mjs';

const grant = (namespace, extra = {}) => ({ id: 'personal',
  instance: { namespace, installationId: 'personal', generation: '1', protocolVersion: '1' },
  service: 'http://127.0.0.1:8080', expectedAuthority: 'remote-provider',
  authentication: { kind: 'environment', variable: `AGENTUI_EXTENSION_${namespace.toUpperCase()}_TOKEN`, revision: '1' }, ...extra });
const extension = namespace => ({ extension: { namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'desktop', module: './desktop.js' }] },
  sources: { './desktop.js': './index.ts' } });
async function local(repo, path, namespace) {
  await write(repo.directory, `${path}/index.ts`, 'export default {};\n');
  await write(repo.directory, `${path}/package.json`, { name: namespace, version: '0.0.0', agentui: extension(namespace) });
}
async function exampleRepository(f, metadata = {}) {
  const repo = await f.repository('example');
  await local(repo, 'extensions/a', 'alpha');
  await local(repo, 'extensions/b', 'beta');
  await write(repo.directory, 'examples/x/package.json', { name: 'x', version: '0.0.0', private: true, agentui: {
    extensions: [{ subdirectory: 'extensions/a', enabled: true }, { subdirectory: 'extensions/b' }], ...metadata } });
  return repo;
}
const namesOf = root => root.extensions.map(child => child.customization.local.manifest.namespace);

test('a root in a subdirectory resolves sibling references from the repository root in one acquisition', async t => {
  const f = await fixture(t);
  const repo = await exampleRepository(f, { installations: [grant('alpha'), grant('beta')] });
  const commit = repo.commit();
  const resolved = await f.read(reference(repo, commit, 'examples/x'));
  try {
    assert.equal(resolved.root.subdirectory, 'examples/x');
    assert.deepEqual(resolved.root.extensions.map(child => child.subdirectory), ['extensions/a', 'extensions/b']);
    assert.deepEqual(namesOf(resolved.root), ['alpha', 'beta']);
    assert.ok(resolved.root.extensions.every(child => child.repositoryDirectory === resolved.root.repositoryDirectory && child.commit === commit));
    assert.deepEqual(resolved.installations.map(item => item.instance.namespace), ['alpha', 'beta']);
    assert.deepEqual(resolved.installations[0].authentication, { kind: 'environment', variable: 'AGENTUI_EXTENSION_ALPHA_TOKEN', revision: '1' });
    const plan = planCustomizationCatalog(resolved.root, EXTENSION_SDK_VERSION, 'desktop');
    assert.deepEqual(plan.entries.map(entry => entry.manifest.namespace), ['alpha', 'beta']);
    assert.equal(plan.roots.length, 1);
  } finally { await resolved.dispose(); }
});

test('a sibling reference inside an external package resolves in that package repository', async t => {
  const f = await fixture(t);
  const other = await f.repository('other');
  await local(other, 'tools/leaf', 'leaf');
  await write(other.directory, 'pack/package.json', { name: 'pack', version: '0.0.0', agentui: { extensions: [{ subdirectory: 'tools/leaf' }] } });
  const otherCommit = other.commit();
  const root = await f.repository('root');
  await local(root, 'tools/leaf', 'decoy');
  await shared(root, '', { agentui: { extensions: [{ ...reference(other, otherCommit, 'pack') }] } });
  const resolved = await f.read(reference(root, root.commit()));
  try {
    const [pack] = resolved.root.extensions;
    assert.equal(pack.commit, otherCommit);
    assert.deepEqual(namesOf(pack), ['leaf']);
    assert.equal(pack.extensions[0].repositoryDirectory, pack.repositoryDirectory);
  } finally { await resolved.dispose(); }
});

test('references must name both repository and commit, or neither', () => {
  const commit = 'a'.repeat(40);
  for (const value of [{ repository: '/tmp/x' }, { commit }, { repository: '/tmp/x', subdirectory: 'a' }, { commit, subdirectory: 'a' },
    { subdirectory: '../escape' }, { subdirectory: 'a', enabled: 'no' }, { subdirectory: 'a', extra: true }, {}]) {
    assert.throws(() => parseCommittedExtensionReference(value), { code: 'invalid-package' }, JSON.stringify(value));
  }
  assert.deepEqual(parseCommittedExtensionReference({ subdirectory: './a/b' }), { subdirectory: 'a/b', enabled: true });
  assert.deepEqual(parseCommittedExtensionReference({ repository: '/tmp/x', commit, enabled: false }), { repository: '/tmp/x', commit, enabled: false });
});

test('a package that references its own subdirectory is a cycle', async t => {
  const f = await fixture(t);
  const repo = await f.repository('cycle');
  await shared(repo, 'pack', { agentui: { extensions: [{ subdirectory: 'pack' }] } });
  await assert.rejects(f.read(reference(repo, repo.commit(), 'pack')), { code: 'invalid-package', message: /cycle/ });
});

test('a sibling reference is not relative to the referencing package', async t => {
  const f = await fixture(t);
  const repo = await exampleRepository(f);
  await local(repo, 'examples/x/extensions/a', 'nested');
  const resolved = await f.read(reference(repo, repo.commit(), 'examples/x'));
  try { assert.deepEqual(namesOf(resolved.root), ['alpha', 'beta']); } finally { await resolved.dispose(); }
});

test('a disabled reference is listed but never resolved, even when its repository does not exist', async t => {
  const f = await fixture(t);
  const repo = await f.repository('disabled');
  await local(repo, 'extensions/a', 'alpha');
  const missing = { repository: `${f.root}/does-not-exist`, commit: 'b'.repeat(40), enabled: false };
  await shared(repo, '', { agentui: { extensions: [{ subdirectory: 'extensions/a', enabled: false }, missing, { subdirectory: 'extensions/missing', enabled: false }] } });
  const resolved = await f.read(reference(repo, repo.commit()));
  try {
    assert.deepEqual(resolved.root.extensions, []);
    assert.deepEqual(resolved.root.customization.extensions, [{ subdirectory: 'extensions/a', enabled: false },
      { repository: missing.repository, commit: missing.commit, enabled: false }, { subdirectory: 'extensions/missing', enabled: false }]);
  } finally { await resolved.dispose(); }
});

test('flipping enabled changes the desktop customization identity', async t => {
  const f = await fixture(t);
  const repo = await exampleRepository(f);
  const identities = [];
  for (const enabled of [true, false]) {
    await write(repo.directory, 'examples/x/package.json', { name: 'x', version: '0.0.0', private: true, agentui: {
      extensions: [{ subdirectory: 'extensions/a', enabled: true }, { subdirectory: 'extensions/b', enabled }] } });
    const resolved = await f.read(reference(repo, repo.commit(), 'examples/x'));
    try {
      const plan = planCustomizationCatalog(resolved.root, EXTENSION_SDK_VERSION, 'desktop');
      identities.push(JSON.stringify(desktopCustomizationIdentity(plan)));
      assert.deepEqual(plan.entries.map(entry => entry.manifest.namespace), enabled ? ['alpha', 'beta'] : ['alpha']);
    } finally { await resolved.dispose(); }
  }
  assert.notEqual(identities[0], identities[1]);
});

test('installations parse structurally and reject secrets, extra keys, bad variables and a 65th grant', () => {
  const parse = installations => parseCustomizationPackage({ agentui: { installations } }, new Set());
  assert.equal(parse([grant('alpha')]).installations.length, 1);
  assert.deepEqual(parse([{ ...grant('alpha'), authentication: { kind: 'unauthenticated' } }]).installations[0].authentication, { kind: 'unauthenticated' });
  assert.equal(parse(Array.from({ length: 64 }, (_, index) => grant('alpha', { id: `g${index}` }))).installations.length, 64);
  for (const installations of [
    [{ ...grant('alpha'), authentication: { kind: 'secret', value: 'literal-secret' } }],
    [{ ...grant('alpha'), authentication: { kind: 'environment', variable: 'AGENTUI_EXTENSION_A', revision: '1', value: 'literal-secret' } }],
    [{ ...grant('alpha'), extra: true }],
    [{ ...grant('alpha'), authentication: { kind: 'environment', variable: 'HOME', revision: '1' } }],
    [{ ...grant('alpha'), authentication: { kind: 'environment', variable: 'AGENTUI_EXTENSION_bad-name', revision: '1' } }],
    Array.from({ length: 65 }, (_, index) => grant('alpha', { id: `g${index}` })),
    'not-an-array',
  ]) assert.throws(() => parse(installations), { code: 'invalid-package' });
});

test('installations in a referenced package are rejected', async t => {
  const f = await fixture(t);
  const repo = await f.repository('nested-grants');
  await shared(repo, 'child', { agentui: { installations: [grant('alpha')] } });
  await shared(repo, '', { agentui: { extensions: [{ subdirectory: 'child' }] } });
  await assert.rejects(f.read(reference(repo, repo.commit())), { code: 'invalid-package', message: /root/ });
});

test('a grant for a disabled namespace does not fail resolution', async t => {
  const f = await fixture(t);
  const repo = await exampleRepository(f, { installations: [grant('alpha'), grant('beta')] });
  await write(repo.directory, 'examples/x/package.json', { name: 'x', version: '0.0.0', agentui: {
    extensions: [{ subdirectory: 'extensions/a' }, { subdirectory: 'extensions/b', enabled: false }], installations: [grant('alpha'), grant('beta')] } });
  const resolved = await f.read(reference(repo, repo.commit(), 'examples/x'));
  try {
    assert.deepEqual(namesOf(resolved.root), ['alpha']);
    assert.equal(resolved.installations.length, 2);
  } finally { await resolved.dispose(); }
});

test('parsing a package with installations never reads the environment', async t => {
  const f = await fixture(t);
  const repo = await exampleRepository(f, { installations: [grant('alpha'), grant('beta')] });
  const commit = repo.commit();
  const saved = process.env;
  const reads = [];
  process.env = new Proxy({ ...saved }, { get(target, key) { if (typeof key === 'string' && key.startsWith('AGENTUI_EXTENSION_')) reads.push(key); return Reflect.get(target, key); },
    has(target, key) { if (typeof key === 'string' && key.startsWith('AGENTUI_EXTENSION_')) reads.push(key); return Reflect.has(target, key); } });
  for (const key of Object.keys(process.env)) if (key.startsWith('AGENTUI_EXTENSION_')) delete process.env[key];
  try {
    const resolved = await f.read(reference(repo, commit, 'examples/x'));
    await resolved.dispose();
    parseCustomizationPackage({ agentui: { installations: [grant('alpha')] } }, new Set());
  } finally { process.env = saved; }
  assert.deepEqual(reads, []);
});

test('refresh requests and the resolver root still reject the same-repository form', async t => {
  assert.throws(() => parseGitExtensionReference({ subdirectory: 'extensions/a' }), { code: 'invalid-package' });
  assert.throws(() => parseGitExtensionReference({ subdirectory: 'extensions/a', enabled: true, repository: '/tmp/x', commit: 'a'.repeat(40) }), { code: 'invalid-package' });
  const f = await fixture(t);
  await assert.rejects(f.read({ subdirectory: 'extensions/a' }), error => error instanceof CustomizationError && error.code === 'invalid-input');
});

test('the settings file parses with defaults, rejects bad input, and serializes byte-stably', () => {
  const minimal = parseCustomizationSettings('{ "version": 1 }');
  assert.deepEqual(minimal, { version: 1, appearance: 'system', showExtensionViews: true });
  const full = { version: 1, appearance: 'dark', showExtensionViews: false, defaultAgent: { kind: 'native', harness: 'codex', model: 'gpt-5' } };
  const text = serializeCustomizationSettings(full);
  assert.equal(text, '{\n  "version": 1,\n  "appearance": "dark",\n  "showExtensionViews": false,\n  "defaultAgent": {\n    "kind": "native",\n    "harness": "codex",\n    "model": "gpt-5"\n  }\n}\n');
  assert.equal(serializeCustomizationSettings(parseCustomizationSettings(text)), text);
  const provider = { version: 1, appearance: 'system', showExtensionViews: true, defaultAgent: { kind: 'provider', namespace: 'alpha', installationId: 'personal', providerAgentId: 'agent-1' } };
  const reordered = JSON.stringify({ defaultAgent: { providerAgentId: 'agent-1', installationId: 'personal', namespace: 'alpha', kind: 'provider' }, showExtensionViews: true, version: 1 });
  assert.equal(serializeCustomizationSettings(parseCustomizationSettings(reordered)), serializeCustomizationSettings(provider));
  for (const bad of [
    '{ "version": 1, "theme": "dark" }', '{ "version": 1, "appearance": "blue" }', '{ "version": 2 }', '{}', 'not json',
    '{ "version": 1, "showExtensionViews": "yes" }', '{ "version": 1, "defaultAgent": { "kind": "native" } }',
    JSON.stringify({ version: 1, defaultAgent: { kind: 'native', harness: 'x'.repeat(65) } }),
    JSON.stringify({ version: 1, defaultAgent: { kind: 'native', harness: 'codex', model: 'm'.repeat(129) } }),
    JSON.stringify({ version: 1, appearance: 'system' }) + ' '.repeat(16_384),
  ]) assert.throws(() => parseCustomizationSettings(bad), { code: 'invalid-settings' }, bad.slice(0, 80));
});

test('a package that uses none of the new forms parses exactly as before', async t => {
  const f = await fixture(t);
  const repo = await f.repository('plain');
  await shared(repo);
  const resolved = await f.read(reference(repo, repo.commit()));
  try {
    assert.deepEqual(resolved.root.customization, { shared: './source.ts', extensions: [] });
    assert.deepEqual(resolved.installations, []);
  } finally { await resolved.dispose(); }
  assert.equal(git(repo.directory, 'status', '--porcelain'), '');
});
