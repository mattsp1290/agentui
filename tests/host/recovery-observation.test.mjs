import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, CORE_SNAPSHOT_DOCUMENT_JSON_BUDGET, DEFAULT_MAX_COMMAND_BYTES,
  HOST_DEFAULT_PAGE_BYTES, HOST_DEFAULT_PAGE_EVENTS, HOST_DEFAULT_SNAPSHOT_BYTES } from '@agentui/contracts';
import { SqliteStore } from '../../packages/host/dist/sqlite-store.js';
import { budgets } from '../../packages/host/dist/durable-model.js';
import { fixture, scope, installed, command, completed, note, deferred, snapshot, projection } from './fixture.mjs';

test('reconciliation before live acceptance does not publish a false uncertain receipt', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = fixture(t, { resolve: async () => { entered.resolve(); await release.promise; return completed(note('done')); } });
  const host = f.open();
  host.createConversation(scope, installed);
  const pending = host.conversation(scope).submit(command('live'));
  await entered.promise;
  const before = await snapshot(host.conversation(scope));
  assert.equal((await host.reconcile(scope, 'live')).state.kind, 'pending');
  const after = await snapshot(host.conversation(scope));
  assert.deepEqual(after, before);
  release.resolve();
  assert.equal((await pending).receipt.state.kind, 'completed');
});
test('snapshot capacity reserves the structure needed by the public wire envelope', async t => {
  const wire = document => ({ ok: true, value: { kind: 'page', page: 1, item: { kind: 'snapshot', snapshot: {
    scope, projectionVersion: 1, cursor: 0, document,
  } } } });
  const initial = count => ({ domain: { items: Array(count).fill(0) }, receipts: {}, decisions: {} });
  assert.doesNotThrow(() => canonicalJson(initial(99985)));
  assert.throws(() => canonicalJson(wire(initial(99985))), /structural limit/);
  const projection = count => ({ version: 1, initial: () => initial(count).domain,
    decodeState: value => value, decodeEvent: value => value, apply: state => state });
  const f = fixture(t);
  const documentItems = CORE_SNAPSHOT_DOCUMENT_JSON_BUDGET.maxNodes - 5;
  const safe = f.open({ projection: projection(documentItems) });
  safe.createConversation(scope, installed);
  const observed = await snapshot(safe.conversation(scope));
  assert.doesNotThrow(() => canonicalJson(wire(observed.document)));
  safe.close();
  const other = fixture(t);
  const full = other.open({ projection: projection(documentItems + 1) });
  assert.throws(() => full.createConversation(scope, installed), /structural budget/);
  assert.deepEqual(full.listConversations(scope.hostId, null, 100), []);
});

test('snapshot structural reserve covers documents at the maximum admitted depth', async t => {
  const nested = depth => {
    let value = null;
    for (let index = 0; index < depth; index++) value = { nested: value };
    return value;
  };
  const projection = depth => ({ version: 1, initial: () => nested(depth),
    decodeState: value => value, decodeEvent: value => value, apply: state => state });
  const safe = fixture(t).open({ projection: projection(CORE_SNAPSHOT_DOCUMENT_JSON_BUDGET.maxDepth - 1) });
  safe.createConversation(scope, installed);
  const observed = await snapshot(safe.conversation(scope));
  assert.doesNotThrow(() => canonicalJson({ ok: true, value: { kind: 'page', page: 1,
    item: { kind: 'snapshot', snapshot: observed } } }));
  const full = fixture(t).open({ projection: projection(CORE_SNAPSHOT_DOCUMENT_JSON_BUDGET.maxDepth) });
  assert.throws(() => full.createConversation(scope, installed), /structural budget/);
});

test('generic hosts retain configured budgets above the service defaults', async t => {
  const limits = budgets({ maxCommandBytes: DEFAULT_MAX_COMMAND_BYTES + 1024, maxEventBytes: DEFAULT_MAX_COMMAND_BYTES + 1024,
    pageEvents: HOST_DEFAULT_PAGE_EVENTS + 1, pageBytes: HOST_DEFAULT_PAGE_BYTES * 2,
    snapshotBytes: HOST_DEFAULT_SNAPSHOT_BYTES * 2 });
  const largeProjection = { ...projection, initial: () => ['x'.repeat(HOST_DEFAULT_SNAPSHOT_BYTES)] };
  const f = fixture(t), host = f.open({ budgets: limits, projection: largeProjection });
  host.createConversation(scope, installed);
  const submitted = await host.conversation(scope).submit(command('large', { kind: 'send', text: 'x'.repeat(DEFAULT_MAX_COMMAND_BYTES + 1) }));
  assert.equal(submitted.kind, 'receipt');
  assert.equal(submitted.receipt.state.kind, 'completed');
  const before = await snapshot(host.conversation(scope));
  host.append(scope, { ...note(''), events: Array.from({ length: limits.pageEvents }, (_, index) =>
    ({ kind: 'note-added', text: 'x'.repeat(index === 0 ? DEFAULT_MAX_COMMAND_BYTES + 1 : 4000) })) });
  const store = new SqliteStore(f.path, largeProjection, limits);
  t.after(() => store.close());
  const events = store.page(scope, before.cursor, before.cursor + limits.pageEvents);
  assert.equal(events.length, limits.pageEvents);
  assert.ok(Buffer.byteLength(canonicalJson({ kind: 'events', events })) > HOST_DEFAULT_PAGE_BYTES);
  assert.ok(Buffer.byteLength(canonicalJson(store.snapshot(scope))) > HOST_DEFAULT_SNAPSHOT_BYTES);
});
