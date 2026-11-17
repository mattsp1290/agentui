import { canonicalJson } from '@agentui/contracts';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createProviderRegistry } from '@agentui/host';
import { frontendToolsFor } from '@agentui/host/frontend-tools';
import { fixture as hostFixture, scope as hostScope } from '../host/fixture.mjs';
import { fixture, create, send, unavailable, offered, aguiExtension } from './provider-send-fixture.mjs';

async function offeredHttp(t, initial = 'accepted', beforeReply = async () => {}) {
  let state = initial;
  const requests = [];
  const remote = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    const operation = JSON.parse(body); requests.push({ path: request.url, body, operation });
    await beforeReply(request.url, operation);
    const result = state === 'pending' ? { kind: 'pending', evidence: {} }
      : state === 'rejected' ? { kind: 'rejected', reason: 'declined', evidence: {} }
      : state === 'not-dispatched' ? { kind: 'not-dispatched', reason: 'refused' }
      : state === 'uncertain' ? { kind: 'uncertain', reason: 'unknown', evidence: {} }
      : a.effect(operation, state, operation.request.runId);
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => remote.close(resolve)));
  const service = `http://127.0.0.1:${remote.address().port}`;
  const call = path => async operation => (await fetch(service + path, { method: 'POST', body: canonicalJson(operation) })).json();
  const a = aguiExtension({ service, request: text => ({ runId: `run-${text}`, threadId: 'original-thread',
    messages: [{ id: 'user', role: 'user', content: text }], state: null, custom: 'preserved' }),
    submit: call('/submit'), reconcile: call('/lookup') });
  const f = await fixture(t, [a]), scope = await create(f);
  return { a, f, scope, requests, state(value) { state = value; } };
}
const originalRow = f => f.inspect(db => db.prepare("SELECT intent,target,receipt FROM commands WHERE id='offered'").get());
function noFrontendEffects(f) {
  for (const table of ['frontend_events', 'frontend_receipts']) assert.equal(f.inspect(db => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n), 0);
}
async function privateOffer(client, scope) {
  await unavailable(client.conversation(scope).receipt('offered'));
  await unavailable(client.reconcile(scope, 'offered'));
  for (const action of ['recover', 'unavailable']) await unavailable(client.frontendBinding({ scope, id: 'offered', action }));
}
for (const initial of ['accepted', 'pending']) for (const owner of ['available', 'released', 'revoked']) {
  for (const next of owner === 'revoked' ? ['other'] : ['same', 'other']) test(`offered blocker ${initial} ${owner} permits ${next} actor after authentic HTTP completion`, async t => {
    const { a, f, scope, requests, state } = await offeredHttp(t, initial), other = await f.anotherClient();
    const principal = (await f.client.metadata()).principalId;
    assert.equal((await f.client.conversation(scope).submit(offered(scope))).receipt.state.kind, initial);
    const original = originalRow(f);
    if (owner === 'released') await f.client.frontendBinding({ scope, id: 'offered', action: 'unavailable' });
    if (owner === 'revoked') f.inspect(db => db.prepare('UPDATE service_devices SET revoked=1 WHERE id=?').run(principal));
    await privateOffer(other, scope);
    state('completed');
    const result = await (next === 'same' ? f.client : other).conversation(scope).submit(send(scope, 'next', 'Next'));
    assert.equal(result.receipt?.state.kind, 'completed');
    assert.equal(JSON.parse(originalRow(f).receipt).state.kind, 'completed');
    assert.equal(originalRow(f).target, original.target); assert.equal(originalRow(f).intent, original.intent);
    assert.equal(a.calls.translations, 2); assert.equal(a.calls.submits.length, 2); assert.equal(a.calls.reconciles.length, 1);
    assert.deepEqual(requests.map(item => item.path), ['/submit', '/lookup', '/submit']);
    assert.equal(requests[1].body, requests[0].body);
    assert.notEqual(requests[2].operation.operationId, requests[0].operation.operationId);
    assert.deepEqual(requests[2].operation.request, { runId: 'run-Next', threadId: 'original-thread',
      messages: [{ id: 'user', role: 'user', content: 'Next' }], state: null, custom: 'preserved' });
    await privateOffer(other, scope);
    if (owner === 'revoked') {
      await assert.rejects(f.client.conversation(scope).receipt('offered'), error => error.kind === 'unauthorized');
      await assert.rejects(f.client.reconcile(scope, 'offered'), error => error.kind === 'unauthorized');
      await assert.rejects(f.client.frontendBinding({ scope, id: 'offered', action: 'recover' }), error => error.kind === 'unauthorized');
    } else assert.equal((await f.client.reconcile(scope, 'offered')).state.kind, 'completed');
    noFrontendEffects(f);
  });
}
test('offered released owner can publicly reconcile authentic evidence', async t => {
  const { f, scope, state, requests } = await offeredHttp(t);
  await f.client.conversation(scope).submit(offered(scope));
  await f.client.frontendBinding({ scope, id: 'offered', action: 'unavailable' }); state('completed');
  assert.equal((await f.client.reconcile(scope, 'offered')).state.kind, 'completed');
  assert.equal(requests[1].body, requests[0].body);
  assert.equal((await f.client.frontendBinding({ scope, id: 'offered', action: 'recover' })).reason, 'closures-unavailable');
  noFrontendEffects(f);
});
for (const initial of ['accepted', 'pending']) for (const refusal of ['pending', 'uncertain', 'provider-revoked']) test(`offered ${initial} blocker keeps ${refusal} unresolved`, async t => {
  const { a, f, scope, state } = await offeredHttp(t, initial), other = await f.anotherClient();
  await f.client.conversation(scope).submit(offered(scope));
  await f.client.frontendBinding({ scope, id: 'offered', action: 'unavailable' });
  state(refusal === 'provider-revoked' ? 'completed' : refusal);
  if (refusal === 'provider-revoked') f.inspect(db => db.exec('UPDATE service_provider_credentials SET revoked=1'));
  assert.equal((await other.conversation(scope).submit(send(scope, 'next'))).reason, 'send-awaiting-confirmation');
  assert.equal(JSON.parse(originalRow(f).receipt).state.kind, initial);
  assert.equal(a.calls.submits.length, 1); assert.equal(a.calls.reconciles.length, refusal === 'provider-revoked' ? 0 : 1);
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM commands').get().n), 1); noFrontendEffects(f);
});
test('offered in-flight initial dispatch cannot be looked up by a new send, but returned pending can', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { a, f, scope, state } = await offeredHttp(t, 'pending', async path => {
    if (path === '/submit') { entered.resolve(); await release.promise; }
  });
  const other = await f.anotherClient(), first = f.client.conversation(scope).submit(offered(scope));
  await entered.promise;
  try {
    assert.equal((await other.conversation(scope).submit(send(scope, 'next'))).reason, 'send-awaiting-confirmation');
    assert.equal(a.calls.reconciles.length, 0); assert.equal(a.calls.submits.length, 1);
  } finally { release.resolve(); }
  assert.equal((await first).receipt.state.kind, 'pending'); state('completed');
  assert.equal((await other.conversation(scope).submit(send(scope, 'next', 'Next'))).receipt?.state.kind, 'completed');
  assert.equal(a.calls.reconciles.length, 1); assert.equal(a.calls.submits.length, 2); noFrontendEffects(f);
});
test('offered blocker settlement persists evidence but revocation during lookup prevents new admission', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { a, f, scope, state } = await offeredHttp(t, 'accepted', async path => {
    if (path === '/lookup') { entered.resolve(); await release.promise; }
  });
  const other = await f.anotherClient(), principal = (await other.metadata()).principalId;
  await f.client.conversation(scope).submit(offered(scope)); state('completed');
  const result = other.conversation(scope).submit(send(scope, 'next')).then(value => ({ value }), error => ({ error }));
  await Promise.race([entered.promise, result.then(() => { throw new Error('New send did not look up the blocker'); })]);
  f.inspect(db => db.prepare('UPDATE service_devices SET revoked=1 WHERE id=?').run(principal)); release.resolve();
  assert.ok((await result).error);
  assert.equal(JSON.parse(originalRow(f).receipt).state.kind, 'completed'); assert.equal(a.calls.submits.length, 1);
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM commands').get().n), 1); noFrontendEffects(f);
});
for (const outcome of ['rejected', 'not-dispatched', 'pending']) test(`offered ${outcome} no-run binding online and offline`, async t => {
  const { a, f, scope } = await offeredHttp(t, outcome);
  await f.client.conversation(scope).submit(offered(scope));
  const expected = outcome === 'pending' ? { kind: 'pending', id: 'offered' }
    : { kind: 'unavailable', id: 'offered', reason: outcome === 'rejected' ? 'provider-rejected' : 'not-dispatched' };
  assert.deepEqual(await f.client.frontendBinding({ scope, id: 'offered', action: 'recover' }), expected);
  await f.restart([]);
  if (outcome === 'pending') await unavailable(f.client.frontendBinding({ scope, id: 'offered', action: 'recover' }));
  else assert.deepEqual(await f.client.frontendBinding({ scope, id: 'offered', action: 'recover' }), expected);
  assert.equal(a.calls.submits.length, 1); assert.equal(a.calls.reconciles.length, outcome === 'pending' ? 1 : 0);
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM frontend_runs').get().n), 0); noFrontendEffects(f);
});
test('offered retained accepted run stays bound after authentic rejection', async t => {
  const { f, scope, state } = await offeredHttp(t);
  await f.client.conversation(scope).submit(offered(scope)); state('rejected');
  assert.equal((await f.client.reconcile(scope, 'offered')).state.kind, 'rejected');
  const bound = await f.client.frontendBinding({ scope, id: 'offered', action: 'recover' });
  assert.equal(bound.kind, 'bound'); assert.equal(bound.run.runId, 'run-Hello'); noFrontendEffects(f);
});

async function localOfferedHost(t, a) {
  const registry = createProviderRegistry([{ ...a.value, authority: { credentials: {},
    issue: () => ({ credential: null, expectedAuthority: 'remote-provider', assertAuthorized() {} }), async close() {} } }]);
  await registry.activate(); t.after(() => registry.close());
  const [discovered] = await registry.discover();
  const target = { kind: 'provider', contributionId: discovered.contributionId, instance: discovered.instance, agent: discovered.agents[0],
    presentationVersion: 1, expectedAuthority: discovered.expectedAuthority };
  const f = hostFixture(t), host = f.open({ providers: registry });
  await host.createProviderConversation(hostScope, target, registry);
  return { host, f, registry };
}
for (const closes of [false, true]) test(`offered recovery decoder registry closure ${closes} fences producer registration`, async t => {
  let armed = false, decodes = 0, closing;
  const a = aguiExtension({ decode(value) {
    if (armed) { decodes++; if (closes) closing = registry.close(); }
    return value;
  } });
  const { host, f, registry } = await localOfferedHost(t, a);
  const actor = { id: 'owner', platform: 'desktop', authorized: () => true };
  assert.equal((await host.conversation(hostScope, actor).submit(offered(hostScope))).receipt.state.kind, 'completed');
  const producer = frontendToolsFor(host).producer(hostScope), registrations = [];
  armed = true;
  const recovery = host.frontendBinding({ scope: hostScope, id: 'offered', action: 'recover' }, actor, () => ({
    register(value) { registrations.push(value); producer.register(value); },
    cancel() { assert.fail('No cancellation expected'); },
  }));
  if (closes) await assert.rejects(recovery, /provider unavailable/);
  else assert.equal((await recovery).kind, 'bound');
  assert.equal(decodes, 1);
  assert.equal(registrations.length, closes ? 0 : 1);
  const db = new DatabaseSync(f.path);
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM frontend_runs').get().n, closes ? 0 : 1); }
  finally { db.close(); }
  assert.equal(a.calls.submits.length, 1); assert.equal(a.calls.reconciles.length, 0);
  if (closes) { assert.ok(closing); await closing; }
});
for (const replaces of [false, true]) test(`offered recovery decoder running-host replacement ${replaces} fences producer registration`, async t => {
  let armed = false, decodes = 0, replacing;
  const a = aguiExtension({ decode(value) {
    if (armed) { decodes++; if (replaces) replacing = f.running.replaceProviderExtensions([]); }
    return value;
  } });
  const f = await fixture(t, [a]), scope = await create(f);
  assert.equal((await f.client.conversation(scope).submit(offered(scope))).receipt.state.kind, 'completed');
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM frontend_runs').get().n), 0);
  armed = true;
  const recovery = f.client.frontendBinding({ scope, id: 'offered', action: 'recover' });
  if (replaces) await unavailable(recovery);
  else assert.equal((await recovery).kind, 'bound');
  assert.equal(decodes, 1);
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM frontend_runs').get().n), replaces ? 0 : 1);
  assert.equal(a.calls.submits.length, 1); assert.equal(a.calls.reconciles.length, 0);
  if (replaces) {
    assert.ok(replacing);
    assert.deepEqual(await replacing, { kind: 'replaced', generation: null });
    assert.equal(f.running.extensionStatus().kind, 'empty');
  }
});
for (const outcome of ['pending', 'rejected', 'not-dispatched']) test(`offered ${outcome} binding never acquires a producer`, async t => {
  const result = outcome === 'pending' ? { kind: outcome, evidence: {} }
    : { kind: outcome, reason: 'provider-decision', ...(outcome === 'rejected' ? { evidence: {} } : {}) };
  const a = aguiExtension({ submit: () => result, reconcile: () => result }), { host, f } = await localOfferedHost(t, a);
  const actor = { id: 'owner', platform: 'desktop', authorized: () => true }, request = { scope: hostScope, id: 'offered', action: 'recover' };
  await host.conversation(hostScope, actor).submit(offered(hostScope));
  const producerFor = () => { assert.fail('No run can require a coordinator'); };
  const binding = await host.frontendBinding(request, actor, producerFor);
  assert.equal(binding.kind, outcome === 'pending' ? 'pending' : 'unavailable');
  host.close(); await host.drained;
  const offline = f.open();
  if (outcome === 'pending') await assert.rejects(offline.frontendBinding(request, actor, producerFor), /provider unavailable/);
  else assert.deepEqual(await offline.frontendBinding(request, actor, producerFor), binding);
});
test('offered binding retains the owner fence after the producer callback', async t => {
  const { host } = await localOfferedHost(t, aguiExtension()); let authorized = true;
  const actor = { id: 'owner', platform: 'desktop', authorized: () => authorized };
  await host.conversation(hostScope, actor).submit(offered(hostScope));
  await assert.rejects(host.frontendBinding({ scope: hostScope, id: 'offered', action: 'recover' }, actor, scope => {
    assert.deepEqual(scope, hostScope);
    return { register() { authorized = false; }, cancel() { assert.fail('No cancellation'); } };
  }), /frontend-owner/);
});
for (const corruption of ['missing', 'state', 'actor']) test(`offered private blocker lookup refuses ${corruption} admitted ownership`, async t => {
  const { a, f, scope, state } = await offeredHttp(t), other = await f.anotherClient();
  await f.client.conversation(scope).submit(offered(scope)); state('completed');
  f.inspect(db => { db.exec('PRAGMA ignore_check_constraints=ON'); db.exec(corruption === 'missing' ? 'DELETE FROM frontend_send_owners'
    : corruption === 'state' ? "UPDATE frontend_send_owners SET state='tombstone'" : "UPDATE frontend_send_owners SET actor_id=''"); });
  assert.equal((await other.conversation(scope).submit(send(scope, 'next'))).reason, 'send-awaiting-confirmation');
  assert.equal(a.calls.reconciles.length, 0); assert.equal(a.calls.submits.length, 1); noFrontendEffects(f);
});
test('offered private lookup checks the incoming actor after reentrant original-input decoding', async t => {
  let f, revoke = false, principal;
  const a = aguiExtension({ submit: (operation, { effect }) => effect(operation, 'accepted', operation.request.runId), decode(value) {
    if (revoke) f.inspect(db => db.prepare('UPDATE service_devices SET revoked=1 WHERE id=?').run(principal));
    return value;
  } });
  f = await fixture(t, [a]); const scope = await create(f), other = await f.anotherClient(); principal = (await other.metadata()).principalId;
  await f.client.conversation(scope).submit(offered(scope)); revoke = true;
  await assert.rejects(other.conversation(scope).submit(send(scope, 'next')));
  assert.equal(a.calls.reconciles.length, 0); assert.equal(a.calls.submits.length, 1);
  assert.equal(JSON.parse(originalRow(f).receipt).state.kind, 'accepted'); noFrontendEffects(f);
});
test('offered original closure release during private lookup does not adopt or revive the old binding', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { a, f, scope, state } = await offeredHttp(t, 'pending', async path => {
    if (path === '/lookup') { entered.resolve(); await release.promise; }
  });
  const other = await f.anotherClient(); await f.client.conversation(scope).submit(offered(scope)); state('completed');
  const next = other.conversation(scope).submit(send(scope, 'next', 'Next'));
  await entered.promise;
  await f.client.frontendBinding({ scope, id: 'offered', action: 'unavailable' }); release.resolve();
  assert.equal((await next).receipt.state.kind, 'completed');
  assert.equal((await f.client.frontendBinding({ scope, id: 'offered', action: 'recover' })).reason, 'closures-unavailable');
  assert.equal(f.inspect(db => JSON.parse(db.prepare('SELECT data FROM frontend_runs').get().data).status), 'blocked');
  await privateOffer(other, scope); assert.equal(a.calls.submits.length, 2); noFrontendEffects(f);
});
test('offered settled blocker cannot admit a new plain send whose decoder revokes the new actor', async t => {
  let authorized = true;
  const a = aguiExtension({ submit: (operation, { effect }) => effect(operation, 'accepted', operation.request.runId), decode(value) {
    if (value.messages[0].content === 'Next') authorized = false;
    return value;
  } });
  const { host } = await localOfferedHost(t, a), owner = { id: 'owner', platform: 'desktop', authorized: () => true };
  const other = { id: 'other', platform: 'desktop', authorized: () => authorized };
  await host.conversation(hostScope, owner).submit(offered(hostScope));
  assert.equal((await host.conversation(hostScope, other).submit(send(hostScope, 'next', 'Next'))).kind, 'rejected');
  assert.equal(authorized, false);
  assert.equal((await host.conversation(hostScope, owner).receipt('offered')).state.kind, 'completed');
  assert.equal(await host.conversation(hostScope, owner).receipt('next'), null);
  assert.equal(a.calls.submits.length, 1);
});


test('released recovery repairs a crash between registration and cancellation after offline reopen', async t => {
  const { host, f } = await localOfferedHost(t, aguiExtension());
  const actor = { id: 'owner', platform: 'desktop', authorized: () => true };
  await host.conversation(hostScope, actor).submit(offered(hostScope));
  const producer = frontendToolsFor(host).producer(hostScope), key = { threadId: 'actual-thread', runId: 'actual-run' };
  await assert.rejects(host.frontendBinding({ scope: hostScope, id: 'offered', action: 'unavailable' }, actor, () => ({
    register: value => producer.register(value), cancel() { throw new Error('Stopped before cancellation'); },
  })), /Stopped before cancellation/);
  assert.equal(producer.inspect(key).status, 'collecting');
  host.close(); await host.drained;
  const offline = f.open(), repair = frontendToolsFor(offline).producer(hostScope);
  const binding = await offline.frontendBinding({ scope: hostScope, id: 'offered', action: 'recover' }, actor, () => repair);
  assert.deepEqual(binding, { kind: 'unavailable', id: 'offered', reason: 'closures-unavailable' });
  assert.equal(repair.inspect(key).status, 'blocked');
});


test('released binding refuses actor revocation during producer cancellation', async t => {
  const { host } = await localOfferedHost(t, aguiExtension());
  let authorized = true;
  const actor = { id: 'owner', platform: 'desktop', authorized: () => authorized };
  await host.conversation(hostScope, actor).submit(offered(hostScope));
  const producer = frontendToolsFor(host).producer(hostScope), key = { threadId: 'actual-thread', runId: 'actual-run' };
  await assert.rejects(host.frontendBinding({ scope: hostScope, id: 'offered', action: 'unavailable' }, actor, () => ({
    register: value => producer.register(value),
    cancel(value) { producer.cancel(value); authorized = false; },
  })), /frontend-owner-unavailable/);
  assert.equal(producer.inspect(key).status, 'blocked');
});

test('binding recovery retains quarantined terminal evidence while explicit reconciliation reapplies it', async t => {
  const a = aguiExtension(), { host, f } = await localOfferedHost(t, a);
  const actor = { id: 'owner', platform: 'desktop', authorized: () => true }, db = new DatabaseSync(f.path);
  try {
    db.prepare('INSERT INTO runs(host,conversation,id,data) VALUES(?,?,?,?)').run(hostScope.hostId, hostScope.conversationId, 'actual-run', '{}');
    const receipt = (await host.conversation(hostScope, actor).submit(offered(hostScope))).receipt;
    assert.deepEqual(receipt.state, { kind: 'uncertain', reason: 'output-rejected' });
    assert.equal(JSON.parse(db.prepare("SELECT observation FROM commands WHERE id='offered'").get().observation).kind, 'conclusive');
    db.exec("DELETE FROM runs WHERE id='actual-run'");
    const saved = () => Object.fromEntries(['commands', 'events', 'conversations', 'runs'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = saved();
    assert.equal((await host.frontendBinding({ scope: hostScope, id: 'offered', action: 'recover' }, actor, scope => frontendToolsFor(host).producer(scope))).kind, 'bound');
    assert.deepEqual(saved(), before);
    assert.equal((await host.reconcile(hostScope, 'offered', actor)).state.kind, 'completed');
    assert.notDeepEqual(saved(), before);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM runs WHERE id='actual-run'").get().n, 1);
    assert.equal(a.calls.submits.length, 1);
    assert.equal(a.calls.reconciles.length, 0);
  } finally { db.close(); }
});
