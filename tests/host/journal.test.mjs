import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fixture, scope, other, installed, note, snapshot, projection, deferred, until } from './fixture.mjs';

async function first(port, request) {
  const got = deferred();
  const feed = port.watch(request, async item => got.resolve(item));
  const item = await got.promise;
  feed.close();
  await feed.ended;
  return item;
}
test('snapshot includes writes before initial read with its exact cursor', async t => {
  const f = fixture(t), host = f.open();
  host.createConversation(scope, installed);
  const got = deferred();
  const feed = host.conversation(scope).watch({ after: null, projectionVersion: 1 }, async item => got.resolve(item));
  host.append(scope, note('before-read'));
  const item = await got.promise;
  assert.equal(item.snapshot.cursor, 1);
  assert.deepEqual(item.snapshot.document.domain, ['before-read']);
  feed.close();
});

test('ordered bounded pages drain writes during replay and independent connection commits while idle', async t => {
  const f = fixture(t), a = f.open({ budgets: { pageEvents: 1, pollMs: 5 } }), b = f.open();
  a.createConversation(scope, installed);
  a.append(scope, note('one'));
  a.append(scope, note('two'));
  const sequences = [], texts = [];
  const feed = a.conversation(scope).watch({ after: 0, projectionVersion: 1 }, async item => {
    assert.equal(item.kind, 'events');
    assert.equal(item.events.length, 1);
    sequences.push(item.events[0].sequence);
    texts.push(item.events[0].event.event.text);
    if (texts.length === 1) b.append(scope, note('during-replay'));
  });
  await until(() => texts.length === 3);
  b.append(scope, note('independent-connection-without-local-wakeup'));
  await until(() => texts.length === 4);
  assert.deepEqual(sequences, [1, 2, 3, 4]);
  assert.deepEqual(texts, ['one', 'two', 'during-replay', 'independent-connection-without-local-wakeup']);
  feed.close();
  assert.equal((await feed.ended).cursor, 4);
});

test('replay count and byte budgets independently select exact snapshots', async t => {
  const f = fixture(t), writer = f.open();
  writer.createConversation(scope, installed);
  writer.append(scope, note('a'.repeat(300)));
  writer.append(scope, note('b'.repeat(300)));
  const count = f.open({ budgets: { replayEvents: 1 } });
  const bytes = f.open({ budgets: { replayEvents: 100, replayBytes: 100 } });
  for (const host of [count, bytes]) {
    const item = await first(host.conversation(scope), { after: 0, projectionVersion: 1 });
    assert.equal(item.kind, 'snapshot');
    assert.equal(item.snapshot.cursor, 2);
    assert.deepEqual(item.snapshot.document.domain, ['a'.repeat(300), 'b'.repeat(300)]);
  }
});

test('page payload reads obey encoded byte budget before loading next row', async t => {
  const f = fixture(t), host = f.open({ budgets: { maxEventBytes: 500, pageBytes: 500, pageEvents: 10 } });
  host.createConversation(scope, installed);
  host.append(scope, note('a'.repeat(180)));
  host.append(scope, note('b'.repeat(180)));
  const got = deferred(), release = deferred();
  let payloadReads = 0;
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    if (sql.startsWith('SELECT payload')) payloadReads++;
    return prepare.call(this, sql);
  };
  t.after(() => { DatabaseSync.prototype.prepare = prepare; });
  const feed = host.conversation(scope).watch({ after: 0, projectionVersion: 1 }, async item => {
    assert.equal(item.events.length, 1);
    got.resolve();
    await release.promise;
  });
  await got.promise;
  assert.equal(payloadReads, 1);
  host.append(scope, note('later'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(payloadReads, 1);
  feed.close();
  release.resolve();
  assert.equal((await feed.ended).cursor, 0);
});

test('oversized event rolls back; oversized snapshot is refused before domain decoding', async t => {
  const f = fixture(t), host = f.open({ budgets: { maxEventBytes: 250, pageBytes: 250 } });
  host.createConversation(scope, installed);
  assert.throws(() => host.append(scope, note('x'.repeat(500))), /byte budget/);
  assert.equal((await snapshot(host.conversation(scope))).cursor, 0);
  host.append(scope, note('x'.repeat(80)));
  let decodes = 0;
  const db = new DatabaseSync(f.path);
  const documentBytes = db.prepare('SELECT bytes FROM conversations').get().bytes;
  db.close();
  const tiny = f.open({ projection: { ...projection, decodeState: value => { decodes++; return projection.decodeState(value); } }, budgets: { snapshotBytes: documentBytes + 1 } });
  const feed = tiny.conversation(scope).watch({ after: null, projectionVersion: 1 }, async () => assert.fail('No oversized snapshot delivery'));
  assert.equal((await feed.ended).reason, 'snapshot-overflow');
  assert.equal(decodes, 0);
});

test('invalid cursor, incompatible projection and unknown scope refuse without callbacks', async t => {
  const f = fixture(t), host = f.open();
  host.createConversation(scope, installed);
  for (const after of [-1, 1, 0.5, NaN]) {
    const feed = host.conversation(scope).watch({ after, projectionVersion: 1 }, async () => assert.fail('Invalid cursor delivered'));
    assert.equal((await feed.ended).kind, 'refused');
  }
  for (const [target, projectionVersion] of [[scope, 2], [other, 1]]) {
    const feed = host.conversation(target).watch({ after: null, projectionVersion }, async () => assert.fail('Invalid scope/version delivered'));
    assert.equal((await feed.ended).kind, 'refused');
  }
});

test('stalled delivery times out at last acknowledgement and ignores late completion', async t => {
  const f = fixture(t), host = f.open({ budgets: { deliveryMs: 20, pageEvents: 1 } });
  host.createConversation(scope, installed);
  host.append(scope, note('one'));
  host.append(scope, note('two'));
  const release = deferred();
  let calls = 0;
  const feed = host.conversation(scope).watch({ after: 0, projectionVersion: 1 }, async () => { calls++; await release.promise; });
  const ended = await feed.ended;
  assert.deepEqual(ended, { kind: 'resync', reason: 'delivery-timeout', cursor: 0 });
  release.resolve();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  assert.equal((await feed.ended).cursor, 0);
});

test('close settles without a blocked consumer; closed and excess feeds never deliver', async t => {
  const f = fixture(t), host = f.open({ budgets: { subscribers: 1 } });
  host.createConversation(scope, installed);
  let callbacks = 0;
  const active = host.conversation(scope).watch({ after: null, projectionVersion: 1 }, async () => { callbacks++; await new Promise(() => {}); });
  await until(() => callbacks === 1);
  const excess = host.conversation(scope).watch({ after: null, projectionVersion: 1 }, async () => assert.fail('Excess subscriber'));
  assert.equal((await excess.ended).kind, 'refused');
  active.close();
  active.close();
  assert.equal((await active.ended).cursor, null);
  const immediate = host.conversation(scope).watch({ after: null, projectionVersion: 1 }, async () => assert.fail('Closed subscriber'));
  immediate.close();
  assert.equal((await immediate.ended).kind, 'closed');
  host.close();
});
