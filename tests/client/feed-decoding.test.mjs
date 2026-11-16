import assert from 'node:assert/strict';
import test from 'node:test';
import { FeedMismatchError, parseFeedItem } from '@agentui/contracts';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { parseServicePull } from '@agentui/contracts/service';
import { createBrowserConnection } from '@agentui/client/service';
import { connected, events, projection, scope, snapshot } from './support.mjs';

const transcriptSnapshot = { kind: 'snapshot', snapshot: { scope, cursor: 0, projectionVersion: 4,
  document: { domain: transcriptProjection.initial(), receipts: {}, decisions: {} } } };

for (const [name, corrupt] of [
  ['extra feed field', item => { item.extra = true; }],
  ['extra envelope field', item => { item.events[0].extra = true; }],
  ['missing envelope scope', item => { delete item.events[0].scope; }],
  ['extra event field', item => { item.events[0].event.extra = true; }],
  ['invalid sequence', item => { item.events[0].sequence = 1.5; }],
]) {
  test(`canonical and direct feed boundaries reject ${name}`, async t => {
    const invalid = events([1, 'unpublished']);
    corrupt(invalid);
    assert.throws(() => parseFeedItem(invalid, projection, scope));
    const { store, stream } = await connected();
    t.after(() => store.disconnect());
    await assert.rejects(stream.receive(invalid));
    assert.equal(store.getSnapshot().connection.kind, 'resync');
    assert.equal(store.getSnapshot().cursor, 0);
    assert.equal(store.getSnapshot().document.domain.text, '');
  });
}

test('service framing preserves a second projection for canonical decoding at its consumer', () => {
  const framed = parseServicePull({ kind: 'page', page: 1, item: snapshot(4, 'text projection') });
  assert.deepEqual(parseFeedItem(framed.item, projection, scope), framed.item);
  assert.throws(() => parseFeedItem(framed.item, transcriptProjection, scope));
  const framedEvents = parseServicePull({ kind: 'page', page: 2, item: events([5, ' more']) });
  assert.deepEqual(parseFeedItem(framedEvents.item, projection, scope), framedEvents.item);
});

test('projection mismatch is classified before attempting to decode state', () => {
  const incompatible = structuredClone(transcriptSnapshot);
  incompatible.snapshot.projectionVersion = 1;
  incompatible.snapshot.document.domain = null;
  assert.throws(() => parseFeedItem(incompatible, { ...transcriptProjection,
    decodeState() { assert.fail('Incompatible projection reached state decoder'); } }, scope), FeedMismatchError);
});

for (const [name, item, expected] of [
  ['foreign snapshot', { ...transcriptSnapshot, snapshot: { ...transcriptSnapshot.snapshot, scope: { ...scope, hostId: 'foreign' } } }, 'refused'],
  ['foreign event envelope', { kind: 'events', events: [{ scope: { ...scope, hostId: 'foreign' }, sequence: 1,
    event: { kind: 'decision-closed', pendingId: 'pending' } }] }, 'refused'],
  ['extra event envelope field', { kind: 'events', events: [{ scope, sequence: 1, extra: true,
    event: { kind: 'decision-closed', pendingId: 'pending' } }] }, 'resync'],
  ['invalid domain event', { kind: 'events', events: [{ scope, sequence: 1, event: { kind: 'domain', event: 'not a transcript event' } }] }, 'resync'],
]) {
  test(`public browser watch validates ${name} before delivery`, async () => {
    const connection = createBrowserConnection({ fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      return Response.json({ ok: true, value: request.op === 'watch' ? { feedId: 'feed' }
        : request.op === 'close' ? null : { kind: 'page', page: 1, item } });
    } });
    const feed = connection.conversation(scope).watch({ after: 8, projectionVersion: 4 }, async () => assert.fail('Invalid item delivered'));
    const end = await feed.ended;
    assert.equal(end.kind, expected);
    assert.equal(end.cursor, 8);
  });
}


test('changed duplicate wire events cannot hide behind projection normalization', async t => {
  const selectedProjection = { ...projection, decodeEvent: value => projection.decodeEvent(value).trim() };
  const { store, stream } = await connected({ selectedProjection });
  t.after(() => store.disconnect());
  await stream.receive(events([1, 'same']));
  await stream.receive(events([1, 'same']));
  await assert.rejects(stream.receive(events([1, ' same '])), /changed duplicate/);
  assert.equal(store.getSnapshot().connection.kind, 'resync');
  assert.equal(store.getSnapshot().cursor, 1);
  assert.equal(store.getSnapshot().document.domain.text, 'same');
});
