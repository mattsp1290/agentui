import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationStore } from '@agentui/client';
import { createViewLeasePool } from '../../apps/desktop/dist/application/view-leases.js';
import { deferred, fakePort, projection, scope, storage } from '../client/support.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const drafts = storage(), captures = [], stores = [], failures = [];
  let closes = 0;
  const physical = { viewId: 'view', close() { closes++; } };
  const pool = createViewLeasePool({
    createStore(_storage, selected, _agentId, capture) {
      captures.push(capture);
      const store = createConversationStore({ scope: selected, drafts, projection, port: fakePort(selected) });
      stores.push(store); return store;
    },
    failed(owner, error) { failures.push([owner, error]); },
  });
  const view = pool.adopt(physical);
  t.after(() => pool.dispose());
  return { pool, view, drafts, captures, stores, failures, closes: () => closes };
}

test('a waiting successor retains physical storage while the old writer drains', async t => {
  const f = fixture(t), first = await f.pool.active(f.view, scope, 'agent');
  const entered = deferred(), gate = deferred(), save = f.drafts.save.bind(f.drafts);
  t.after(gate.resolve);
  f.drafts.save = async value => { entered.resolve(); await gate.promise; await save(value); };
  const writing = first.store.setDraft('Predecessor write'); await entered.promise;
  first.release();
  let acquired = false;
  const next = f.pool.active(f.view, scope, 'agent').then(value => { acquired = true; return value; });
  f.view.release();
  await flush();
  assert.equal(acquired, false); assert.equal(f.stores.length, 1); assert.equal(f.closes(), 0);
  gate.resolve(); await writing;
  const successor = await next;
  assert.notEqual(successor.store, first.store);
  assert.equal(successor.storage, f.view.storage);
  assert.equal(successor.store.getSnapshot().draft, 'Predecessor write');
  await successor.store.setDraft('Successor write');
  assert.equal(f.drafts.value.draft, 'Successor write');
  successor.release(); await flush();
  assert.equal(f.stores.length, 2); assert.equal(f.closes(), 1); assert.deepEqual(f.failures, []);
});

test('the closing slot refuses synchronous capture in its disposal listener', async t => {
  const f = fixture(t), first = await f.pool.active(f.view, scope, 'agent');
  let checked = false;
  first.store.subscribe(() => {
    checked = true;
    assert.throws(() => f.captures[0].borrow(), /closing/);
  });
  first.release(); await flush();
  assert.equal(checked, true);
  assert.equal(f.stores.length, 1);
  assert.equal(f.closes(), 0);
  f.view.release(); await flush();
  assert.equal(f.closes(), 1);
});

test('pool disposal drains admitted writes without waiting for an arbitrary capture handle', async t => {
  const f = fixture(t), first = await f.pool.active(f.view, scope, 'agent');
  const capture = f.captures[0].borrow(), gate = deferred(), entered = deferred();
  const save = f.drafts.save.bind(f.drafts);
  t.after(gate.resolve);
  f.drafts.save = async value => { entered.resolve(); await gate.promise; await save(value); };
  const writing = first.store.setDraft('Admitted write'); await entered.promise;
  const closing = f.pool.dispose();
  assert.equal(f.pool.dispose(), closing);
  assert.throws(() => f.captures[0].borrow(), /closing/);
  await flush(); assert.equal(f.closes(), 0);
  gate.resolve(); await Promise.all([writing, closing]);
  assert.equal(f.drafts.value.draft, 'Admitted write'); assert.equal(f.closes(), 1);
  capture.release(); first.release(); f.view.release();
  assert.deepEqual(f.failures, []);
});


for (const purpose of ['active', 'recovery']) test(`${purpose} readiness failure respects its purpose while a capture still retains the view`, async t => {
  const f = fixture(t), first = await f.pool.active(f.view, scope, 'agent');
  const capture = f.captures[0].borrow(), original = f.view.storage;
  const selected = { ...scope, conversationId: 'corrupt' }, corrupt = { version: 99, scope: selected };
  f.drafts.value = corrupt;
  const gate = deferred(), entered = deferred();
  t.after(gate.resolve);
  f.drafts.load = async () => { entered.resolve(); await gate.promise; return corrupt; };
  const acquiring = purpose === 'active' ? f.pool.active(f.view, selected, 'agent') : f.pool.recovery(f.view, selected);
  const rejected = assert.rejects(acquiring, /Unsupported local storage version/);
  await entered.promise;
  first.release(); f.view.release();
  gate.resolve(); await rejected; await flush();
  assert.equal(f.failures.length, purpose === 'active' ? 1 : 0);
  assert.equal(f.closes(), 0);
  assert.equal(f.drafts.value, corrupt);
  const failure = new Error('Live captured write failed');
  capture.failed(failure);
  assert.deepEqual(f.failures.at(-1), [original, failure]);
  capture.release(); await flush();
  assert.equal(f.closes(), 1);
});
