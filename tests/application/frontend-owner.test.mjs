import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendToolGeneration } from '@agentui/sdk/tools';
import { createConversationStore } from '@agentui/client';
import { createFrontendSends } from '../../apps/desktop/dist/application/frontend-sends.js';
import { scope, projection, storage, fakePort, deferred, receipt } from '../client/support.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, { drafts = storage(), reply } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const disposed = [], calls = [], failures = [], requests = [];
  const owner = createFrontendSends({ changed() {}, failed(view, error) { failures.push([view, error.message]); owner.storageFailed(view); }, unauthorized() { void owner.session(null, connection); } });
  const connection = { async frontendBinding(request) { requests.push(structuredClone(request)); return reply ? reply(request) : request.action === 'unavailable' ? { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' } : { kind: 'pending', id: request.id }; } };
  await owner.session({ hostId: scope.hostId, principalId: 'A' }, connection);
  const generation = async id => (await createFrontendToolGeneration({ namespace: 'fixture', generation: id, platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: id }, decodeInput: x => x, async execute() { calls.push(id); return id; } }); return { dispose() { disposed.push(id); } }; } })).generation;
  const a = await generation('A'), token = {};
  owner.source.begin(token); owner.source.publish(token, { kind: 'ready', generations: [a] });
  const port = fakePort(); let id = 0;
  const frontend = owner.forStore({ viewId: 'view', scope, eligibility: () => 'ag-ui-capture-and-bind' });
  const store = createConversationStore({ scope, projection, drafts, port, createCommandId: () => String(++id), frontend });
  t.after(async () => { await owner.dispose(); await a.retire(); });
  const recover = async () => { for (const reference of store.frontendJournal.read()) await owner.recover({ viewId: 'view', journal: store.frontendJournal, reference }); };
  const tick = async () => { t.mock.timers.tick(2000); await flush(); await recover(); };
  return { owner, store, port, frontend, drafts, a, token, generation, disposed, calls, requests, failures, connection, tick, recover };
}
const bound = command => ({ kind: 'bound', command, hostOperationId: 'operation', threadId: 'actual-thread', run: { conversation: scope, runId: 'actual-run', authority: { kind: 'remote-provider', binding: { namespace: 'provider', installationId: 'installation', opaqueSessionId: 'session' } } } });

test('completed outbox settlement retains A, exact delayed binding rejects drift, and release retries a lost acknowledgment', async t => {
  let response, lost = true;
  const f = await fixture(t, { reply: request => {
    if (request.action === 'recover') return response;
    if (lost) { lost = false; throw new Error('Reply lost'); }
    return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' };
  } });
  f.port.submit = async command => ({ kind: 'receipt', receipt: receipt(command, 'completed') });
  await f.store.send('Original'); const command = f.drafts.value.frontendSends[0].command;
  assert.equal(f.store.getSnapshot().outbox.length, 0);
  const retiring = f.a.retire(); const b = await f.generation('B'); t.after(() => b.retire());
  f.owner.source.publish(f.token, { kind: 'ready', generations: [b] });
  response = bound({ ...command, body: { ...command.body, text: 'Changed' } }); await f.tick();
  assert.equal(f.owner.snapshot()[0].status, 'waiting');
  response = bound(command); await f.tick();
  assert.equal(f.owner.snapshot()[0].status, 'bound'); assert.deepEqual(f.disposed, []);
  const key = f.owner.snapshot()[0].key; await f.owner.release(key); await retiring; await flush(); await f.recover();
  assert.deepEqual(f.disposed, ['A']); assert.equal(f.drafts.value.frontendSends[0].state, 'unavailable-pending');
  await f.tick(); assert.equal(f.drafts.value.frontendSends[0].state, 'unavailable-confirmed');
  await f.owner.release(key); assert.equal(f.owner.holds('view'), false); assert.deepEqual(f.calls, []);
});

test('release during an outstanding recovery cannot bind or revive its delayed reply', async t => {
  const gate = deferred(); const f = await fixture(t, { reply: request => request.action === 'recover' ? gate.promise : { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' } });
  await f.store.send('Waiting'); const command = f.drafts.value.frontendSends[0].command;
  await f.tick(); await f.tick(); assert.equal(f.requests.length, 1);
  await f.owner.release(f.owner.snapshot()[0].key); gate.resolve(bound(command)); await flush();
  assert.equal(f.owner.snapshot()[0].status, 'unavailable');
  await f.tick(); assert.equal(f.drafts.value.frontendSends[0].state, 'unavailable-confirmed');
  assert.deepEqual(f.calls, []);
});

test('original journal is never adopted or notified by a new principal and its pending notification resumes on return', async t => {
  const gate = deferred(), f = await fixture(t, { reply: request => request.action === 'recover' ? gate.promise : { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' } });
  await f.store.send('A message'); const command = f.drafts.value.frontendSends[0].command;
  await f.tick();
  await f.owner.session({ hostId: scope.hostId, principalId: 'B' }, f.connection);
  gate.resolve(bound(command)); await flush(); await f.tick();
  assert.deepEqual(f.owner.snapshot(), []); assert.equal(f.requests.length, 1);
  await assert.rejects(f.store.retry('1'), /Original captured tools/);
  await f.store.send('B message'); assert.equal(f.drafts.value.frontendSends[1].ownerId, 'B');
  assert.equal(f.drafts.value.frontendSends[0].ownerId, 'A');
  await f.owner.session({ hostId: scope.hostId, principalId: 'A' }, f.connection); await f.tick();
  assert.equal(f.drafts.value.frontendSends[0].state, 'unavailable-confirmed');
  assert.ok(f.requests.filter(request => request.action === 'unavailable').every(request => request.id === '1'));
  assert.deepEqual(f.calls, []);
});

for (const fault of ['save', 'parse', 'release-save']) test(`${fault} failure releases original holds and never executes handlers`, async t => {
  const f = await fixture(t);
  if (fault === 'save') f.drafts.save = async () => { throw new Error('Disk failed'); };
  if (fault === 'parse') await assert.rejects(f.store.send(''), /text|empty|Invalid/i);
  else if (fault === 'save') await assert.rejects(f.store.send('No network'), /Disk failed/);
  else {
    await f.store.send('Captured'); f.drafts.save = async () => { throw new Error('Release disk failed'); };
    await assert.rejects(f.owner.release(f.owner.snapshot()[0].key), /Release disk failed/);
    await f.tick(); assert.deepEqual(f.requests, []); assert.equal(f.owner.snapshot()[0].status, 'unavailable');
    await assert.rejects(f.store.retry('1'), /disk|unavailable/i);
  }
  await f.a.retire(); assert.deepEqual(f.disposed, ['A']); assert.deepEqual(f.calls, []);
  if (fault !== 'release-save') assert.deepEqual(f.port.submitted, []);
});

test('source tokens distinguish transition and ready-empty and refuse a retired generation without B fallback', async t => {
  const f = await fixture(t), next = {};
  f.owner.source.begin(next);
  await assert.rejects(f.store.send('Transition'), /changing/);
  f.owner.source.publish(next, { kind: 'ready', generations: [f.a] }); f.owner.source.clear(f.token);
  await f.store.send('New source'); assert.equal(f.port.submitted[0].version, 2);
  await f.owner.release(f.owner.snapshot()[0].key); await flush(); await f.a.retire();
  await assert.rejects(f.store.send('Retired'), /retired/);
  f.owner.source.publish(next, { kind: 'ready', generations: [] });
  await f.store.send('Empty source'); assert.equal(f.port.submitted.at(-1).version, 1);
});

test('32 retained owners are bounded including provisional saves and can be explicitly released', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 32; index++) await f.store.send(`Send ${index}`);
  await assert.rejects(f.store.send('33'), /32 captured sends/);
  assert.equal(f.port.submitted.length, 32);
  await f.owner.release(f.owner.snapshot()[0].key); await flush();
  await f.store.send('After release'); assert.equal(f.port.submitted.length, 33);
  assert.deepEqual(f.calls, []);
});

test('session closure during durable admission preserves an unavailable reference and prevents dispatch', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred(), save = f.drafts.save.bind(f.drafts);
  f.drafts.save = async records => { entered.resolve(); await gate.promise; return save(records); };
  const send = f.store.send('Delayed save'); await entered.promise;
  const changed = f.owner.session({ hostId: scope.hostId, principalId: 'B' }, f.connection); gate.resolve();
  await assert.rejects(send, /capture session changed/); await changed;
  assert.equal(f.drafts.value.frontendSends[0].state, 'unavailable-pending'); assert.equal(f.drafts.value.frontendSends[0].ownerId, 'A');
  assert.deepEqual(f.port.submitted, []); await f.a.retire(); assert.deepEqual(f.disposed, ['A']);
});

test('reload has no original closure and preserves original bytes while notifying unavailability', async t => {
  const f = await fixture(t); await f.store.send('Old capture'); const saved = structuredClone(f.drafts.value);
  await f.owner.dispose();
  const second = createFrontendSends({ changed() {}, failed() {}, unauthorized() {} }); t.after(() => second.dispose());
  await second.session({ hostId: scope.hostId, principalId: 'A' }, f.connection);
  const drafts = storage(saved), port = fakePort();
  const store = createConversationStore({ scope, projection, drafts, port, createCommandId: () => 'new', frontend: second.forStore({ viewId: 'view', scope, eligibility: () => 'ag-ui-capture-and-bind' }) });
  await store.ready; await store.drained();
  await assert.rejects(store.retry('1'), /Original captured tools/);
  for (const reference of store.frontendJournal.read()) await second.recover({ viewId: 'view', journal: store.frontendJournal, reference });
  assert.equal(drafts.value.frontendSends[0].state, 'unavailable-confirmed');
  assert.deepEqual(drafts.value.frontendSends[0].command, saved.frontendSends[0].command); assert.deepEqual(port.submitted, []);
});

test('a provisional save finishing after disposal cannot reinsert an owner into the closed application', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred(), save = f.drafts.save.bind(f.drafts);
  f.drafts.save = async records => { entered.resolve(); await gate.promise; return save(records); };
  const send = f.store.send('Disposing during save'); await entered.promise;
  await f.owner.dispose(); gate.resolve(); await assert.rejects(send, /capture session changed/);
  await f.store.drained();
  assert.equal(f.drafts.value.frontendSends[0].state, 'unavailable-pending');
  assert.equal(f.owner.holds('view'), false);
  assert.deepEqual(f.port.submitted, []);
});

test('storage failure invalidates a provisional capture even if its outstanding save later resolves', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred(), save = f.drafts.save.bind(f.drafts);
  f.drafts.save = async records => { entered.resolve(); await gate.promise; return save(records); };
  const send = f.store.send('Storage closing during save'); await entered.promise;
  f.owner.storageFailed('view'); gate.resolve(); await assert.rejects(send, /capture session changed/);
  await f.tick(); assert.deepEqual(f.requests, []); await assert.rejects(f.store.send('Still failed'), /storage failed/);
  assert.deepEqual(f.port.submitted, []); await f.a.retire(); assert.deepEqual(f.disposed, ['A']);
});

test('32 released A captures leave all 32 slots available to B without notifying A', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 32; index++) await f.store.send(`A ${index}`);
  const originals = structuredClone(f.drafts.value.frontendSends);
  await f.owner.session({ hostId: scope.hostId, principalId: 'B' }, f.connection);
  for (let index = 0; index < 32; index++) await f.store.send(`B ${index}`);
  await assert.rejects(f.store.send('B overflow'), /32 captured sends/);
  assert.deepEqual(f.drafts.value.frontendSends.slice(0, 32).map(({ command, ownerId }) => ({ command, ownerId })), originals.map(({ command, ownerId }) => ({ command, ownerId })));
  assert.deepEqual(f.requests, []);
});

test('sweeping during admission skips the provisional scope and the persisted-before-commit window', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred(), save = f.drafts.save.bind(f.drafts);
  let pending, windowRecovery;
  const capture = f.frontend.capture.bind(f.frontend);
  f.frontend.capture = id => {
    const retained = capture(id);
    return { ...retained, commit(command, journal) {
      windowRecovery = f.owner.recover({ viewId: 'view', journal, reference: journal.read().at(-1) });
      return retained.commit(command, journal);
    } };
  };
  f.drafts.save = async records => { pending = records; entered.resolve(); await gate.promise; await save(records); };
  const sending = f.store.send('Gated admission'); await entered.promise;
  await f.owner.recover({ viewId: 'view', journal: f.store.frontendJournal, reference: pending.frontendSends[0] });
  gate.resolve(); await sending; await windowRecovery; await f.recover();
  assert.equal(f.owner.snapshot()[0].status, 'waiting'); assert.equal(f.drafts.value.frontendSends[0].state, 'retained');
  assert.deepEqual(f.requests, []); assert.equal(f.drafts.writes.length, 1);
});

test('more than 32 restored references occupy only bounded presentation rows and no live quota', async t => {
  const f = await fixture(t); await f.store.send('Template');
  const original = f.drafts.value.frontendSends[0]; await f.owner.dispose();
  const saved = { ...f.drafts.value, outbox: [], frontendSends: Array.from({ length: 70 }, (_, index) => ({ ...original, command: { ...original.command, clientCommandId: `old-${index}` } })) };
  f.owner.start(); await f.owner.session({ hostId: scope.hostId, principalId: 'B' }, f.connection);
  const drafts = storage(saved), store = createConversationStore({ scope, projection, drafts, port: fakePort(), createCommandId: () => 'B', frontend: f.owner.forStore({ viewId: 'view', scope, eligibility: () => 'ag-ui-capture-and-bind' }) });
  await store.ready;
  for (const reference of store.frontendJournal.read()) await f.owner.recover({ viewId: 'view', journal: store.frontendJournal, reference });
  assert.equal(f.owner.holds('view'), false); assert.deepEqual(f.owner.snapshot(), []); assert.deepEqual(f.requests, []);
  await store.send('B still has capacity');
  await f.owner.session({ hostId: scope.hostId, principalId: 'A' }, f.connection);
  for (const reference of store.frontendJournal.read()) await f.owner.recover({ viewId: 'view', journal: store.frontendJournal, reference });
  assert.equal(f.owner.snapshot().length, 32); assert.equal(f.owner.holds('view'), false);
  assert.ok(drafts.value.frontendSends.slice(0, 70).every(row => row.state === 'unavailable-confirmed'));
  assert.deepEqual(drafts.value.frontendSends.slice(0, 70).map(row => row.command), saved.frontendSends.map(row => row.command));
});

test('session invalidation releases a stalled recovery and its late reply cannot acknowledge a successor epoch', async t => {
  const gate = deferred(), entered = deferred(), f = await fixture(t, { reply: () => { entered.resolve(); return gate.promise; } });
  await f.store.send('Original'); await f.owner.release(f.owner.snapshot()[0].key);
  const recovering = f.recover(); await entered.promise;
  await f.owner.session({ hostId: scope.hostId, principalId: 'B' }, f.connection);
  await recovering;
  const before = structuredClone(f.drafts.value);
  gate.resolve({ kind: 'unavailable', id: '1', reason: 'closures-unavailable' }); await flush();
  assert.deepEqual(f.drafts.value, before); assert.equal(before.frontendSends[0].state, 'unavailable-pending');
  await f.store.send('B'); assert.equal(f.drafts.value.frontendSends[1].ownerId, 'B');
});

test('the final provisional admission consumes the 32nd slot until committed or released', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 31; index++) await f.store.send(`Live ${index}`);
  const gate = deferred(), entered = deferred(), save = f.drafts.save.bind(f.drafts);
  f.drafts.save = async records => { entered.resolve(); await gate.promise; await save(records); };
  const pending = f.store.send('Provisional 32'); await entered.promise;
  assert.throws(() => f.frontend.capture('overflow'), /32 captured sends/);
  gate.resolve(); await pending; assert.equal(f.owner.snapshot().length, 32);
});
