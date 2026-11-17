import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '@agentui/contracts';
import { fixture, providerFixture, turn, invalid, unavailable, unsupported } from './provider-outputs-fixture.mjs';

test('four total registry output operations admit before work without a queue; other registries remain independent', async t => {
  const f = await fixture(t), other = await fixture(t), id = await f.id(), gate = Promise.withResolvers();
  f.hooks.list = async binding => { await gate.promise; return { kind: 'complete', outputs: [f.row(binding)] }; };
  const calls = { ...f.calls };
  const held = [f.registry.conversationOutputs(f.original), f.registry.readOutput(f.original, id),
    f.registry.conversationOutputs(f.original), f.registry.readOutput(f.original, id)];
  assert.equal(f.registry.activity().pending, 4);
  assert.deepEqual(await f.registry.readOutput(f.original, id), unavailable);
  assert.equal(f.registry.activity().pending, 4);
  await turn();
  assert.equal(f.calls.connect, calls.connect); assert.equal(f.calls.list, calls.list + 4); assert.equal(f.calls.read, calls.read);
  assert.equal((await other.host.conversationOutputs(other.scope)).kind, 'available');
  gate.resolve();
  assert.ok((await Promise.all(held)).every(result => result.kind === 'available'));
  assert.equal(f.registry.activity().pending, 0);
  assert.equal((await f.registry.readOutput(f.original, id)).kind, 'available');
});

for (const stage of ['acquisition', 'listing', 'reading']) {
  test(`saved credential change during ${stage} prevents late success and releases every slot`, async t => {
    const f = await fixture(t), id = await f.id(), gate = Promise.withResolvers(), entered = Promise.withResolvers();
    if (stage === 'acquisition') {
      f.hooks.discover = () => ({ kind: 'version-unsupported', reason: 'Retry connection' });
      await f.registry.discover(); delete f.hooks.discover;
      f.hooks.connect = async () => { entered.resolve(); await gate.promise; return { kind: 'connected', backend: f.connected }; };
    } else if (stage === 'listing') {
      f.hooks.list = async binding => { entered.resolve(); await gate.promise; return { kind: 'complete', outputs: [f.row(binding)] }; };
    } else f.hooks.read = async () => { entered.resolve(); await gate.promise; return { kind: 'available', bytes: f.state.bytes }; };
    const calls = { ...f.calls };
    const pending = f.registry.readOutput(f.original, id);
    await entered.promise;
    f.state.credential = { ...f.state.credential, opaqueHandle: 'changed' };
    gate.resolve(); assert.deepEqual(await pending, unavailable);
    if (stage === 'acquisition') assert.equal(f.calls.list, calls.list);
    if (stage !== 'reading') assert.equal(f.calls.read, calls.read);
    assert.equal(f.registry.activity().pending, 0);
    f.state.credential = structuredClone(f.original.credential);
    assert.equal((await f.registry.readOutput(f.original, id)).kind, 'available');
  });
}

test('authorization loss during acquisition retires and disposes the acquired connection', async t => {
  const f = await fixture(t), id = await f.id(), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  f.hooks.discover = () => ({ kind: 'version-unsupported', reason: 'Reconnect' });
  await f.registry.discover(); delete f.hooks.discover;
  f.hooks.connect = async () => { entered.resolve(); await gate.promise; return { kind: 'connected', backend: f.connected }; };
  const before = f.calls.close, lists = f.calls.list;
  const pending = f.registry.readOutput(f.original, id);
  await entered.promise; f.state.authorized = false; gate.resolve();
  assert.deepEqual(await pending, unavailable); await turn();
  assert.equal(f.calls.list, lists); assert.equal(f.calls.close, before + 1);
  assert.equal(f.registry.activity().pending, 0);
  assert.deepEqual(await f.registry.readOutput(f.original, id), unavailable);
});

test('failed acquisition does not list or read and releases all admission slots', async t => {
  const f = await fixture(t), id = await f.id();
  f.hooks.discover = () => ({ kind: 'version-unsupported', reason: 'Reconnect' });
  await f.registry.discover(); delete f.hooks.discover;
  const calls = { ...f.calls };
  f.hooks.connect = () => ({ kind: 'unavailable', reason: 'private' });
  for (let n = 0; n < 6; n++) assert.deepEqual(await f.registry.readOutput(f.original, id), unavailable);
  assert.equal(f.calls.list, calls.list); assert.equal(f.calls.read, calls.read);
  assert.equal(f.registry.activity().pending, 0);
  delete f.hooks.connect;
  assert.equal((await f.registry.readOutput(f.original, id)).kind, 'available');
});

test('native, absent and unconfirmed conversations never acquire or enumerate outputs', async t => {
  const f = await fixture(t), id = await f.id(), calls = { ...f.calls };
  const native = { hostId: 'host', conversationId: 'native' };
  f.host.createConversation(native, { installationId: 'native', binding: { engine: 'fixture', nativeVersion: '1', account: 'account', authorizedScope: 'scope', nativeFormat: 'fixture-v1' } });
  assert.deepEqual(await f.host.conversationOutputs(native), unsupported);
  assert.deepEqual(await f.host.readOutput(native, id), unsupported);
  assert.deepEqual(await f.host.conversationOutputs({ ...native, conversationId: 'absent' }), unsupported);
  assert.deepEqual(await f.registry.conversationOutputs({ ...f.original, observation: null }), unavailable);
  f.hooks.create = () => ({ kind: 'pending', evidence: null });
  const pending = { ...native, conversationId: 'pending' };
  assert.equal((await f.host.createProviderConversation(pending, f.installation, f.registry)).kind, 'pending');
  assert.deepEqual(await f.host.conversationOutputs(pending), unavailable);
  assert.deepEqual(await f.host.readOutput(pending, id), unavailable);
  assert.equal(f.calls.connect, calls.connect); assert.equal(f.calls.list, calls.list); assert.equal(f.calls.read, calls.read);
});

for (const operation of ['list', 'read']) {
  test(`scope authorization is checked before and after ${operation}`, async t => {
    const f = await fixture(t), id = await f.id(), gate = Promise.withResolvers(), entered = Promise.withResolvers();
    f.hooks[operation] = async binding => { entered.resolve(); await gate.promise;
      return operation === 'list' ? { kind: 'complete', outputs: [f.row(binding)] } : { kind: 'available', bytes: f.state.bytes }; };
    const pending = operation === 'list' ? f.host.conversationOutputs(f.scope) : f.host.readOutput(f.scope, id);
    const rejection = assert.rejects(pending, /Unauthorized scope/);
    await entered.promise; f.state.scoped = false; gate.resolve(); await rejection;
    const calls = { ...f.calls };
    assert.throws(() => f.host.conversationOutputs(f.scope), /Unauthorized scope/);
    assert.throws(() => f.host.readOutput(f.scope, id), /Unauthorized scope/);
    assert.equal(f.calls.list, calls.list); assert.equal(f.calls.read, calls.read);
    f.state.scoped = true;
    assert.equal((await f.host.readOutput(f.scope, id)).kind, 'available');
  });
}

for (const operation of ['list', 'read']) {
  test(`LocalHost drain waits for actual held ${operation} and rejects its result after close`, async t => {
    const f = await fixture(t), id = await f.id(), gate = Promise.withResolvers(), entered = Promise.withResolvers();
    let drained = false;
    f.hooks[operation] = async binding => { entered.resolve(); await gate.promise;
      return operation === 'list' ? { kind: 'complete', outputs: [f.row(binding)] } : { kind: 'available', bytes: f.state.bytes }; };
    const pending = operation === 'list' ? f.host.conversationOutputs(f.scope) : f.host.readOutput(f.scope, id);
    const rejected = assert.rejects(pending, /Host is closed/);
    await entered.promise; f.host.close(); f.host.drained.then(() => { drained = true; });
    await turn(); assert.equal(drained, false); assert.equal(f.registry.activity().pending, 1);
    gate.resolve(); await rejected; await f.host.drained;
    assert.equal(drained, true); assert.equal(f.registry.activity().pending, 0);
  });
}

for (const operation of ['list', 'read']) {
  test(`registry close waits for held ${operation}, rejects late output and disposes once`, async t => {
    const f = await fixture(t), id = await f.id(), gate = Promise.withResolvers(), entered = Promise.withResolvers();
    f.hooks[operation] = async binding => { entered.resolve(); await gate.promise;
      return operation === 'list' ? { kind: 'complete', outputs: [f.row(binding)] } : { kind: 'available', bytes: f.state.bytes }; };
    const pending = operation === 'list' ? f.registry.conversationOutputs(f.original) : f.registry.readOutput(f.original, id);
    await entered.promise;
    let closed = false;
    const closing = f.registry.close(); closing.then(() => { closed = true; });
    assert.equal(f.registry.close(), closing); await turn();
    assert.equal(closed, false); assert.equal(f.calls.close, 0); assert.equal(f.calls.dispose, 0);
    assert.deepEqual(await f.registry.readOutput(f.original, id), unavailable);
    gate.resolve(); assert.deepEqual(await pending, unavailable); await closing;
    assert.equal(f.calls.close, 1); assert.equal(f.calls.dispose, 1); assert.equal(f.calls.authorityClose, 1);
    assert.equal(f.registry.activity().pending, 0);
  });
}

for (const operation of ['list', 'read']) {
  test(`extension replacement defers held ${operation} and routes new work to only the current generation`, async t => {
    const f = await fixture(t, { owner: true }), id = await f.id(), next = providerFixture({ generation: '2' });
    const gate = Promise.withResolvers(), entered = Promise.withResolvers();
    f.hooks[operation] = async binding => { entered.resolve(); await gate.promise;
      return operation === 'list' ? { kind: 'complete', outputs: [f.row(binding)] } : { kind: 'available', bytes: f.state.bytes }; };
    const source = { async prepare() { return { kind: 'ready', extensions: [next.extension] }; } };
    const pending = operation === 'list' ? f.host.conversationOutputs(f.scope) : f.host.readOutput(f.scope, id);
    assert.deepEqual(await f.registry.replace(source), { kind: 'deferred', reason: 'active-work' });
    await entered.promise;
    assert.equal(f.registry.status().pending, 1);
    assert.deepEqual(await f.registry.replace(source), { kind: 'deferred', reason: 'active-work' });
    assert.equal(f.calls.close, 0); gate.resolve(); assert.equal((await pending).kind, 'available');
    assert.equal((await f.registry.replace(source)).kind, 'replaced');
    assert.equal(f.calls.close, 1); assert.equal(f.calls.dispose, 1);
    assert.deepEqual(await f.host.conversationOutputs(f.scope), unavailable);
    assert.deepEqual(await f.host.readOutput(f.scope, id), unavailable);
    const scope = { ...f.scope, conversationId: 'next' };
    await f.host.createProviderConversation(scope, next.installation, f.registry);
    const result = await f.host.conversationOutputs(scope);
    assert.equal(result.kind, 'available'); assert.notEqual(result.outputs[0].outputId, id);
    assert.equal((await f.host.readOutput(scope, result.outputs[0].outputId)).kind, 'available');
    assert.equal(next.calls.list, 2); assert.equal(next.calls.read, 1);
    await f.registry.close(); assert.equal(next.calls.close, 1); assert.equal(next.calls.dispose, 1);
  });
}

test('original binding byte budget admits its exact bound and rejects one extra byte before acquisition', async t => {
  const f = await fixture(t), original = structuredClone(f.original);
  const binding = original.observation.binding;
  const base = Buffer.byteLength(canonicalJson(binding));
  binding.authority.binding.opaqueSessionId += 's'.repeat(8192 - base);
  assert.equal(Buffer.byteLength(canonicalJson(binding)), 8192);
  assert.equal((await f.registry.conversationOutputs(original)).kind, 'available');
  binding.authority.binding.opaqueSessionId += 's';
  assert.equal(Buffer.byteLength(canonicalJson(binding)), 8193);
  const calls = { ...f.calls };
  assert.deepEqual(await f.registry.conversationOutputs(original), invalid);
  assert.equal(f.calls.connect, calls.connect); assert.equal(f.calls.list, calls.list); assert.equal(f.calls.read, calls.read);
  assert.equal(f.registry.activity().pending, 0);
});
