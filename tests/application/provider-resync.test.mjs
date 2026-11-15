import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { SqliteStore } from '../../packages/host/dist/sqlite-store.js';
import { observeProvider } from '../../packages/host/dist/provider-stream.js';
import { providerService, fixture, saved, send } from './provider-stream-fixture.mjs';
import { until, snapshot as readSnapshot } from '../host/fixture.mjs';

function resyncable(extension) {
  const observe = extension.backend.observe, feeds = [];
  extension.backend.observe = (input, receive) => {
    const feed = observe(input, receive), end = Promise.withResolvers();
    const entry = { input, receive, resync() {
      end.resolve({ kind: 'resync', cursor: null, reason: 'Cursor expired' });
      feed.close();
    } };
    feeds.push(entry);
    return { close: feed.close, ended: Promise.race([end.promise, feed.ended]) };
  };
  return feeds;
}

function replacement(remote, id = 'chat') {
  const snapshot = structuredClone(remote.conversations.get(id).snapshot);
  snapshot.cursor = remote.cursor(snapshot.binding);
  snapshot.state.transcript.messages = [{ messageId: 'replacement', revision: 1, role: 'assistant', text: 'Recovered snapshot', complete: true }];
  remote.conversations.get(id).snapshot = snapshot;
  return snapshot;
}

test('provider resync drains admitted callbacks, fetches a fresh snapshot and rejects the retired feed', { timeout: 15_000 }, async t => {
  const remote = await providerService(t), a = remote.extension(), feeds = resyncable(a);
  const f = await fixture(t, [a]), scope = await f.create();
  await until(() => a.calls.ready === 1);
  await f.client.conversation(scope).submit(send(scope));
  const binding = remote.conversations.get('chat').snapshot.binding;
  let beforeSnapshot;
  const snapshot = a.backend.snapshot;
  a.backend.snapshot = async value => { beforeSnapshot = saved(f); return snapshot(value); };
  const fresh = replacement(remote);
  const admitted = feeds[0].receive(remote.makeEvent(binding, 'Admitted before resync', 1));
  feeds[0].resync();
  await admitted;
  await until(() => feeds.length === 2 && a.calls.ready === 2);
  assert.equal(JSON.parse(beforeSnapshot.conversation.document).domain.messages.at(-1).text, 'Admitted before resync');
  assert.deepEqual(feeds[1].input, { binding, after: fresh.cursor });
  assert.equal(remote.requests.filter(request => request.path === '/snapshot').length, 2);
  const recovered = saved(f);
  assert.equal(JSON.parse(recovered.conversation.document).domain.messages[0].text, 'Recovered snapshot');
  assert.equal(JSON.parse(recovered.commands[0].receipt).state.kind, 'accepted');
  await assert.rejects(feeds[0].receive(remote.makeEvent(binding, 'Late retired event', 2)), /stream closed/);
  assert.deepEqual(saved(f), recovered);
  const observed = await readSnapshot(f.client.conversation(scope), 2);
  assert.equal(observed.document.domain.messages[0].text, 'Recovered snapshot');
  remote.emit(remote.makeEvent(binding, 'Continues after resync', 2, true));
  await until(() => a.calls.ack.some(item => item.kind === 'event' && item.eventId === 'event-2'));
  assert.equal(JSON.parse(saved(f).conversation.document).domain.messages.at(-1).text, 'Continues after resync');
});

for (const action of ['shutdown', 'replacement']) test(`${action} waits for resync snapshot and forbids its late application`, { timeout: 15_000 }, async t => {
  const remote = await providerService(t), a = remote.extension(), feeds = resyncable(a);
  const f = await fixture(t, [a]); await f.create(); await until(() => a.calls.ready === 1);
  const before = saved(f), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const snapshot = a.backend.snapshot;
  a.backend.snapshot = async binding => {
    const result = await snapshot(binding); entered.resolve(); await release.promise; return result;
  };
  replacement(remote); feeds[0].resync(); await entered.promise;
  let settled = false;
  const b = remote.extension();
  const finishing = (action === 'shutdown' ? f.running.close() : f.running.replaceProviderExtensions([b.value]))
    .finally(() => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(a.calls.closed, 0); assert.equal(a.calls.disposed, 0);
    await assert.rejects(feeds[0].receive(remote.makeEvent(feeds[0].input.binding, 'Late output', 1)), /stream closed/);
    assert.deepEqual(saved(f), before);
  } finally { release.resolve(); await finishing; }
  assert.deepEqual(saved(f), before);
  assert.equal(feeds.length, 1); assert.equal(a.calls.closed, 1); assert.equal(a.calls.disposed, 1);
  if (action === 'replacement') {
    assert.equal(b.calls.observe.length, 1);
    assert.deepEqual(b.calls.observe[0].after, JSON.parse(before.checkpoint.data).cursor);
  }
});

for (const failure of ['unsupported', 'unavailable', 'throws', 'foreign-binding', 'projection']) {
  test(`resync snapshot ${failure} preserves history without poisoning cleanup`, { timeout: 15_000 }, async t => {
    const remote = await providerService(t), a = remote.extension(), feeds = resyncable(a);
    const f = await fixture(t, [a]); await f.create(); await until(() => a.calls.ready === 1);
    const before = saved(f), entered = Promise.withResolvers(), fresh = replacement(remote);
    a.backend.snapshot = async () => {
      entered.resolve();
      if (failure === 'throws') throw new Error('Snapshot temporarily unavailable');
      if (failure === 'unsupported' || failure === 'unavailable') return { kind: failure, reason: 'Recovery unavailable' };
      if (failure === 'projection') fresh.projectionVersion++;
      else fresh.binding.creation.scope.conversationId = 'foreign';
      return { kind: 'available', snapshot: fresh };
    };
    feeds[0].resync(); await entered.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(saved(f), before); assert.equal(feeds.length, 1);
    const b = remote.extension();
    assert.equal((await f.running.replaceProviderExtensions([b.value])).kind, 'replaced');
    assert.deepEqual(saved(f), before);
    await f.running.close();
  });
}

test('immediate repeated resync stops until an explicit retry instead of spinning', { timeout: 15_000 }, async t => {
  const remote = await providerService(t), a = remote.extension();
  let observations = 0, snapshots = 0;
  const snapshot = a.backend.snapshot;
  a.backend.snapshot = binding => { snapshots++; return snapshot(binding); };
  a.backend.observe = () => {
    observations++;
    return { close() {}, ended: Promise.resolve({ kind: 'resync', cursor: null, reason: 'Unbridgeable gap' }) };
  };
  const f = await fixture(t, [a]), scope = await f.create();
  await until(() => observations === 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observations, 2); assert.equal(snapshots, 2);
  for (let i = 0; i < 3; i++) assert.deepEqual(await f.client.providerObservation({ scope, action: 'read' }), { kind: 'stopped', reason: 'retry-exhausted' });
  assert.equal(observations, 2); assert.equal(snapshots, 2);
  assert.equal((await readSnapshot(f.client.conversation(scope), 2)).cursor, saved(f).conversation.head);
  const port = f.client.conversation(scope), command = send(scope, 'while-paused');
  const accepted = await port.submit(command);
  assert.equal(accepted.receipt.state.kind, 'accepted');
  assert.deepEqual(await port.submit(command), accepted);
  assert.equal((await port.submit({ version: 1, scope, clientCommandId: 'rejected-stop',
    body: { kind: 'cancel', runId: 'missing-run' } })).kind, 'rejected');
  assert.deepEqual(await f.client.providerObservation({ scope, action: 'read' }), { kind: 'stopped', reason: 'retry-exhausted' });
  assert.equal(observations, 2); assert.equal(snapshots, 2);
  await f.client.providerObservation({ scope, action: 'retry' });
  await until(() => observations === 4);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(snapshots, 4);
  await f.running.close(); assert.equal(observations, 4); assert.equal(snapshots, 4);
});

for (const progress of ['event', 'duplicate', 'snapshot']) test(`${progress === 'event' ? 'new committed event does' : progress === 'duplicate' ? 'duplicate replay does not' : 'feed snapshot does not'} allow another resync recovery`, { timeout: 15_000 }, async t => {
  const renews = progress === 'event';
  const remote = await providerService(t), a = remote.extension();
  const f = await fixture(t, [a]); await f.create(); await until(() => a.calls.ready === 1);
  const binding = remote.conversations.get('chat').snapshot.binding;
  const event = remote.emit(remote.makeEvent(binding, 'Original progress', 1));
  await until(() => a.calls.ack.length === 1);
  const original = f.inspect(db => JSON.parse(db.prepare('SELECT original FROM provider_creations').get().original));
  const limits = f.inspect(db => JSON.parse(db.prepare('SELECT value FROM host_limits').get().value));
  await f.running.close();
  const store = new SqliteStore(join(f.directory, 'host.sqlite'), transcriptProjection, limits);
  const feeds = [], thirdOpened = Promise.withResolvers();
  let snapshots = 0;
  const backend = {
    async snapshot() { snapshots++; return { kind: 'available', snapshot: structuredClone(remote.conversations.get('chat').snapshot) }; },
    observe(input, receive) {
      const end = Promise.withResolvers();
      feeds.push({ input, receive, resync: () => end.resolve({ kind: 'resync', cursor: null, reason: 'Expired' }) });
      if (feeds.length === 3) thirdOpened.resolve();
      return { close() { end.resolve({ kind: 'closed', cursor: null, reason: 'closed' }); }, ended: end.promise };
    },
  };
  const stream = await observeProvider(backend, a.presentation, original, binding, () => {}, store);
  t.after(async () => { stream.close(); await stream.drained; store.close(); });
  feeds[0].resync(); await until(() => feeds.length === 2);
  await feeds[1].receive(progress === 'snapshot' ? { kind: 'snapshot', snapshot: remote.conversations.get('chat').snapshot }
    : renews ? remote.makeEvent(binding, 'New progress', 2) : event);
  feeds[1].resync();
  const result = await Promise.race([stream.drained.then(() => 'drained'), thirdOpened.promise.then(() => 'third-feed')]);
  assert.equal(result, renews ? 'third-feed' : 'drained');
  assert.equal(feeds.length, renews ? 3 : 2);
  assert.equal(snapshots, renews ? 2 : 1);
});

test('a naturally ended feed is not closed again during resync', { timeout: 15_000 }, async t => {
  const remote = await providerService(t), a = remote.extension(), feeds = resyncable(a), observe = a.backend.observe;
  a.backend.observe = (input, receive) => {
    const feed = observe(input, receive);
    return feeds.length === 1 ? { close() { throw new Error('Already ended feed'); }, ended: feed.ended } : feed;
  };
  const f = await fixture(t, [a]); await f.create(); await until(() => a.calls.ready === 1);
  feeds[0].resync(); await until(() => feeds.length === 2 && a.calls.ready === 2);
  await f.running.close(); assert.equal(a.calls.closed, 1);
});

test('replacement feed close failure rejects shutdown even when its ending never settles', { timeout: 15_000 }, async t => {
  const remote = await providerService(t), a = remote.extension(), feeds = resyncable(a);
  const f = await fixture(t, [a], { shutdownFailure: true }); await f.create(); await until(() => a.calls.ready === 1);
  const observe = a.backend.observe;
  let release;
  a.backend.observe = (input, receive) => {
    const feed = observe(input, receive); release = feed.close;
    return { close() { throw new Error('Replacement close failed'); }, ended: feed.ended };
  };
  feeds[0].resync(); await until(() => feeds.length === 2 && a.calls.ready === 2);
  try { await assert.rejects(f.running.close(), /Host shutdown failed/); }
  finally { release(); }
});

test('credential revocation during resync snapshot forbids late writes and replacement observation', { timeout: 15_000 }, async t => {
  const remote = await providerService(t), a = remote.extension(), feeds = resyncable(a);
  const f = await fixture(t, [a]); await f.create(); await until(() => a.calls.ready === 1);
  const before = saved(f), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const snapshot = a.backend.snapshot;
  a.backend.snapshot = async binding => {
    const result = await snapshot(binding); entered.resolve(); await release.promise; return result;
  };
  replacement(remote); feeds[0].resync(); await entered.promise;
  try {
    f.inspect(db => db.prepare('UPDATE service_provider_credentials SET revoked=1').run());
  } finally { release.resolve(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(saved(f), before); assert.equal(feeds.length, 1);
  await f.running.close();
});
