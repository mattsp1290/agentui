import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, create, offered, send, actualInput, aguiExtension, unavailable } from './provider-send-fixture.mjs';

const tables = ['conversations', 'events', 'commands', 'frontend_sends', 'runs'];
const durable = f => f.inspect(db => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
async function orphan(t, options = {}) {
  let f, admission;
  const a = aguiExtension({ request: text => ({ ...actualInput(text), runId: `run-${text}` }), ...options,
    submit(operation, { effect }) {
      if (!admission) {
        admission = durable(f);
        assert.equal(admission.commands.length, 1);
        assert.equal(admission.commands[0].observation, null);
        assert.equal(JSON.parse(admission.commands[0].receipt).state.kind, 'pending');
        assert.equal(JSON.parse(admission.conversations[0].document).receipts.offered.state.kind, 'pending');
      }
      return effect(operation, 'completed', operation.request.runId);
    } });
  f = await fixture(t, [a]); const scope = await create(f);
  await f.client.conversation(scope).submit(offered(scope));
  f.inspect(db => {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of [...tables].reverse()) db.exec(`DELETE FROM ${table}`);
      for (const table of tables) for (const row of admission[table]) {
        const columns = Object.keys(row);
        db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row));
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  assert.deepEqual(durable(f), admission);
  await f.restart([a]);
  assert.deepEqual(durable(f), admission);
  return { a, f, scope, admission };
}

for (const refusal of ['absent', 'revoked', 'unknown']) test(`crash admission keeps pending NULL after ${refusal} lookup and two private retries`, async t => {
  const { a, f, scope } = await orphan(t, { reconcile: () => ({ kind: 'uncertain', reason: 'unknown', evidence: {} }) });
  if (refusal === 'absent') await f.restart([]);
  if (refusal === 'revoked') f.inspect(db => db.exec('UPDATE service_provider_credentials SET revoked=1'));
  const other = await f.anotherClient(), before = durable(f);
  const replies = [];
  for (let attempt = 0; attempt < 2; attempt++) replies.push(await other.conversation(scope).submit(send(scope, 'next', 'Next')));
  assert.deepEqual(replies, Array.from({ length: 2 }, () => ({ kind: 'rejected', reason: 'send-awaiting-confirmation' })));
  assert.deepEqual(durable(f), before);
  assert.equal(a.calls.submits.length, 1);
  assert.equal(a.calls.reconciles.length, refusal === 'unknown' ? 2 : 0);
});

test('tagged v1 cannot adopt an offered capture key', async t => {
  const a = aguiExtension(), f = await fixture(t, [a]), scope = await create(f), other = await f.anotherClient();
  await f.client.conversation(scope).submit(offered(scope));
  const before = durable(f);
  assert.deepEqual(await other.conversation(scope).submit(send(scope, 'next')), { kind: 'rejected', reason: 'frontend-run-reused' });
  assert.deepEqual(durable(f), before);
  assert.equal(a.calls.submits.length, 1);
});

test('offered capture cannot adopt an earlier tagged v1 key', async t => {
  const a = aguiExtension(), f = await fixture(t, [a]), scope = await create(f);
  await f.client.conversation(scope).submit(send(scope)); await f.restart([a]);
  const before = durable(f);
  assert.deepEqual(await f.client.conversation(scope).submit(offered(scope)), { kind: 'rejected', reason: 'frontend-run-reused' });
  assert.deepEqual(durable(f), before);
  assert.equal(a.calls.submits.length, 1);
});

for (const action of ['reconcile', 'recover']) for (const refusal of ['absent', 'revoked', 'unknown']) test(`crash admission ${action} retains pending NULL on ${refusal}`, async t => {
  const { a, f, scope } = await orphan(t, { reconcile: () => ({ kind: 'uncertain', reason: 'unknown', evidence: {} }) });
  if (refusal === 'absent') await f.restart([]);
  if (refusal === 'revoked') f.inspect(db => db.exec('UPDATE service_provider_credentials SET revoked=1'));
  const before = durable(f);
  if (action === 'reconcile') assert.equal((await f.client.reconcile(scope, 'offered')).state.kind, 'pending');
  else if (refusal === 'unknown') assert.deepEqual(await f.client.frontendBinding({ scope, id: 'offered', action }), { kind: 'pending', id: 'offered' });
  else await unavailable(f.client.frontendBinding({ scope, id: 'offered', action }));
  assert.deepEqual(durable(f), before);
  const other = await f.anotherClient();
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await other.conversation(scope).submit(send(scope, 'next', 'Next'))).reason, 'send-awaiting-confirmation');
  assert.deepEqual(durable(f), before);
  assert.equal(a.calls.submits.length, 1);
});

for (const outcome of ['completed', 'rejected', 'pending']) test(`crash admission authentic ${outcome} lookup preserves captured operation`, async t => {
  const { a, f, scope, admission } = await orphan(t, { reconcile: (operation, { effect }) => outcome === 'completed'
    ? effect(operation, outcome, operation.request.runId)
    : { kind: outcome, ...(outcome === 'rejected' ? { reason: 'declined' } : {}), evidence: {} } });
  const other = await f.anotherClient();
  const next = await other.conversation(scope).submit(send(scope, 'next', 'Next'));
  if (outcome === 'pending') assert.equal(next.reason, 'send-awaiting-confirmation');
  else assert.equal(next.receipt.state.kind, 'completed');
  const stored = durable(f).commands.find(row => row.id === 'offered');
  assert.equal(JSON.parse(stored.receipt).state.kind, outcome);
  assert.equal(stored.intent, admission.commands[0].intent);
  assert.equal(stored.target, admission.commands[0].target);
  assert.deepEqual(a.calls.reconciles, [a.calls.submits[0]]);
  assert.equal(a.calls.translations, outcome === 'pending' ? 1 : 2);
  assert.equal(a.calls.submits.length, outcome === 'pending' ? 1 : 2);
});

test('crash admission persists authentic completion before refusing revoked new sender', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { a, f, scope } = await orphan(t, { async reconcile(operation, { effect }) {
    entered.resolve(); await release.promise; return effect(operation, 'completed', operation.request.runId);
  } });
  const other = await f.anotherClient(), principal = (await other.metadata()).principalId;
  const next = other.conversation(scope).submit(send(scope, 'next', 'Next')).then(value => ({ value }), error => ({ error }));
  await Promise.race([entered.promise, next.then(() => { throw new Error('Lookup was not entered'); })]);
  f.inspect(db => db.prepare('UPDATE service_devices SET revoked=1 WHERE id=?').run(principal)); release.resolve();
  assert.ok((await next).error);
  const saved = durable(f);
  assert.equal(saved.commands.length, 1);
  assert.equal(JSON.parse(saved.commands[0].receipt).state.kind, 'completed');
  assert.equal(a.calls.submits.length, 1);
  assert.deepEqual(a.calls.reconciles, a.calls.submits);
});

test('inconclusive lookup returns latest persisted receipt after concurrent authentic completion', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let lookups = 0;
  const { a, f, scope } = await orphan(t, { async reconcile(operation, { effect }) {
    if (++lookups === 1) { entered.resolve(); await release.promise; return { kind: 'uncertain', reason: 'unknown', evidence: {} }; }
    return effect(operation, 'completed', operation.request.runId);
  } });
  const stale = f.client.reconcile(scope, 'offered'); await entered.promise;
  const current = await f.client.reconcile(scope, 'offered');
  assert.equal(current.state.kind, 'completed'); const before = durable(f); release.resolve();
  assert.deepEqual(await stale, current);
  assert.deepEqual(durable(f), before);
  assert.equal(a.calls.submits.length, 1);
});

for (const terminal of ['completed', 'rejected', 'not-dispatched']) for (const actor of ['same', 'other']) test(`tagged v1 cannot reuse ${terminal} offered key after release and restart by ${actor} actor`, async t => {
  const a = aguiExtension({ submit: (operation, { effect }) => terminal === 'completed' ? effect(operation, terminal, operation.request.runId)
    : { kind: terminal, reason: 'declined', ...(terminal === 'rejected' ? { evidence: {} } : {}) } });
  const f = await fixture(t, [a]), scope = await create(f), other = await f.anotherClient();
  const original = offered(scope), receipt = (await f.client.conversation(scope).submit(original)).receipt;
  await f.client.frontendBinding({ scope, id: 'offered', action: 'unavailable' }); await f.restart([a]);
  const before = durable(f);
  assert.deepEqual(await (actor === 'same' ? f.client : other).conversation(scope).submit(send(scope, 'next')), { kind: 'rejected', reason: 'frontend-run-reused' });
  assert.deepEqual(durable(f), before);
  assert.deepEqual((await f.client.conversation(scope).submit(original)).receipt, receipt);
  assert.equal(a.calls.submits.length, 1);
});

test('offered key refuses earlier tagged not-dispatched capture without run evidence', async t => {
  const a = aguiExtension({ submit: () => ({ kind: 'not-dispatched', reason: 'declined' }) });
  const f = await fixture(t, [a]), scope = await create(f);
  assert.equal((await f.client.conversation(scope).submit(send(scope))).receipt.state.kind, 'not-dispatched');
  assert.equal(durable(f).runs.length, 0); await f.restart([a]); const before = durable(f);
  assert.deepEqual(await f.client.conversation(scope).submit(offered(scope)), { kind: 'rejected', reason: 'frontend-run-reused' });
  assert.deepEqual(durable(f), before); assert.equal(a.calls.submits.length, 1);
});

test('two tagged v1 commands may reuse a key without an offered claim', async t => {
  const a = aguiExtension(), f = await fixture(t, [a]), scope = await create(f);
  for (const id of ['first', 'second']) assert.equal((await f.client.conversation(scope).submit(send(scope, id))).receipt.state.kind, 'completed');
  assert.equal(durable(f).frontend_sends.length, 0); assert.equal(a.calls.submits.length, 2);
});

test('untagged AG-UI-shaped captures permit offered claim and later generic reuse', async t => {
  const generic = aguiExtension({ agui: false }), tagged = aguiExtension();
  const f = await fixture(t, [generic]), scope = await create(f);
  assert.equal((await f.client.conversation(scope).submit(send(scope, 'before'))).receipt.state.kind, 'completed');
  const original = durable(f).commands[0].target;
  assert.equal(Object.hasOwn(JSON.parse(original).operation, 'protocol'), false);
  await f.restart([tagged]);
  assert.equal((await f.client.conversation(scope).submit(offered(scope))).receipt.state.kind, 'completed');
  await f.restart([generic]);
  assert.equal((await f.client.conversation(scope).submit(send(scope, 'after'))).receipt.state.kind, 'completed');
  assert.equal(durable(f).commands[0].target, original);
  assert.equal(generic.calls.submits.length, 2); assert.equal(tagged.calls.submits.length, 1);
});

for (const owner of ['released', 'revoked']) test(`crash admission ${owner} old owner permits private authentic completion`, async t => {
  const { a, f, scope } = await orphan(t);
  const other = await f.anotherClient(), principal = (await f.client.metadata()).principalId;
  if (owner === 'released') await f.client.frontendBinding({ scope, id: 'offered', action: 'unavailable' });
  else f.inspect(db => db.prepare('UPDATE service_devices SET revoked=1 WHERE id=?').run(principal));
  assert.equal((await other.conversation(scope).submit(send(scope, 'next', 'Next'))).receipt.state.kind, 'completed');
  for (const action of ['recover', 'unavailable']) await unavailable(other.frontendBinding({ scope, id: 'offered', action }));
  await unavailable(other.conversation(scope).receipt('offered')); await unavailable(other.reconcile(scope, 'offered'));
  if (owner === 'released') assert.equal((await f.client.frontendBinding({ scope, id: 'offered', action: 'recover' })).reason, 'closures-unavailable');
  assert.deepEqual(a.calls.reconciles, [a.calls.submits[0]]);
  assert.equal(a.calls.submits.length, 2);
});

test('crash admission discards late completion after provider authority revocation', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { a, f, scope } = await orphan(t, { async reconcile(operation, { effect }) {
    entered.resolve(); await release.promise; return effect(operation, 'completed', operation.request.runId);
  } });
  const other = await f.anotherClient(), before = durable(f);
  const next = other.conversation(scope).submit(send(scope, 'next', 'Next')); await entered.promise;
  f.inspect(db => db.exec('UPDATE service_provider_credentials SET revoked=1')); release.resolve();
  assert.equal((await next).reason, 'send-awaiting-confirmation');
  assert.deepEqual(durable(f), before);
  assert.equal((await other.conversation(scope).submit(send(scope, 'next', 'Next'))).reason, 'send-awaiting-confirmation');
  assert.deepEqual(durable(f), before); assert.equal(a.calls.submits.length, 1);
});

for (const boundary of ['thread', 'run', 'conversation']) test(`earlier tagged v1 key does not reserve a distinct ${boundary}`, async t => {
  const a = aguiExtension({ request: text => ({ ...actualInput(text), ...(text === 'thread' ? { threadId: 'different-thread' }
    : text === 'run' ? { runId: 'different-run' } : {}) }) });
  const f = await fixture(t, [a]), scope = await create(f);
  await f.client.conversation(scope).submit(send(scope));
  const destination = boundary === 'conversation' ? await create(f, 'another-chat') : scope;
  const command = offered(destination); command.body.text = boundary;
  assert.equal((await f.client.conversation(destination).submit(command)).receipt.state.kind, 'completed');
  assert.equal(a.calls.submits.length, 2);
});
