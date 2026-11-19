import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createBrowserConnection } from '@agentui/client/service';
import { EXTENSION_SDK_VERSION, backendProviderContractVersion } from '@agentui/sdk';
import { options, startBrowserHost } from './fixtures.mjs';

const secret = 'PRIVATE_OPERATION_CREDENTIAL_42';
const namespace = 'ops';

/** A tiny service whose `/agents` route lists the agents this installation discovers. */
async function service(t, agents) {
  const state = { agents: [...agents], requests: [], gate: null, readBeforeGate: null };
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${secret}`) { response.writeHead(401).end(); return; }
    state.requests.push(request.url);
    const listed = [...state.agents];
    if (state.gate) { state.readBeforeGate?.(); await state.gate; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ agents: listed }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  state.origin = `http://127.0.0.1:${server.address().port}`;
  return state;
}

const unsupported = { kind: 'unsupported', reason: 'Discovery-only fixture.' };
function provider(context, installation) {
  const presentation = { instance: installation.instance, decodeRequest: value => value, decodeCursor: value => value, decodeState: value => value,
    decodeEvent: value => value, request: text => ({ text }), snapshot: () => ({ messages: [] }), apply: state => ({ state, events: [] }) };
  context.providers.add(installation.id, { apiVersion: backendProviderContractVersion, async connect({ credential }) {
    return { kind: 'connected', backend: { instance: installation.instance,
      capabilities: { create: unsupported, send: unsupported, cancel: unsupported, decide: unsupported, reconcile: unsupported, observe: unsupported },
      async discover() {
        const body = await context.credentials.use({ credential, service: installation.service }, async token => {
          const response = await fetch(`${installation.service}/agents`, { headers: { authorization: `Bearer ${token}` } });
          return response.json();
        });
        return { kind: 'available', agents: body.agents.map(name => ({ ref: { instance: installation.instance, kind: 'agent', opaqueId: name }, name })) };
      },
      async create() { throw new Error('unused'); }, async reconcileCreation() { throw new Error('unused'); },
      async submit() { throw new Error('unused'); }, async reconcileCommand() { throw new Error('unused'); },
      async snapshot() { throw new Error('unused'); }, observe() { throw new Error('unused'); }, async close() {},
    } };
  } }, presentation);
}

function extension({ services, operations = {}, activate }) {
  const seen = { contexts: [] };
  const installations = services.map((value, index) => ({ id: `grant-${index}`,
    instance: { namespace, installationId: `install-${index}`, generation: '1', protocolVersion: '1' },
    service: value.origin, expectedAuthority: 'remote-provider', authentication: { kind: 'secret', revision: '1', resolve: async () => secret } }));
  const entry = { kind: 'server', sdkVersion: EXTENSION_SDK_VERSION, async activate(context) {
    seen.contexts.push(context);
    await activate?.(context);
    for (const installation of context.installations) provider(context, installation);
    for (const [id, run] of Object.entries(operations)) context.operations.add(id, { run: call => run(call, context) });
    return { dispose() {} };
  } };
  return { seen, value: { manifest: { namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './server.js' }] },
    entry, installations } };
}

async function open(t, selected, { operationDeadlineMs } = {}) {
  const host = await startBrowserHost({ ...options(t), agentStartup: { kind: 'extensions' },
    extensions: { kind: 'transient', entries: selected.map(value => value.value) }, ...(operationDeadlineMs ? { operationDeadlineMs } : {}) });
  let closed = false;
  t.after(async () => { if (!closed) await host.close(); });
  const raw = [];
  const client = createBrowserConnection({ fetch: async (path, init) => {
    const response = await fetch(host.origin + path, { ...init, headers: { ...init.headers, Origin: host.origin } });
    raw.push(await response.clone().text());
    return response;
  } });
  return { host, client, raw, close: async () => { closed = true; await host.close(); } };
}
const call = (client, operation, input = {}, installationId = 'install-0', target = namespace) =>
  client.extensionCall({ namespace: target, installationId, operation, input });

test('each installation reaches its own service through context.installations and metadata lists the namespace without origins', async t => {
  const a = await service(t, ['alpha']), b = await service(t, ['beta']);
  const ext = extension({ services: [a, b], operations: { echo: async ({ input }) => ({ kind: 'ok', output: input }) } });
  const f = await open(t, [ext]);
  const [context] = ext.seen.contexts;
  assert.deepEqual(context.installations.map(installation => [installation.id, installation.instance.installationId, installation.service, installation.expectedAuthority]),
    [['grant-0', 'install-0', a.origin, 'remote-provider'], ['grant-1', 'install-1', b.origin, 'remote-provider']]);
  assert.ok(Object.isFrozen(context.installations));
  assert.equal(JSON.stringify(context.installations).includes(secret), false);
  const metadata = await f.client.metadata();
  assert.deepEqual(metadata.agents.map(agent => agent.label).sort(), ['alpha', 'beta']);
  assert.deepEqual(metadata.extensions, [{ namespace, state: 'active', operations: ['echo'],
    installations: [{ installationId: 'install-0', status: 'available' }, { installationId: 'install-1', status: 'available' }] }]);
  const text = f.raw.join('\n');
  for (const value of [a.origin, b.origin, secret, 'grant-0']) assert.equal(text.includes(value), false, value);
  assert.deepEqual(await call(f.client, 'echo', { nested: [1, null, 'x'] }), { kind: 'ok', output: { nested: [1, null, 'x'] } });
});

test('an operation receives the named installation and a credential that only that installation service accepts', async t => {
  const a = await service(t, []), b = await service(t, []);
  const ext = extension({ services: [a, b], operations: {
    async probe({ installation, credential, input, signal }, context) {
      assert.equal(signal.aborted, false);
      const own = await context.credentials.use({ credential, service: installation.service }, async token => token === secret);
      const other = installation.service === a.origin ? b.origin : a.origin;
      const foreign = await context.credentials.use({ credential, service: other }, async () => 'leaked').then(() => 'accepted', () => 'refused');
      return { kind: 'ok', output: { id: installation.id, installationId: installation.instance.installationId, own, foreign, input } };
    },
  } });
  const f = await open(t, [ext]);
  assert.deepEqual(await call(f.client, 'probe', 1, 'install-1'), { kind: 'ok', output: { id: 'grant-1', installationId: 'install-1', own: true, foreign: 'refused', input: 1 } });
  assert.deepEqual(await call(f.client, 'probe', 2, 'install-0'), { kind: 'ok', output: { id: 'grant-0', installationId: 'install-0', own: true, foreign: 'refused', input: 2 } });
});

test('unknown targets, thrown handlers, invalid and over-limit values fail with fixed causes and no extension text', async t => {
  const a = await service(t, []);
  const ext = extension({ services: [a], operations: {
    throws: async () => { throw new Error(`private failure ${secret}`); },
    huge: async () => ({ kind: 'ok', output: 'x'.repeat(256_001) }),
    invalid: async () => ({ kind: 'ok', output: { value: undefined, fn() {} } }),
    'bad-code': async () => ({ kind: 'refused', code: 'Not A Code' }),
    'extra-key': async () => ({ kind: 'ok', output: 1, secret }),
    refuses: async () => ({ kind: 'refused', code: 'unknown-profile' }),
  } });
  const f = await open(t, [ext]);
  assert.deepEqual(await call(f.client, 'echo', {}, 'install-0', 'missing'), { kind: 'failed', cause: 'unknown-extension' });
  assert.deepEqual(await call(f.client, 'throws', {}, 'other'), { kind: 'failed', cause: 'unknown-installation' });
  assert.deepEqual(await call(f.client, 'missing'), { kind: 'failed', cause: 'unknown-operation' });
  assert.deepEqual(await call(f.client, 'throws'), { kind: 'failed', cause: 'threw' });
  assert.deepEqual(await call(f.client, 'huge'), { kind: 'failed', cause: 'too-large' });
  assert.deepEqual(await call(f.client, 'invalid'), { kind: 'failed', cause: 'invalid-result' });
  assert.deepEqual(await call(f.client, 'bad-code'), { kind: 'failed', cause: 'invalid-result' });
  assert.deepEqual(await call(f.client, 'extra-key'), { kind: 'failed', cause: 'invalid-result' });
  assert.deepEqual(await call(f.client, 'refuses'), { kind: 'refused', code: 'unknown-profile' });
  assert.deepEqual(await f.host.callOperation({ namespace, installationId: 'install-0', operation: 'refuses', input: 'x'.repeat(64_001) }), { kind: 'failed', cause: 'too-large' });
  assert.equal(f.raw.join('\n').includes(secret), false);
  assert.equal(f.raw.join('\n').includes('private failure'), false);
});

test('a handler waiting inside credentials.use times out at the deadline, releases admission and lets replacement complete', async t => {
  const a = await service(t, []);
  const aborted = Promise.withResolvers();
  const ext = extension({ services: [a], operations: {
    async wait({ installation, credential, signal }, context) {
      return context.credentials.use({ credential, service: installation.service }, () => new Promise(resolve => {
        signal.addEventListener('abort', () => { aborted.resolve(); resolve({ kind: 'ok', output: 'late' }); }, { once: true });
      }));
    },
  } });
  const f = await open(t, [ext], { operationDeadlineMs: 300 });
  const started = Date.now();
  assert.deepEqual(await call(f.client, 'wait'), { kind: 'failed', cause: 'timeout' });
  assert.ok(Date.now() - started >= 250);
  await aborted.promise;
  assert.equal(f.host.extensionStatus().pending, 0);
  assert.equal((await f.host.replaceProviderExtensions([ext.value])).kind, 'replaced');
});

test('host close aborts an admitted operation at once and replies unavailable without waiting for the deadline', async t => {
  const a = await service(t, []);
  const admitted = Promise.withResolvers(), aborted = Promise.withResolvers();
  const ext = extension({ services: [a], operations: {
    async wait({ signal }) {
      admitted.resolve();
      return new Promise(resolve => signal.addEventListener('abort', () => { aborted.resolve(); resolve({ kind: 'ok', output: 'late' }); }, { once: true }));
    },
  } });
  const f = await open(t, [ext], { operationDeadlineMs: 10_000 });
  const reply = f.host.callOperation({ namespace, installationId: 'install-0', operation: 'wait', input: null });
  await admitted.promise;
  const started = Date.now();
  await f.close();
  assert.ok(Date.now() - started < 5_000, 'close waited for the operation deadline');
  await aborted.promise;
  assert.deepEqual(await reply, { kind: 'failed', cause: 'unavailable' });
});

test('a malformed direct call request rejects as a caller error instead of reporting a handler fault', async t => {
  const a = await service(t, []);
  const ext = extension({ services: [a], operations: { echo: async ({ input }) => ({ kind: 'ok', output: input }) } });
  const f = await open(t, [ext]);
  await assert.rejects(f.host.callOperation({ namespace, installationId: 'install-0', operation: 'echo', input: 1, extra: true }), TypeError);
  await assert.rejects(f.host.callOperation({ namespace, installationId: 'install-0', operation: 'Echo', input: 1 }), TypeError);
  assert.deepEqual(await f.host.callOperation({ namespace, installationId: 'install-0', operation: 'echo', input: 1 }), { kind: 'ok', output: 1 });
});

test('metadata keeps the retiring namespaces listed, with unavailable installations, while a replacement is changing', { timeout: 10000 }, async t => {
  const a = await service(t, []);
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const good = extension({ services: [a], operations: { echo: async ({ input }) => ({ kind: 'ok', output: input }) } });
  const slow = extension({ services: [a], operations: { echo: async ({ input }) => ({ kind: 'ok', output: input }) },
    async activate() { entered.resolve(); await finish.promise; } });
  const f = await open(t, [good]);
  const replacing = f.host.replaceProviderExtensions([slow.value]);
  try {
    await entered.promise;
    assert.equal(f.host.extensionStatus().kind, 'changing');
    assert.deepEqual((await f.client.metadata()).extensions, [{ namespace, state: 'active', operations: ['echo'],
      installations: [{ installationId: 'install-0', status: 'unavailable' }] }]);
    assert.deepEqual(await call(f.client, 'echo'), { kind: 'failed', cause: 'unavailable' });
  } finally { finish.resolve(); }
  assert.equal((await replacing).kind, 'replaced');
  assert.deepEqual((await f.client.metadata()).extensions, [{ namespace, state: 'active', operations: ['echo'],
    installations: [{ installationId: 'install-0', status: 'available' }] }]);
});

test('agentsChanged waits for a running discovery, then rediscovers before replying', async t => {
  const a = await service(t, ['first']);
  const ext = extension({ services: [a], operations: {
    async add({ input }) { a.agents.push(input); return { kind: 'ok', output: null, agentsChanged: true }; },
  } });
  const f = await open(t, [ext]);
  assert.deepEqual(await call(f.client, 'add', 'second'), { kind: 'ok', output: null });
  assert.deepEqual((await f.client.metadata()).agents.map(agent => agent.label).sort(), ['first', 'second']);
  // A discovery that read the old list before the change must not be the one the reply waits for.
  const gate = Promise.withResolvers(), read = Promise.withResolvers();
  a.gate = gate.promise; a.readBeforeGate = () => read.resolve();
  const running = f.host.discoverProviders();
  await read.promise;
  a.gate = null; a.readBeforeGate = null;
  const reply = call(f.client, 'add', 'third');
  setTimeout(() => gate.resolve(), 50);
  assert.deepEqual(await reply, { kind: 'ok', output: null });
  await running;
  assert.deepEqual((await f.client.metadata()).agents.map(agent => agent.label).sort(), ['first', 'second', 'third']);
});

test('an agentsChanged result is the reply even when the rediscovery outlasts the deadline', async t => {
  const a = await service(t, ['first']);
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const ext = extension({ services: [a], operations: {
    async add({ input }) {
      a.agents.push(input);
      // The change is made; the rediscovery that follows now stalls past the deadline.
      a.gate = gate.promise;
      return { kind: 'ok', output: 'created', agentsChanged: true };
    },
  } });
  const f = await open(t, [ext], { operationDeadlineMs: 300 });
  const started = Date.now();
  assert.deepEqual(await call(f.client, 'add', 'second'), { kind: 'ok', output: 'created' });
  assert.ok(Date.now() - started >= 250, 'the reply came before the deadline, so the stall was not exercised');
  a.gate = null;
  gate.resolve();
  assert.equal((await f.client.metadata()).extensions[0].operations.includes('add'), true);
});

test('calls and metadata choose the same grant when two grants share an installation ID', async t => {
  const a = await service(t, []);
  const generations = [];
  const ext = extension({ services: [a, { origin: 'http://127.0.0.1:1' }], operations: {
    echo: async ({ installation, input }) => { generations.push(installation.instance.generation); return { kind: 'ok', output: input }; },
  } });
  // The second grant is the same installation at a later generation whose service cannot be reached.
  ext.value.installations[1] = { ...ext.value.installations[1], instance: { ...ext.value.installations[0].instance, generation: '2' } };
  const f = await open(t, [ext]);
  assert.deepEqual((await f.client.metadata()).extensions[0].installations, [{ installationId: 'install-0', status: 'available' }]);
  assert.deepEqual(await call(f.client, 'echo', 7), { kind: 'ok', output: 7 });
  assert.deepEqual(generations, ['1']);
});

test('a configured installation with several available grants is unavailable to calls and metadata, not unknown', async t => {
  const a = await service(t, ['first']), b = await service(t, ['second']);
  let ran = 0;
  const ext = extension({ services: [a, b], operations: { echo: async ({ input }) => { ran += 1; return { kind: 'ok', output: input }; } } });
  // Both grants are the same installation and both services answer, so no single grant can be chosen.
  ext.value.installations[1] = { ...ext.value.installations[1], instance: { ...ext.value.installations[0].instance, generation: '2' } };
  const f = await open(t, [ext]);
  const metadata = await f.client.metadata();
  // Both grants' discoveries succeeded, so each lists its agent: the ambiguity is several available grants, not none.
  // (Agent availability is about conversation creation, which this fixture does not support.)
  assert.ok(a.requests.includes('/agents') && b.requests.includes('/agents'));
  assert.deepEqual(metadata.agents.filter(agent => agent.namespace === namespace)
    .map(agent => `${agent.installationId} ${agent.label}`).sort(), ['install-0 first', 'install-0 second']);
  assert.deepEqual(metadata.extensions[0].installations, [{ installationId: 'install-0', status: 'unavailable' }]);
  assert.deepEqual(await call(f.client, 'echo', 7), { kind: 'failed', cause: 'unavailable' });
  assert.deepEqual(await call(f.client, 'echo', 7, 'other'), { kind: 'failed', cause: 'unknown-installation' });
  assert.equal(ran, 0);
});

test('a failed generation reports failed descriptors and a closed host refuses calls as unavailable', async t => {
  const a = await service(t, []);
  const good = extension({ services: [a], operations: { echo: async ({ input }) => ({ kind: 'ok', output: input }) } });
  const f = await open(t, [good]);
  const bad = extension({ services: [a], activate() { throw new Error(`private ${secret}`); } });
  assert.equal((await f.host.replaceProviderExtensions([bad.value])).kind, 'failed');
  assert.deepEqual((await f.client.metadata()).extensions, [{ namespace, state: 'failed', operations: [], installations: [] }]);
  assert.deepEqual(await call(f.client, 'echo'), { kind: 'failed', cause: 'unavailable' });
  assert.equal(f.raw.join('\n').includes(secret), false);
  await f.close();
  assert.deepEqual(await f.host.callOperation({ namespace, installationId: 'install-0', operation: 'echo', input: 1 }), { kind: 'failed', cause: 'unavailable' });
});

test('no configuration lists no extensions', async t => {
  const f = await open(t, []);
  assert.deepEqual((await f.client.metadata()).extensions, []);
  assert.deepEqual(await call(f.client, 'echo'), { kind: 'failed', cause: 'unavailable' });
});
