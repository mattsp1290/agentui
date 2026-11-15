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
import { createBrowserConnection } from '@agentui/client/service';
import { createProviderRegistry } from '@agentui/host';
import { createServerExtensions } from '@agentui/host/extensions';
import { entry } from '../host/extensions/fixtures.mjs';
import { fixture as hostFixture, scope as hostScope, snapshot } from '../host/fixture.mjs';
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
function extension({ native = false, create, lookup, submit, reconcile, request, decode, reconcileSupported = true, service = 'http://127.0.0.1:12345', revision = '1', generation, name } = {}) {
  const base = native ? localBackend : crewBackend, provider = native ? local : crew;
  const presentation = { ...(native ? localPresentation : crewPresentation) };
  if (generation) presentation.instance = { ...presentation.instance, generation };
  const calls = { creates: [], lookups: [], submits: [], reconciles: [], translations: 0, close: 0, dispose: 0 };
  const originalRequest = presentation.request;
  presentation.request = (text, binding) => { calls.translations++; return request ? request(text, binding) : originalRequest(text, binding); };
  if (decode) presentation.decodeRequest = decode;
  let context, credential;
  const binding = operation => ({ kind: 'agentui-created', creation: operation, authority: {
    kind: native ? 'agentui-host' : 'remote-provider', ...(native ? { hostId: operation.scope.hostId } : {}),
    binding: { namespace: presentation.instance.namespace, installationId: presentation.instance.installationId, opaqueSessionId: 'same-session' },
  } });
  const confirmed = operation => ({ kind: 'confirmed', value: binding(operation), evidence: { operationId: operation.operationId } });
  const effect = (operation, state = 'accepted', run = 'same-run') => ({ kind: 'confirmed', value: { kind: 'send', state,
    run: { binding: operation.binding, ref: { kind: 'run', instance: presentation.instance, opaqueId: run } } }, evidence: { accepted: true } });
  const connected = { ...base, instance: presentation.instance,
    capabilities: { ...base.capabilities, reconcile: reconcileSupported ? { kind: 'supported' } : { kind: 'unsupported', reason: 'No lookup' } },
    async discover() { return { kind: 'available', agents: [{ ref: { kind: 'agent', instance: presentation.instance, opaqueId: 'same-agent' }, name: name ?? (native ? 'Local provider' : 'Remote provider') }] }; },
    async create(operation) { calls.creates.push(structuredClone(operation)); return create ? create(operation, { confirmed, context, credential }) : confirmed(operation); },
    async reconcileCreation(operation) { calls.lookups.push(structuredClone(operation)); return lookup ? lookup(operation, { confirmed, context, credential }) : confirmed(operation); },
    async submit(operation) { calls.submits.push(structuredClone(operation)); return submit ? submit(operation, { effect, context, credential }) : effect(operation); },
    async reconcileCommand(operation) { calls.reconciles.push(structuredClone(operation)); return reconcile ? reconcile(operation, { effect, context, credential }) : effect(operation); }, async close() { calls.close++; },
  };
  return { calls, connected, confirmed, effect, get context() { return context; }, get credential() { return credential; }, rename(value) { name = value; }, value: {
    manifest: { namespace: presentation.instance.namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './server.js' }] },
    entry: { kind: 'server', sdkVersion: EXTENSION_SDK_VERSION, activate(value) {
      context = value;
      value.providers.add('service', { ...provider, async connect(request) { credential = request.credential; return { kind: 'connected', backend: connected }; } }, presentation);
      return { async dispose() { calls.dispose++; } };
    } },
    installations: [{ id: 'service', instance: presentation.instance, service, expectedAuthority: native ? 'agentui-host' : 'remote-provider',
      authentication: { kind: 'secret', revision, resolve: async () => secret } }],
  } };
}
async function fixture(t, extensions) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-provider-send-'));
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
const send = (scope, id = 'send', text = 'Hello') => ({ version: 1, scope, clientCommandId: id, body: { kind: 'send', text } });
const stored = (f, conversation) => f.inspect(db => db.prepare('SELECT target,observation,receipt FROM commands WHERE conversation=?').get(conversation));
async function create(f, name = 'chat', label) { const scope = f.scope(name); await f.client.create(scope, (await selected(f, label)).id); return scope; }


test('authenticated send commits exact target before HTTP effect, persists accepted runs for distinct typed models, and emits receipts only', async t => {
  let f;
  const remote = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    let body = ''; for await (const part of request) body += part;
    const operation = JSON.parse(body), row = stored(f, operation.binding.creation.scope.conversationId);
    assert.deepEqual(JSON.parse(row.target).operation, operation);
    assert.equal(JSON.parse(row.receipt).state.kind, 'pending');
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(a.effect(operation)));
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => remote.close(resolve)));
  const service = `http://127.0.0.1:${remote.address().port}`;
  const a = extension({ service, submit: (operation, { context, credential }) => context.credentials.use({ credential, service }, async token => {
    return (await fetch(service, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(operation) })).json();
  }) }), b = extension({ native: true, submit: (operation, { effect }) => effect(operation, 'completed') });
  f = await fixture(t, [a, b]);
  const metadata = await f.client.metadata(); assert.equal(metadata.compatibility.wireVersion, 4);
  for (const agent of metadata.agents.filter(agent => agent.kind === 'provider')) assert.deepEqual(agent.commands, agent.label === 'Local provider' ? ['send', 'cancel', 'approve'] : ['send', 'approve']);
  const scope = await create(f, 'remote'), local = await create(f, 'local', 'Local provider');
  const native = f.scope('native'); await f.client.create(native, metadata.defaultAgentId);
  const nativeBytes = f.inspect(db => db.prepare("SELECT installation,document FROM conversations WHERE conversation='native'").get());
  assert.equal((await f.client.conversation(scope).submit(send(scope))).receipt.state.kind, 'accepted');
  assert.equal((await f.client.conversation(local).submit(send(local))).receipt.state.kind, 'completed');
  assert.deepEqual(a.calls.submits[0].request, { member: 'research', text: 'Hello' });
  assert.deepEqual(b.calls.submits[0].request, { input: [{ role: 'user', content: 'Hello' }] });
  const runs = f.inspect(db => db.prepare('SELECT conversation,data FROM runs ORDER BY conversation').all());
  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map(row => JSON.parse(row.data).identity.runId), ['same-run', 'same-run']);
  assert.deepEqual(runs.map(row => JSON.parse(row.data).identity.authority.kind), ['agentui-host', 'remote-provider']);
  assert.equal(f.inspect(db => db.prepare("SELECT COUNT(*) AS n FROM events WHERE json_extract(payload,'$.event.kind')<>'receipt'").get().n), 0);
  assert.equal((await f.client.conversation(scope).submit(send(scope, 'next'))).reason, 'send-awaiting-confirmation');
  for (const body of [{ kind: 'cancel', runId: 'same-run' }, { kind: 'approve', pendingId: 'same-decision', choiceId: 'same-choice' }]) {
    assert.equal((await f.client.conversation(scope).submit({ ...send(scope, body.kind), body })).kind, 'rejected');
  }
  await f.restart([]);
  assert.deepEqual(await f.client.conversation(scope).submit(send(scope)), { kind: 'receipt', receipt: JSON.parse(stored(f, 'remote').receipt) });
  assert.equal((await f.client.reconcile(scope, 'send')).state.kind, 'accepted');
  assert.deepEqual(f.inspect(db => db.prepare('SELECT conversation,data FROM runs ORDER BY conversation').all()), runs);
  assert.deepEqual(f.inspect(db => db.prepare("SELECT installation,document FROM conversations WHERE conversation='native'").get()), nativeBytes);
});

test('lost response and restart retry never translate or submit; explicit lookup receives original bytes and rejects a changed run', async t => {
  const a = extension({ submit() { throw new Error('Reply lost'); } }), f = await fixture(t, [a]), scope = await create(f);
  const original = await f.client.conversation(scope).submit(send(scope));
  assert.equal(original.receipt.state.kind, 'uncertain'); assert.equal(a.calls.translations, 1);
  const target = stored(f, 'chat').target;
  const b = extension({ request() { assert.fail('Retry must not translate'); } }); await f.restart([b]);
  assert.deepEqual(await f.client.conversation(scope).submit(send(scope)), original);
  assert.equal((await f.client.conversation(scope).submit(send(scope, 'send', 'different'))).reason, 'command-id-conflict');
  assert.equal(b.calls.translations + b.calls.submits.length + b.calls.reconciles.length, 0);
  const accepted = await f.client.reconcile(scope, 'send'); assert.equal(accepted.state.kind, 'accepted');
  assert.deepEqual(b.calls.reconciles, a.calls.submits); assert.equal(stored(f, 'chat').target, target);
  const run = f.inspect(db => db.prepare('SELECT data FROM runs').get().data);
  b.connected.reconcileCommand = async operation => b.effect(operation, 'completed', 'different-run');
  await unavailable(f.client.reconcile(scope, 'send'));
  assert.equal((await f.client.conversation(scope).receipt('send')).state.kind, 'accepted');
  assert.equal(f.inspect(db => db.prepare('SELECT data FROM runs').get().data), run);
  b.connected.reconcileCommand = async operation => b.effect(operation, 'completed');
  assert.equal((await f.client.reconcile(scope, 'send')).state.kind, 'completed');
  assert.equal(f.inspect(db => db.prepare("SELECT COUNT(*) AS n FROM events WHERE json_extract(payload,'$.event.kind')<>'receipt'").get().n), 0);
});

for (const state of ['pending', 'accepted']) {
  test(`${state} positive facts survive weaker lookups, replaced credentials, missing generations and revocation`, async t => {
    const a = extension({ submit: (operation, { effect }) => state === 'pending' ? { kind: 'pending', evidence: { admitted: true } } : effect(operation) });
    const f = await fixture(t, [a]), scope = await create(f);
    const original = await f.client.conversation(scope).submit(send(scope)), bytes = stored(f, 'chat');
    for (const kind of ['unavailable', 'authentication-failed', 'unsupported', 'not-dispatched', 'uncertain']) {
      a.connected.reconcileCommand = async () => ({ kind, reason: secret, ...(kind === 'uncertain' ? { evidence: null } : {}) });
      assert.deepEqual(await f.client.reconcile(scope, 'send'), original.receipt);
      assert.deepEqual(stored(f, 'chat'), bytes);
    }
    for (const change of [{ revision: '2' }, { generation: 'replacement' }]) {
      const b = extension(change); await f.restart([b]);
      assert.deepEqual(await f.client.conversation(scope).submit(send(scope)), original);
      assert.deepEqual(await f.client.reconcile(scope, 'send'), original.receipt);
      assert.equal(b.calls.translations + b.calls.submits.length + b.calls.reconciles.length, 0);
      assert.deepEqual(stored(f, 'chat'), bytes);
    }
    const b = extension(); await f.restart([b]);
    f.inspect(db => db.exec('UPDATE service_provider_credentials SET revoked=1'));
    assert.deepEqual(await f.client.reconcile(scope, 'send'), original.receipt);
    assert.equal(b.calls.reconciles.length, 0); assert.deepEqual(stored(f, 'chat'), bytes);
  });
}

for (const field of ['scope', 'operation', 'generation', 'protocol', 'namespace', 'installation', 'authority', 'host', 'session', 'effect']) {
  test(`foreign ${field} in command confirmation cannot establish acceptance or a run`, async t => {
    const a = extension({ native: field === 'host', submit(operation, { effect }) {
      const result = structuredClone(effect(operation)), run = result.value.run;
      if (field === 'scope') run.binding.creation.scope.conversationId = 'foreign';
      if (field === 'operation') run.binding.creation.operationId = '00000000-0000-4000-8000-000000000000';
      if (field === 'generation') run.ref.instance.generation = 'foreign';
      if (field === 'protocol') run.ref.instance.protocolVersion = 'foreign';
      if (field === 'namespace') run.ref.instance.namespace = 'foreign';
      if (field === 'installation') run.ref.instance.installationId = 'foreign';
      if (field === 'authority') run.binding.authority = { ...run.binding.authority, kind: 'agentui-host', hostId: operation.binding.creation.scope.hostId };
      if (field === 'host') run.binding.authority.hostId = 'foreign';
      if (field === 'session') run.binding.authority.binding.opaqueSessionId = 'foreign';
      if (field === 'effect') result.value.kind = 'cancel';
      return result;
    } });
    const f = await fixture(t, [a]), scope = await create(f, 'chat', field === 'host' ? 'Local provider' : 'Remote provider');
    assert.equal((await f.client.conversation(scope).submit(send(scope))).receipt.state.kind, 'uncertain');
    assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM runs').get().n), 0);
  });
}

test('decoder drift refuses lookup without replacing the captured operation; revocation during submit discards the late response', async t => {
  const a = extension({ submit() { throw new Error('Reply lost'); } }), f = await fixture(t, [a]), scope = await create(f);
  await f.client.conversation(scope).submit(send(scope)); const target = stored(f, 'chat').target;
  const b = extension({ decode: () => ({ member: 'changed', text: 'changed' }) }); await f.restart([b]);
  assert.equal((await f.client.reconcile(scope, 'send')).state.kind, 'uncertain');
  assert.equal(b.calls.reconciles.length + b.calls.translations, 0); assert.equal(stored(f, 'chat').target, target);
  const c = extension({ submit(operation, { effect }) { f.inspect(db => db.exec('UPDATE service_provider_credentials SET revoked=1')); return effect(operation); } });
  await f.restart([c]); const next = await create(f, 'late');
  assert.equal((await f.client.conversation(next).submit(send(next))).receipt.state.kind, 'uncertain');
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM runs').get().n), 0);
});

test('capability intersection requires reconciliation and never changes the provider identifier', async t => {
  const a = extension({ reconcileSupported: false }), f = await fixture(t, [a]), agent = await selected(f), scope = await create(f);
  assert.deepEqual(agent.commands, []);
  assert.equal((await f.client.conversation(scope).submit(send(scope))).kind, 'rejected'); assert.equal(a.calls.translations, 0);
  await f.restart([extension()]);
  const enabled = await selected(f); assert.equal(enabled.id, agent.id); assert.deepEqual(enabled.commands, ['send', 'approve']);
  assert.equal((await f.client.conversation(scope).submit(send(scope))).receipt.state.kind, 'accepted');
});

test('admission and accepted run writes roll back atomically; recovery looks up an intent even before known dispatch', async t => {
  const a = extension(), f = await fixture(t, [a]), scope = await create(f);
  f.inspect(db => db.exec("CREATE TRIGGER fail_command BEFORE INSERT ON commands BEGIN SELECT RAISE(ABORT,'injected'); END"));
  await unavailable(f.client.conversation(scope).submit(send(scope)));
  assert.equal(a.calls.submits.length, 0);
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM events').get().n), 0);
  f.inspect(db => db.exec("DROP TRIGGER fail_command; CREATE TRIGGER fail_receipt BEFORE UPDATE ON commands WHEN json_extract(NEW.receipt,'$.state.kind')='accepted' BEGIN SELECT RAISE(ABORT,'injected'); END"));
  await unavailable(f.client.conversation(scope).submit(send(scope)));
  assert.equal(a.calls.submits.length, 1); assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM runs').get().n), 0);
  assert.equal((await f.client.conversation(scope).receipt('send')).state.kind, 'pending');
  f.inspect(db => db.exec('DROP TRIGGER fail_receipt'));
  const b = extension({ request() { assert.fail('Recovery cannot translate'); } }); await f.restart([b]);
  assert.equal((await f.client.conversation(scope).submit(send(scope))).receipt.state.kind, 'pending');
  assert.equal((await f.client.reconcile(scope, 'send')).state.kind, 'accepted');
  assert.deepEqual(b.calls.reconciles, a.calls.submits); assert.equal(b.calls.submits.length, 0);
});

test('copied translated request is bounded and receipt capacity refuses before translation', async t => {
  const a = extension({ request: text => ({ member: 'research', text: text.repeat(100000) }) });
  const registry = createProviderRegistry([{ ...a.value, authority: { credentials: {},
    issue: () => ({ credential: null, expectedAuthority: 'remote-provider', assertAuthorized() {} }), async close() {} } }]);
  await registry.activate(); t.after(() => registry.close()); const [discovered] = await registry.discover();
  const target = { kind: 'provider', contributionId: discovered.contributionId, instance: discovered.instance, agent: discovered.agents[0],
    presentationVersion: 1, expectedAuthority: discovered.expectedAuthority };
  const f = hostFixture(t), host = f.open({ providers: registry });
  await host.createProviderConversation(hostScope, target, registry);
  assert.equal((await host.conversation(hostScope).submit(send(hostScope))).reason, 'command-too-large');
  assert.equal(a.calls.submits.length, 0); assert.deepEqual((await snapshot(host.conversation(hostScope))).document.receipts, {});
  const tiny = hostFixture(t), limited = tiny.open({ providers: registry, budgets: { snapshotBytes: 300 } });
  await limited.createProviderConversation(hostScope, target, registry);
  const count = a.calls.translations;
  assert.equal((await limited.conversation(hostScope).submit(send(hostScope))).reason, 'conversation-capacity');
  assert.equal(a.calls.translations, count); assert.equal(a.calls.submits.length, 0);
});

for (const kind of ['not-dispatched', 'unsupported', 'unavailable', 'authentication-failed', 'unauthorized', 'version-unsupported']) {
  test(`fresh resolved ${kind} records known nonacceptance and retry never invokes again`, async t => {
    const a = extension({ submit: () => ({ kind, reason: secret }) }), f = await fixture(t, [a]), scope = await create(f);
    const result = await f.client.conversation(scope).submit(send(scope));
    assert.deepEqual(result.receipt.state, { kind: 'not-dispatched', reason: `provider-${kind}` });
    assert.deepEqual(await f.client.conversation(scope).submit(send(scope)), result);
    assert.deepEqual(await f.client.reconcile(scope, 'send'), result.receipt);
    assert.equal(a.calls.translations, 1); assert.equal(a.calls.submits.length, 1); assert.equal(a.calls.reconciles.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CREATION/);
  });
}

test('authoritative rejection after acceptance retains the original run across restart', async t => {
  const a = extension({ reconcile: () => ({ kind: 'rejected', reason: secret, evidence: { denied: true } }) });
  const f = await fixture(t, [a]), scope = await create(f);
  await f.client.conversation(scope).submit(send(scope));
  const run = f.inspect(db => db.prepare('SELECT data FROM runs').get().data);
  const receipt = await f.client.reconcile(scope, 'send'); assert.equal(receipt.state.kind, 'rejected');
  assert.equal(f.inspect(db => db.prepare('SELECT data FROM runs').get().data), run);
  await f.restart([]);
  assert.deepEqual(await f.client.conversation(scope).receipt('send'), receipt);
  assert.deepEqual(await f.client.reconcile(scope, 'send'), receipt);
});

test('lookup while fresh submission is running cannot weaken its receipt, and shutdown drains that submission', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const a = extension({ async submit(operation, { effect }) { entered.resolve(); await release.promise; return effect(operation); },
    reconcile: () => ({ kind: 'unavailable', reason: 'pending' }) });
  const f = await fixture(t, [a]), scope = await create(f);
  const submitting = f.client.conversation(scope).submit(send(scope)); await entered.promise;
  assert.equal((await f.client.reconcile(scope, 'send')).state.kind, 'pending');
  let closed = false; const closing = f.running.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release.resolve(); assert.equal((await submitting).receipt.state.kind, 'uncertain'); await closing;
  const b = extension(); await f.restart([b]);
  assert.equal((await f.client.reconcile(scope, 'send')).state.kind, 'accepted');
  assert.deepEqual(b.calls.reconciles, a.calls.submits); assert.equal(b.calls.submits.length, 0);
});

for (const lookup of [false, true]) {
  test(`entered credential-backed ${lookup ? 'original lookup' : 'send'} defers replacement without retiring its owner`, { timeout: 10000 }, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), service = 'http://127.0.0.1:12345';
    const held = async (operation, { context, credential, effect }) => context.credentials.use({ credential, service }, async token => {
      assert.equal(token, secret); entered.resolve(); await release.promise; return effect(operation);
    });
    const a = extension({ submit: lookup ? () => { throw new Error('Reply lost'); } : held, ...(lookup ? { reconcile: held } : {}) });
    const next = entry(t, { label: 'replacement' }), f = await fixture(t, [a]), scope = await create(f);
    if (lookup) {
      assert.equal((await f.client.conversation(scope).submit(send(scope))).receipt.state.kind, 'uncertain');
      const unresolved = await create(f, 'unresolved');
      await f.client.conversation(unresolved).submit(send(unresolved));
    }
    const working = lookup ? f.client.reconcile(scope, 'send') : f.client.conversation(scope).submit(send(scope));
    try {
      await entered.promise;
      const targets = f.inspect(db => db.prepare('SELECT target FROM commands ORDER BY conversation').all());
      const credentials = f.inspect(db => db.prepare('SELECT handle,revoked FROM service_provider_credentials').all());
      assert.equal(f.running.extensionStatus().pending, 1);
      assert.deepEqual(await f.running.replaceProviderExtensions([next.value]), { kind: 'deferred', reason: 'active-work' });
      assert.equal(f.running.extensionStatus().pending, 1);
      assert.equal(next.calls.import, 0); assert.equal(a.calls.close + a.calls.dispose, 0);
      assert.equal(await a.context.credentials.use({ credential: a.credential, service }, async token => token), secret);
      assert.deepEqual(f.inspect(db => db.prepare('SELECT handle,revoked FROM service_provider_credentials').all()), credentials);
      assert.deepEqual(JSON.parse(targets[0].target).operation, a.calls.submits[0]);
      if (lookup) assert.deepEqual(a.calls.reconciles, [a.calls.submits[0]]);
      release.resolve();
      const result = await working;
      assert.equal((lookup ? result : result.receipt).state.kind, 'accepted');
      assert.equal(f.running.extensionStatus().pending, 0);
      assert.deepEqual(await f.running.replaceProviderExtensions([next.value]), { kind: 'replaced', generation: 2 });
      assert.equal(next.calls.import, 1); assert.equal(a.calls.close, 1); assert.equal(a.calls.dispose, 1);
      await assert.rejects(a.context.credentials.use({ credential: a.credential, service }, async () => assert.fail('retired credential')), /credential use refused/);
      if (lookup) {
        assert.equal((await f.client.reconcile(f.scope('unresolved'), 'send')).state.kind, 'uncertain');
        assert.equal(next.calls.commands, 0); assert.equal(a.calls.submits.length, 2); assert.equal(a.calls.reconciles.length, 1);
      }
      assert.deepEqual(f.inspect(db => db.prepare('SELECT target FROM commands ORDER BY conversation').all()), targets);
    } finally { release.resolve(); await working; }
  });
}

test('inactive owner refuses fresh sends and preserves lookup uncertainty without entering effects', async () => {
  const owner = createServerExtensions();
  for (const closing of [false, true]) {
    if (closing) await owner.close();
    assert.throws(() => owner.captureCommand(null, { kind: 'send', text: 'text' }, 'operation'), /Provider unavailable/);
    assert.deepEqual(await owner.executeCommand(null, true, () => assert.fail('inactive fresh effect')),
      { kind: 'not-dispatched', reason: 'provider-local-refusal' });
    assert.deepEqual(await owner.executeCommand(null, false, () => assert.fail('inactive lookup effect')), { kind: 'outcome-unknown' });
  }
});
