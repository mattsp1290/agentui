import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '@agentui/contracts';
import { fixture, scope, installed, command, completed, note, deferred, snapshot } from './fixture.mjs';

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
  const safe = f.open({ projection: projection(99500) });
  safe.createConversation(scope, installed);
  const observed = await snapshot(safe.conversation(scope));
  assert.doesNotThrow(() => canonicalJson(wire(observed.document)));
  safe.close();
  const other = fixture(t);
  const full = other.open({ projection: projection(99985) });
  assert.throws(() => full.createConversation(scope, installed), /structural budget/);
  assert.deepEqual(full.listConversations(scope.hostId, null, 100), []);
});
