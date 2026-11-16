import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendToolGeneration } from '@agentui/sdk/tools';
import { scope, empty, fixture } from './controller-fixture.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
async function captured(t, count = 1) {
  const f = fixture();
  f.behavior.frontendOffers = 'ag-ui-capture-and-bind';
  f.behavior.observation = () => new Promise(() => {});
  f.views.set('original-view/host', { ...empty(), route: scope });
  const { generation } = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'A', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) {
      frontendTools.add({ definition: { name: 'echo', description: 'A' }, decodeInput: value => value,
        execute() { throw new Error('Execution is not enabled'); } });
      return { dispose() {} };
    } });
  const token = {};
  f.app.frontendGenerations.begin(token);
  f.app.frontendGenerations.publish(token, { kind: 'ready', generations: [generation] });
  t.after(async () => { await f.app.dispose(); await generation.retire(); });
  await f.app.start();
  for (let i = 0; i < count; i++) await assert.rejects(f.app.getSnapshot().active.store.send(`Message ${i}`), /Reply lost/);
  return f;
}

for (const count of [1, 3]) test(`${count} waiting captures publish nothing across two pending poll intervals`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await captured(t, count), requests = [];
  f.behavior.binding = async request => { requests.push(request); return { kind: 'pending', id: request.id }; };
  t.mock.timers.tick(0); await flush();
  const rows = f.app.getSnapshot().capturedSends, values = [...rows];
  const durable = structuredClone([...f.drafts]);
  let publications = 0;
  t.after(f.app.subscribe(() => { publications++; }));
  for (let interval = 0; interval < 2; interval++) { t.mock.timers.tick(2000); await flush(); t.mock.timers.tick(0); await flush(); }
  assert.equal(requests.filter(request => request.action === 'recover').length, count * 2);
  assert.deepEqual(rows.map(row => row.status), Array(count).fill('waiting'));
  assert.equal(publications, 0);
  assert.equal(f.app.getSnapshot().capturedSends, rows);
  values.forEach((row, index) => assert.equal(f.app.getSnapshot().capturedSends[index], row));
  assert.deepEqual([...f.drafts], durable);
});

test('a late predecessor storage failure cannot poison the same reopened view', async t => {
  const f = await captured(t);
  await f.app.releaseCapturedSend(f.app.getSnapshot().capturedSends[0].key);
  const predecessor = f.leases[0];
  await f.app.reopenView('other-view'); await flush();
  assert.equal(predecessor.closed, true);
  await f.app.reopenView('original-view');
  assert.equal(f.leases.length, 3);
  await assert.rejects(f.app.getSnapshot().active.store.send('Successor capture'), /Reply lost/);
  predecessor.failure(new Error('Late predecessor failure'));
  assert.equal(f.app.getSnapshot().storageFailure, '');
  await f.app.getSnapshot().active.store.setDraft('Healthy successor');
  assert.equal(f.drafts.get('original-view/host/conversation').draft, 'Healthy successor');
  f.leases[2].failure(new Error('Current storage failed'));
  assert.equal(f.app.getSnapshot().storageFailure, 'Current storage failed');
});

test('synchronous disposal listeners cannot dispatch a stale captured send', async t => {
  const f = await captured(t), store = f.app.getSnapshot().active.store;
  const writes = f.drafts.size, dispatches = f.submitted.length, physical = f.leases.length;
  let attempt;
  const unsubscribe = store.subscribe(() => { attempt ??= store.send('Stale send').then(() => null, error => error); });
  t.after(unsubscribe);
  await f.app.dispose();
  assert.match((await attempt).message, /closed|closing|Reconnect/);
  assert.equal(f.submitted.length, dispatches);
  assert.equal(f.drafts.size, writes);
  assert.equal(f.leases.length, physical);
});
