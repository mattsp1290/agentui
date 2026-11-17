import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, create, offered, aguiExtension, actualInput, send } from './provider-send-fixture.mjs';

function durable(f) {
  return f.inspect(db => Object.fromEntries(['commands', 'frontend_send_owners', 'frontend_send_tombstones', 'events', 'conversations'].map(table =>
    [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}
for (const changed of [false, true]) test(`offered run reservation rejects ${changed ? 'changed' : 'identical'} bindings and rolls back admission`, async t => {
  const a = aguiExtension(), f = await fixture(t, [a]), scope = await create(f);
  const first = offered(scope, 'first');
  const receipt = (await f.client.conversation(scope).submit(first)).receipt;
  assert.equal((await f.client.frontendBinding({ scope, id: 'first', action: 'recover' })).kind, 'bound');
  await f.client.frontendBinding({ scope, id: 'first', action: 'unavailable' });
  assert.equal(f.inspect(db => JSON.parse(db.prepare('SELECT data FROM frontend_runs').get().data).status), 'blocked');
  await f.restart([a]);
  const second = offered(scope, 'second');
  if (changed) second.body.frontend.tools[0].activationId = 'replacement';
  const before = durable(f);
  assert.deepEqual(await f.client.conversation(scope).submit(second), { kind: 'rejected', reason: 'frontend-run-reused' });
  assert.deepEqual(durable(f), before);
  assert.equal(a.calls.submits.length, 1);
  assert.deepEqual((await f.client.conversation(scope).submit(first)).receipt, receipt);
  const changedBody = structuredClone(first); changedBody.body.text = 'Changed';
  assert.deepEqual(await f.client.conversation(scope).submit(changedBody), { kind: 'rejected', reason: 'command-id-conflict' });
  assert.equal(a.calls.translations, 2);
  assert.equal(a.calls.submits.length, 1);
});

test('generic captured run remains generic after add becomes addAgui', async t => {
  const generic = aguiExtension({ agui: false, submit: (operation, { effect }) => effect(operation, 'accepted', 'provider-run') });
  const f = await fixture(t, [generic]), scope = await create(f), command = send(scope);
  assert.equal((await f.client.conversation(scope).submit(command)).receipt.state.kind, 'accepted');
  const original = f.inspect(db => db.prepare('SELECT target FROM commands').get().target);
  const current = aguiExtension({ reconcile: (operation, { effect }) => effect(operation, 'completed', 'provider-run') });
  await f.restart([current]);
  assert.equal((await f.client.reconcile(scope, command.clientCommandId)).state.kind, 'completed');
  assert.equal(f.inspect(db => db.prepare('SELECT target FROM commands').get().target), original);
  assert.equal(current.calls.translations, 0);
});

test('offered reservation permits distinct threads, runs and conversations', async t => {
  const a = aguiExtension({ request: text => ({ ...actualInput(text), ...(text === 'thread' ? { threadId: 'other-thread' } : text === 'run' ? { runId: 'other-run' } : {}) }) });
  const f = await fixture(t, [a]), scope = await create(f);
  for (const text of ['first', 'thread', 'run']) {
    const command = offered(scope, text); command.body.text = text;
    assert.equal((await f.client.conversation(scope).submit(command)).receipt.state.kind, 'completed');
  }
  const other = await create(f, 'other');
  assert.equal((await f.client.conversation(other).submit(offered(other))).receipt.state.kind, 'completed');
  assert.equal(a.calls.submits.length, 4);
});

for (const release of [false, true]) test(`a second owner view cannot reuse an offered key after ${release ? 'release' : 'admission'} before late binding`, async t => {
  const a = aguiExtension(), f = await fixture(t, [a]), scope = await create(f), view = f.secondView();
  await f.client.conversation(scope).submit(offered(scope, 'first'));
  if (release) await f.client.frontendBinding({ scope, id: 'first', action: 'unavailable' });
  const before = durable(f);
  assert.deepEqual(await view.conversation(scope).submit(offered(scope, 'second')), { kind: 'rejected', reason: 'frontend-run-reused' });
  assert.deepEqual(durable(f), before);
  const recovered = await f.client.frontendBinding({ scope, id: 'first', action: 'recover' });
  assert.equal(recovered.kind, release ? 'unavailable' : 'bound');
  assert.equal(a.calls.submits.length, 1);
});

test('terminal rejection retaining run evidence keeps the offered reservation', async t => {
  const a = aguiExtension({ submit: (operation, { effect }) => effect(operation, 'accepted', operation.request.runId),
    reconcile: () => ({ kind: 'rejected', reason: 'declined', evidence: {} }) });
  const f = await fixture(t, [a]), scope = await create(f);
  await f.client.conversation(scope).submit(offered(scope, 'first'));
  assert.equal((await f.client.reconcile(scope, 'first')).state.kind, 'rejected');
  const observation = f.inspect(db => JSON.parse(db.prepare('SELECT observation FROM commands').get().observation));
  assert.equal(observation.evidence.source.run.identity.runId, 'actual-run');
  const before = durable(f);
  assert.deepEqual(await f.client.conversation(scope).submit(offered(scope, 'second')), { kind: 'rejected', reason: 'frontend-run-reused' });
  assert.deepEqual(durable(f), before);
  assert.equal(a.calls.submits.length, 1);
});

test('generic completed sends can reuse a run without an offered reservation', async t => {
  const a = aguiExtension({ agui: false }), f = await fixture(t, [a]), scope = await create(f);
  for (const id of ['first', 'second']) assert.equal((await f.client.conversation(scope).submit(send(scope, id))).receipt.state.kind, 'completed');
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) n FROM frontend_send_owners').get().n), 0);
  assert.equal(a.calls.submits.length, 2);
});

test('schema rejects keyless owners and reads refuse owner key corruption', async t => {
  const a = aguiExtension(), f = await fixture(t, [a]), scope = await create(f);
  await f.client.conversation(scope).submit(offered(scope, 'first'));
  f.inspect(db => {
    for (const assignment of ['thread_id=NULL', 'run_id=NULL', 'thread_id=NULL,run_id=NULL']) {
      assert.throws(() => db.exec(`UPDATE frontend_send_owners SET ${assignment}`), /NOT NULL constraint/);
    }
    db.exec("UPDATE frontend_send_owners SET thread_id='foreign-thread'");
  });
  await assert.rejects(f.client.conversation(scope).receipt('first'), error => error.kind === 'unavailable');
  await assert.rejects(f.client.frontendBinding({ scope, id: 'first', action: 'recover' }), error => error.kind === 'unavailable');
  assert.equal(a.calls.submits.length, 1);
});
