import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';
import { createBrowserConnection } from '@agentui/client/service';
import { createProviderRegistry } from '@agentui/host';
import { fixture as hostFixture, scope as hostScope } from '../host/fixture.mjs';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { crew, crewBackend, crewPresentation } from '../extensions/providers/contracts/crew.ts';
import { local, localBackend, localPresentation } from '../extensions/providers/contracts/local.ts';

const artifact = new URL('../../apps/host/build/tsc/artifact.js', import.meta.url).href;
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
const secret = 'PRIVATE_CREATION_SECRET';
function extension({ native = false, create, lookup, service = 'http://127.0.0.1:12345', revision = '1', generation, name } = {}) {
  const base = native ? localBackend : crewBackend, provider = native ? local : crew;
  const presentation = { ...(native ? localPresentation : crewPresentation) };
  if (generation) presentation.instance = { ...presentation.instance, generation };
  const calls = { creates: [], lookups: [], submits: 0 };
  let context, credential;
  const binding = operation => ({ kind: 'agentui-created', creation: operation, authority: {
    kind: native ? 'agentui-host' : 'remote-provider', ...(native ? { hostId: operation.scope.hostId } : {}),
    binding: { namespace: presentation.instance.namespace, installationId: presentation.instance.installationId, opaqueSessionId: 'same-session' },
  } });
  const confirmed = operation => ({ kind: 'confirmed', value: binding(operation), evidence: { operationId: operation.operationId } });
  const connected = { ...base, instance: presentation.instance,
    async discover() { return { kind: 'available', agents: [{ ref: { kind: 'agent', instance: presentation.instance, opaqueId: 'same-agent' }, name: name ?? (native ? 'Local provider' : 'Remote provider') }] }; },
    async create(operation) { calls.creates.push(structuredClone(operation)); return create ? create(operation, { confirmed, context, credential }) : confirmed(operation); },
    async reconcileCreation(operation) { calls.lookups.push(structuredClone(operation)); return lookup ? lookup(operation, { confirmed, context, credential }) : confirmed(operation); },
    async submit() { calls.submits++; assert.fail('Messaging must remain disabled'); }, async close() {},
  };
  return { calls, connected, confirmed, rename(value) { name = value; }, value: {
    manifest: { namespace: presentation.instance.namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './server.js' }] },
    entry: { kind: 'server', sdkVersion: EXTENSION_SDK_VERSION, activate(value) {
      context = value;
      value.providers.add('service', { ...provider, async connect(request) { credential = request.credential; return { kind: 'connected', backend: connected }; } }, presentation);
      return { async dispose() {} };
    } },
    installations: [{ id: 'service', instance: presentation.instance, service, expectedAuthority: native ? 'agentui-host' : 'remote-provider',
      authentication: { kind: 'secret', revision, resolve: async () => secret } }],
  } };
}
async function fixture(t, extensions) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-provider-create-'));
  let running, cookie;
  const control = op => new Promise((resolve, reject) => {
    const socket = createConnection(join(directory, 'control.sock')); let output = '';
    socket.once('error', reject); socket.once('connect', () => socket.end(`${JSON.stringify(op)}\n`));
    socket.on('data', data => { output += data; });
    socket.once('end', () => { const result = JSON.parse(output); if (result.ok) resolve(result.value); else reject(new Error(result.error)); });
  });
  const client = createBrowserConnection({ fetch: async (url, init) => {
    const response = await fetch(`${running.origin}${url}`, { ...init, headers: { ...init.headers, Origin: running.origin, ...(cookie ? { Cookie: cookie } : {}) } });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  } });
  const start = async values => {
    running = await startBrowserHost({ directory, port: 0, assetsDirectory: fileURLToPath(new URL('../../apps/desktop/web-dist-browser/', import.meta.url)), providerExtensions: values.map(item => item.value) });
    if (!cookie) await client.pair((await control({ op: 'invite' })).code);
  };
  await start(extensions);
  t.after(async () => { await running.close(); rmSync(directory, { recursive: true, force: true }); });
  const inspect = action => { const db = new DatabaseSync(join(directory, 'host.sqlite')); try { return action(db); } finally { db.close(); } };
  return { client, directory, inspect, get running() { return running; }, get cookie() { return cookie; },
    scope: id => ({ hostId: running.hostId, conversationId: id }),
    async restart(values) { await running.close(); await start(values); },
  };
}
const selected = async (f, label = 'Remote provider') => (await f.client.metadata()).agents.find(agent => agent.label === label);
const unavailable = promise => assert.rejects(promise, error => error.kind === 'unavailable');

 test('public activation and authenticated chooser create distinct provider models, SQLite commits before HTTP effects, native history stays intact', async t => {
  let f;
  const remote = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    let body = ''; for await (const part of request) body += part;
    const operation = JSON.parse(body);
    const row = f.inspect(db => db.prepare('SELECT original,status FROM provider_creations WHERE conversation=?').get(operation.scope.conversationId));
    assert.equal(row.status, 'attempted'); assert.deepEqual(JSON.parse(row.original).intent, operation);
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(a.confirmed(operation)));
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => remote.close(resolve)));
  const service = `http://127.0.0.1:${remote.address().port}`;
  const a = extension({ service, create: (operation, { context, credential }) => context.credentials.use({ credential, service }, async token => {
    const response = await fetch(service, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(operation) });
    return response.json();
  }) }), b = extension({ native: true });
  f = await fixture(t, [a, b]);
  const metadata = await f.client.metadata(), first = await selected(f), second = await selected(f, 'Local provider');
  assert.equal(metadata.compatibility.wireVersion, 3); assert.notEqual(first.id, second.id);
  assert.equal(first.kind, 'provider'); assert.equal('runtime' in first, false); assert.deepEqual(first.commands, []);
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE_CREATION|opaqueHandle|revision/);
  const nativeScope = f.scope('native'); await f.client.create(nativeScope, metadata.defaultAgentId);
  const nativeBytes = f.inspect(db => db.prepare('SELECT installation,document FROM conversations WHERE conversation=?').get('native'));
  const scope = f.scope('remote');
  await Promise.all([f.client.create(scope, first.id), f.client.create(scope, first.id)]);
  await f.client.create(f.scope('local'), second.id);
  assert.equal(a.calls.creates.length, 1); assert.equal(b.calls.creates.length, 1);
  assert.equal((await f.client.conversation(scope).submit({ version: 1, scope, clientCommandId: 'blocked', body: { kind: 'send', text: 'no effect' } })).kind, 'rejected');
  assert.equal(a.calls.submits + b.calls.submits, 0);
  await f.restart([]);
  assert.deepEqual(await f.client.create(scope, first.id), scope);
  assert.equal((await f.client.conversationAgent(scope)).availability.kind, 'unavailable');
  assert.equal((await f.client.catalog()).length, 3);
  assert.deepEqual(f.inspect(db => db.prepare('SELECT installation,document FROM conversations WHERE conversation=?').get('native')), nativeBytes);
  assert.equal(f.inspect(db => db.prepare('SELECT version FROM conversations WHERE conversation=?').get('remote').version), 2);
});

test('removed agent is a known negative only with no original provider operation or local conversation', async t => {
  const a = extension({ create() { throw new Error('Reply lost'); } }), f = await fixture(t, [a]);
  const agent = await selected(f), unknown = f.scope('unknown'), absent = f.scope('absent');
  const native = f.scope('native'), metadata = await f.client.metadata();
  await f.client.create(native, metadata.defaultAgentId);
  await unavailable(f.client.create(unknown, agent.id));
  const original = f.inspect(db => db.prepare('SELECT original,status FROM provider_creations').get());
  await f.restart([]);
  assert.equal(await f.client.conversationAgent(absent), null);
  await assert.rejects(f.client.create(absent, agent.id), error => error.kind === 'create-rejected');
  await unavailable(f.client.create(unknown, agent.id));
  await assert.rejects(f.client.create(native, agent.id), error => error.kind === 'invalid');
  assert.deepEqual(f.inspect(db => db.prepare('SELECT original,status FROM provider_creations').get()), original);
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS count FROM conversations WHERE conversation=?').get('absent').count), 0);
  assert.equal(a.calls.creates.length, 1);
  assert.deepEqual(a.calls.lookups, []);
});

test('lost response and restart reconcile only the original immutable operation; concurrent recovery shares its lease', async t => {
  const a = extension({ create() { throw new Error(secret); } }), f = await fixture(t, [a]);
  const agent = await selected(f), scope = f.scope('lost');
  await unavailable(f.client.create(scope, agent.id));
  assert.equal((await f.client.catalog()).length, 0);
  assert.equal((await f.client.conversationAgent(scope)).id, agent.id);
  const row = f.inspect(db => db.prepare('SELECT original FROM provider_creations').get().original);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const next = extension({ lookup: async (operation, { confirmed }) => { entered.resolve(); await release.promise; return confirmed(operation); } });
  await f.restart([next]);
  const first = f.client.create(scope, agent.id); await entered.promise;
  const second = f.client.create(scope, agent.id); await new Promise(resolve => setTimeout(resolve, 20));
  release.resolve(); await Promise.all([first, second]);
  assert.equal(next.calls.creates.length, 0); assert.equal(next.calls.lookups.length, 1);
  assert.deepEqual(next.calls.lookups[0], a.calls.creates[0]);
  assert.equal(f.inspect(db => db.prepare('SELECT original FROM provider_creations').get().original), row);
  assert.equal(f.inspect(db => JSON.parse(db.prepare('SELECT observation FROM provider_creations').get().observation).source), 'lookup');
});

for (const field of ['scope', 'operation', 'agent', 'generation', 'namespace', 'protocol', 'kind', 'host']) {
  test(`foreign confirmed ${field} never publishes a conversation`, async t => {
    const native = field === 'host';
    const a = extension({ native, create(operation, { confirmed }) {
      const result = confirmed(structuredClone(operation)), value = result.value;
      if (field === 'scope') value.creation.scope.conversationId = 'another-conversation';
      if (field === 'operation') value.creation.operationId = '00000000-0000-4000-8000-000000000000';
      if (field === 'agent') value.creation.agent.opaqueId = 'foreign';
      if (field === 'generation') value.creation.agent.instance.generation = 'foreign';
      if (field === 'namespace') value.authority.binding.namespace = 'foreign';
      if (field === 'protocol') value.creation.agent.instance.protocolVersion = 'foreign';
      if (field === 'kind') value.authority = { ...value.authority, kind: 'agentui-host', hostId: operation.scope.hostId };
      if (field === 'host') value.authority.hostId = 'foreign';
      return result;
    } });
    const f = await fixture(t, [a]), agent = await selected(f, native ? 'Local provider' : 'Remote provider');
    await unavailable(f.client.create(f.scope('foreign'), agent.id));
    assert.deepEqual(await f.client.catalog(), []);
  });
}

test('unknown lookup and missing generation retain original agent, credential and unresolved intent; known rejection stays terminal', async t => {
  const a = extension({ create: () => ({ kind: 'uncertain', reason: 'lost', evidence: null }) }), f = await fixture(t, [a]);
  const agent = await selected(f), scope = f.scope('pending');
  await unavailable(f.client.create(scope, agent.id));
  const original = f.inspect(db => db.prepare('SELECT original FROM provider_creations').get().original);
  const changed = extension({ generation: 'replacement' }); await f.restart([changed]);
  const replacement = await selected(f);
  assert.notEqual(agent.id, replacement.id);
  await assert.rejects(f.client.create(scope, replacement.id), error => error.kind === 'invalid');
  await unavailable(f.client.create(scope, agent.id));
  assert.equal(changed.calls.creates.length + changed.calls.lookups.length, 0);
  assert.equal((await f.client.conversationAgent(scope)).id, agent.id);
  const unknown = extension({ lookup: () => ({ kind: 'unavailable', reason: secret }) }); await f.restart([unknown]);
  await unavailable(f.client.create(scope, agent.id));
  assert.equal(unknown.calls.creates.length, 0); assert.equal(unknown.calls.lookups.length, 1);
  assert.equal(f.inspect(db => db.prepare('SELECT original FROM provider_creations').get().original), original);
  const rejected = extension({ lookup: () => ({ kind: 'rejected', reason: secret, evidence: { originalRejected: true } }) });
  await f.restart([rejected]);
  for (let i = 0; i < 2; i++) await assert.rejects(f.client.create(scope, agent.id), error => error.kind === 'create-rejected' && !error.message.includes(secret));
  assert.equal(rejected.calls.lookups.length, 1); assert.deepEqual(await f.client.catalog(), []);
});

test('SQLite failure after confirmation recovers by lookup; a stray local row never proves creation', async t => {
  const a = extension({ create(operation, { confirmed }) {
    f.inspect(db => db.exec("CREATE TRIGGER fail_creation BEFORE INSERT ON conversations BEGIN SELECT RAISE(ABORT,'injected failure'); END"));
    return confirmed(operation);
  } }), f = await fixture(t, [a]), agent = await selected(f), scope = f.scope('commit');
  await unavailable(f.client.create(scope, agent.id));
  assert.equal(f.inspect(db => db.prepare('SELECT status FROM provider_creations').get().status), 'attempted');
  assert.deepEqual(await f.client.catalog(), []);
  f.inspect(db => db.exec('DROP TRIGGER fail_creation'));
  const next = extension(); await f.restart([next]);
  await f.client.create(scope, agent.id);
  assert.equal(next.calls.creates.length, 0); assert.equal(next.calls.lookups.length, 1);
  f.inspect(db => db.exec('DELETE FROM provider_creations; UPDATE service_provider_credentials SET revoked=1'));
  await unavailable(f.client.create(scope, agent.id));
  assert.equal(next.calls.creates.length, 0);
  await f.restart([]);
  await unavailable(f.client.create(scope, agent.id));
});

test('reserved restart never dispatches create, original credentials cannot be rebound, and revocation discards late confirmation', async t => {
  const a = extension({ create: () => ({ kind: 'pending', evidence: null }) }), f = await fixture(t, [a]), agent = await selected(f), scope = f.scope('reserved');
  await unavailable(f.client.create(scope, agent.id));
  f.inspect(db => db.exec("UPDATE provider_creations SET status='reserved',observation=NULL"));
  const revised = extension({ revision: '2' }); await f.restart([revised]);
  await unavailable(f.client.create(scope, agent.id));
  assert.equal(revised.calls.creates.length + revised.calls.lookups.length, 0);
  const original = extension({ lookup(operation, { confirmed }) {
    f.inspect(db => db.exec('UPDATE service_provider_credentials SET revoked=1'));
    return confirmed(operation);
  } });
  await f.restart([original]);
  await unavailable(f.client.create(scope, agent.id));
  assert.equal(original.calls.creates.length, 0); assert.equal(original.calls.lookups.length, 1);
  assert.deepEqual(await f.client.catalog(), []);
});

test('browser chooser opens an empty provider conversation, disables Send, and releases definitive refusals', { timeout: 30000 }, async t => {
  let refuse = true;
  const a = extension({ create: (operation, { confirmed }) => refuse ? { kind: 'rejected', reason: 'permanent refusal', evidence: null } : confirmed(operation) });
  const f = await fixture(t, [a]);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext();
  await context.addCookies([{ name: f.cookie.split('=')[0], value: f.cookie.split('=')[1], url: f.running.origin }]);
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  await page.goto(`${f.running.origin}/browser.html`);
  const agent = await selected(f);
  const harness = page.getByRole('button', { name: /^Harness,/ });
  const chooseProvider = async () => {
    await harness.click();
    await page.getByRole('button', { name: 'Provider', exact: true }).click();
    await page.getByRole('button', { name: `Start new chat with ${agent.label}`, exact: true }).click();
  };
  await chooseProvider();
  await page.getByRole('alert').filter({ hasText: 'did not create' }).waitFor();
  assert.equal(await harness.isEnabled(), true);
  assert.equal(await page.locator('.creation-recovery').count(), 0);
  refuse = false; await chooseProvider();
  await page.getByRole('status').filter({ hasText: 'Conversation connected' }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled(), false);
  assert.match(await page.locator('.composer-footer').textContent(), /Messaging is not available yet/);
  assert.equal(await page.getByRole('button', { name: 'Harness, Provider', exact: true }).count(), 1);
  await page.getByRole('button', { name: `Model, ${agent.label}`, exact: true }).click();
  assert.equal(await page.getByRole('button', { name: `${agent.label}, current model`, exact: true }).isDisabled(), true);
  assert.equal(a.calls.creates.length, 2); assert.equal(a.calls.submits, 0);
});

for (const kind of ['not-dispatched', 'unsupported', 'authentication-failed']) {
  test(`fresh ${kind} is a known negative, while lookup failure preserves uncertainty`, async t => {
    const a = extension({ create: () => ({ kind, reason: secret }) }), f = await fixture(t, [a]), agent = await selected(f), scope = f.scope('negative');
    for (let i = 0; i < 2; i++) await assert.rejects(f.client.create(scope, agent.id), error => error.kind === 'create-rejected');
    assert.equal(a.calls.creates.length, 1); assert.equal(a.calls.lookups.length, 0);
    assert.deepEqual(await f.client.catalog(), []);
  });
}

test('host-owned installation refuses a remote authority claim and pre-effect revocation creates nothing', async t => {
  const a = extension({ native: true, create(operation, { confirmed }) {
    const result = confirmed(operation); delete result.value.authority.hostId; result.value.authority.kind = 'remote-provider'; return result;
  } }), f = await fixture(t, [a]), agent = await selected(f, 'Local provider');
  await unavailable(f.client.create(f.scope('wrong-kind'), agent.id));
  f.inspect(db => db.exec('UPDATE service_provider_credentials SET revoked=1'));
  await assert.rejects(f.client.create(f.scope('revoked'), agent.id), error => error.kind === 'create-rejected');
  assert.equal(a.calls.creates.length, 1); assert.deepEqual(await f.client.catalog(), []);
});

test('shutdown drains an admitted creation and restart looks up its original operation', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const a = extension({ async create(operation, { confirmed }) { entered.resolve(); await release.promise; return confirmed(operation); } });
  const f = await fixture(t, [a]), agent = await selected(f), scope = f.scope('shutdown');
  const creating = unavailable(f.client.create(scope, agent.id)); await entered.promise;
  let closed = false;
  const stopping = f.running.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release.resolve(); await creating; await stopping;
  const b = extension(); await f.restart([b]);
  await f.client.create(scope, agent.id);
  assert.deepEqual(b.calls.lookups, a.calls.creates); assert.equal(b.calls.creates.length, 0);
});

for (const kind of ['not-dispatched', 'unsupported', 'authentication-failed']) {
  test(`lookup ${kind} cannot erase admitted processing or release the pending creation`, async t => {
    const evidence = { admitted: true };
    const a = extension({ create: () => ({ kind: 'pending', evidence }), lookup: () => ({ kind, reason: 'lookup refusal' }) });
    const f = await fixture(t, [a]), agent = await selected(f), scope = f.scope('admitted');
    await unavailable(f.client.create(scope, agent.id));
    await unavailable(f.client.create(scope, agent.id));
    const observation = f.inspect(db => JSON.parse(db.prepare('SELECT observation FROM provider_creations').get().observation));
    assert.deepEqual(observation, { kind: 'pending', source: 'create', evidence });
    assert.equal(a.calls.creates.length, 1); assert.equal(a.calls.lookups.length, 1);
  });
}


test('provider display rename preserves HTTP identity, confirmed history and original lost-reply recovery', async t => {
  const a = extension({ name: 'Before', create: (operation, { confirmed }) => operation.scope.conversationId === 'lost-rename'
    ? { kind: 'uncertain', reason: 'lost response', evidence: null } : confirmed(operation) });
  const f = await fixture(t, [a]), agent = await selected(f, 'Before');
  const confirmedScope = f.scope('confirmed-rename'), lostScope = f.scope('lost-rename');
  await f.client.create(confirmedScope, agent.id);
  await unavailable(f.client.create(lostScope, agent.id));
  const originals = f.inspect(db => db.prepare('SELECT conversation,original FROM provider_creations ORDER BY conversation').all());
  const next = extension({ name: 'After' }); await f.restart([next]);
  const renamed = await selected(f, 'After');
  assert.equal(renamed.id, agent.id);
  assert.deepEqual(await f.client.conversationAgent(confirmedScope), renamed);
  assert.equal(renamed.availability.kind, 'ready');
  assert.deepEqual(await f.client.create(confirmedScope, renamed.id), confirmedScope);
  assert.deepEqual(await f.client.create(lostScope, renamed.id), lostScope);
  assert.equal(next.calls.creates.length, 0);
  assert.deepEqual(next.calls.lookups, [a.calls.creates[1]]);
  assert.deepEqual(f.inspect(db => db.prepare('SELECT conversation,original FROM provider_creations ORDER BY conversation').all()), originals);
  assert.deepEqual(f.inspect(db => db.prepare('SELECT installation FROM conversations ORDER BY conversation').all().map(row => JSON.parse(row.installation).agent.name)), ['Before', 'Before']);
});

test('live rediscovery accepts an already selected agent after its display name changes', async t => {
  const a = extension({ name: 'Before' }), f = await fixture(t, [a]), agent = await selected(f, 'Before');
  a.rename('After');
  const catalog = await f.running.discoverProviders();
  assert.equal(catalog[0].agents[0].name, 'After');
  const scope = f.scope('rediscovered');
  assert.deepEqual(await f.client.create(scope, agent.id), scope);
  assert.equal(a.calls.creates.length, 1);
  assert.equal(f.inspect(db => JSON.parse(db.prepare('SELECT original FROM provider_creations').get().original).installation.agent.name), 'Before');
});

test('direct creation retry accepts a display rename while retaining its captured intent and rejecting foreign identity', async t => {
  const a = extension({ name: 'Before', create: () => ({ kind: 'pending', evidence: null }) });
  const registry = createProviderRegistry([{ ...a.value, authority: {
    credentials: {}, issue: () => ({ credential: null, expectedAuthority: 'remote-provider', assertAuthorized() {} }), async close() {},
  } }]);
  await registry.activate(); t.after(() => registry.close());
  const [discovered] = await registry.discover();
  const target = { kind: 'provider', contributionId: discovered.contributionId, instance: discovered.instance,
    agent: discovered.agents[0], presentationVersion: 1, expectedAuthority: discovered.expectedAuthority };
  const f = hostFixture(t), host = f.open();
  assert.equal((await host.createProviderConversation(hostScope, target, registry)).kind, 'pending');
  const captured = host.creation(hostScope);
  a.rename('After'); await registry.discover();
  const renamed = { ...target, agent: { ...target.agent, name: 'After' } };
  assert.equal((await host.createProviderConversation(hostScope, renamed, registry)).kind, 'confirmed');
  assert.deepEqual(host.creation(hostScope).installation, captured.installation);
  assert.deepEqual(host.creation(hostScope).intent, captured.intent);
  assert.deepEqual(host.creation(hostScope).credential, captured.credential);
  assert.deepEqual(a.calls.lookups, a.calls.creates);
  for (const changed of [
    { ...renamed, agent: { ...renamed.agent, opaqueId: 'foreign' } },
    { ...renamed, instance: { ...renamed.instance, generation: 'foreign' } },
    { ...renamed, contributionId: 'foreign' },
    { ...renamed, expectedAuthority: 'agentui-host' },
  ]) await assert.rejects(host.createProviderConversation(hostScope, changed, registry), /Creation agent is immutable/);
  assert.equal(a.calls.creates.length, 1); assert.equal(a.calls.lookups.length, 1);
});
