import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { ownDirectory } from '../../apps/host/build/tsc/ownership.js';
import { providerService, fixture, saved, send } from './provider-stream-fixture.mjs';
import { until } from '../host/fixture.mjs';

const replace = (f, extensions) => f.running.replaceProviderExtensions(extensions.map(extension => extension.value));

test('live replacement resumes one saved observation and an existing HTTP watch without repeating effects', async t => {
  const remote = await providerService(t), a = remote.extension(), f = await fixture(t, [a]), scope = await f.create();
  await until(() => a.calls.ready === 1);
  const items = [], feed = f.client.conversation(scope).watch({ after: null, projectionVersion: 4 }, async item => { items.push(item); });
  t.after(() => feed.close()); await until(() => items.length === 1);
  await f.client.conversation(scope).submit(send(scope));
  const binding = remote.conversations.get('chat').snapshot.binding;
  remote.emit(remote.makeEvent(binding, 'Before replacement', 1));
  await until(() => a.calls.ack.length === 1);
  const before = saved(f), b = remote.extension();
  assert.equal((await replace(f, [b])).kind, 'replaced');
  assert.equal(b.calls.observe.length, 1);
  await until(() => b.calls.ready === 1 && remote.clients.size === 1);
  assert.equal(a.calls.closed, 1); assert.equal(a.calls.disposed, 1);
  assert.deepEqual(b.calls.observe[0], { binding: a.calls.observe[0].binding, after: JSON.parse(before.checkpoint.data).cursor });
  assert.deepEqual(b.calls.connected[0].credential, a.calls.connected[0].credential);
  assert.deepEqual(saved(f), before);
  await assert.rejects(a.calls.receive(remote.makeEvent(binding, 'Late retired callback', 2)), /stream closed/);
  const duplicate = remote.conversations.get('chat').history[0];
  remote.emit(duplicate, false); await until(() => b.calls.ack.length === 1);
  assert.deepEqual(saved(f), before);
  remote.emit(remote.makeEvent(binding, 'Completed after replacement', 2, true));
  await until(() => b.calls.ack.length === 2);
  await until(() => items.some(item => item.kind === 'events' && item.events.some(envelope => envelope.event.event?.kind === 'run-ended')));
  assert.equal(JSON.parse(saved(f).conversation.document).domain.messages.at(-1).text, 'Completed after replacement');
  const final = saved(f);
  remote.emit({ ...duplicate, event: { ...duplicate.event, text: 'Changed duplicate' } }, false);
  await until(() => b.calls.failures.length > 0); assert.deepEqual(saved(f), final);
  assert.deepEqual(remote.requests.filter(value => ['/create', '/snapshot', '/submit', '/lookup'].includes(value.path)).map(value => value.path), ['/create', '/snapshot', '/submit']);
});

test('replacement preserves history across unavailable generations and retries compatible observation', async t => {
  const remote = await providerService(t), a = remote.extension(), f = await fixture(t, [a]), scope = await f.create();
  await until(() => a.calls.ready === 1);
  const binding = remote.conversations.get('chat').snapshot.binding;
  await a.calls.receive(remote.makeEvent(binding, 'Saved output', 1)); const before = saved(f);
  for (const options of [{ generation: 'different' }, { revision: 'different' }, { mutate(presentation) { presentation.decodeState = () => { throw new Error('decoder unavailable'); }; } }]) {
    const b = remote.extension(options);
    assert.equal((await replace(f, [b])).kind, 'replaced');
    assert.equal(b.calls.observe.length, 0); assert.deepEqual(saved(f), before);
    const items = [], feed = f.client.conversation(scope).watch({ after: null, projectionVersion: 4 }, async item => { items.push(item); });
    await until(() => items.length === 1); feed.close();
    assert.equal(items[0].snapshot.document.domain.messages.at(-1).text, 'Saved output');
    const resumed = remote.extension(); await replace(f, [resumed]);
    assert.equal(resumed.calls.observe.length, 1); assert.deepEqual(saved(f), before);
  }
  assert.deepEqual(await replace(f, []), { kind: 'replaced', generation: null });
  const failed = remote.extension(); failed.backend.discover = async () => { throw new Error('unavailable'); };
  assert.equal((await replace(f, [failed])).kind, 'replaced');
  assert.deepEqual((await f.running.discoverProviders()).map(item => item.cause), ['invalid-installation']);
  assert.equal(failed.calls.observe.length, 0); assert.deepEqual(saved(f), before);
  const resumed = remote.extension(); await replace(f, [resumed]);
  assert.equal(resumed.calls.observe.length, 1); assert.deepEqual(saved(f), before);
  assert.equal(remote.requests.filter(value => value.path === '/create').length, 1);
  assert.equal(remote.requests.filter(value => value.path === '/snapshot').length, 1);
});

for (const failure of ['close-throws', 'drain-rejects', 'internal-close-throws']) {
  test(`${failure} freezes credentials, drains all streams, and permanently refuses replacement`, async t => {
    const remote = await providerService(t), a = remote.extension(), observe = a.backend.observe;
    let closeCalls = 0, credentialAttempt;
    a.backend.observe = (input, receive) => {
      const feed = observe(input, receive);
      return { close() {
        closeCalls++;
        credentialAttempt ??= a.context.credentials.use({ credential: a.credential, service: remote.service }, async () => 'authorized').then(() => 'authorized', () => 'refused');
        feed.close();
        if (failure !== 'drain-rejects') throw new Error('feed close failed');
      }, ended: failure === 'drain-rejects' ? feed.ended.then(() => { throw new Error('feed drain failed'); }) : feed.ended };
    };
    const f = await fixture(t, [a], { shutdownFailure: true }); await f.create(); await f.create('other');
    await until(() => a.calls.ready === 2);
    const before = saved(f), binding = remote.conversations.get('chat').snapshot.binding;
    if (failure === 'internal-close-throws') {
      await assert.rejects(a.calls.receive({ kind: 'event', invalid: true }));
      await new Promise(resolve => setImmediate(resolve));
      const expected = { kind: 'stopped', reason: 'cleanup-failed' }, scope = f.scope('other');
      assert.deepEqual(await f.client.providerObservation({ scope, action: 'read' }), expected);
      assert.deepEqual(await f.client.providerObservation({ scope, action: 'retry' }), expected);
      assert.equal(a.calls.observe.length, 2);
    }
    const b = remote.extension();
    assert.deepEqual(await replace(f, [b]), { kind: 'failed', failure: 'cleanup', recovery: 'restart' });
    if (failure !== 'internal-close-throws') assert.equal(await credentialAttempt, 'refused');
    assert.equal(closeCalls, 2); assert.equal(a.calls.closed, 1); assert.equal(a.calls.disposed, 1);
    assert.equal(b.calls.connected.length, 0); assert.equal(b.calls.observe.length, 0);
    assert.deepEqual(await replace(f, [b]), { kind: 'failed', failure: 'cleanup', recovery: 'restart' });
    await assert.rejects(a.calls.receive(remote.makeEvent(binding, 'Late output', 1)), /stream closed/);
    assert.deepEqual(saved(f), before);
    await assert.rejects(f.running.close(), /Host shutdown failed/);
    assert.equal(closeCalls, 2); assert.equal(a.calls.closed, 1); assert.equal(a.calls.disposed, 1);
  });
}

test('synchronous invalid observation closes its eventually assigned feed once and cannot write later', async t => {
  const remote = await providerService(t), a = remote.extension(), observe = a.backend.observe, end = Promise.withResolvers();
  a.backend.observe = (input, receive) => {
    const cyclic = {}; cyclic.cyclic = cyclic;
    void receive(cyclic).catch(() => {});
    const feed = observe(input, receive);
    return { close: feed.close, ended: feed.ended.then(() => end.promise) };
  };
  const f = await fixture(t, [a]); await f.create();
  const before = saved(f), binding = remote.conversations.get('chat').snapshot.binding;
  const closing = f.running.close();
  await new Promise(resolve => setImmediate(resolve)); end.resolve(); await closing;
  assert.equal(a.calls.feedClosed, 1); assert.equal(a.calls.closed, 1); assert.equal(a.calls.disposed, 1);
  await assert.rejects(a.calls.receive(remote.makeEvent(binding, 'Late output', 1)), /stream closed/);
  assert.deepEqual(saved(f), before);
});

test('normal feed disconnect permits replacement and observation retry without poisoning cleanup', async t => {
  const remote = await providerService(t), a = remote.extension(), f = await fixture(t, [a]); await f.create();
  await until(() => a.calls.ready === 1);
  a.calls.disconnect(); await new Promise(resolve => setImmediate(resolve));
  const b = remote.extension(); assert.equal((await replace(f, [b])).kind, 'replaced');
  assert.equal(b.calls.observe.length, 1); assert.equal(a.calls.closed, 1); assert.equal(a.calls.disposed, 1);
  await f.running.close(); assert.equal(b.calls.feedClosed, 1);
});

test('throwing feed close reports cleanup failure even if its ended promise never settles', async t => {
  const remote = await providerService(t), a = remote.extension(), observe = a.backend.observe;
  let release;
  a.backend.observe = (input, receive) => {
    const feed = observe(input, receive); release = feed.close;
    return { close() { throw new Error('close failed before ending'); }, ended: feed.ended };
  };
  const f = await fixture(t, [a], { shutdownFailure: true }); await f.create();
  await until(() => a.calls.ready === 1);
  const b = remote.extension(), replacing = replace(f, [b]);
  try {
    const result = await Promise.race([replacing, new Promise(resolve => setImmediate(() => resolve('still pending')))]);
    assert.deepEqual(result, { kind: 'failed', failure: 'cleanup', recovery: 'restart' });
    assert.equal(b.calls.connected.length, 0);
    await assert.rejects(f.running.close(), /Host shutdown failed/);
  } finally { release(); await replacing; }
});

for (const when of ['before-receive', 'during-copy']) {
  test(`revocation ${when} refuses callback admission before any durable change`, async t => {
    const remote = await providerService(t), a = remote.extension(), f = await fixture(t, [a]); await f.create();
    const before = saved(f), binding = remote.conversations.get('chat').snapshot.binding;
    const item = remote.makeEvent(binding, 'Unauthorized output', 1);
    const revoke = () => f.inspect(db => db.prepare('UPDATE service_provider_credentials SET revoked=1').run());
    if (when === 'before-receive') revoke();
    else {
      const event = item.event;
      Object.defineProperty(item, 'event', { enumerable: true, get() { revoke(); return event; } });
    }
    await assert.rejects(a.calls.receive(item));
    assert.deepEqual(saved(f), before);
    await assert.rejects(a.context.credentials.use({ credential: a.credential, service: remote.service }, async () => assert.fail('revoked effect')));
  });
}

test('replacement waits for old feed drain and resumes after the last admitted callback', async t => {
  const remote = await providerService(t), a = remote.extension(), observe = a.backend.observe, end = Promise.withResolvers();
  a.backend.observe = (input, receive) => {
    const feed = observe(input, receive); return { close: feed.close, ended: feed.ended.then(() => end.promise) };
  };
  const f = await fixture(t, [a]); await f.create(); await until(() => a.calls.ready === 1);
  const binding = remote.conversations.get('chat').snapshot.binding;
  const accepted = a.calls.receive(remote.makeEvent(binding, 'Admitted before retirement', 1));
  const b = remote.extension(), replacing = replace(f, [b]);
  try {
    await until(() => a.calls.feedClosed === 1); await accepted;
    assert.equal(f.running.extensionStatus().kind, 'changing');
    assert.equal(b.calls.connected.length, 0); assert.equal(a.calls.closed, 0); assert.equal(a.calls.disposed, 0);
    const before = saved(f); assert.equal(JSON.parse(before.conversation.document).domain.messages.at(-1).text, 'Admitted before retirement');
    await assert.rejects(a.calls.receive(remote.makeEvent(binding, 'Too late', 2)), /stream closed/);
    end.resolve(); assert.equal((await replacing).kind, 'replaced');
    assert.deepEqual(b.calls.observe[0].after, JSON.parse(before.checkpoint.data).cursor);
    assert.deepEqual(saved(f), before); assert.equal(a.calls.feedClosed, 1);
  } finally { end.resolve(); await replacing; }
});

test('observation acquisition and command acceptance defer replacement while idle live feeds do not', async t => {
  const remote = await providerService(t), a = remote.extension(), snapshot = a.backend.snapshot;
  const acquiring = Promise.withResolvers(), snapshotRelease = Promise.withResolvers();
  a.backend.snapshot = async binding => { acquiring.resolve(); await snapshotRelease.promise; return snapshot(binding); };
  const f = await fixture(t, [a]), creating = f.create(), b = remote.extension();
  try {
    await acquiring.promise;
    assert.deepEqual(await replace(f, [b]), { kind: 'deferred', reason: 'active-work' });
    assert.equal(b.calls.connected.length, 0); assert.equal(a.calls.closed, 0);
  } finally { snapshotRelease.resolve(); }
  const scope = await creating; await until(() => a.calls.ready === 1);
  const accepting = Promise.withResolvers(), commandRelease = Promise.withResolvers();
  remote.command(async operation => { accepting.resolve(); await commandRelease.promise;
    return { kind: 'confirmed', value: { kind: 'send', state: 'accepted', run: remote.ref(operation.binding, 'run', 'same-run') }, evidence: null }; });
  const sending = f.client.conversation(scope).submit(send(scope));
  try {
    await accepting.promise;
    assert.deepEqual(await replace(f, [b]), { kind: 'deferred', reason: 'active-work' });
    assert.equal(b.calls.connected.length, 0); assert.equal(a.calls.closed, 0);
  } finally { commandRelease.resolve(); }
  assert.equal((await sending).receipt.state.kind, 'accepted');
  assert.equal((await replace(f, [b])).kind, 'replaced'); assert.equal(b.calls.observe.length, 1);
});

test('disable refuses new dispatch, preserves history, and compatible re-enable resumes without remote commands', async t => {
  const remote = await providerService(t), a = remote.extension({ controls: true }), f = await fixture(t, [a]), scope = await f.create();
  await until(() => a.calls.ready === 1);
  const binding = remote.conversations.get('chat').snapshot.binding;
  await a.calls.receive(remote.makeEvent(binding, 'Saved before disable', 1)); const before = saved(f);
  assert.deepEqual(await replace(f, []), { kind: 'replaced', generation: null });
  const result = await f.client.conversation(scope).submit(send(scope, 'disabled-send'));
  assert.equal(result.kind, 'rejected'); assert.deepEqual(saved(f), before);
  const b = remote.extension({ controls: true }); assert.equal((await replace(f, [b])).kind, 'replaced');
  assert.equal(b.calls.observe.length, 1); assert.deepEqual(saved(f), before);
  assert.equal(remote.requests.filter(value => ['/submit', '/lookup'].includes(value.path)).length, 0);
});

test('shutdown during replacement recovery waits for acquisition and stops scanning saved conversations', async t => {
  const remote = await providerService(t), a = remote.extension();
  a.backend.snapshot = async () => { throw new Error('snapshot temporarily unavailable'); };
  const f = await fixture(t, [a]); await f.create(); await f.create('other');
  const before = saved(f), b = remote.extension(), snapshot = b.backend.snapshot;
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let snapshots = 0;
  b.backend.snapshot = async binding => { snapshots++; entered.resolve(); await release.promise; return snapshot(binding); };
  const recovering = replace(f, [b]); await entered.promise;
  const c = remote.extension(); assert.deepEqual(await replace(f, [c]), { kind: 'deferred', reason: 'active-work' });
  const closing = f.running.close();
  release.resolve(); await recovering; await closing;
  assert.equal(snapshots, 1); assert.equal(b.calls.observe.length, 0); assert.equal(c.calls.connected.length, 0);
  assert.equal(b.calls.closed, 1); assert.equal(b.calls.disposed, 1); assert.deepEqual(saved(f), before);
});

test('a newer replacement takes over recovery without opening later conversations on the obsolete generation', async t => {
  const remote = await providerService(t), a = remote.extension(), f = await fixture(t, [a]); await f.create(); await f.create('other');
  const b = remote.extension(), c = remote.extension(), observe = b.backend.observe;
  const competing = Promise.withResolvers();
  b.backend.observe = (input, receive) => {
    const feed = observe(input, receive);
    void (async () => {
      for (let turn = 0; turn < 50; turn++) {
        await Promise.resolve();
        const status = f.running.extensionStatus();
        if (status.kind === 'active' && status.pending === 0) return replace(f, [c]);
      }
      assert.fail('Observation acquisition did not finish');
    })().then(competing.resolve, competing.reject);
    return feed;
  };
  await replace(f, [b]);
  assert.equal((await competing.promise).kind, 'replaced');
  assert.equal(b.calls.observe.length, 1); assert.equal(b.calls.feedClosed, 1);
  assert.equal(c.calls.observe.length, 2);
  await until(() => c.calls.ready === 2 && remote.clients.size === 2);
  assert.equal(remote.requests.filter(value => value.path === '/create').length, 2);
  assert.equal(remote.requests.filter(value => value.path === '/snapshot').length, 2);
});

for (const cleanupFails of [false, true]) {
  test(`host shutdown shares synchronous HTTP feed reentry through ${cleanupFails ? 'failed' : 'successful'} drain`, { timeout: 5000 }, async t => {
    const remote = await providerService(t), a = remote.extension(), observe = a.backend.observe, gate = Promise.withResolvers();
    let f, nested, credentialAttempt, settled = false;
    a.backend.observe = (input, receive) => {
      const feed = observe(input, receive);
      return { close() {
        nested ??= f.running.close();
        credentialAttempt ??= a.context.credentials.use({ credential: a.credential, service: remote.service }, async () => assert.fail('retired credential effect'))
          .then(() => 'authorized', () => 'refused');
        feed.close();
      }, ended: feed.ended.then(() => gate.promise).then(() => { if (cleanupFails) throw new Error('feed drain failed'); }) };
    };
    f = await fixture(t, [a], { shutdownFailure: cleanupFails }); await f.create(); await until(() => a.calls.ready === 1);
    const binding = remote.conversations.get('chat').snapshot.binding;
    const accepted = a.calls.receive(remote.makeEvent(binding, 'Admitted before reentrant shutdown', 1));
    const closedDatabases = [], closeDatabase = DatabaseSync.prototype.close;
    const storageClose = t.mock.method(DatabaseSync.prototype, 'close', function () {
      if (this.prepare('PRAGMA database_list').all().some(row => row.file === join(realpathSync(f.directory), 'host.sqlite'))) closedDatabases.push(this);
      return closeDatabase.call(this);
    });
    const outer = f.running.close(), result = outer.then(() => { settled = true; return null; }, error => { settled = true; return error; });
    try {
      assert.equal(nested, outer); assert.equal(f.running.close(), outer);
      await accepted;
      assert.equal(await credentialAttempt, 'refused');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false); assert.deepEqual(f.running.extensionStatus(), { kind: 'closing' });
      assert.equal(a.calls.feedClosed, 1); assert.equal(a.calls.closed, 0); assert.equal(a.calls.disposed, 0);
      assert.equal(closedDatabases.length, 0);
      assert.throws(() => ownDirectory(f.directory), /Another host owns/);
      await assert.rejects(a.calls.receive(remote.makeEvent(binding, 'Late callback', 2)), /stream closed/);
    } finally { gate.resolve(); await Promise.allSettled([outer, nested]); storageClose.mock.restore(); }
    const error = await result;
    assert.equal(a.calls.feedClosed, 1); assert.equal(a.calls.closed, 1); assert.equal(a.calls.disposed, 1);
    assert.equal(f.running.close(), outer);
    assert.equal(JSON.parse(saved(f).conversation.document).domain.messages.at(-1).text, 'Admitted before reentrant shutdown');
    if (cleanupFails) {
      assert.equal(error.message, 'Host shutdown failed'); assert.equal(error.cause.message, 'Provider cleanup failed');
      assert.deepEqual(f.running.extensionStatus(), { kind: 'failed', failure: 'cleanup', recovery: 'restart' });
      assert.deepEqual(await replace(f, []), f.running.extensionStatus());
      await assert.rejects(f.running.close(), value => value === error);
      assert.equal(closedDatabases.length, 0);
      assert.throws(() => ownDirectory(f.directory), /Another host owns/);
    } else {
      assert.equal(error, null); assert.deepEqual(f.running.extensionStatus(), { kind: 'closed' });
      await f.running.close();
      assert.equal(closedDatabases.length, 2); assert.equal(new Set(closedDatabases).size, 2);
      ownDirectory(f.directory).close();
    }
    assert.equal(a.calls.feedClosed, 1); assert.equal(a.calls.closed, 1); assert.equal(a.calls.disposed, 1);
  });
}
