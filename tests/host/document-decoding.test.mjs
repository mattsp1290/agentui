import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { FeedMismatchError, parseFeedItem } from '@agentui/contracts';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { parseServicePull, parseServiceResponse } from '@agentui/contracts/service';
import { createBrowserConnection } from '@agentui/client/service';
import { fixture as clientFixture } from '../client/support.mjs';
import { fixture, installed, scope, until } from './fixture.mjs';

const receipt = { scope, clientCommandId: 'command', hostOperationId: 'operation', sequence: 1, state: { kind: 'accepted' } };
const decision = { pendingId: 'pending', runId: 'run', choices: ['yes'], prompt: 'Continue?' };
const valid = () => ({ domain: transcriptProjection.initial(), receipts: { command: structuredClone(receipt) }, decisions: { pending: structuredClone(decision) } });
const item = (document, cursor = 1) => ({ kind: 'snapshot', snapshot: { scope, projectionVersion: transcriptProjection.version, cursor, document } });
const page = document => ({ kind: 'page', page: 1, item: item(document) });
const malformed = [
  ['extra document field', document => { document.extra = true; }],
  ['missing domain', document => { delete document.domain; }],
  ['missing receipts', document => { delete document.receipts; }],
  ['missing decisions', document => { delete document.decisions; }],
  ['invalid domain', document => { document.domain = null; }],
  ['receipt map array', document => { document.receipts = []; }],
  ['decision map array', document => { document.decisions = []; }],
  ['receipt key mismatch', document => { document.receipts = { other: document.receipts.command }; }],
  ['decision key mismatch', document => { document.decisions = { other: document.decisions.pending }; }],
  ['receipt beyond cursor', document => { document.receipts.command.sequence = 2; }],
  ['negative receipt sequence', document => { document.receipts.command.sequence = -1; }],
  ['extra receipt field', document => { document.receipts.command.extra = true; }],
  ['extra receipt state field', document => { document.receipts.command.state.extra = true; }],
  ['invalid receipt state', document => { document.receipts.command.state = { kind: 'uncertain', reason: '' }; }],
  ['extra decision field', document => { document.decisions.pending.extra = true; }],
  ['duplicate choices', document => { document.decisions.pending.choices = ['yes', 'yes']; }],
  ['foreign receipt scope', document => { document.receipts.command.scope.hostId = 'foreign'; }, 'mismatch'],
];

for (const [name, corrupt, classification = 'resync'] of malformed) {
  test(`document boundaries reject ${name} without publishing partial state`, { timeout: 5000 }, async t => {
    const document = valid();
    corrupt(document);
    const framed = parseServicePull(page(document));
    const response = parseServiceResponse({ op: 'pull' }, { ok: true, value: page(document) });
    assert.deepEqual(framed.item, item(document));
    assert.deepEqual(response.value.item, framed.item);
    assert.throws(() => parseFeedItem(framed.item, transcriptProjection, scope), classification === 'mismatch' ? FeedMismatchError : Error);
    const browser = createBrowserConnection({ fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      return Response.json({ ok: true, value: request.op === 'watch' ? { feedId: 'feed' } : request.op === 'close' ? null : framed });
    } });
    const browserFeed = browser.conversation(scope).watch({ after: null, projectionVersion: 2 }, async () => assert.fail('Malformed document delivered'));
    const end = await browserFeed.ended;
    assert.equal(end.kind, classification === 'mismatch' ? 'refused' : 'resync');
    assert.equal(end.cursor, null);

    const client = clientFixture({ selectedProjection: transcriptProjection });
    t.after(() => client.store.disconnect());
    await client.store.connect();
    const stream = client.port.watches.at(-1);
    await stream.receive(item({ domain: transcriptProjection.initial(), receipts: {}, decisions: {} }, 0));
    const before = client.store.getSnapshot().document;
    await assert.rejects(stream.receive(item(document)));
    assert.equal(client.store.getSnapshot().document, before);
    assert.equal(client.store.getSnapshot().cursor, 0);
    assert.equal(client.store.getSnapshot().connection.kind, classification);

    const f = fixture(t), host = f.open({ projection: transcriptProjection });
    host.createConversation(scope, installed);
    host.close();
    await host.drained;
    const db = new DatabaseSync(f.path);
    const encoded = JSON.stringify(document);
    db.prepare('UPDATE conversations SET document=?, head=1, bytes=? WHERE host=? AND conversation=?')
      .run(encoded, Buffer.byteLength(encoded), scope.hostId, scope.conversationId);
    db.close();
    const reopened = f.open({ projection: transcriptProjection });
    let deliveries = 0;
    const feed = reopened.conversation(scope).watch({ after: null, projectionVersion: transcriptProjection.version }, async () => { deliveries++; });
    assert.equal((await feed.ended).kind, 'failed');
    assert.equal(deliveries, 0);
    reopened.close();
    await reopened.drained;
    const persisted = new DatabaseSync(f.path);
    try { assert.equal(persisted.prepare('SELECT document FROM conversations').get().document, encoded); }
    finally { persisted.close(); }
  });
}

test('valid documents retain prototype-like identities at wire, delivery and reopened SQLite boundaries', { timeout: 5000 }, async t => {
  const document = { domain: transcriptProjection.initial(),
    receipts: { ['__proto__']: { ...receipt, clientCommandId: '__proto__' } },
    decisions: { ['__proto__']: { ...decision, pendingId: '__proto__' } } };
  assert.deepEqual(parseFeedItem(parseServicePull(page(document)).item, transcriptProjection, scope).snapshot.document, document);
  const client = clientFixture({ selectedProjection: transcriptProjection });
  t.after(() => client.store.disconnect());
  await client.store.connect();
  await client.port.watches.at(-1).receive(item(document));
  assert.deepEqual(client.store.getSnapshot().document, document);
  const f = fixture(t), host = f.open({ projection: transcriptProjection });
  host.createConversation(scope, installed);
  host.close();
  await host.drained;
  const db = new DatabaseSync(f.path), encoded = JSON.stringify(document);
  db.prepare('UPDATE conversations SET document=?, head=1, bytes=?').run(encoded, Buffer.byteLength(encoded));
  db.close();
  const reopened = f.open({ projection: transcriptProjection });
  const received = Promise.withResolvers();
  const feed = reopened.conversation(scope).watch({ after: null, projectionVersion: transcriptProjection.version }, async next => received.resolve(next));
  assert.deepEqual((await received.promise).snapshot.document, document);
  feed.close();
  await feed.ended;
});

test('browser document scope rejection remains sticky mismatch across a later failed reconnect', async t => {
  const document = valid();
  document.receipts.command.scope.hostId = 'foreign';
  let reconnecting = false, submissions = 0;
  const connection = createBrowserConnection({ fetch: async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.op === 'watch') return Response.json({ ok: true, value: { feedId: 'feed' } });
    if (request.op === 'close') return Response.json({ ok: true, value: null });
    if (request.op === 'submit') submissions++;
    if (reconnecting) throw new Error('Disconnected');
    return Response.json({ ok: true, value: page(document) });
  } });
  const { store } = clientFixture({ port: connection.conversation(scope), selectedProjection: transcriptProjection });
  t.after(() => store.disconnect());
  await store.connect();
  await until(() => store.getSnapshot().connection.kind === 'mismatch');
  assert.equal(store.getSnapshot().cursor, null);
  reconnecting = true;
  await store.connect();
  await until(() => store.getSnapshot().connection.kind === 'failed');
  await store.setDraft('Do not dispatch');
  await assert.rejects(store.send(), /scope mismatch/);
  assert.equal(submissions, 0);
});

test('document decoding preserves the projection receiver and outer delivery classifications', async t => {
  const projection = { ...transcriptProjection, calls: 0,
    decodeState(value) { this.calls++; return transcriptProjection.decodeState(value); } };
  const client = clientFixture({ selectedProjection: projection });
  t.after(() => client.store.disconnect());
  await client.store.connect();
  await client.port.watches.at(-1).receive(item(valid()));
  assert.ok(projection.calls > 0);
  for (const [change, classification] of [
    [snapshot => { snapshot.scope = { ...scope, hostId: 'foreign' }; }, 'mismatch'],
    [snapshot => { snapshot.projectionVersion++; }, 'mismatch'],
    [snapshot => { snapshot.cursor = 0; }, 'resync'],
  ]) {
    const next = clientFixture({ selectedProjection: transcriptProjection });
    t.after(() => next.store.disconnect());
    await next.store.connect();
    const stream = next.port.watches.at(-1);
    await stream.receive(item(valid()));
    const invalid = item(valid());
    change(invalid.snapshot);
    await assert.rejects(stream.receive(invalid));
    assert.equal(next.store.getSnapshot().connection.kind, classification);
  }
});
