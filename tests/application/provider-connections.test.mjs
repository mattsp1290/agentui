import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { crew, crewBackend, crewPresentation } from '../extensions/providers/contracts/crew.ts';
import { local, localBackend, localPresentation } from '../extensions/providers/contracts/local.ts';
import { ownDirectory } from '../../apps/host/build/tsc/ownership.js';

const artifact = new URL('../../apps/host/build/tsc/artifact.js', import.meta.url).href;
// The source entry lives in build/tsc; installed artifact bytes live beside dist/main.js.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './artifact.js' && context.parentURL?.endsWith('/server.js')) {
    const source = `export * from ${JSON.stringify(artifact)};
      import { readInstalledArtifact as read } from ${JSON.stringify(artifact)};
      export function readInstalledArtifact() { return read(${JSON.stringify(fileURLToPath(new URL('../../apps/host/dist/', import.meta.url)))}); }`;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { startBrowserHost } = await import('../../apps/host/build/tsc/server.js');
const sentinel = 'PRIVATE_PROVIDER_SENTINEL_98';
function options(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-provider-connections-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, port: 0, assetsDirectory: fileURLToPath(new URL('../../apps/desktop/web-dist-browser/', import.meta.url)) };
}
function extension({ backend = crewBackend, provider = crew, presentation = crewPresentation, service = 'http://127.0.0.1:12345',
  authentication = { kind: 'secret', revision: 'first', resolve: async () => sentinel }, connect, discover, activate, close, dispose } = {}) {
  const calls = { connect: 0, discover: 0, close: 0, dispose: 0, create: 0, submit: 0 };
  let context, credential;
  const connected = { ...backend,
    async discover() { calls.discover++; return discover ? discover({ context, credential, connected }) : backend.discover(); },
    async create() { calls.create++; assert.fail('unexpected create'); },
    async submit() { calls.submit++; assert.fail('unexpected submit'); },
    async close() { calls.close++; await close?.(); },
  };
  const contribution = { ...provider, async connect(request) {
    calls.connect++; credential = request.credential;
    if (connect) return connect({ request, context, connected });
    return { kind: 'connected', backend: connected };
  } };
  const entry = { kind: 'server', sdkVersion: EXTENSION_SDK_VERSION, async activate(value) {
    context = value;
    value.providers.add('service', contribution, presentation);
    await activate?.(value, contribution, presentation);
    return { async dispose() { calls.dispose++; await dispose?.(); } };
  } };
  return { calls, connected, get context() { return context; }, get credential() { return credential; }, value: {
    manifest: { namespace: presentation.instance.namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './server.js' }] },
    entry, installations: [{ id: 'service', instance: presentation.instance, service, authentication }],
  } };
}
function revoke(directory) {
  const database = new DatabaseSync(join(directory, 'host.sqlite'));
  database.prepare('UPDATE service_provider_credentials SET revoked=1').run();
  database.close();
}

test('real host activates two public models, authenticates read-only HTTP discovery, reuses connections and isolates colliding IDs', async t => {
  let requests = 0;
  const remote = createServer((request, response) => {
    requests++;
    assert.equal(request.method, 'GET'); assert.equal(request.url, '/agents');
    assert.equal(request.headers.authorization, `Bearer ${sentinel}`);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ kind: 'available', agents: [{ ref: { kind: 'agent', instance: crewPresentation.instance, opaqueId: 'same-agent' }, name: 'Remote assistant' }] }));
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  const service = `http://127.0.0.1:${remote.address().port}`;
  t.after(() => new Promise(resolve => remote.close(resolve)));
  const a = extension({ service, discover: ({ context, credential }) => context.credentials.use({ credential, service }, async secret => {
    const response = await fetch(`${service}/agents`, { headers: { authorization: `Bearer ${secret}` } });
    return response.json();
  }) });
  const b = extension({ provider: local, backend: localBackend, presentation: localPresentation, authentication: { kind: 'unauthenticated' } });
  const host = await startBrowserHost({ ...options(t), providerExtensions: [a.value, b.value] });
  try {
    const catalog = await host.discoverProviders();
    assert.equal(catalog.length, 2);
    assert.deepEqual(catalog.map(item => item.instance.namespace), ['example-crew', 'example-local']);
    assert.deepEqual(catalog.map(item => item.agents[0].opaqueId), ['same-agent', 'same-agent']);
    assert.equal(catalog[0].capabilities.cancel, false); assert.equal(catalog[1].capabilities.cancel, true);
    assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE_PROVIDER|opaqueHandle|revision/);
    assert.equal(b.credential, null);
    assert.equal(requests, 2); assert.equal(a.calls.connect, 1); assert.equal(b.calls.connect, 1);
    catalog[0].agents[0].name = 'caller mutation';
    assert.equal((await host.discoverProviders())[0].agents[0].name, 'Remote assistant');
    assert.throws(() => a.context.providers.add('late', crew, crewPresentation), /Invalid provider registration/);
  } finally { await host.close(); }
  for (const fixture of [a, b]) assert.deepEqual(fixture.calls, { connect: 1, discover: 3, close: 1, dispose: 1, create: 0, submit: 0 });
  await host.close();
  await assert.rejects(host.discoverProviders(), /discovery unavailable/);
});

for (const [name, change] of [
  ['duplicate contribution', context => context.providers.add('service', crew, crewPresentation)],
  ['duplicate full instance', context => context.providers.add('different', crew, crewPresentation)],
  ['wrong namespace', context => context.providers.add('different', local, localPresentation)],
  ['invalid presentation', context => context.providers.add('different', crew, { ...crewPresentation, instance: { ...crewPresentation.instance, installationId: 'other' }, apply: null })],
]) test(`activation rejects ${name} before any connection and disposes valid staged lifetimes`, async t => {
  const first = extension({ provider: local, backend: localBackend, presentation: localPresentation });
  const second = extension({ async activate(context) { try { change(context); } catch {} } });
  const configured = options(t);
  await assert.rejects(startBrowserHost({ ...configured, providerExtensions: [first.value, second.value] }), /^Error: Provider activation failed$/);
  assert.equal(first.calls.dispose, 1); assert.equal(second.calls.dispose, 1);
  assert.equal(first.calls.connect + second.calls.connect, 0);
  ownDirectory(configured.directory).close();
});

test('failed activation disposes earlier entries, refuses credentials and releases ownership', async t => {
  const first = extension({ provider: local, backend: localBackend, presentation: localPresentation });
  const failed = extension({ activate() { throw new Error(sentinel); } });
  const configured = options(t);
  await assert.rejects(startBrowserHost({ ...configured, providerExtensions: [first.value, failed.value] }), /^Error: Provider activation failed$/);
  assert.equal(first.calls.dispose, 1); assert.equal(failed.calls.dispose, 0);
  assert.equal(first.calls.connect + failed.calls.connect, 0);
  ownDirectory(configured.directory).close();
});

test('revocation during connect closes late backend exactly once before extension disposal', async t => {
  const configured = options(t), events = [];
  const fixture = extension({ async connect({ connected }) {
    await new Promise(resolve => setImmediate(resolve)); revoke(configured.directory);
    return { kind: 'connected', backend: connected };
  }, close() { events.push('close'); }, dispose() { events.push('dispose'); } });
  await assert.rejects(startBrowserHost({ ...configured, providerExtensions: [fixture.value] }), /^Error: Provider discovery failed$/);
  assert.deepEqual(events, ['close', 'dispose']);
  assert.equal(fixture.calls.discover, 0); assert.equal(fixture.calls.close, 1);
  ownDirectory(configured.directory).close();
});

test('failed startup drains a late peer connection and cleans both lifetimes', async t => {
  const configured = options(t), entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const bad = extension({ async discover() { await entered.promise; throw new Error(sentinel); } });
  const late = extension({ provider: local, backend: localBackend, presentation: localPresentation,
    async connect({ connected }) { entered.resolve(); await finish.promise; return { kind: 'connected', backend: connected }; } });
  let settled = false;
  const starting = startBrowserHost({ ...configured, providerExtensions: [bad.value, late.value] });
  const rejected = assert.rejects(starting, /^Error: Provider discovery failed$/).then(() => { settled = true; });
  await entered.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  finish.resolve(); await rejected;
  for (const fixture of [bad, late]) { assert.equal(fixture.calls.close, 1); assert.equal(fixture.calls.dispose, 1); }
  assert.equal(late.calls.discover, 0, 'peer failure freezes authority before late connection can discover');
  ownDirectory(configured.directory).close();
});

test('close freezes credential use, waits for discovery and discards late catalog before disposal', async t => {
  const configured = options(t), entered = Promise.withResolvers(), finish = Promise.withResolvers(), events = [];
  const fixture = extension({ async discover({ connected }) {
    if (fixture.calls.discover === 1) return crewBackend.discover();
    entered.resolve(); await finish.promise;
    assert.equal(fixture.calls.close, 0);
    return { kind: 'available', agents: [{ ref: { instance: connected.instance, kind: 'agent', opaqueId: 'late' }, name: 'Late agent' }] };
  }, close() { events.push('close'); }, dispose() { events.push('dispose'); } });
  const host = await startBrowserHost({ ...configured, providerExtensions: [fixture.value] });
  const discover = assert.rejects(host.discoverProviders(), /^Error: Provider discovery failed$/);
  await entered.promise;
  let done = false;
  const closing = host.close().then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false);
  await assert.rejects(fixture.context.credentials.use({ credential: fixture.credential, service: 'http://127.0.0.1:12345' }, async () => assert.fail('closed use')), /credential use refused/);
  finish.resolve(); await discover; await closing;
  assert.deepEqual(events, ['close', 'dispose']); assert.equal(fixture.calls.close, 1);
  ownDirectory(configured.directory).close();
});

for (const [name, discover] of [
  ['foreign reference', async () => localBackend.discover()],
  ['duplicate agents', async () => { const result = await crewBackend.discover(); return { ...result, agents: [...result.agents, ...result.agents] }; }],
  ['blank name', async () => { const result = await crewBackend.discover(); return { ...result, agents: [{ ...result.agents[0], name: ' ' }] }; }],
  ['unbounded JSON', async () => ({ kind: 'available', agents: [], extra: 'x'.repeat(16_000_001) })],
  ['private exception', async () => { throw new Error(sentinel); }],
]) test(`discovery rejects ${name} with fixed safe errors and closes acquired backend`, async t => {
  const fixture = extension({ discover }), configured = options(t);
  await assert.rejects(startBrowserHost({ ...configured, providerExtensions: [fixture.value] }), error => {
    assert.equal(error.message, 'Provider discovery failed'); assert.equal(error.cause, undefined); return true;
  });
  assert.equal(fixture.calls.close, 1); assert.equal(fixture.calls.dispose, 1);
  ownDirectory(configured.directory).close();
});

for (const [name, setup] of [
  ['missing provisioning', fixture => { fixture.value.installations = []; }],
  ['foreign installation', fixture => { fixture.value.installations[0].instance = { ...crewPresentation.instance, generation: 'other' }; }],
  ['old SDK', fixture => { fixture.value.entry.sdkVersion = '0.0.0'; }],
  ['invalid lifetime', fixture => { const activate = fixture.value.entry.activate; fixture.value.entry.activate = async context => { await activate(context); return {}; }; }],
]) test(`host refuses ${name} before provider effects`, async t => {
  const fixture = extension(), configured = options(t);
  setup(fixture);
  await assert.rejects(startBrowserHost({ ...configured, providerExtensions: [fixture.value] }), /Provider (activation|discovery) failed/);
  assert.equal(fixture.calls.connect, 0); assert.equal(fixture.calls.discover, 0);
  ownDirectory(configured.directory).close();
});

for (const [name, setup] of [
  ['foreign connected instance', connected => { connected.instance = localPresentation.instance; }],
  ['invalid capability', connected => { connected.capabilities = { ...connected.capabilities, create: { kind: 'maybe' } }; }],
]) test(`host closes ${name} before discovery`, async t => {
  const fixture = extension(), configured = options(t);
  setup(fixture.connected);
  await assert.rejects(startBrowserHost({ ...configured, providerExtensions: [fixture.value] }), /^Error: Provider discovery failed$/);
  assert.equal(fixture.calls.close, 1); assert.equal(fixture.calls.discover, 0); assert.equal(fixture.calls.dispose, 1);
  ownDirectory(configured.directory).close();
});

test('revocation discards overlapping discovery through one call and closes the backend once', async t => {
  const configured = options(t), entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const fixture = extension({ async discover() {
    if (fixture.calls.discover > 1) { entered.resolve(); await finish.promise; }
    return crewBackend.discover();
  } });
  const host = await startBrowserHost({ ...configured, providerExtensions: [fixture.value] });
  const first = assert.rejects(host.discoverProviders(), /^Error: Provider discovery failed$/);
  const second = assert.rejects(host.discoverProviders(), /^Error: Provider discovery failed$/);
  await entered.promise; revoke(configured.directory); finish.resolve();
  await Promise.all([first, second]); await host.close();
  assert.equal(fixture.calls.discover, 2); assert.equal(fixture.calls.close, 1); assert.equal(fixture.calls.dispose, 1);
});

test('provider cleanup failure remains visible and retains directory ownership', async t => {
  const configured = options(t), fixture = extension({ close() { throw new Error(sentinel); } });
  const host = await startBrowserHost({ ...configured, providerExtensions: [fixture.value] });
  await assert.rejects(host.close(), error => {
    assert.equal(error.message, 'Host shutdown failed');
    assert.equal(error.cause.message, 'Provider cleanup failed');
    assert.equal(error.cause.cause, undefined);
    return true;
  });
  await assert.rejects(host.close(), /Host shutdown failed/);
  assert.equal(fixture.calls.close, 1); assert.equal(fixture.calls.dispose, 1);
  assert.throws(() => ownDirectory(configured.directory), /Another host owns/);
});

test('shutdown drains separately admitted credential work before backend closure and extension disposal', async t => {
  const configured = options(t), fixture = extension(), entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const host = await startBrowserHost({ ...configured, providerExtensions: [fixture.value] });
  const use = fixture.context.credentials.use({ credential: fixture.credential, service: 'http://127.0.0.1:12345' }, async () => {
    entered.resolve(); await finish.promise; return 'late credential result';
  });
  const rejected = assert.rejects(use, /^Error: Provider credential use refused$/);
  await entered.promise;
  const closing = host.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.close, 0); assert.equal(fixture.calls.dispose, 0);
  finish.resolve(); await rejected; await closing;
  assert.equal(fixture.calls.close, 1); assert.equal(fixture.calls.dispose, 1);
});
