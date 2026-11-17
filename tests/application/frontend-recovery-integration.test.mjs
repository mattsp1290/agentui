import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationStore } from '@agentui/client';
import { ServiceError } from '@agentui/contracts/service';
import { createFrontendToolGeneration } from '@agentui/sdk/tools';
import { createFrontendRecovery } from '../../apps/desktop/dist/application/frontend-recovery.js';
import { createFrontendSends, createGenerationSource } from '../../apps/desktop/dist/application/frontend-sends.js';
import { createViewLeasePool } from '../../apps/desktop/dist/application/view-leases.js';
import { projection, fakePort, deferred, receipt } from '../client/support.mjs';

const scope = { hostId: 'host', conversationId: 'a' };
const confirmed = request => ({ kind: 'unavailable', id: request.id, reason: 'closures-unavailable' });
const record = (selected = scope, state = 'retained', ownerId = 'principal') => ({ version: 3, scope: selected, image: null, draft: 'Preserved', draftRevision: 1, outbox: [], frontendSends: [
  { ownerId, state, command: { version: 2, scope: selected, clientCommandId: `old-${selected.conversationId}`, body: { kind: 'send', text: 'Original', frontend: {
    platform: 'desktop', tools: [{ activationId: 'old', definition: { name: 'fixture__echo', description: 'Original' } }] } } } },
] });
const flush = () => new Promise(resolve => setImmediate(resolve));
async function settle(t) { for (let index = 0; index < 4; index++) { await flush(); t.mock.timers.tick(0); } await flush(); }
async function intervals(t, count = 3) { for (let index = 0; index < count; index++) { t.mock.timers.tick(2_000); await settle(t); } }
async function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = createFrontendRecovery(), source = createGenerationSource(), records = new Map(), requests = [], ports = [], gates = [], failures = [];
  const counts = { discoveries: 0, loads: 0, writes: 0, publications: 0 };
  const behavior = { save: async () => {}, discover: async () => {}, binding: request => request.action === 'recover' ? { kind: 'pending', id: request.id } : confirmed(request) };
  const { generation } = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'A', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'Original' }, decodeInput: value => value,
      execute() { assert.fail('No execution'); } }); return { dispose() {} }; } });
  const token = {}; source.begin(token); source.publish(token, { kind: 'ready', generations: [generation] });
  const frontend = createFrontendSends({ generations: source, rowsChanged() { counts.publications++; } });
  const connection = { async frontendBinding(request) { requests.push(request); return behavior.binding(request); } };
  let id = 0;
  const pool = createViewLeasePool({
    createStore(storage, selected, _agent, capture) {
      const port = fakePort(selected); ports.push(port);
      port.submit = async command => { port.submitted.push(command); return { kind: 'receipt', receipt: receipt(command, 'completed') }; };
      return createConversationStore({ scope: selected, projection, port, createCommandId: () => `new-${++id}`, drafts: storage.drafts(),
        frontend: frontend.forStore({ viewId: storage.viewId, scope: selected, capture, eligibility: () => 'ag-ui-capture-and-bind',
          recoveryNeeded: () => worker.wake({ pool, storage }) }) });
    },
    failed(storage, error) { failures.push({ storage, error }); },
  });
  function physical(viewId) {
    return { viewId, closed: false,
      async draftScopes(hostId, after) {
        counts.discoveries++; await behavior.discover(viewId, after);
        const scopes = [...records.entries()].filter(([key, row]) => key === `${viewId}/${row.scope.conversationId}` && row.scope.hostId === hostId && (after === null || row.scope.conversationId > after))
          .map(([, row]) => row.scope).sort((a, b) => a.conversationId.localeCompare(b.conversationId)).slice(0, 100);
        return { scopes, after: scopes.length === 100 ? scopes.at(-1).conversationId : null };
      },
      drafts() { return {
        async load(selected) { counts.loads++; return records.get(`${viewId}/${selected.conversationId}`) ?? null; },
        async save(value) { await behavior.save(value); counts.writes++; records.set(`${viewId}/${value.scope.conversationId}`, value); },
      }; },
      close() { this.closed = true; },
    };
  }
  const storage = physical('view'), lease = pool.adopt(storage), metadata = { hostId: 'host', principalId: 'principal' };
  const target = { pool, frontend, lease, metadata };
  await frontend.session(metadata, connection);
  t.after(async () => { for (const gate of gates) gate.resolve(); worker.retarget(null); await frontend.dispose(); await pool.dispose(); await generation.retire(); });
  return { worker, frontend, pool, storage, lease, target, physical, records, requests, ports, failures, counts, behavior, connection,
    gate() { const gate = deferred(); gates.push(gate); return gate; } };
}

test('durable selected capture release wakes idle recovery only after its held save', async t => {
  const f = await fixture(t), active = await f.pool.active(f.lease, scope, 'agent');
  await active.store.send('Original');
  const original = structuredClone(f.records.get('view/a').frontendSends[0]);
  f.worker.retarget(f.target); await settle(t);
  const before = { ...f.counts };
  await intervals(t);
  assert.equal(f.counts.discoveries, before.discoveries);
  const entered = f.gate(), saved = f.gate();
  f.behavior.save = async value => { if (value.frontendSends.some(row => row.state === 'unavailable-pending')) { entered.resolve(); await saved.promise; } };
  const releasing = f.frontend.release(f.frontend.snapshot()[0].key);
  await entered.promise; await settle(t);
  assert.equal(f.counts.discoveries, before.discoveries);
  assert.equal(f.records.get('view/a').frontendSends[0].state, 'retained');
  saved.resolve(); await releasing; await settle(t);
  assert.equal(f.records.get('view/a').frontendSends[0].state, 'unavailable-confirmed');
  assert.deepEqual(f.records.get('view/a').frontendSends[0].command, original.command);
  assert.equal(f.counts.discoveries, before.discoveries + 1);
  assert.equal(f.requests.filter(request => request.action === 'unavailable').length, 1);
  const idle = { ...f.counts }; await intervals(t); assert.deepEqual(f.counts, idle);
  active.release();
});

test('release in a previously visited scope requests a successor while the current pass is held', async t => {
  const f = await fixture(t), active = await f.pool.active(f.lease, scope, 'agent'), entered = f.gate(), reply = f.gate();
  await active.store.send('Original');
  const late = { ...scope, conversationId: 'z' }; f.records.set('view/z', record(late));
  f.behavior.binding = async request => { if (request.scope.conversationId === 'z') { entered.resolve(); await reply.promise; } return confirmed(request); };
  f.worker.retarget(f.target); await settle(t); await entered.promise;
  await f.frontend.release(f.frontend.snapshot().find(row => row.status === 'waiting').key);
  assert.equal(f.counts.discoveries, 1);
  reply.resolve(); await settle(t);
  assert.equal(f.counts.discoveries, 2);
  assert.equal(f.records.get('view/a').frontendSends[0].state, 'unavailable-confirmed');
  assert.equal(f.records.get('view/z').frontendSends[0].state, 'unavailable-confirmed');
  const idle = { ...f.counts }; await intervals(t); assert.deepEqual(f.counts, idle);
  active.release();
});

test('a durable pending record behind the 100-key cursor gets a successor sweep', async t => {
  const f = await fixture(t), active = await f.pool.active(f.lease, scope, 'agent'), entered = f.gate(), page = f.gate();
  for (let index = 0; index < 100; index++) {
    const selected = { ...scope, conversationId: `b-${String(index).padStart(3, '0')}` };
    f.records.set(`view/${selected.conversationId}`, { ...record(selected), frontendSends: [] });
  }
  f.behavior.discover = async (_viewId, after) => { if (after !== null) { entered.resolve(); await page.promise; } };
  f.worker.retarget(f.target); await settle(t); await entered.promise;
  await active.store.send('Behind cursor');
  await f.frontend.release(f.frontend.snapshot()[0].key);
  page.resolve(); await settle(t);
  assert.equal(f.records.get('view/a').frontendSends[0].state, 'unavailable-confirmed');
  assert.equal(f.counts.discoveries, 4);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].id, 'new-1');
  const idle = { ...f.counts }; await intervals(t); assert.deepEqual(f.counts, idle);
  active.release();
});

for (const response of ['pending', 'lost', 'blocked', 'malformed', 'wrong identity']) test(`own pending ${response} response retries after two seconds and stops after acknowledgment`, async t => {
  const f = await fixture(t), original = record(); f.records.set('view/a', original);
  f.behavior.binding = request => {
    if (response === 'lost') throw new Error('Reply lost');
    if (response === 'blocked') throw new ServiceError('unavailable', 'The host is busy');
    return response === 'pending' ? { kind: 'pending', id: request.id } : response === 'wrong identity' ? confirmed({ id: 'elsewhere' }) : { kind: 'malformed' };
  };
  f.worker.retarget(f.target); await settle(t);
  assert.equal(f.records.get('view/a').frontendSends[0].state, 'unavailable-pending');
  const rows = f.frontend.snapshot(), saved = f.records.get('view/a'), publications = f.counts.publications, writes = f.counts.writes;
  await intervals(t, 1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.records.get('view/a'), saved);
  assert.equal(f.frontend.snapshot(), rows);
  assert.equal(f.counts.publications, publications); assert.equal(f.counts.writes, writes);
  f.behavior.binding = confirmed; await intervals(t, 1);
  assert.equal(f.records.get('view/a').frontendSends[0].state, 'unavailable-confirmed');
  assert.deepEqual(f.records.get('view/a').frontendSends[0].command, original.frontendSends[0].command);
  assert.equal(f.frontend.snapshot(), rows);
  const idle = { ...f.counts }; await intervals(t); assert.deepEqual(f.counts, idle);
  assert.equal(f.requests.length, 3); assert.deepEqual(f.failures, []);
});

test('foreign retained repair becomes idle foreign pending and the returning principal resumes it', async t => {
  const f = await fixture(t), original = record(scope, 'retained', 'foreign'); f.records.set('view/a', original);
  f.worker.retarget(f.target); await settle(t);
  assert.equal(f.records.get('view/a').frontendSends[0].state, 'unavailable-pending');
  assert.deepEqual(f.requests, []); assert.deepEqual(f.frontend.snapshot(), []);
  const idle = { ...f.counts }; await intervals(t); assert.deepEqual(f.counts, idle);
  const metadata = { ...f.target.metadata, principalId: 'foreign' };
  await f.frontend.session(metadata, f.connection); f.worker.retarget({ ...f.target, metadata }); await settle(t);
  assert.equal(f.records.get('view/a').frontendSends[0].state, 'unavailable-confirmed');
  assert.deepEqual(f.records.get('view/a').frontendSends[0].command, original.frontendSends[0].command);
  assert.equal(f.requests.length, 1);
});

test('provisional scope exclusion keeps retry work until admission commits', async t => {
  const f = await fixture(t); f.records.set('view/a', record(scope, 'unavailable-pending'));
  const active = await f.pool.active(f.lease, scope, 'agent'), entered = f.gate(), save = f.gate();
  f.behavior.save = async () => { entered.resolve(); await save.promise; };
  const sending = active.store.send('Provisional'); await entered.promise;
  f.worker.retarget(f.target); await settle(t); await intervals(t, 1);
  assert.equal(f.counts.discoveries, 2); assert.deepEqual(f.requests, []);
  save.resolve(); await sending; await intervals(t, 1);
  assert.equal(f.records.get('view/a').frontendSends[0].state, 'unavailable-confirmed');
  assert.equal(f.records.get('view/a').frontendSends[1].state, 'retained');
  const scans = f.counts.discoveries; await intervals(t); assert.equal(f.counts.discoveries, scans);
  active.release();
});

test('same-principal reset compensation completing after an empty sweep wakes recovery', async t => {
  const f = await fixture(t), active = await f.pool.active(f.lease, scope, 'agent');
  const first = f.gate(), second = f.gate(), admitted = f.gate(), compensating = f.gate();
  let saves = 0;
  f.behavior.save = async () => {
    if (++saves === 1) { admitted.resolve(); await first.promise; }
    else if (saves === 2) { compensating.resolve(); await second.promise; }
  };
  const sending = assert.rejects(active.store.send('Original'), /capture session changed/); await admitted.promise;
  await f.frontend.session(null, f.connection);
  await f.frontend.session(f.target.metadata, f.connection);
  f.worker.retarget(f.target); await settle(t);
  assert.equal(f.counts.discoveries, 1);
  first.resolve(); await compensating.promise;
  assert.equal(f.records.get('view/a').frontendSends[0].state, 'retained');
  await intervals(t); assert.equal(f.counts.discoveries, 1); assert.deepEqual(f.requests, []);
  second.resolve(); await sending; await settle(t);
  assert.equal(f.counts.discoveries, 2);
  assert.equal(f.records.get('view/a').frontendSends[0].state, 'unavailable-confirmed');
  assert.equal(f.records.get('view/a').frontendSends[0].ownerId, 'principal');
  assert.deepEqual(f.ports.flatMap(port => port.submitted), []);
  const idle = { ...f.counts }; await intervals(t); assert.deepEqual(f.counts, idle);
  active.release();
});

for (const state of ['waiting', 'bound']) test(`live ${state} captures do not keep full-view recovery polling alive`, async t => {
  const f = await fixture(t), active = await f.pool.active(f.lease, scope, 'agent');
  await active.store.send('Original');
  const command = f.records.get('view/a').frontendSends[0].command;
  f.behavior.binding = request => state === 'waiting' ? { kind: 'pending', id: request.id } : { kind: 'bound', command,
    hostOperationId: 'operation', threadId: 'thread', run: { conversation: scope, runId: 'run', authority: { kind: 'remote-provider', binding: { namespace: 'provider', installationId: 'installation', opaqueSessionId: 'session' } } } };
  f.worker.retarget(f.target); await settle(t); const scans = f.counts.discoveries;
  await intervals(t);
  assert.equal(f.counts.discoveries, scans);
  assert.equal(f.frontend.snapshot()[0].status, state);
  assert.equal(f.requests.length, state === 'waiting' ? 3 : 1);
  assert.ok(f.requests.every(request => request.action === 'recover'));
  assert.equal(f.records.get('view/a').frontendSends[0].state, 'retained');
  active.release();
});

test('inactive physical capture release cannot wake the selected view and reopening discovers its durable record', async t => {
  const f = await fixture(t), active = await f.pool.active(f.lease, scope, 'agent');
  await active.store.send('Original');
  const key = f.frontend.snapshot()[0].key;
  f.worker.retarget(f.target); await settle(t);
  const other = f.pool.adopt(f.physical('other'));
  f.worker.retarget({ ...f.target, lease: other }); await settle(t);
  const scans = f.counts.discoveries;
  await f.frontend.release(key); await settle(t);
  assert.equal(f.counts.discoveries, scans); assert.deepEqual(f.requests, []);
  assert.equal(f.records.get('view/a').frontendSends[0].state, 'unavailable-pending');
  f.worker.retarget(f.target); await settle(t);
  assert.equal(f.records.get('view/a').frontendSends[0].state, 'unavailable-confirmed');
  assert.deepEqual(f.failures, []);
  active.release(); other.release();
});
