import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createProviderRegistry } from '@agentui/host';
import { createServerExtensions } from '@agentui/host/extensions';
import { openAccessDatabase } from '../../../apps/host/build/tsc/access-database.js';
import { providerExtensionSource } from '../../../apps/host/build/tsc/provider-extensions.js';
import { createBrowserConnection } from '@agentui/client/service';
import { entry, listenerLog, options, secret, service, startBrowserHost, turn } from './fixtures.mjs';

async function paired(t, extensions) {
  const configured = options(t), host = await startBrowserHost({ ...configured, providerExtensions: extensions.map(value => value.value) });
  t.after(() => host.close());
  let cookie;
  const client = createBrowserConnection({ fetch: async (url, init) => {
    const response = await fetch(`${host.origin}${url}`, { ...init,
      headers: { ...init.headers, Origin: host.origin, ...(cookie ? { Cookie: cookie } : {}) } });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  } });
  const invite = await new Promise((resolve, reject) => {
    const socket = createConnection(join(configured.directory, 'control.sock')); let output = '';
    socket.once('error', reject); socket.once('connect', () => socket.end(`${JSON.stringify({ op: 'invite' })}\n`));
    socket.on('data', data => { output += data; });
    socket.once('end', () => { const result = JSON.parse(output); if (result.ok) resolve(result.value); else reject(new Error(result.error)); });
  });
  await client.pair(invite.code);
  return { host, client, scope: conversationId => ({ hostId: host.hostId, conversationId }),
    inspect(action) { const db = new DatabaseSync(join(configured.directory, 'host.sqlite')); try { return action(db); } finally { db.close(); } } };
}
const selected = async (f, label) => (await f.client.metadata()).agents.find(agent => agent.label === label);
const unavailable = promise => assert.rejects(promise, error => error.kind === 'unavailable');
const rejected = promise => assert.rejects(promise, error => error.kind === 'create-rejected');
const confirmed = (operation, fixture) => fixture.confirmed(operation);
const uncertain = () => ({ kind: 'uncertain', reason: 'Reply lost', evidence: null });
const originals = f => f.inspect(db => db.prepare('SELECT original FROM provider_creations ORDER BY conversation').all());

test('entered credential-backed creation defers replacement and the same paired API follows replace, disable and failure', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers(), listeners = listenerLog();
  const old = entry(t, { label: 'old', listeners, async create(operation, fixture) {
    entered.resolve(); await finish.promise; return fixture.confirmed(operation);
  } });
  const next = entry(t, { label: 'next', listeners, create: confirmed });
  const f = await paired(t, [old]), agent = await selected(f, 'old'), scope = f.scope('held');
  const creating = f.client.create(scope, agent.id);
  try {
    await entered.promise;
    assert.equal(f.host.extensionStatus().pending, 1);
    assert.equal(f.inspect(db => db.prepare('SELECT status FROM provider_creations').get().status), 'attempted');
    assert.deepEqual(await f.host.replaceProviderExtensions([next.value]), { kind: 'deferred', reason: 'active-work' });
    assert.equal(next.calls.import, 0); assert.equal(old.calls.close + old.calls.dispose, 0);
    assert.equal(await old.context.credentials.use({ credential: old.credential, service }, async value => value), secret);
    finish.resolve(); assert.deepEqual(await creating, scope);
    assert.equal(f.host.extensionStatus().pending, 0);
    await f.client.create(scope, agent.id); assert.equal(old.calls.creates.length, 1);
    assert.deepEqual(await f.host.replaceProviderExtensions([next.value]), { kind: 'replaced', generation: 2 });
    assert.equal(old.calls.close, 1); assert.equal(old.calls.dispose, 1); assert.equal(listeners.maximum, 1);
    const replacement = await selected(f, 'next'); assert.ok(replacement); assert.equal(await selected(f, 'old'), undefined);
    assert.equal((await f.client.conversationAgent(scope)).availability.kind, 'unavailable');
    await rejected(f.client.create(f.scope('stale'), agent.id));
    await f.client.create(f.scope('new'), replacement.id); assert.equal(next.calls.creates.length, 1);
    await f.host.replaceProviderExtensions([]);
    assert.equal((await f.client.metadata()).agents.filter(value => value.kind === 'provider').length, 0);
    await rejected(f.client.create(f.scope('disabled'), replacement.id));
    assert.equal(next.calls.creates.length, 1);
    const bad = entry(t, { label: 'bad', discover() { throw new Error(secret); } });
    assert.equal((await f.host.replaceProviderExtensions([bad.value])).kind, 'failed');
    assert.equal((await f.client.metadata()).agents.filter(value => value.kind === 'provider').length, 0);
    await rejected(f.client.create(f.scope('failed'), replacement.id));
    assert.equal(bad.calls.commands, 0);
  } finally { finish.resolve(); await creating; }
});

test('original uncertain lookup retains its operation and defers replacement; a mismatched successor cannot recreate it', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const old = entry(t, { label: 'old', create: uncertain, async lookup(operation, fixture) {
    entered.resolve(); await finish.promise; return fixture.confirmed(operation);
  } });
  const next = entry(t, { label: 'next', create: confirmed, lookup: confirmed });
  const f = await paired(t, [old]), agent = await selected(f, 'old'), scope = f.scope('recover');
  await unavailable(f.client.create(scope, agent.id));
  await unavailable(f.client.create(f.scope('unresolved'), agent.id));
  const original = originals(f), recovering = f.client.create(scope, agent.id);
  try {
    await entered.promise;
    assert.equal(f.host.extensionStatus().pending, 1);
    assert.deepEqual(await f.host.replaceProviderExtensions([next.value]), { kind: 'deferred', reason: 'active-work' });
    assert.equal(next.calls.import, 0); assert.equal(old.calls.dispose + old.calls.close, 0);
    assert.deepEqual(old.calls.lookups, [old.calls.creates[0]]);
    finish.resolve(); assert.deepEqual(await recovering, scope);
    assert.deepEqual(originals(f), original);
    await f.host.replaceProviderExtensions([next.value]);
    await unavailable(f.client.create(f.scope('unresolved'), agent.id));
    const replacement = await selected(f, 'next');
    await assert.rejects(f.client.create(f.scope('unresolved'), replacement.id), error => error.kind === 'invalid');
    assert.equal(next.calls.creates.length + next.calls.lookups.length, 0);
    assert.equal(f.host.extensionStatus().pending, 0);
    assert.deepEqual(originals(f), original);
  } finally { finish.resolve(); await recovering; }
});

test('shutdown freezes credentials during entered creation and persists uncertainty before releasing ownership', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const old = entry(t, { create: async (operation, fixture) => { entered.resolve(); await finish.promise; return fixture.confirmed(operation); } });
  const f = await paired(t, [old]), agent = await selected(f, 'entry');
  const creating = unavailable(f.client.create(f.scope('shutdown'), agent.id));
  await entered.promise;
  const original = originals(f), closing = f.host.close();
  try {
    await turn(); assert.equal(f.host.extensionStatus().kind, 'closing');
    await assert.rejects(old.context.credentials.use({ credential: old.credential, service }, async () => assert.fail('credential effect after shutdown')), /credential use refused/);
    assert.equal(old.calls.close + old.calls.dispose, 0);
  } finally { finish.resolve(); await creating; await closing; }
  assert.deepEqual(originals(f), original);
  assert.equal(f.inspect(db => JSON.parse(db.prepare('SELECT observation FROM provider_creations').get().observation).kind), 'uncertain');
  assert.equal(old.calls.close, 1); assert.equal(old.calls.dispose, 1);
});

test('discovery failure reports changing and defers replacement before owner failure handling while cleanup drains', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const old = entry(t, { discover(fixture) { if (fixture.calls.discover > 1) throw new Error(secret); },
    async close() { entered.resolve(); await finish.promise; } });
  const f = await paired(t, [old]), agent = await selected(f, 'entry');
  const discovering = assert.rejects(f.host.discoverProviders(), /Provider discovery failed/);
  try {
    await entered.promise;
    assert.deepEqual(f.host.extensionStatus(), { kind: 'changing', generation: 1 });
    const next = entry(t, { label: 'next' });
    assert.deepEqual(await f.host.replaceProviderExtensions([next.value]), { kind: 'deferred', reason: 'changing' });
    assert.equal(next.calls.import, 0);
    assert.equal((await f.client.metadata()).agents.filter(value => value.kind === 'provider').length, 0);
    await rejected(f.client.create(f.scope('stale'), agent.id));
    assert.equal(old.calls.commands, 0);
  } finally { finish.resolve(); await discovering; }
});


test('owner catalog copies cannot alter creation choices and inactive operations have no effects', async t => {
  const owner = createServerExtensions(), configured = options(t);
  const database = openAccessDatabase(join(configured.directory, 'host.sqlite'));
  const fixture = entry(t, { create: confirmed });
  try {
    assert.deepEqual(owner.catalog(), []);
    assert.throws(() => owner.capture(null, null), /Provider unavailable/);
    for (const fresh of [true, false]) {
      assert.deepEqual(await owner.execute(null, fresh, () => assert.fail('inactive effect')),
        { kind: fresh ? 'not-dispatched' : 'uncertain', source: fresh ? 'create' : 'lookup', evidence: null });
    }
    await owner.replace(providerExtensionSource(database, [fixture.value]));
    const [provider] = owner.catalog(), pristine = structuredClone(provider);
    provider.agents[0].name = 'mutated'; provider.agents[0].opaqueId = 'foreign';
    provider.instance.generation = 'foreign'; provider.capabilities.create = false;
    owner.catalog().splice(0);
    assert.deepEqual(owner.catalog(), [pristine]);
    const scope = { hostId: database.hostId, conversationId: 'copy' };
    const target = { kind: 'provider', contributionId: pristine.contributionId, instance: pristine.instance,
      agent: pristine.agents[0], presentationVersion: 1, expectedAuthority: pristine.expectedAuthority };
    const original = owner.capture(scope, target);
    assert.equal(original.intent.agent.opaqueId, 'entry');
    const creating = owner.execute(original, true, () => {});
    assert.equal(owner.status().pending, 1);
    assert.equal((await creating).kind, 'confirmed'); assert.equal(owner.status().pending, 0);
    const refused = owner.execute(original, true, () => { throw new Error('host refusal'); });
    assert.equal((await refused).kind, 'not-dispatched'); assert.equal(owner.status().pending, 0);
    assert.equal(fixture.calls.creates.length, 1);
    const closing = owner.close();
    assert.deepEqual(owner.catalog(), []);
    assert.throws(() => owner.capture(scope, target), /Provider unavailable/);
    assert.deepEqual(await owner.execute(original, false, () => assert.fail('closing effect')),
      { kind: 'uncertain', source: 'lookup', evidence: null });
    await closing;
    assert.deepEqual(owner.catalog(), []);
  } finally { await owner.close(); database.database.close(); }
});

test('accepted replacement hides the retired catalog during cleanup and after candidate failure', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const old = entry(t, { async dispose() { entered.resolve(); await finish.promise; } });
  const bad = entry(t, { label: 'bad', discover() { throw new Error(secret); } });
  const f = await paired(t, [old]), agent = await selected(f, 'entry');
  const replacing = f.host.replaceProviderExtensions([bad.value]);
  try {
    await entered.promise;
    assert.equal(f.host.extensionStatus().kind, 'changing');
    assert.equal((await f.client.metadata()).agents.filter(value => value.kind === 'provider').length, 0);
    await rejected(f.client.create(f.scope('changing'), agent.id));
    assert.equal(bad.calls.import, 0); assert.equal(old.calls.commands, 0);
    finish.resolve(); assert.equal((await replacing).kind, 'failed');
    assert.equal((await f.client.metadata()).agents.filter(value => value.kind === 'provider').length, 0);
    await rejected(f.client.create(f.scope('failed'), agent.id));
    assert.equal(bad.calls.commands, 0);
  } finally { finish.resolve(); await replacing; }
});

for (const create of [createProviderRegistry.bind(null, []), createServerExtensions]) {
  test(`${create.name} inactive send capture refuses before inspecting the original operation`, async () => {
    const registry = create();
    const original = { get installation() { return assert.fail('inactive input was inspected'); } };
    assert.throws(() => registry.captureCommand(original, { kind: 'send', text: 'text' }, 'operation'), /^Error: Provider unavailable$/);
    await registry.close();
    assert.throws(() => registry.captureCommand(original, { kind: 'send', text: 'text' }, 'operation'), /^Error: Provider unavailable$/);
  });
}

test('mutating registry activity snapshots cannot change admission or lifecycle phase', async () => {
  const registry = createProviderRegistry([]);
  const activating = registry.activate(), observed = registry.activity();
  assert.deepEqual(observed, { phase: 'activating', pending: 1 });
  observed.phase = 'closing'; observed.pending = 0;
  assert.deepEqual(registry.activity(), { phase: 'activating', pending: 1 });
  await activating;
  assert.deepEqual(registry.activity(), { phase: 'active', pending: 0 });
  assert.throws(() => registry.capture(null, null), /Provider agent unavailable/);
  const closing = registry.close();
  registry.activity().phase = 'active';
  assert.throws(() => registry.capture(null, null), /^Error: Provider unavailable$/);
  await closing;
});
