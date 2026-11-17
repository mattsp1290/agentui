import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationStore } from '@agentui/client';
import { createFrontendToolGeneration } from '@agentui/sdk/tools';
import { createFrontendSends, createGenerationSource } from '../../apps/desktop/dist/application/frontend-sends.js';
import { scope, projection, storage, fakePort, deferred } from '../client/support.mjs';

async function fixture(t) {
  const drafts = storage(), source = createGenerationSource(), wakes = [];
  const { generation } = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'A', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'A' }, decodeInput: value => value, execute() { assert.fail('No execution'); } }); return { dispose() {} }; } });
  const token = {}; source.begin(token); source.publish(token, { kind: 'ready', generations: [generation] });
  const owner = createFrontendSends({ generations: source, rowsChanged() {} });
  const connection = { frontendBinding: async request => ({ kind: 'pending', id: request.id }) };
  await owner.session({ hostId: scope.hostId, principalId: 'A' }, connection);
  const port = fakePort();
  const admission = owner.forStore({ viewId: 'view', scope, eligibility: () => 'ag-ui-capture-and-bind',
    capture: { borrow: () => ({ failed() {}, release() {} }) }, recoveryNeeded() { wakes.push(structuredClone(drafts.value?.frontendSends ?? [])); } });
  const store = createConversationStore({ scope, projection, drafts, port, frontend: admission, createCommandId: () => 'command' });
  t.after(async () => { await owner.dispose(); await store.dispose(); await generation.retire(); });
  return { drafts, owner, connection, store, port, wakes };
}

for (const invalidation of ['session', 'same-principal reset', 'dispose', 'storage']) test(`Desktop callback observes durable compensation after provisional ${invalidation}`, async t => {
  const f = await fixture(t), first = deferred(), second = deferred(), admitted = deferred(), compensated = deferred();
  t.after(() => { first.resolve(); second.resolve(); });
  let writes = 0;
  const save = f.drafts.save.bind(f.drafts);
  f.drafts.save = async records => {
    writes++;
    if (writes === 1) { admitted.resolve(); await first.promise; }
    if (writes === 2) { compensated.resolve(); await second.promise; }
    await save(records);
  };
  const sending = assert.rejects(f.store.send('Original'), /capture session changed/);
  await admitted.promise;
  if (invalidation === 'session') await f.owner.session({ hostId: scope.hostId, principalId: 'B' }, f.connection);
  if (invalidation === 'same-principal reset') { await f.owner.session(null, f.connection); await f.owner.session({ hostId: scope.hostId, principalId: 'A' }, f.connection); }
  if (invalidation === 'dispose') await f.owner.dispose();
  if (invalidation === 'storage') f.owner.storageFailed('view');
  assert.equal(f.wakes.length, 0);
  first.resolve(); await compensated.promise;
  assert.equal(f.drafts.value.frontendSends[0].state, 'retained');
  assert.equal(f.wakes.length, 0);
  second.resolve(); await sending;
  assert.equal(f.wakes.length, 1);
  assert.equal(f.wakes[0][0].state, 'unavailable-pending');
  assert.equal(f.wakes[0][0].ownerId, 'A');
  assert.deepEqual(f.port.submitted, []);
});

for (const ending of ['release', 'rejected', 'session', 'dispose']) test(`Desktop callback observes durable ${ending} notification`, async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  t.after(gate.resolve);
  if (ending === 'rejected') f.port.submit = async () => ({ kind: 'rejected', reason: 'No admission' });
  else await f.store.send('Original');
  const save = f.drafts.save.bind(f.drafts);
  f.drafts.save = async records => {
    if (records.frontendSends.some(row => row.state === 'unavailable-pending')) { entered.resolve(); await gate.promise; }
    await save(records);
  };
  const endingTask = ending === 'release' ? f.owner.release(f.owner.snapshot()[0].key)
    : ending === 'rejected' ? f.store.send('Original')
    : ending === 'session' ? f.owner.session({ hostId: scope.hostId, principalId: 'B' }, f.connection) : f.owner.dispose();
  await entered.promise;
  assert.equal(f.wakes.length, 0);
  gate.resolve(); await endingTask;
  assert.equal(f.wakes.length, 1);
  assert.equal(f.wakes[0][0].state, 'unavailable-pending');
});
