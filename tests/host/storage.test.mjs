import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fixture, installed, scope, other, command, snapshot, note, run, question, empty, deferred, completed } from './fixture.mjs';

function state(path) {
  const db = new DatabaseSync(path);
  try { return ['conversations', 'commands', 'events', 'runs', 'pending_decisions'].map(table => db.prepare(`SELECT * FROM ${table}`).all()); }
  finally { db.close(); }
}
test('real file reopen retains exact projection, scoped receipts and immutable private runs', async t => {
  const f = fixture(t), host = f.open();
  host.createConversation(scope, installed);
  host.createConversation(other, installed);
  host.append(scope, { ...note('first'), runs: [run()], decisions: [question()] });
  const result = await host.conversation(scope).submit(command('send-a'));
  const before = await snapshot(host.conversation(scope));
  assert.equal(result.receipt.state.kind, 'completed');
  assert.equal(before.document.receipts['send-a'].state.kind, 'completed');
  assert.equal(before.cursor, 5);
  assert.ok(!JSON.stringify(before).includes('private-'));
  host.close();
  const reopened = f.open();
  assert.deepEqual(await snapshot(reopened.conversation(scope)), before);
  assert.deepEqual((await snapshot(reopened.conversation(other))).document.domain, []);
  const foreign = await reopened.conversation(other).submit(command('cancel', { kind: 'cancel', runId: 'run-a' }, other));
  assert.equal(foreign.kind, 'rejected');
  assert.throws(() => reopened.append(other, { ...empty(), runs: [run()] }), /Foreign/);
  const changed = run();
  changed.reference.opaque = 'changed';
  changed.identity.authority.binding.opaqueSessionId = 'changed';
  assert.throws(() => reopened.append(scope, { ...empty(), runs: [changed] }), /immutable/);
});

test('exact id retries deduplicate across independent connections; changed intent conflicts', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { resolve: async () => { entered.resolve(); await release.promise; return completed(empty()); } });
  const a = f.open(), b = f.open();
  a.createConversation(scope, installed);
  const first = a.conversation(scope).submit(command('id'));
  await entered.promise;
  const retry = await b.conversation(scope).submit(command('id'));
  assert.equal(retry.receipt.state.kind, 'uncertain');
  assert.equal((await b.conversation(scope).submit(command('id', { kind: 'send', text: 'different' }))).reason, 'command-id-conflict');
  release.resolve();
  const done = await first;
  assert.deepEqual(await b.conversation(scope).submit(command('id')), done);
  assert.equal(readFileSync(f.backendPath, 'utf8').trim().split('\n').length, 1);
});

test('decision reservation excludes a different command id through uncertainty and preserves exact retry after closure', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { resolve: async () => { entered.resolve(); await release.promise; return completed(empty()); } });
  const a = f.open(), b = f.open();
  a.createConversation(scope, installed);
  a.append(scope, { ...empty(), runs: [run()], decisions: [question()] });
  const approve = command('approve-a', { kind: 'approve', pendingId: 'question-a', choiceId: 'yes' });
  const first = a.conversation(scope).submit(approve);
  await entered.promise;
  assert.equal((await b.conversation(scope).submit({ ...approve, clientCommandId: 'approve-b' })).reason, 'decision-unavailable');
  release.resolve();
  const result = await first;
  assert.deepEqual(await b.conversation(scope).submit(approve), result);
  assert.deepEqual((await snapshot(b.conversation(scope))).document.decisions, {});
});

test('projection failure rolls all output and reservation changes back', async t => {
  const f = fixture(t), host = f.open();
  host.createConversation(scope, installed);
  const before = state(f.path);
  assert.throws(() => host.append(scope, { ...note('projector-failure'), runs: [run()], decisions: [question()] }), /Projector/);
  assert.deepEqual(state(f.path), before);
  const tiny = f.open({ budgets: { maxEventBytes: 50 } });
  await assert.rejects(tiny.conversation(scope).submit(command('too-big')), /byte budget/);
  assert.deepEqual(state(f.path), before);
});

test('future versions and corrupt projection fail without replacing the database', t => {
  const f = fixture(t), host = f.open();
  host.createConversation(scope, installed);
  host.close();
  const db = new DatabaseSync(f.path);
  db.exec('PRAGMA user_version=99');
  const before = readFileSync(f.path);
  assert.throws(() => f.open(), /Unsupported database version/);
  assert.deepEqual(readFileSync(f.path), before);
  db.exec("PRAGMA user_version=1; UPDATE conversations SET document='not-json'");
  assert.throws(() => f.open(), /JSON/);
  assert.equal(db.prepare('SELECT document FROM conversations').get().document, 'not-json');
  db.close();
});

test('same client id stays scoped; supported cancel resolves only its own run command', async t => {
  const f = fixture(t, { cancel: { kind: 'supported' }, resolve: async () => completed(empty()) });
  const host = f.open();
  host.createConversation(scope, installed);
  host.createConversation(other, installed);
  host.append(scope, { ...empty(), runs: [run()], decisions: [question()] });
  const a = await host.conversation(scope).submit(command('same'));
  const b = await host.conversation(other).submit(command('same', undefined, other));
  assert.notEqual(a.receipt.hostOperationId, b.receipt.hostOperationId);
  assert.equal((await host.conversation(other).submit(command('foreign', { kind: 'cancel', runId: 'run-a' }, other))).reason, 'unknown-run');
  for (const id of ['cancel-one', 'cancel-two']) {
    assert.equal((await host.conversation(scope).submit(command(id, { kind: 'cancel', runId: 'run-a' }))).receipt.state.kind, 'completed');
  }
  assert.equal((await snapshot(host.conversation(scope))).document.decisions['question-a'].runId, 'run-a');
  const invalid = await host.conversation(scope).submit(command('bad-choice', { kind: 'approve', pendingId: 'question-a', choiceId: 'hidden-choice' }));
  assert.equal(invalid.reason, 'invalid-choice');
  assert.equal(await host.conversation(scope).receipt('bad-choice'), null);
});
