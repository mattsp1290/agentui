import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, command, scope, other, installed, run, question, empty, completed, deferred, until, snapshot } from './fixture.mjs';

test('a pending send excludes overlap; an unknown outcome stays recorded without replaying or freezing later commands', async t => {
  const f = fixture(t), gate = deferred();
  let calls = 0;
  const driver = { ...f.driver, async dispatch(value, target) {
    if (++calls === 1) { await gate.promise; throw new Error('controlled lost response'); }
    return f.driver.dispatch(value, target);
  } };
  const host = f.open({ driver });
  host.createConversation(scope, installed);
  const port = host.conversation(scope), original = command('unknown-send');
  const pending = port.submit(original);
  await until(() => calls === 1);
  assert.deepEqual(await port.submit(command('overlap')), { kind: 'rejected', reason: 'send-awaiting-confirmation' });
  gate.resolve();
  const result = await pending;
  assert.equal(result.receipt.state.kind, 'uncertain');
  assert.deepEqual(await port.submit(original), result);
  assert.equal(calls, 1);
  assert.equal((await port.submit(command('next-explicit-message'))).receipt.state.kind, 'completed');
  assert.equal(calls, 2);
  assert.equal((await port.receipt(original.clientCommandId)).state.kind, 'uncertain');
});

test('follow-up admission captures the newest persisted native session after reopening', async t => {
  const targets = [];
  const f = fixture(t, { resolve: async (_command, target) => { targets.push(target); return completed(empty()); } });
  const first = f.open();
  first.createConversation(scope, installed);
  const latest = { ...run(scope, 'new-run'), reference: { ...run().reference, opaque: 'new-session' },
    identity: { ...run(scope, 'new-run').identity, authority: { ...run().identity.authority,
      binding: { ...run().identity.authority.binding, opaqueSessionId: 'new-session' } } } };
  first.append(scope, { ...empty(), runs: [run(), latest] });
  first.close();
  const reopened = f.open();
  assert.equal((await reopened.conversation(scope).submit(command('follow-up'))).receipt.state.kind, 'completed');
  assert.equal(targets[0].run.reference.opaque, 'new-session');
  assert.equal(targets[0].identity.target.kind, 'session');
  assert.equal(targets[0].identity.target.reference.opaque, 'new-session');
});

test('wrong-workspace installation is rejected before intent admission or provider effects', async t => {
  let effects = 0;
  const f = fixture(t, { resolve: async () => { effects++; return completed(empty()); } });
  const driver = { ...f.driver, installation: { ...installed, binding: { ...installed.binding, authorizedScope: 'another-workspace' } } };
  const host = f.open({ driver });
  host.createConversation(scope, installed);
  const value = command('wrong-workspace');
  const result = await host.conversation(scope).submit(value);
  assert.equal(result.kind, 'rejected');
  assert.match(result.reason, /different agent or workspace/);
  assert.equal(await host.conversation(scope).receipt(value.clientCommandId), null);
  assert.equal(effects, 0);
});

test('local approval expiry closes only the scoped card and preserves the original unresolved receipt', async t => {
  const f = fixture(t, { resolve: async () => 'accepted' });
  const host = f.open();
  for (const value of [scope, other]) {
    host.createConversation(value, installed);
    host.append(value, { ...empty(), runs: [run(value)], decisions: [question()] });
  }
  const port = host.conversation(scope);
  const approval = command('waiting-approval', { kind: 'approve', pendingId: 'question-a', choiceId: 'yes' });
  const result = await port.submit(approval);
  assert.equal(result.receipt.state.kind, 'accepted');
  host.append(scope, { ...empty(), expiredDecisions: ['question-a'] });
  assert.deepEqual((await snapshot(port)).document.decisions, {});
  assert.ok((await snapshot(host.conversation(other))).document.decisions['question-a']);
  assert.deepEqual(await port.receipt(approval.clientCommandId), result.receipt);
  assert.deepEqual(await port.submit(approval), result);
  assert.deepEqual(await port.submit(command('stale-click', approval.body)), { kind: 'rejected', reason: 'decision-unavailable' });
  assert.equal((await host.reconcile(scope, approval.clientCommandId)).state.kind, 'accepted');
  assert.deepEqual((await snapshot(port)).document.decisions, {});
});
