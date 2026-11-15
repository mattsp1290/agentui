import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '@agentui/contracts';
import { fixture, scope, installed, command, completed, empty, note, run, question, snapshot } from './fixture.mjs';

function persisted(path) {
  const db = new DatabaseSync(path);
  try {
    return Object.fromEntries(['conversations', 'commands', 'runs', 'pending_decisions', 'events']
      .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))]));
  } finally { db.close(); }
}

test('native send, approval and cancel retain original serialized shapes and exact retries across reopening', async t => {
  const f = fixture(t, { cancel: { kind: 'supported' }, resolve: async cmd => completed(cmd.body.kind === 'send'
    ? { ...note('sent'), runs: [run()], decisions: [question()] } : note(cmd.body.kind)) });
  const dispatched = [];
  const driver = { ...f.driver, async dispatch(cmd, target) {
    const result = await f.driver.dispatch(cmd, target);
    dispatched.push({ command: cmd, target, result });
    return result;
  } };
  const host = f.open({ driver });
  host.createConversation(scope, installed);
  const commands = [command('send'), command('approve', { kind: 'approve', pendingId: 'question-a', choiceId: 'yes' }),
    command('cancel', { kind: 'cancel', runId: 'run-a' })];
  const replies = [];
  for (const cmd of commands) replies.push(await host.conversation(scope).submit(cmd));
  const before = persisted(f.path), visible = await snapshot(host.conversation(scope));
  assert.equal(before.conversations[0].installation, canonicalJson(installed));
  assert.equal(before.runs[0].data, canonicalJson(run()));
  assert.equal(before.pending_decisions[0].data, canonicalJson(question()));
  for (const [index, row] of before.commands.entries()) {
    const hostOperationId = replies[index].receipt.hostOperationId;
    const expectedTarget = { installation: installed, run: index === 0 ? null : run(),
      decision: index === 1 ? question() : null,
      identity: { hostOperationId, target: index === 0 ? { kind: 'new-session', binding: installed.binding }
        : { kind: 'session', reference: run().reference } } };
    assert.equal(row.intent, canonicalJson(commands[index]));
    assert.equal(row.operation, hostOperationId);
    assert.equal(row.target, canonicalJson(expectedTarget));
    assert.equal(row.observation, canonicalJson(dispatched[index].result));
    assert.equal(row.receipt, canonicalJson(replies[index].receipt));
    assert.deepEqual(dispatched[index].target, expectedTarget);
    assert.equal(replies[index].receipt.state.kind, 'completed');
  }
  host.close(); await host.drained;
  // No installed driver is needed to read historical data or return an exact retry.
  const reopened = f.open({ driver: [] });
  for (const [index, cmd] of commands.entries()) {
    assert.deepEqual(await reopened.conversation(scope).submit(JSON.parse(canonicalJson(cmd))), replies[index]);
    assert.deepEqual(await reopened.reconcile(scope, cmd.clientCommandId), replies[index].receipt);
  }
  assert.deepEqual(await snapshot(reopened.conversation(scope)), visible);
  assert.deepEqual(persisted(f.path), before);
  assert.equal(dispatched.length, 3);
});

test('recovery uses the captured native identity and source evidence after reopen without dispatching again', async t => {
  const f = fixture(t, { resolve: async () => 'accepted' });
  let dispatches = 0, lookups = 0, previous;
  const driver = { ...f.driver, async dispatch(cmd, target) {
    dispatches++;
    const observed = await f.driver.dispatch(cmd, target);
    previous = { cmd, target, observed };
    return observed;
  } };
  const host = f.open({ driver }); host.createConversation(scope, installed);
  const submitted = await host.conversation(scope).submit(command('accepted'));
  const initial = persisted(f.path);
  assert.equal(initial.commands[0].observation, canonicalJson(previous.observed));
  host.close(); await host.drained;
  const reopened = f.open({ driver: { ...driver, async lookup(cmd, target) {
    lookups++;
    assert.deepEqual(cmd, previous.cmd);
    assert.deepEqual(target, previous.target);
    const native = await f.driver.lookup(cmd, target);
    assert.equal(native.evidence.source, 'authoritative-native-lookup');
    return native;
  } } });
  assert.deepEqual(await reopened.conversation(scope).submit(command('accepted')), submitted);
  assert.deepEqual(persisted(f.path), initial);
  assert.deepEqual(await reopened.reconcile(scope, 'accepted'), submitted.receipt);
  const after = persisted(f.path);
  assert.equal(after.commands[0].observation, canonicalJson({ ...previous.observed,
    evidence: { ...previous.observed.evidence, source: 'authoritative-native-lookup' } }));
  assert.deepEqual({ ...after, commands: after.commands.map(row => ({ ...row, observation: initial.commands[0].observation })) }, initial);
  assert.equal(dispatches, 1); assert.equal(lookups, 1);
});

test('a foreign native recovery identity cannot overwrite accepted evidence or its raw records', async t => {
  const f = fixture(t, { resolve: async () => 'accepted' });
  const host = f.open(); host.createConversation(scope, installed);
  const original = await host.conversation(scope).submit(command('accepted'));
  host.close(); await host.drained;
  const before = persisted(f.path);
  const reopened = f.open({ driver: { ...f.driver, async dispatch() { assert.fail('recovery dispatched'); },
    async lookup(_cmd, target) {
      return { kind: 'conclusive', result: completed(empty()), evidence: {
        identity: { ...target.identity, hostOperationId: 'foreign-operation' }, source: 'authoritative-native-lookup',
        nativeOperation: null, observation: { namespace: 'recorded', schemaVersion: 1, data: null },
      } };
    } } });
  assert.deepEqual(await reopened.reconcile(scope, 'accepted'), original.receipt);
  assert.deepEqual(persisted(f.path), before);
});
