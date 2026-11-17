import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendToolGeneration } from '@agentui/sdk/tools';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { scope, empty, deferred, fixture } from './controller-fixture.mjs';

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


for (const failure of ['load', 'restore']) test(`obsolete recovery ${failure} failure cannot poison a replacement while a live capture retains its old view`, async t => {
  const f = await captured(t), gate = deferred(), entered = deferred();
  t.after(gate.resolve);
  const selected = { ...scope, conversationId: 'z-corrupt' }, corrupt = { version: 99, scope: selected };
  f.drafts.set('original-view/host/z-corrupt', corrupt);
  f.behavior.load = async (loading, viewId) => {
    if (viewId === 'original-view' && loading.conversationId === selected.conversationId) { entered.resolve(); await gate.promise; }
  };
  await f.app.reconnect(); await entered.promise;
  const row = f.app.getSnapshot().capturedSends[0];
  f.views.set('other-view/host', { ...empty(), route: scope });
  await f.app.reopenView('other-view');
  const active = f.app.getSnapshot().active, feed = f.feeds.at(-1);
  await feed.receive({ kind: 'snapshot', snapshot: { scope, projectionVersion: transcriptProjection.version, cursor: 0,
    document: { domain: transcriptProjection.initial(), receipts: {}, decisions: {} } } });
  assert.equal(active.store.getSnapshot().connection.kind, 'connected');
  assert.equal(f.leases[0].closed, false);
  if (failure === 'load') gate.reject(new Error('Obsolete corrupt load')); else gate.resolve();
  for (let i = 0; i < 10; i++) await flush();
  assert.equal(f.app.getSnapshot().storageFailure, '');
  assert.equal(f.app.getSnapshot().error, '');
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  assert.equal(f.app.getSnapshot().active, active);
  assert.equal(active.store.getSnapshot().connection.kind, 'connected');
  assert.equal(f.app.getSnapshot().capturedSends[0], row);
  assert.equal(row.status, 'waiting');
  assert.equal(f.leases[0].closed, false);
  assert.equal(f.drafts.get('original-view/host/z-corrupt'), corrupt);
  await active.store.setDraft('Healthy replacement');
  assert.equal(f.drafts.get('other-view/host/conversation').draft, 'Healthy replacement');
});

for (const operation of ['send', 'retry']) test(`a synchronous captured ${operation} release during submitting prevents transport and drains its admitted unavailable write`, async t => {
  const gate = deferred(), entered = deferred();
  t.after(gate.resolve);
  const f = await captured(t), store = f.app.getSnapshot().active.store;
  const original = structuredClone(f.submitted[0]), before = f.submitted.length;
  f.behavior.write = async () => {
    if (f.app.getSnapshot().capturedSends.some(row => row.status === 'unavailable')) { entered.resolve(); await gate.promise; }
  };
  let releasing;
  const unsubscribe = store.subscribe(() => {
    if (releasing || !store.getSnapshot().submitting.length) return;
    const id = store.getSnapshot().submitting[0];
    const row = f.app.getSnapshot().capturedSends.find(value => value.command.clientCommandId === id);
    releasing = f.app.releaseCapturedSend(row.key);
  });
  t.after(unsubscribe);
  const sending = operation === 'send' ? store.send('Second original') : store.retry(original.clientCommandId);
  await assert.rejects(sending, /unavailable/);
  await entered.promise;
  assert.equal(f.submitted.length, before);
  const records = f.drafts.get('original-view/host/conversation');
  assert.deepEqual(records.outbox[0].command, original);
  if (operation === 'retry') assert.deepEqual(records.frontendSends[0].command, original);
  let disposed = false;
  const closing = f.app.dispose().then(() => { disposed = true; });
  await flush(); assert.equal(disposed, false); assert.equal(f.leases[0].closed, false);
  gate.resolve(); await Promise.all([releasing, closing]);
  assert.equal(f.leases[0].closed, true);
  const saved = f.drafts.get('original-view/host/conversation');
  assert.ok(saved.frontendSends.every(row => row.state === 'unavailable-pending'));
  assert.equal(saved.outbox.length, operation === 'retry' ? 1 : 2);
});
