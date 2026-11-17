import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { frontendToolsFor } from '@agentui/host/frontend-tools';
import { SqliteStore } from '../../../packages/host/dist/sqlite-store.js';
import { budgets } from '../../../packages/host/dist/durable-model.js';
import { createFrontendCoordinator, prepareFrontendRegistration, prepareFrontendObservation } from '../../../packages/host/dist/frontend-tools/coordinator.js';
import { fixture, installed, projection, run, scope } from '../fixture.mjs';

const key = { threadId: 'thread', runId: 'run-a' };
const registration = () => prepareFrontendRegistration(scope, { identity: run().identity, threadId: key.threadId,
  platform: 'desktop', bindings: [{ name: 'demo__work', activationId: 'original', definition: { name: 'demo__work', description: 'Work' } }] });
const prefix = (args = '{}') => [
  { type: 'RUN_STARTED', ...key },
  { type: 'TOOL_CALL_START', toolCallId: 'call', toolCallName: 'demo__work' },
  { type: 'TOOL_CALL_ARGS', toolCallId: 'call', delta: args },
  { type: 'TOOL_CALL_END', toolCallId: 'call' },
  { type: 'RUN_FINISHED', ...key },
].map((event, index) => prepareFrontendObservation(index + 1, event));
function setup(t) {
  const f = fixture(t), store = new SqliteStore(f.path, projection, budgets());
  store.create(scope, installed);
  t.after(() => { if (store.db.isOpen) store.close(); });
  return { ...f, store };
}
function counts(db) {
  return ['frontend_runs', 'frontend_events', 'frontend_receipts'].map(table => db.prepare(`SELECT count(*) count FROM ${table}`).get().count);
}

test('one store transaction publishes registration and complete prefix together', t => {
  const f = setup(t), prepared = registration(), events = prefix(), reader = new DatabaseSync(f.path);
  t.after(() => reader.close());
  let commits = 0; f.store.onCommit = () => commits++;
  f.store.transaction(transaction => {
    const writer = f.store.frontendWriter(transaction, scope, createFrontendCoordinator);
    writer.register(prepared);
    for (const event of events) assert.equal(writer.observe(key, event), 'accepted');
    assert.deepEqual(counts(f.store.db), [1, 5, 0]);
    assert.deepEqual(counts(reader), [0, 0, 0]);
  });
  assert.equal(commits, 1);
  assert.deepEqual(counts(reader), [1, 5, 0]);
  const publicProducer = frontendToolsFor(f.open()).producer(scope);
  assert.equal(publicProducer.inspect(key).status, 'ready');
  assert.equal(publicProducer.inspect(key).calls[0].status, 'pending');
  assert.equal(publicProducer.observe(key, 1, events[0].input), 'duplicate');
  t.diagnostic(JSON.stringify({ commits, committedRows: counts(reader), publicStatus: publicProducer.inspect(key).status }));
});

test('writer refuses a registration prepared for another conversation or host', t => {
  const f = setup(t), prepared = registration();
  for (const other of [{ ...scope, conversationId: 'other' }, { ...scope, hostId: 'other' }]) {
    f.store.create(other, installed);
    assert.throws(() => f.store.transaction(transaction => {
      f.store.frontendWriter(transaction, other, createFrontendCoordinator).register(prepared);
    }), /Frontend registration scope mismatch/);
    assert.deepEqual(counts(f.store.db), [0, 0, 0]);
  }
  f.store.transaction(transaction => f.store.frontendWriter(transaction, scope, createFrontendCoordinator).register(prepared));
  assert.deepEqual(counts(f.store.db), [1, 0, 0]);
  assert.deepEqual(frontendToolsFor(f.open()).producer(scope).inspect(key), { status: 'collecting', calls: [] });
});

test('issued writer retains its scope when the caller changes the original object', t => {
  const f = setup(t), other = { ...scope, conversationId: 'other' };
  f.store.create(other, installed);
  f.store.transaction(transaction => {
    const local = { ...scope }, writer = f.store.frontendWriter(transaction, local, createFrontendCoordinator);
    local.hostId = other.hostId; local.conversationId = other.conversationId;
    writer.register(registration());
    assert.equal(writer.observe(key, prefix()[0]), 'accepted');
    const foreign = prepareFrontendRegistration(other, { identity: { ...run().identity, conversation: other }, threadId: key.threadId,
      platform: 'desktop', bindings: [] });
    assert.throws(() => writer.register(foreign), /scope mismatch/);
  });
  const rows = f.store.db.prepare('SELECT host, conversation FROM frontend_runs').all();
  assert.deepEqual(rows.map(row => ({ hostId: row.host, conversationId: row.conversation })), [scope]);
  assert.deepEqual(counts(f.store.db), [1, 1, 0]);
});

test('outer failure rolls registration, prefix and generated refusal receipt back together', t => {
  const f = setup(t), prepared = registration(), events = prefix('{');
  let commits = 0, escaped;
  f.store.onCommit = () => commits++;
  assert.throws(() => f.store.transaction(transaction => {
    escaped = f.store.frontendWriter(transaction, scope, createFrontendCoordinator);
    escaped.register(prepared);
    for (const event of events) assert.equal(escaped.observe(key, event), 'accepted');
    assert.deepEqual(counts(f.store.db), [1, 5, 1]);
    throw new Error('injected outer failure');
  }), /injected outer failure/);
  assert.equal(commits, 0);
  assert.deepEqual(counts(f.store.db), [0, 0, 0]);
  assert.throws(() => escaped.observe(key, events[0]), /Inactive frontend write transaction/);
  f.store.transaction(transaction => {
    const writer = f.store.frontendWriter(transaction, scope, createFrontendCoordinator);
    writer.register(registration());
    for (const event of events) assert.equal(writer.observe(key, event), 'accepted');
  });
  assert.deepEqual(counts(f.store.db), [1, 5, 1]);
  assert.deepEqual(frontendToolsFor(f.open()).producer(scope).results(key).batch,
    [{ toolCallId: 'call', result: { kind: 'refused', code: 'invalid-arguments' } }]);
  t.diagnostic(JSON.stringify({ rollbackRows: [0, 0, 0], retryRows: counts(f.store.db), commits }));
});

test('writer rejects foreign, read, forged and expired handles without touching either store', t => {
  const a = setup(t), b = setup(t), prepared = registration(), event = prefix()[0];
  let retained, escaped;
  a.store.transaction(transaction => {
    retained = transaction; escaped = a.store.frontendWriter(transaction, scope, createFrontendCoordinator);
    b.store.transaction(other => {
      assert.throws(() => b.store.frontendWriter(transaction, scope, createFrontendCoordinator), /Inactive/);
      assert.throws(() => a.store.frontendWriter(other, scope, createFrontendCoordinator), /Inactive/);
      assert.throws(() => a.store.frontendWriter({ ...transaction }, scope, createFrontendCoordinator), /Inactive/);
    });
    escaped.register(prepared);
  });
  const refuse = () => {
    assert.throws(() => a.store.frontendWriter(retained, scope, createFrontendCoordinator), /Inactive/);
    assert.throws(() => escaped.register(prepared), /Inactive/);
    assert.throws(() => escaped.observe(key, event), /Inactive/);
  };
  refuse();
  a.store.transaction(transaction => {
    refuse();
    assert.equal(a.store.frontendWriter(transaction, scope, createFrontendCoordinator).observe(key, event), 'accepted');
  });
  a.store.transaction(transaction => {
    assert.throws(() => { transaction.write = true; }, TypeError);
    assert.throws(() => a.store.frontendWriter(transaction, scope, createFrontendCoordinator), /Inactive/);
    refuse();
  }, false);
  assert.deepEqual(counts(a.store.db), [1, 1, 0]);
  assert.deepEqual(counts(b.store.db), [0, 0, 0]);
  a.store.close(); refuse();
  b.store.transaction(transaction => b.store.frontendWriter(transaction, scope, createFrontendCoordinator).register(registration()));
  assert.deepEqual(counts(b.store.db), [1, 0, 0]);
});

test('async escape and commit callback cannot reuse a finished writer', async t => {
  const { store } = setup(t), prepared = registration();
  let escaped;
  store.onCommit = () => assert.throws(() => escaped.register(prepared), /Inactive/);
  await store.transaction(async transaction => {
    escaped = store.frontendWriter(transaction, scope, createFrontendCoordinator);
    await Promise.resolve();
    assert.throws(() => escaped.register(prepared), /Inactive/);
  });
  assert.deepEqual(counts(store.db), [0, 0, 0]);
});

test('failed initialization closes its database and a valid store still opens', t => {
  const f = setup(t); f.store.close();
  const original = DatabaseSync.prototype.close; let closed = 0;
  DatabaseSync.prototype.close = function () { closed++; return original.call(this); };
  try { assert.throws(() => new SqliteStore(f.path, projection, budgets({ maxEventBytes: 9999 })), /Incompatible persistent host budgets/); }
  finally { DatabaseSync.prototype.close = original; }
  assert.equal(closed, 1);
  const reopened = new SqliteStore(f.path, projection, budgets());
  try {
    reopened.transaction(transaction => reopened.frontendWriter(transaction, scope, createFrontendCoordinator).register(registration()));
    assert.deepEqual(counts(reopened.db), [1, 0, 0]);
  } finally { reopened.close(); }
});

test('coordinator transaction seam is absent from package exports', async () => {
  for (const path of ['@agentui/host/sqlite-store', '@agentui/host/frontend-tools/coordinator']) {
    await assert.rejects(import(path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
  const publicTools = await import('@agentui/host/frontend-tools');
  assert.deepEqual(Object.keys(publicTools), ['frontendToolsFor']);
});
