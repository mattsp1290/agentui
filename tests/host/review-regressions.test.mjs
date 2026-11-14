import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { foldDocument } from '@agentui/contracts';
import { SqliteStore } from '../../packages/host/dist/sqlite-store.js';
import { budgets } from '../../packages/host/dist/durable-model.js';
import { fixture, scope, installed, command, empty, completed, snapshot, deferred, note, run, question, projection } from './fixture.mjs';

const evidence = (target, nativeOperation = null, source = 'native-acknowledgement') => ({
  identity: target.identity, source, nativeOperation,
  observation: { namespace: 'recorded', schemaVersion: 1, data: null },
});

test('repeated output quarantine retains newly learned native identity', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  const native = { namespace: 'recorded', id: 'confirmed-operation' };
  const result = completed({ ...empty(), events: [{ nonsense: 'invalid output' }] });
  let target;
  const driver = { source: 'recorded', capability: () => ({ kind: 'supported' }),
    dispatch: async (_command, captured) => {
      target = captured; entered.resolve(); await release.promise;
      return { kind: 'conclusive', evidence: evidence(target, native), result };
    },
    lookup: async () => ({ kind: 'conclusive', evidence: evidence(target, null, 'authoritative-native-lookup'), result }),
  };
  const host = f.open({ driver }); host.createConversation(scope, installed);
  const submitting = host.conversation(scope).submit(command('id')); await entered.promise;
  const quarantined = await host.reconcile(scope, 'id');
  assert.deepEqual(quarantined.state, { kind: 'uncertain', reason: 'output-rejected' });
  release.resolve();
  assert.deepEqual((await submitting).receipt, quarantined);
  const db = new DatabaseSync(f.path);
  try { assert.deepEqual(JSON.parse(db.prepare('SELECT observation FROM commands').get().observation).evidence.nativeOperation, native); }
  finally { db.close(); }
  const store = new SqliteStore(f.path, projection, budgets());
  try {
    assert.throws(() => store.settle(scope, 'id', { kind: 'conclusive',
      evidence: evidence(target, { ...native, id: 'competing-operation' }), result }), /Conflicting native operation/);
  } finally { store.close(); }
  assert.deepEqual(await host.conversation(scope).receipt('id'), quarantined);
});

test('a failed lookup returns a receipt settled by another connection during the wait', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  let target;
  const driver = { source: 'recorded', capability: () => ({ kind: 'supported' }),
    dispatch: async (_command, captured) => { target = captured; return { kind: 'accepted', evidence: evidence(target) }; },
    lookup: async () => { entered.resolve(); await release.promise; throw new Error('lookup disconnected'); },
  };
  const host = f.open({ driver }); host.createConversation(scope, installed);
  await host.conversation(scope).submit(command('id'));
  const recovering = host.reconcile(scope, 'id'); await entered.promise;
  const other = f.open({ driver: { ...driver, lookup: async () => ({ kind: 'conclusive',
    evidence: evidence(target, null, 'authoritative-native-lookup'), result: completed(note('finished')) }) } });
  const current = await other.reconcile(scope, 'id');
  assert.equal(current.state.kind, 'completed');
  release.resolve();
  assert.deepEqual(await recovering, current);
});

test('invalid Switchboard bindings fail before any conversation or intent is persisted', t => {
  const f = fixture(t), host = f.open();
  for (const value of [' ', 'a'.repeat(1025), 'bad\u0000engine']) {
    assert.throws(() => host.createConversation(scope, { ...installed, binding: { ...installed.binding, engine: value } }), /installation binding/);
  }
  const db = new DatabaseSync(f.path);
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM conversations').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM commands').get().n, 0);
  } finally { db.close(); }
});

for (const initialKnown of [false, true]) {
  test(`native id can be ${initialKnown ? 'omitted by lookup' : 'discovered by lookup'}`, async t => {
    const f = fixture(t); let target;
    const native = { namespace: 'recorded', id: 'native-id' };
    const driver = { source: 'recorded', capability: () => ({ kind: 'supported' }),
      dispatch: async (_command, captured) => { target = captured; return { kind: 'accepted', evidence: evidence(target, initialKnown ? native : null) }; },
      lookup: async () => ({ kind: 'conclusive', evidence: evidence(target, initialKnown ? null : native, 'authoritative-native-lookup'), result: completed(note('once')) }),
    };
    const host = f.open({ driver }); host.createConversation(scope, installed);
    await host.conversation(scope).submit(command('id'));
    assert.equal((await host.reconcile(scope, 'id')).state.kind, 'completed');
    assert.deepEqual((await snapshot(host.conversation(scope))).document.domain, ['once']);
    const db = new DatabaseSync(f.path);
    try { assert.deepEqual(JSON.parse(db.prepare('SELECT observation FROM commands').get().observation).evidence.nativeOperation, native); }
    finally { db.close(); }
  });
  test(`late original result merges native id with ${initialKnown ? 'known' : 'unknown'} lookup id`, async t => {
    const f = fixture(t), entered = deferred(), release = deferred(); let target;
    const native = { namespace: 'recorded', id: 'native-id' };
    const driver = { source: 'recorded', capability: () => ({ kind: 'supported' }),
      dispatch: async (_command, captured) => { target = captured; entered.resolve(); await release.promise;
        return { kind: 'conclusive', evidence: evidence(target, initialKnown ? null : native), result: completed(note('once')) }; },
      lookup: async () => ({ kind: 'conclusive', evidence: evidence(target, initialKnown ? native : null, 'authoritative-native-lookup'), result: completed(note('once')) }),
    };
    const host = f.open({ driver }); host.createConversation(scope, installed);
    const submitting = host.conversation(scope).submit(command('id')); await entered.promise;
    const recovered = await host.reconcile(scope, 'id'); release.resolve();
    assert.deepEqual((await submitting).receipt, recovered);
    assert.deepEqual((await snapshot(host.conversation(scope))).document.domain, ['once']);
  });
}

for (const lookup of [undefined, async () => { throw new Error('offline'); }]) {
  test(`live reconciliation stays pending until dispatch reports uncertainty with ${lookup ? 'failing' : 'absent'} lookup`, async t => {
    const f = fixture(t), entered = deferred(), release = deferred();
    const driver = { source: 'recorded', capability: () => ({ kind: 'supported' }), lookup,
      dispatch: async () => { entered.resolve(); await release.promise; return { kind: 'outcome-unknown' }; },
    };
    const host = f.open({ driver }); host.createConversation(scope, installed);
    const submitting = host.conversation(scope).submit(command('id')); await entered.promise;
    const pending = await host.conversation(scope).receipt('id');
    assert.deepEqual(pending, (await snapshot(host.conversation(scope))).document.receipts.id);
    assert.deepEqual(await host.reconcile(scope, 'id'), pending);
    assert.deepEqual(pending, (await snapshot(host.conversation(scope))).document.receipts.id);
    release.resolve();
    const uncertain = (await submitting).receipt;
    assert.equal(uncertain.state.kind, 'uncertain'); assert.ok(uncertain.sequence > pending.sequence);
    assert.deepEqual(uncertain, (await snapshot(host.conversation(scope))).document.receipts.id);
  });
}

test('invalid provider output is quarantined with evidence and can apply after projection repair', async t => {
  const f = fixture(t); let entries = 0, repaired = false;
  const original = { nonsense: 'unrecognized' };
  const driver = { source: 'recorded', capability: () => ({ kind: 'supported' }),
    dispatch: async (_command, target) => { entries++; return { kind: 'conclusive', evidence: evidence(target), result: completed({ ...empty(), events: [original] }) }; },
  };
  const host = f.open({ driver, projection: { ...projection, decodeEvent: value => repaired ? { kind: 'note-added', text: value.nonsense } : projection.decodeEvent(value) } });
  host.createConversation(scope, installed);
  const submitted = await host.conversation(scope).submit(command('id'));
  assert.deepEqual(submitted.receipt.state, { kind: 'uncertain', reason: 'output-rejected' });
  assert.deepEqual(await host.reconcile(scope, 'id'), submitted.receipt);
  assert.deepEqual(await host.conversation(scope).receipt('id'), submitted.receipt);
  const db = new DatabaseSync(f.path);
  try { assert.deepEqual(JSON.parse(db.prepare('SELECT observation FROM commands').get().observation).result.output.events, [original]); }
  finally { db.close(); }
  repaired = true;
  assert.equal((await host.reconcile(scope, 'id')).state.kind, 'completed');
  assert.deepEqual((await snapshot(host.conversation(scope))).document.domain, ['unrecognized']);
  assert.equal(entries, 1);
});

test('a repeated pending decision id quarantines output and never releases its approval reservation', async t => {
  const f = fixture(t, { resolve: async () => completed({ ...empty(), decisions: [question()] }) });
  const host = f.open(); host.createConversation(scope, installed);
  host.append(scope, { ...empty(), runs: [run()], decisions: [question()] });
  const approval = command('approve', { kind: 'approve', pendingId: 'question-a', choiceId: 'yes' });
  const result = await host.conversation(scope).submit(approval);
  assert.deepEqual(result.receipt.state, { kind: 'uncertain', reason: 'output-rejected' });
  assert.deepEqual(await host.reconcile(scope, 'approve'), result.receipt);
  assert.equal((await host.conversation(scope).submit({ ...approval, clientCommandId: 'again' })).reason, 'decision-unavailable');
  assert.deepEqual((await snapshot(host.conversation(scope))).document.domain, []);
});

test('snapshot writes reserve room for quarantining oversize output', async t => {
  const f = fixture(t, { resolve: async () => completed(note('x'.repeat(3000))) });
  const host = f.open({ budgets: { snapshotBytes: 850 } }); host.createConversation(scope, installed);
  const result = await host.conversation(scope).submit(command('id'));
  assert.deepEqual(result.receipt.state, { kind: 'uncertain', reason: 'output-rejected' });
  const snap = await snapshot(host.conversation(scope));
  assert.deepEqual(snap.document.domain, []); assert.ok(Buffer.byteLength(JSON.stringify(snap)) <= 850);
  assert.throws(() => host.append(scope, note('x'.repeat(3000))), /snapshot budget/);
  assert.deepEqual((await snapshot(host.conversation(scope))).document, snap.document);
});

test('admission capacity and command budgets reject before provider entry', async t => {
  const f = fixture(t); let entries = 0;
  const driver = { ...f.driver, dispatch: async () => { entries++; return { kind: 'outcome-unknown' }; } };
  const host = f.open({ driver, budgets: { snapshotBytes: 450, maxCommandBytes: 300 } }); host.createConversation(scope, installed);
  assert.equal((await host.conversation(scope).submit(command('big', { kind: 'send', text: 'x'.repeat(301) }))).reason, 'command-too-large');
  assert.deepEqual(await host.conversation(scope).submit(command('small')), { kind: 'rejected', reason: 'conversation-capacity' });
  assert.equal(entries, 0);
  assert.equal(await host.conversation(scope).receipt('small'), null);
  assert.deepEqual((await snapshot(host.conversation(scope))).document.receipts, {});
});

test('persistent write budgets must match across host connections', t => {
  const f = fixture(t); f.open({ budgets: { snapshotBytes: 900 } });
  assert.throws(() => f.open(), /persistent host budgets/);
  assert.doesNotThrow(() => f.open({ budgets: { snapshotBytes: 900 } }));
});

test('projection bounds terminal receipts and keeps every unresolved receipt', () => {
  let document = { domain: [], receipts: {}, decisions: {} };
  for (let sequence = 1; sequence <= 140; sequence++) document = foldDocument(document, { kind: 'receipt', receipt: {
    scope, clientCommandId: `id-${sequence}`, hostOperationId: `op-${sequence}`, sequence,
    state: sequence === 1 ? { kind: 'uncertain', reason: 'provider-outcome-unknown' } : { kind: 'completed' },
  } }, projection);
  assert.equal(Object.keys(document.receipts).length, 129);
  assert.equal(document.receipts['id-1'].state.kind, 'uncertain');
  assert.equal(document.receipts['id-2'], undefined);
  assert.equal(document.receipts['id-140'].state.kind, 'completed');
});

test('torn final backend line does not hide earlier durable evidence', async t => {
  const f = fixture(t), host = f.open(); host.createConversation(scope, installed);
  await host.conversation(scope).submit(command('id'));
  appendFileSync(f.backendPath, '{"kind":');
  const db = new DatabaseSync(f.path);
  let target;
  try { target = JSON.parse(db.prepare('SELECT target FROM commands').get().target); } finally { db.close(); }
  assert.equal((await f.driver.lookup(command('id'), target)).kind, 'conclusive');
});

test('synchronous subscriber bursts preserve the first admitted watcher', async t => {
  const f = fixture(t), host = f.open({ budgets: { subscribers: 1 } }); host.createConversation(scope, installed);
  let firstSeen = false;
  const first = host.conversation(scope).watch({ after: null, projectionVersion: 1 }, async () => { firstSeen = true; });
  const second = host.conversation(scope).watch({ after: null, projectionVersion: 1 }, async () => assert.fail('excess subscriber delivered'));
  assert.equal((await second.ended).kind, 'refused');
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(firstSeen, true);
  first.close(); await first.ended;
});

test('a faulty non-JSON driver result remains single-attempt and can journal uncertainty', async t => {
  const f = fixture(t); let entries = 0;
  const cycle = {}; cycle.self = cycle;
  const driver = { source: 'recorded', capability: () => ({ kind: 'supported' }),
    dispatch: async (_command, target) => { entries++; return { kind: 'conclusive', evidence: evidence(target), result: completed({ ...empty(), events: [cycle] }) }; },
  };
  const host = f.open({ driver }); host.createConversation(scope, installed);
  await assert.rejects(host.conversation(scope).submit(command('id')), /Cyclic JSON/);
  const pending = await host.conversation(scope).receipt('id');
  assert.equal(pending.state.kind, 'pending');
  assert.deepEqual((await host.conversation(scope).submit(command('id'))).receipt, pending);
  const uncertain = await host.reconcile(scope, 'id');
  assert.equal(uncertain.state.kind, 'uncertain');
  assert.deepEqual((await snapshot(host.conversation(scope))).document.receipts.id, uncertain);
  assert.equal(entries, 1);
});

test('snapshot capacity admits the exact reserved envelope size and rejects one byte below it', async t => {
  const admitted = { scope, clientCommandId: 'boundary', hostOperationId: '00000000-0000-0000-0000-000000000000', sequence: 1, state: { kind: 'pending' } };
  const boundary = Buffer.byteLength(JSON.stringify({ scope, projectionVersion: 1, cursor: Number.MAX_SAFE_INTEGER,
    document: { domain: [], receipts: { boundary: admitted }, decisions: {} } })) + 128;
  for (const snapshotBytes of [boundary - 1, boundary]) {
    const f = fixture(t); let entries = 0;
    const driver = { source: 'recorded', capability: () => ({ kind: 'supported' }),
      dispatch: async (_command, target) => { entries++; return { kind: 'conclusive', evidence: evidence(target), result: completed(note('x'.repeat(5000))) }; },
    };
    const host = f.open({ driver, budgets: { snapshotBytes } }); host.createConversation(scope, installed);
    if (snapshotBytes < boundary) {
      assert.deepEqual(await host.conversation(scope).submit(command('boundary')), { kind: 'rejected', reason: 'conversation-capacity' });
      assert.equal(entries, 0);
    } else {
      const result = await host.conversation(scope).submit(command('boundary'));
      assert.deepEqual(result.receipt.state, { kind: 'uncertain', reason: 'output-rejected' });
      assert.equal(entries, 1);
      assert.deepEqual((await snapshot(host.conversation(scope))).document.receipts.boundary, result.receipt);
    }
  }
});

test('terminal projection retention preserves historical receipt lookup after reopening', async t => {
  const f = fixture(t);
  const driver = { source: 'recorded', capability: () => ({ kind: 'supported' }),
    dispatch: async (_command, target) => ({ kind: 'conclusive', evidence: evidence(target), result: completed(empty()) }),
  };
  const host = f.open({ driver }); host.createConversation(scope, installed);
  const first = (await host.conversation(scope).submit(command('id-0'))).receipt;
  for (let index = 1; index < 130; index++) await host.conversation(scope).submit(command(`id-${index}`));
  const document = (await snapshot(host.conversation(scope))).document;
  assert.equal(Object.keys(document.receipts).length, 128);
  assert.equal(document.receipts['id-0'], undefined);
  host.close();
  assert.deepEqual(await f.open({ driver }).conversation(scope).receipt('id-0'), first);
});

test('timer budgets reject values that Node would clamp to one millisecond', t => {
  const f = fixture(t);
  assert.throws(() => f.open({ budgets: { deliveryMs: 2_147_483_648 } }), /Timer budget/);
  assert.throws(() => f.open({ budgets: { pollMs: 2_147_483_648 } }), /Timer budget/);
  assert.throws(() => f.open({ budgets: { misspelled: 1 } }), /Unknown host budget/);
});

for (const action of ['submit', 'reconcile']) {
  test(`closing the host allows in-flight ${action} evidence to settle before closing storage`, async t => {
    const f = fixture(t), entered = deferred(), release = deferred();
    const driver = { source: 'recorded', capability: () => ({ kind: 'supported' }),
      dispatch: async (_command, target) => {
        if (action !== 'submit') return { kind: 'outcome-unknown' };
        entered.resolve(); await release.promise;
        return { kind: 'conclusive', evidence: evidence(target), result: completed(note('done')) };
      },
      lookup: async (_command, target) => { entered.resolve(); await release.promise;
        return { kind: 'conclusive', evidence: evidence(target, null, 'authoritative-native-lookup'), result: completed(note('done')) }; },
    };
    const host = f.open({ driver }); host.createConversation(scope, installed);
    if (action === 'reconcile') await host.conversation(scope).submit(command('id'));
    const pending = action === 'submit' ? host.conversation(scope).submit(command('id')) : host.reconcile(scope, 'id');
    await entered.promise; host.close();
    assert.throws(() => host.conversation(scope), /closed/);
    release.resolve(); const result = await pending;
    assert.equal((action === 'submit' ? result.receipt : result).state.kind, 'completed');
    assert.deepEqual((await snapshot(f.open({ driver }).conversation(scope))).document.domain, ['done']);
  });
}

test('a cursor ahead of a restored journal requests a snapshot through resync', async t => {
  const f = fixture(t), host = f.open(); host.createConversation(scope, installed);
  const feed = host.conversation(scope).watch({ after: 10, projectionVersion: 1 }, async () => assert.fail('ahead cursor delivered'));
  assert.deepEqual(await feed.ended, { kind: 'resync', reason: 'cursor-ahead-request-snapshot', cursor: 10 });
  assert.equal((await snapshot(host.conversation(scope))).cursor, 0);
});
