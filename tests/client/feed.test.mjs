import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connected, events, fixture, receipt, scope, snapshot } from './support.mjs';

test('pages publish once, preserve prior views and accept only identical duplicates', async () => {
  const { store, stream } = await connected();
  const before = store.getSnapshot();
  let notices = 0;
  store.subscribe(() => notices++);
  const page = events([1, 'a'], [2, 'b']);
  await stream.receive(page);
  assert.equal(notices, 1);
  assert.equal(before.document.domain.text, '');
  assert.equal(store.getSnapshot().document.domain.text, 'ab');
  assert.equal(Object.isFrozen(store.getSnapshot().document.domain), true);
  page.events[0].event.event = 'mutated by sender';
  assert.equal(store.getSnapshot().document.domain.text, 'ab');
  await stream.receive(events([1, 'a'], [2, 'b']));
  assert.equal(notices, 1);
  assert.equal(store.getSnapshot().document.domain.text, 'ab');
  await assert.rejects(stream.receive(events([2, 'different'])), /duplicate/);
  assert.equal(store.getSnapshot().connection.kind, 'resync');
  assert.equal(store.getSnapshot().cursor, 2);
});

test('gap rejects the whole page and reconnect requests an exact snapshot', async () => {
  const { store, port, stream } = await connected();
  await assert.rejects(stream.receive(events([1, 'a'], [3, 'c'])), /gap/);
  assert.equal(store.getSnapshot().cursor, 0);
  assert.equal(store.getSnapshot().document.domain.text, '');
  assert.equal(stream.closed, 1);
  await store.connect();
  assert.deepEqual(port.watches[1].request, { after: null, projectionVersion: 1 });
  await port.watches[1].receive(snapshot(3, 'abc'));
  assert.equal(store.getSnapshot().cursor, 3);
});

test('scope and projection version mismatches preserve host state', async () => {
  for (const invalid of [snapshot(9, 'bad', { ...scope, hostId: 'other' }), { kind: 'snapshot', snapshot: { ...snapshot().snapshot, projectionVersion: 9 } }]) {
    const { store, stream } = await connected();
    await assert.rejects(stream.receive(invalid), /mismatch/);
    assert.equal(store.getSnapshot().connection.kind, 'mismatch');
    assert.equal(store.getSnapshot().cursor, 0);
  }
});

test('snapshot replacement preserves local draft and uncertain outbox while restoring decisions', async () => {
  const { store, stream } = await connected();
  await store.setDraft('local');
  await store.approve('pending', 'allow');
  const before = store.getSnapshot().outbox;
  const decision = { pendingId: 'pending', runId: 'run', choices: ['allow'], prompt: 'Allow?' };
  await stream.receive(snapshot(8, 'remote', scope, {}, { pending: decision }));
  assert.equal(store.getSnapshot().document.domain.text, 'remote');
  assert.equal(store.getSnapshot().draft, 'local');
  assert.deepEqual(store.getSnapshot().outbox, before);
  assert.deepEqual(store.getSnapshot().document.decisions.pending, decision);
});

test('response loss then a completed snapshot preserves exact retry ID and newer draft', async () => {
  const { store, stream, port, drafts } = await connected();
  await store.setDraft('sent');
  port.submit = async command => { port.submitted.push(command); throw new Error('lost'); };
  await assert.rejects(store.send(), /lost/);
  const command = port.submitted[0];
  const completed = receipt(command, 'completed', 1);
  await store.setDraft('newer text');
  const writes = drafts.writes.length;
  await stream.receive(snapshot(1, 'sent', scope, { [completed.clientCommandId]: completed }));
  assert.equal(drafts.writes.length, writes);
  assert.equal(store.getSnapshot().draft, 'newer text');
  assert.deepEqual(store.getSnapshot().outbox[0].command, command);
  assert.equal(store.getSnapshot().document.receipts[command.clientCommandId].state.kind, 'completed');
  port.submit = async retried => { port.submitted.push(retried); return { kind: 'receipt', receipt: completed }; };
  await store.retry(command.clientCommandId);
  assert.deepEqual(port.submitted, [command, command]);
  assert.equal(store.getSnapshot().draft, 'newer text');
  assert.equal(store.getSnapshot().outbox.length, 0);
});

test('disconnect is idempotent and stale callbacks and end notices cannot mutate a new connection', async () => {
  const { store, port, stream } = await connected();
  store.disconnect();
  store.disconnect();
  assert.equal(stream.closed, 1);
  await store.connect();
  await port.watches[1].receive(snapshot(4, 'current'));
  await stream.receive(snapshot(100, 'stale'));
  assert.equal(store.getSnapshot().cursor, 4);
  assert.equal(store.getSnapshot().connection.kind, 'connected');
});

test('disconnect before callback acknowledgement prevents late host cursor advancement', async () => {
  const { store, stream } = await connected();
  const delivering = stream.receive(snapshot(1, 'late'));
  store.disconnect();
  await delivering;
  assert.equal(store.getSnapshot().cursor, 0);
  assert.equal(store.getSnapshot().document.domain.text, '');
  assert.equal(store.getSnapshot().connection.kind, 'disconnected');
});

test('events without a snapshot and unknown earlier duplicates require explicit resync', async () => {
  const { store, port } = fixture();
  await store.connect();
  await assert.rejects(port.watches[0].receive(events([1, 'first'])), /before a snapshot/);
  assert.equal(store.getSnapshot().connection.kind, 'resync');
  await store.connect();
  await port.watches[1].receive(snapshot(3, 'abc'));
  await assert.rejects(port.watches[1].receive(events([2, 'b'])), /duplicate/);
});

test('malformed projection and cross-scope receipts reject a whole page', async () => {
  const { store, stream } = await connected();
  await assert.rejects(stream.receive(events([1, 'valid'], [2, { invalid: true }])), /Invalid text event/);
  assert.equal(store.getSnapshot().document.domain.text, '');
  const next = await connected();
  const foreign = { scope: { ...scope, conversationId: 'foreign' }, clientCommandId: 'id', hostOperationId: 'op', sequence: 1, state: { kind: 'accepted' } };
  await assert.rejects(next.stream.receive({ kind: 'events', events: [{ scope, sequence: 1, event: { kind: 'receipt', receipt: foreign } }] }), /scope mismatch/);
  assert.equal(next.store.getSnapshot().cursor, 0);
});

test('concurrent host callbacks close the connection without advancing either delivery', async () => {
  const { store, stream } = await connected();
  const first = stream.receive(events([1, 'one']));
  await stream.receive(events([2, 'two']));
  assert.equal(store.getSnapshot().connection.kind, 'failed');
  await first;
  assert.equal(store.getSnapshot().cursor, 0);
});

test('each reconnect requires its own snapshot before any events', async () => {
  const { store, stream, port } = await connected();
  await stream.receive(events([1, 'old']));
  store.disconnect();
  await store.connect();
  await assert.rejects(port.watches[1].receive(events([2, 'unbased'])), /before a snapshot/);
  assert.equal(store.getSnapshot().cursor, 1);
  assert.equal(store.getSnapshot().document.domain.text, 'old');
  assert.equal(store.getSnapshot().connection.kind, 'resync');
});

test('a snapshot cannot regress the cursor within one connection', async () => {
  const { store, stream, port } = await connected();
  await stream.receive(snapshot(5, 'current'));
  await assert.rejects(stream.receive(snapshot(4, 'stale')), /snapshot.*cursor/);
  assert.equal(store.getSnapshot().cursor, 5);
  assert.equal(store.getSnapshot().document.domain.text, 'current');
  await store.connect();
  await port.watches[1].receive(snapshot(3, 'explicit new baseline'));
  assert.equal(store.getSnapshot().cursor, 3);
  assert.equal(store.getSnapshot().document.domain.text, 'explicit new baseline');
});
