import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../../../packages/host/dist/sqlite-store.js';
import { budgets } from '../../../packages/host/dist/durable-model.js';
import { createFrontendCoordinator } from '../../../packages/host/dist/frontend-tools/coordinator.js';
import { fixture, projection, scope } from '../fixture.mjs';

test('acquisition initializes lazily, retries factory failure and shares one coordinator', t => {
  const f = fixture(t), store = new SqliteStore(f.path, projection, budgets());
  t.after(() => store.close());
  let attempts = 0, created;
  const factory = current => { attempts++; return created = createFrontendCoordinator(current); };
  assert.throws(() => store.frontendWriter({ write: true }, scope, factory), /Inactive/);
  assert.equal(attempts, 0);
  store.transaction(transaction => {
    assert.throws(() => store.frontendWriter(transaction, scope, factory), /Inactive/);
  }, false);
  assert.equal(attempts, 0);
  assert.throws(() => store.transaction(transaction => {
    store.frontendWriter(transaction, scope, () => { throw new Error('factory failure'); });
  }), /factory failure/);
  store.transaction(transaction => store.frontendWriter(transaction, scope, factory));
  assert.equal(attempts, 1);
  let toolsCalls = 0;
  const tools = created.tools;
  created.tools = authorized => { toolsCalls++; return tools(authorized); };
  store.frontendTools(factory, current => current);
  store.transaction(transaction => store.frontendWriter(transaction, scope, factory));
  assert.equal(attempts, 1);
  assert.equal(toolsCalls, 1);
});
