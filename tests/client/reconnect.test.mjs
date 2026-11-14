import assert from 'node:assert/strict';
import test from 'node:test';
import { connected, events, fixture, snapshot, storage } from './support.mjs';
import { fixture as hostFixture, installed, note, projection, scope, deferred, until } from '../host/fixture.mjs';

for (const ending of ['disconnect', 'closed', 'failed', 'rejected']) {
  test(`${ending} retains the applied cursor and duplicate identities without command replay`, async () => {
    const { store, stream, port } = await connected();
    await stream.receive(events([1, 'one']));
    await store.setDraft('original');
    await store.send();
    await store.setDraft('newer draft');
    const before = store.getSnapshot();
    if (ending === 'disconnect') store.disconnect();
    else if (ending === 'rejected') {
      port.watch = function (request, receive) {
        const next = { request, receive, close() {}, ended: Promise.reject(new Error('Network lost')) };
        this.watches.push(next);
        return next;
      };
      await store.connect();
      await until(() => store.getSnapshot().connection.kind === 'failed');
    } else {
      stream.finish({ kind: ending, reason: 'Network lost', cursor: 999 });
      await until(() => store.getSnapshot().connection.kind !== 'connected');
    }
    if (ending === 'rejected') {
      port.watch = function (request, receive) {
        const next = { request, receive, close() {}, ended: new Promise(() => {}) };
        this.watches.push(next);
        return next;
      };
    }
    await store.connect();
    const resumed = port.watches.at(-1);
    assert.deepEqual(resumed.request, { after: 1, projectionVersion: 1 });
    await resumed.receive(events([1, 'one'], [2, 'two']));
    const after = store.getSnapshot();
    assert.equal(after.document.domain.text, 'onetwo');
    assert.equal(after.cursor, 2);
    assert.equal(after.connection.kind, 'connected');
    assert.equal(after.draft, before.draft);
    assert.deepEqual(after.outbox, before.outbox);
    assert.equal(port.submitted.length, 1);
    store.disconnect();
  });
}

test('empty resume acknowledgement connects a quiet view without replacing its document', async () => {
  const { store, stream, port } = await connected();
  await stream.receive(events([1, 'unchanged']));
  const document = store.getSnapshot().document;
  store.disconnect();
  await store.connect();
  const resumed = port.watches.at(-1);
  assert.equal(store.getSnapshot().connection.kind, 'connecting');
  let notices = 0;
  store.subscribe(() => notices++);
  await resumed.receive(events());
  assert.equal(store.getSnapshot().connection.kind, 'connected');
  assert.equal(store.getSnapshot().document, document);
  assert.equal(store.getSnapshot().cursor, 1);
  assert.equal(notices, 1);
  await resumed.receive(events());
  assert.equal(notices, 1);
});

for (const invalid of ['malformed', 'gap', 'changed-duplicate', 'concurrent', 'resync-end', 'regressed-snapshot']) {
  test(`${invalid} invalidates resume trust while retaining the last good view and local intent`, async () => {
    const { store, stream, port } = await connected();
    await stream.receive(events([1, 'good']));
    await store.setDraft('unsent');
    await store.send();
    const before = store.getSnapshot();
    if (invalid === 'concurrent') {
      const first = stream.receive(events([2, 'unacknowledged']));
      await stream.receive(events([3, 'concurrent']));
      await first;
    } else if (invalid === 'resync-end') {
      stream.finish({ kind: 'resync', cursor: 999, reason: 'journal-gap' });
      await until(() => store.getSnapshot().connection.kind === 'resync');
    } else {
      const bad = invalid === 'malformed' ? events([2, 'uncommitted'], [3, {}])
        : invalid === 'gap' ? events([2, 'uncommitted'], [4, 'gap'])
        : invalid === 'changed-duplicate' ? events([1, 'changed']) : snapshot(0, 'regressed');
      await assert.rejects(stream.receive(bad));
    }
    assert.equal(store.getSnapshot().document, before.document);
    assert.equal(store.getSnapshot().cursor, 1);
    assert.equal(store.getSnapshot().draft, before.draft);
    assert.deepEqual(store.getSnapshot().outbox, before.outbox);
    await store.connect();
    assert.equal(port.watches.at(-1).request.after, null);
    await assert.rejects(port.watches.at(-1).receive(events()), /before a snapshot/);
    await store.connect();
    await port.watches.at(-1).receive(snapshot(4, 'authoritative'));
    assert.equal(store.getSnapshot().document.domain.text, 'authoritative');
    assert.equal(store.getSnapshot().connection.kind, 'connected');
    assert.equal(port.submitted.length, 1);
    assert.deepEqual(store.getSnapshot().outbox, before.outbox);
  });
}

for (const mismatch of ['scope', 'projection', 'refused']) {
  test(`${mismatch} mismatch preserves local intent and blocks command submission`, async () => {
    const { store, stream, port } = await connected();
    await store.setDraft('saved command');
    await store.send();
    const before = store.getSnapshot();
    if (mismatch === 'refused') {
      stream.finish({ kind: 'refused', reason: 'incompatible', cursor: null });
      await until(() => store.getSnapshot().connection.kind === 'mismatch');
    } else {
      const bad = snapshot(5, 'invalid');
      if (mismatch === 'scope') bad.snapshot.scope = { ...scope, hostId: 'foreign' };
      else bad.snapshot.projectionVersion = 9;
      await assert.rejects(stream.receive(bad), /mismatch/);
    }
    await assert.rejects(store.send());
    await assert.rejects(store.approve('pending', 'yes'));
    await assert.rejects(store.cancel('run'));
    await assert.rejects(store.retry(before.outbox[0].command.clientCommandId));
    assert.equal(store.getSnapshot().connection.kind, 'mismatch');
    assert.equal(store.getSnapshot().document, before.document);
    assert.equal(store.getSnapshot().draft, before.draft);
    assert.deepEqual(store.getSnapshot().outbox, before.outbox);
    assert.equal(port.submitted.length, 1);
    store.disconnect();
    await assert.rejects(store.send());
    await store.connect();
    assert.equal(port.watches.at(-1).request.after, null);
    await assert.rejects(store.retry(before.outbox[0].command.clientCommandId));
    await port.watches.at(-1).receive(snapshot());
    assert.equal(port.submitted.length, 1);
  });
}

test('a cold store restores only local intent and requires its own snapshot', async () => {
  const drafts = storage();
  const original = await connected({ drafts });
  await original.stream.receive(events([1, 'live baseline']));
  await original.store.setDraft('saved');
  await original.store.send();
  original.store.disconnect();
  const cold = fixture({ drafts });
  await cold.store.connect();
  assert.equal(cold.port.watches[0].request.after, null);
  assert.equal(cold.store.getSnapshot().cursor, null);
  assert.equal(cold.store.getSnapshot().draft, 'saved');
  assert.equal(cold.store.getSnapshot().outbox.length, 1);
  await assert.rejects(cold.port.watches[0].receive(events([2, 'without baseline'])), /before a snapshot/);
  assert.equal(cold.port.submitted.length, 0);
});

test('interrupted application never exposes or resumes from an unacknowledged cursor', async () => {
  const { store, stream, port } = await connected();
  await stream.receive(events([1, 'good']));
  const pending = stream.receive(events([2, 'uncommitted']));
  store.disconnect();
  await store.connect();
  await pending;
  const resumed = port.watches.at(-1);
  assert.equal(resumed.request.after, 1);
  await resumed.receive(events([2, 'committed']));
  await stream.receive(snapshot(99, 'stale'));
  assert.equal(store.getSnapshot().document.domain.text, 'goodcommitted');
  assert.equal(store.getSnapshot().cursor, 2);
});

test('real journal acknowledges quiet resume, replays bounded gaps and falls back to snapshots', async t => {
  const f = hostFixture(t);
  const host = f.open({ budgets: { replayEvents: 2, pageEvents: 1 } });
  host.createConversation(scope, installed);
  const underlying = host.conversation(scope), requests = [], deliveries = [];
  const port = { ...underlying, watch(request, receive) {
    requests.push(request);
    return underlying.watch(request, async item => { deliveries.push(item); await receive(item); });
  } };
  const { store } = fixture({ port, selectedProjection: projection });
  t.after(() => store.disconnect());
  const reconnect = async () => {
    store.disconnect();
    deliveries.length = 0;
    await store.connect();
    await until(() => store.getSnapshot().connection.kind === 'connected');
  };
  await reconnect();
  assert.equal(requests.at(-1).after, null);
  assert.equal(deliveries[0].kind, 'snapshot');
  await reconnect();
  assert.equal(requests.at(-1).after, 0);
  assert.deepEqual(deliveries, [{ kind: 'events', events: [] }]);
  store.disconnect();
  host.append(scope, note('one'));
  host.append(scope, note('two'));
  await reconnect();
  await until(() => store.getSnapshot().cursor === 2);
  assert.equal(requests.at(-1).after, 0);
  assert.deepEqual(deliveries.map(item => item.events.length), [0, 1, 1]);
  assert.deepEqual(store.getSnapshot().document.domain, ['one', 'two']);
  store.disconnect();
  for (const text of ['three', 'four', 'five']) host.append(scope, note(text));
  await reconnect();
  assert.equal(requests.at(-1).after, 2);
  assert.equal(deliveries[0].kind, 'snapshot');
  assert.equal(store.getSnapshot().cursor, 5);
  assert.deepEqual(store.getSnapshot().document.domain, ['one', 'two', 'three', 'four', 'five']);
});

test('initial resume acknowledgement is bounded and blocks subsequent delivery until accepted', async t => {
  const f = hostFixture(t), host = f.open({ budgets: { deliveryMs: 30 } });
  host.createConversation(scope, installed);
  host.append(scope, note('one'));
  const release = deferred(), deliveries = [];
  const feed = host.conversation(scope).watch({ after: 0, projectionVersion: 1 }, async item => {
    deliveries.push(item);
    await release.promise;
  });
  t.after(() => { release.resolve(); feed.close(); });
  assert.deepEqual(await feed.ended, { kind: 'resync', reason: 'delivery-timeout', cursor: 0 });
  assert.deepEqual(deliveries, [{ kind: 'events', events: [] }]);
  release.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(deliveries.length, 1);
});
