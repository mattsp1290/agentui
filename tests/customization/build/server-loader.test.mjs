import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import * as SDK from '@agentui/sdk';
import { loadServerArtifact } from '@agentui/host/extensions';
import { parseServerCustomizationArtifact, readServerCustomizationArtifact } from '@agentui/host/customization';
import { setup, expectation, resigned } from './server-support.mjs';

async function retained(t, catalog, lazy = 'export const value = 17;') {
  const f = await setup(t), built = await f.build();
  const assets = { 'entries.mjs': catalog, 'lazy.mjs': lazy, 'unused.mjs': lazy };
  const manifest = parseServerCustomizationArtifact(resigned(built.manifest, value => {
    value.assets = Object.entries(assets).map(([path, bytes]) => ({ path, size: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') }));
  }));
  for (const [path, bytes] of Object.entries(assets)) await writeFile(join(built.directory, path), bytes);
  await writeFile(join(built.directory, 'customization.json'), JSON.stringify(manifest));
  return { directory: built.directory, verified: await readServerCustomizationArtifact({ directory: built.directory, expected: expectation(manifest) }) };
}
const entry = body => `import {parseExtensionManifest, EXTENSION_SDK_VERSION} from '@agentui/sdk';
  export const entries = [{kind:'server', sdkVersion:EXTENSION_SDK_VERSION, activate() { ${body} }}];`;

test('retained loader preserves bytes, lazy imports, SDK identity and unrelated host imports until disposal', async t => {
  const f = await retained(t, entry("return {sdk:parseExtensionManifest, lazy:() => import('./lazy.mjs'), dispose(){}};"));
  await writeFile(join(f.directory, 'entries.mjs'), "throw new Error('MUTATED_CATALOG');");
  await writeFile(join(f.directory, 'lazy.mjs'), "throw new Error('MUTATED_LAZY');");
  const [loaded] = await loadServerArtifact(f.verified, import.meta.resolve('@agentui/sdk'));
  const lifetime = loaded.entry.activate({});
  assert.equal(lifetime.sdk, SDK.parseExtensionManifest);
  assert.equal((await lifetime.lazy()).value, 17);
  assert.equal((await import('node:path')).join('a', 'b'), 'a/b');
  assert.equal((await import('@agentui/host')).providerIdentity instanceof Function, true);
  await loaded.dispose();
  await loaded.dispose();
  const [second] = await loadServerArtifact(f.verified, import.meta.resolve('@agentui/sdk'));
  assert.notEqual(second.entry, loaded.entry);
  await second.dispose();
});

test('loader deregisters after import and export failures and denies nonartifact imports', async t => {
  for (const source of ["throw new Error('PRIVATE_IMPORT_FAILURE')", 'export const entries = [];', "import 'node:module'; export const entries = [];", "import '@agentui/host'; export const entries = [];"]) {
    const f = await retained(t, source);
    await assert.rejects(loadServerArtifact(f.verified, import.meta.resolve('@agentui/sdk')), { message: 'Server artifact loading failed' });
    assert.equal((await import('@agentui/sdk')).parseExtensionManifest, SDK.parseExtensionManifest);
    assert.equal((await import('node:module')).isBuiltin('node:fs'), true);
  }
});

test('lazy imports remain available through lifetime disposal and are unavailable after module disposal', async t => {
  const f = await retained(t, entry("return {lazy:() => import('./unused.mjs'), async dispose(){return (await import('./lazy.mjs')).value}};"));
  const [loaded] = await loadServerArtifact(f.verified, import.meta.resolve('@agentui/sdk'));
  const lifetime = loaded.entry.activate({});
  assert.equal(await lifetime.dispose(), 17);
  await loaded.dispose();
  await assert.rejects(lifetime.lazy());
});

test('simultaneous artifacts isolate identical relative filenames and dispose independently', async t => {
  const a = await retained(t, entry("return {lazy:() => import('./lazy.mjs'), dispose(){}};"), 'export const value = 1;');
  const b = await retained(t, entry("return {lazy:() => import('./lazy.mjs'), dispose(){}};"), 'export const value = 2;');
  const [first] = await loadServerArtifact(a.verified, import.meta.resolve('@agentui/sdk'));
  const [second] = await loadServerArtifact(b.verified, import.meta.resolve('@agentui/sdk'));
  assert.equal((await first.entry.activate({}).lazy()).value, 1);
  await first.dispose();
  assert.equal((await second.entry.activate({}).lazy()).value, 2);
  await second.dispose();
});

test('provider registry retains module ownership through lifetime cleanup and cleans activation failures once', async t => {
  const { createProviderRegistry } = await import('@agentui/host');
  const f = await retained(t, `import {EXTENSION_SDK_VERSION} from '@agentui/sdk';
    const trace=[];
    export const entries=[{kind:'server',sdkVersion:EXTENSION_SDK_VERSION,trace,probe:()=>import('./unused.mjs'),
      activate(){ return {async dispose(){trace.push((await import('./lazy.mjs')).value)}} }}];`);
  for (const fails of [false, true]) {
    const [loaded] = await loadServerArtifact(f.verified, import.meta.resolve('@agentui/sdk'));
    let releases = 0;
    const provider = { ...loaded, authority: { credentials: {}, issue(){ throw new Error('unused'); }, async close() {} },
      async dispose() { releases++; await loaded.dispose(); } };
    const registry = createProviderRegistry(fails ? [provider, { ...provider, manifest: { ...provider.manifest, namespace: 'failed' },
      entry: { ...provider.entry, activate(){ throw new Error('PRIVATE_ACTIVATION_FAILURE'); } }, dispose: undefined }] : [provider]);
    if (fails) await assert.rejects(registry.activate(), /Provider activation failed/);
    else await registry.activate();
    await registry.close(); await registry.close();
    assert.equal(releases, 1);
    assert.deepEqual(loaded.entry.trace, [17]);
    await assert.rejects(loaded.entry.probe());
  }
});
