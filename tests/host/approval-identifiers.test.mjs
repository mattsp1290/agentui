import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, parseCommand } from '@agentui/contracts';
import { createConversationStore } from '@agentui/client';
import { storage } from '../client/support.mjs';
import { fixture, scope, installed, projection, command, empty, completed, run, question, snapshot, until } from './fixture.mjs';

function evidence(target, source = 'native-acknowledgement') {
  return { identity: target.identity, source,
    nativeOperation: { namespace: 'recorded', id: 'original-native-operation' },
    observation: { namespace: 'recorded', schemaVersion: 1, data: null } };
}

for (const [name, pendingId, choiceId, runId, action] of [
  ['long pending', 'p'.repeat(1025), 'yes', 'run-a', 'approve'],
  ['long choice', 'question-a', 'c'.repeat(1025), 'run-a', 'approve'],
  ['long cancel run', 'question-a', 'yes', 'r'.repeat(1025), 'cancel'],
  ['1024 control', 'p'.repeat(1024), 'c'.repeat(1024), 'r'.repeat(1024), 'approve'],
  ['Unicode and control', '問'.repeat(1025), '\0'.repeat(1025), '運'.repeat(1025), 'approve'],
]) {
  test(`public client acts on persisted ${name} identifiers after SQLite reopen`, async t => {
    const f = fixture(t), dispatched = [];
    const driver = { source: 'recorded', installation: installed, capability: () => ({ kind: 'supported' }),
      dispatch: async (cmd, target) => {
        dispatched.push(structuredClone({ command: cmd, target }));
        return { kind: 'conclusive', evidence: evidence(target), result: completed(empty()) };
      },
    };
    const original = f.open({ driver });
    original.createConversation(scope, installed);
    const nativeRun = run(scope, runId), decision = question(pendingId);
    decision.visible.runId = runId;
    decision.visible.choices = [choiceId];
    original.append(scope, { ...empty(), runs: [nativeRun], decisions: [decision] });
    const before = await snapshot(original.conversation(scope));
    original.close();
    const host = f.open({ driver }), drafts = storage();
    assert.deepEqual(await snapshot(host.conversation(scope)), before);
    const client = createConversationStore({ scope, projection, drafts,
      port: host.conversation(scope), createCommandId: () => 'public-action' });
    t.after(() => client.disconnect());
    await client.connect();
    await until(() => client.getSnapshot().connection.kind === 'connected');
    assert.deepEqual(client.getSnapshot().document.decisions[pendingId], decision.visible);
    const body = action === 'approve' ? { kind: action, pendingId, choiceId } : { kind: action, runId };
    const result = action === 'approve' ? await client.approve(pendingId, choiceId) : await client.cancel(runId);
    assert.equal(result.receipt.state.kind, 'completed');
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0].command, command('public-action', body));
    assert.deepEqual(dispatched[0].target.run, nativeRun);
    assert.deepEqual(dispatched[0].target.decision, action === 'approve' ? decision : null);
    assert.equal(dispatched[0].target.identity.hostOperationId, result.receipt.hostOperationId);
    assert.deepEqual(drafts.writes[0].outbox[0].command, dispatched[0].command);
    await until(() => client.getSnapshot().document.receipts['public-action']?.state.kind === 'completed');
    assert.deepEqual(client.getSnapshot().outbox, []);
    assert.equal(Boolean(client.getSnapshot().document.decisions[pendingId]), action === 'cancel');
    assert.deepEqual(await host.conversation(scope).submit(dispatched[0].command), result);
    assert.equal(dispatched.length, 1);
  });
}

test('accepted long approval retains its original reservation and target through reopened reconciliation', async t => {
  const f = fixture(t), pendingId = 'p'.repeat(1025), choiceId = 'c'.repeat(1025);
  const nativeRun = run(scope, 'r'.repeat(1025)), decision = question(pendingId);
  decision.visible.runId = nativeRun.identity.runId;
  decision.visible.choices = [choiceId];
  let captured, dispatches = 0, lookups = 0;
  const approval = command('original', { kind: 'approve', pendingId, choiceId });
  const driver = { source: 'recorded', installation: installed, capability: () => ({ kind: 'supported' }),
    dispatch: async (cmd, target) => {
      assert.deepEqual(cmd, approval);
      captured = structuredClone(target);
      dispatches++;
      return { kind: 'accepted', evidence: evidence(target) };
    },
    lookup: async (cmd, target) => {
      assert.deepEqual(cmd, approval);
      assert.deepEqual(target, captured);
      lookups++;
      return { kind: 'conclusive', evidence: evidence(target, 'authoritative-native-lookup'),
        result: completed({ ...empty(), runs: [nativeRun] }) };
    },
  };
  const original = f.open({ driver });
  original.createConversation(scope, installed);
  original.append(scope, { ...empty(), runs: [nativeRun], decisions: [decision] });
  const accepted = await original.conversation(scope).submit(approval);
  assert.equal(accepted.kind, 'receipt');
  assert.equal(accepted.receipt.state.kind, 'accepted');
  assert.deepEqual(captured.run, nativeRun);
  assert.deepEqual(captured.decision, decision);
  original.close();
  const reopened = f.open({ driver }), port = reopened.conversation(scope);
  assert.deepEqual(await port.submit(approval), accepted);
  assert.deepEqual(await port.submit({ ...approval, clientCommandId: 'competitor' }),
    { kind: 'rejected', reason: 'decision-unavailable' });
  const db = new DatabaseSync(f.path);
  t.after(() => db.close());
  const reserved = db.prepare('SELECT status, operation FROM pending_decisions WHERE id=?').get(pendingId);
  assert.equal(reserved.status, 'reserved');
  assert.equal(reserved.operation, accepted.receipt.hostOperationId);
  const done = await reopened.reconcile(scope, 'original');
  assert.equal(done.state.kind, 'completed');
  assert.equal(done.hostOperationId, accepted.receipt.hostOperationId);
  assert.deepEqual(await port.submit(approval), { kind: 'receipt', receipt: done });
  assert.deepEqual(await reopened.reconcile(scope, 'original'), done);
  assert.equal(dispatches, 1);
  assert.equal(lookups, 1);
  assert.deepEqual((await snapshot(port)).document.decisions, {});
  const stored = db.prepare('SELECT intent, target, observation FROM commands WHERE id=?').get('original');
  assert.deepEqual(JSON.parse(stored.intent), approval);
  assert.deepEqual(JSON.parse(stored.target), captured);
  assert.deepEqual(JSON.parse(stored.observation).evidence.nativeOperation, evidence(captured).nativeOperation);
  assert.deepEqual(JSON.parse(db.prepare('SELECT data FROM runs WHERE id=?').get(nativeRun.identity.runId).data), nativeRun);
});

test('provider targets remain nonempty strings and local identifiers retain the 1024-unit limit', () => {
  for (const invalid of ['', null, 1, {}, []]) {
    for (const body of [
      { kind: 'approve', pendingId: invalid, choiceId: 'yes' },
      { kind: 'approve', pendingId: 'question-a', choiceId: invalid },
      { kind: 'cancel', runId: invalid },
    ]) assert.throws(() => parseCommand(command('invalid', body)), /Expected nonempty string/);
  }
  const long = 'x'.repeat(1025);
  for (const invalid of [command(long), command('id', undefined, { ...scope, hostId: long }),
    command('id', undefined, { ...scope, conversationId: long })]) {
    assert.throws(() => parseCommand(invalid), /Identifier exceeds length limit/);
  }
  const boundary = 'x'.repeat(1024);
  const valid = command(boundary, undefined, { hostId: boundary, conversationId: boundary });
  assert.deepEqual(parseCommand(valid), valid);
});

test('long target command exceeding maxCommandBytes is rejected before persistence, reservation or dispatch', async t => {
  const f = fixture(t);
  let dispatches = 0;
  const driver = { source: 'recorded', installation: installed, capability: () => ({ kind: 'supported' }),
    dispatch: async () => { dispatches++; throw new Error('Unexpected dispatch'); } };
  const host = f.open({ driver, budgets: { maxCommandBytes: 200 } });
  host.createConversation(scope, installed);
  const decision = question();
  decision.visible.choices = ['c'.repeat(1025)];
  host.append(scope, { ...empty(), runs: [run()], decisions: [decision] });
  const before = await snapshot(host.conversation(scope));
  const approval = command('oversized', { kind: 'approve', pendingId: decision.visible.pendingId, choiceId: decision.visible.choices[0] });
  assert.deepEqual(parseCommand(approval), approval);
  assert.ok(Buffer.byteLength(canonicalJson(approval)) > 200);
  assert.deepEqual(await host.conversation(scope).submit(approval), { kind: 'rejected', reason: 'command-too-large' });
  assert.equal(await host.conversation(scope).receipt('oversized'), null);
  assert.deepEqual(await snapshot(host.conversation(scope)), before);
  const db = new DatabaseSync(f.path);
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM commands').get().count, 0);
    assert.equal(db.prepare('SELECT status FROM pending_decisions').get().status, 'open');
  } finally { db.close(); }
  assert.equal(dispatches, 0);
});
