import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fixture, scope, other, installed, command, empty, completed, snapshot, deferred, note, run, question } from './fixture.mjs';

function evidence(target, source = 'native-acknowledgement') {
  return { identity: target.identity, source,
    nativeOperation: { namespace: 'recorded', id: target.identity.hostOperationId },
    observation: { namespace: 'recorded', schemaVersion: 1, data: { source: 'recorded' } } };
}
test('Switchboard native entry sees committed intent on another SQLite connection', async t => {
  let f;
  f = fixture(t, { resolve: async (cmd, target) => {
    const db = new DatabaseSync(f.path);
    try {
      const row = db.prepare('SELECT intent, target, receipt FROM commands WHERE id=?').get(cmd.clientCommandId);
      assert.deepEqual(JSON.parse(row.intent), cmd);
      assert.deepEqual(JSON.parse(row.target), target);
      assert.equal(JSON.parse(row.receipt).state.kind, 'pending');
      assert.equal(db.prepare('SELECT count(*) AS count FROM events').get().count, 1);
      db.exec('BEGIN IMMEDIATE; ROLLBACK');
    } finally { db.close(); }
    return completed(empty());
  } });
  const host = f.open();
  host.createConversation(scope, installed);
  assert.equal((await host.conversation(scope).submit(command('intent'))).receipt.state.kind, 'completed');
});

test('accepted evidence survives unknown lookups, deduplicates repeated acceptance and completes exactly once', async t => {
  const f = fixture(t);
  let lookup = 'outcome-unknown', target;
  const driver = { source: 'recorded', capability: () => ({ kind: 'supported' }),
    dispatch: async (_cmd, captured) => { target = captured; return { kind: 'accepted', evidence: evidence(target) }; },
    lookup: async () => lookup === 'outcome-unknown' ? { kind: lookup }
      : lookup === 'accepted' ? { kind: lookup, evidence: evidence(target, 'authoritative-native-lookup') }
      : { kind: 'conclusive', evidence: evidence(target, 'authoritative-native-lookup'), result: completed(note('done')) },
  };
  const host = f.open({ driver });
  host.createConversation(scope, installed);
  const accepted = (await host.conversation(scope).submit(command('id'))).receipt;
  assert.equal(accepted.state.kind, 'accepted');
  assert.deepEqual(await host.reconcile(scope, 'id'), accepted);
  lookup = 'accepted';
  assert.deepEqual(await host.reconcile(scope, 'id'), accepted);
  assert.equal((await snapshot(host.conversation(scope))).cursor, 2);
  lookup = 'completed';
  const done = await host.reconcile(scope, 'id');
  assert.equal(done.state.kind, 'completed');
  assert.deepEqual(await host.reconcile(scope, 'id'), done);
  assert.deepEqual((await snapshot(host.conversation(scope))).document.domain, ['done']);
});

test('recovery can resolve while original call is blocked without duplicating its later result', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  let target;
  const driver = { source: 'recorded', capability: () => ({ kind: 'supported' }),
    dispatch: async (_cmd, captured) => { target = captured; entered.resolve(); await release.promise;
      return { kind: 'conclusive', evidence: evidence(target), result: completed(note('once')) }; },
    lookup: async () => ({ kind: 'conclusive', evidence: evidence(target, 'authoritative-native-lookup'), result: completed(note('once')) }),
  };
  const a = f.open({ driver }), b = f.open({ driver });
  a.createConversation(scope, installed);
  const pending = a.conversation(scope).submit(command('id'));
  await entered.promise;
  const recovered = await b.reconcile(scope, 'id');
  release.resolve();
  assert.deepEqual((await pending).receipt, recovered);
  assert.deepEqual((await snapshot(a.conversation(scope))).document.domain, ['once']);
});

test('absent or unsupported lookup cannot free an uncertain approval or dispatch again', async t => {
  const f = fixture(t);
  let entries = 0;
  const driver = { source: 'recorded', capability: () => ({ kind: 'supported' }),
    dispatch: async () => { entries++; return { kind: 'outcome-unknown' }; } };
  const a = f.open({ driver });
  a.createConversation(scope, installed);
  a.append(scope, { ...empty(), runs: [run()], decisions: [question()] });
  const approval = command('a', { kind: 'approve', pendingId: 'question-a', choiceId: 'yes' });
  assert.equal((await a.conversation(scope).submit(approval)).receipt.state.kind, 'uncertain');
  assert.equal((await a.reconcile(scope, 'a')).state.kind, 'uncertain');
  const b = f.open({ driver: { ...driver, lookup: async () => ({ kind: 'outcome-unknown' }) } });
  assert.equal((await b.reconcile(scope, 'a')).state.kind, 'uncertain');
  assert.equal((await b.conversation(scope).submit({ ...approval, clientCommandId: 'b' })).reason, 'decision-unavailable');
  await b.conversation(scope).submit(approval);
  assert.equal(entries, 1);
});

test('authorization precedes reads, unsupported cancel rejects, and settlement failure leaves uncertainty', async t => {
  const f = fixture(t, { resolve: async () => completed(note('projector-failure')) }), host = f.open();
  host.createConversation(scope, installed);
  assert.equal((await host.conversation(scope).submit(command('cancel', { kind: 'cancel', runId: 'r' }))).reason, 'recorded-cancel-unavailable');
  assert.equal((await host.conversation(scope).submit(command('wrong', undefined, other))).reason, 'scope-mismatch');
  await assert.rejects(host.conversation(scope).submit(command('failure')), /Projector/);
  assert.equal((await host.conversation(scope).receipt('failure')).state.kind, 'uncertain');
  assert.deepEqual((await snapshot(host.conversation(scope))).document.domain, []);
  const denied = f.open({ authorize: () => false });
  assert.throws(() => denied.conversation(scope), /Unauthorized/);
  assert.throws(() => denied.append(scope, empty()), /Unauthorized/);
  await assert.rejects(denied.reconcile(scope, 'failure'), /Unauthorized/);
});

test('conflicting late conclusive evidence preserves the prior committed result', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  let target;
  const driver = { source: 'recorded', capability: () => ({ kind: 'supported' }),
    dispatch: async (_cmd, captured) => { target = captured; entered.resolve(); await release.promise;
      return { kind: 'conclusive', evidence: evidence(target), result: completed(note('late-conflict')) }; },
    lookup: async () => ({ kind: 'conclusive', evidence: evidence(target, 'authoritative-native-lookup'), result: completed(note('authoritative-result')) }),
  };
  const a = f.open({ driver }), b = f.open({ driver });
  a.createConversation(scope, installed);
  const pending = a.conversation(scope).submit(command('id'));
  await entered.promise;
  const committed = await b.reconcile(scope, 'id');
  release.resolve();
  await assert.rejects(pending, /Conflicting terminal evidence/);
  assert.deepEqual(await a.conversation(scope).receipt('id'), committed);
  assert.deepEqual((await snapshot(a.conversation(scope))).document.domain, ['authoritative-result']);
});
