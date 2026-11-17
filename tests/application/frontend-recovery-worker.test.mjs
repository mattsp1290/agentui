import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRecovery } from '../../apps/desktop/dist/application/frontend-recovery.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
function target(id, recover, events) {
  const storage = { viewId: id, async draftScopes() {
    events.push(`scan ${id}`);
    return { scopes: [{ hostId: 'host', conversationId: id }], after: null };
  } };
  return {
    metadata: { hostId: 'host' }, lease: { storage }, frontend: { recover, needsRecovery: () => false },
    pool: {
      retainRecovery() { events.push(`retain ${id}`); return { release() { events.push(`release ${id}`); } }; },
      async recovery() { return { store: { frontendJournal: { read: () => [id] } }, release() {} }; },
      failed(_storage, error) { assert.fail(error); },
    },
  };
}

test('recovery cancellation keeps a reentrant successor and waits for the old pass to release', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = createFrontendRecovery(), events = [], entered = Promise.withResolvers(), drain = Promise.withResolvers();
  const last = target('last', async () => {}, events), superseded = target('superseded', async () => {}, events);
  const first = target('first', async ({ signal }) => {
    signal.addEventListener('abort', () => worker.retarget(last), { once: true });
    entered.resolve();
    await drain.promise;
  }, events);
  t.after(() => { worker.retarget(null); drain.resolve(); });
  worker.retarget(first);
  await entered.promise;
  worker.retarget(superseded);
  assert.deepEqual(events, ['retain first', 'scan first']);
  drain.resolve(); await flush();
  assert.deepEqual(events, ['retain first', 'scan first', 'release first', 'retain last', 'scan last']);
  t.mock.timers.tick(0); await flush();
  assert.equal(events.at(-1), 'release last');
});

for (const identity of ['pool', 'lease', 'metadata']) test(`recovery ${identity} identity changes cancel the pass but an equivalent target does not`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = createFrontendRecovery(), entered = Promise.withResolvers(), drain = Promise.withResolvers(), events = [];
  let signal;
  const first = target('first', async input => { signal = input.signal; entered.resolve(); await drain.promise; }, events);
  t.after(() => { worker.retarget(null); drain.resolve(); });
  worker.retarget(first); await entered.promise;
  worker.retarget({ ...first });
  assert.equal(signal.aborted, false);
  worker.retarget({ ...first, [identity]: { ...first[identity] } });
  assert.equal(signal.aborted, true);
  worker.retarget(null);
  drain.resolve(); await flush(); t.mock.timers.tick(0); await flush();
  assert.deepEqual(events, ['retain first', 'scan first', 'release first']);
});

for (const boundary of ['last work query', 'borrow release']) test(`a wake during the ${boundary} survives completion and starts one successor`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = createFrontendRecovery(), events = [];
  const selected = target('selected', async () => {}, events);
  let wakes = 0;
  const wake = () => { if (wakes++ === 0) worker.wake({ pool: selected.pool, storage: selected.lease.storage }); };
  if (boundary === 'last work query') selected.frontend.needsRecovery = () => { wake(); return false; };
  else selected.pool.retainRecovery = () => ({ release: wake });
  t.after(() => worker.retarget(null));
  worker.retarget(selected); await flush();
  for (let index = 0; index < 3; index++) { t.mock.timers.tick(0); await flush(); }
  assert.equal(events.filter(event => event === 'scan selected').length, 2);
  for (let index = 0; index < 3; index++) { t.mock.timers.tick(2000); await flush(); }
  assert.equal(events.filter(event => event === 'scan selected').length, 2);
});

test('same target publications and obsolete physical or session wakes cannot restart idle work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = createFrontendRecovery(), events = [], selected = target('selected', async () => {}, events);
  t.after(() => worker.retarget(null));
  worker.retarget(selected); await flush(); t.mock.timers.tick(0); await flush();
  assert.deepEqual(events, ['retain selected', 'scan selected', 'release selected']);
  worker.retarget({ ...selected });
  worker.wake({ pool: selected.pool, storage: { ...selected.lease.storage } });
  worker.wake({ pool: { ...selected.pool }, storage: selected.lease.storage });
  await flush(); t.mock.timers.tick(6000); await flush();
  assert.deepEqual(events, ['retain selected', 'scan selected', 'release selected']);
  worker.wake({ pool: selected.pool, storage: selected.lease.storage });
  worker.wake({ pool: selected.pool, storage: selected.lease.storage });
  await flush(); t.mock.timers.tick(0); await flush();
  assert.equal(events.filter(event => event === 'scan selected').length, 2);
  worker.retarget(null);
  worker.wake({ pool: selected.pool, storage: selected.lease.storage });
  await flush(); t.mock.timers.tick(6000); await flush();
  assert.equal(events.filter(event => event === 'scan selected').length, 2);
});

test('reentrant cancellation during retain cannot start a replacement before the borrow releases', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = createFrontendRecovery(), events = [], first = target('first', async () => {}, events), last = target('last', async () => {}, events);
  first.pool.retainRecovery = () => {
    events.push('retain first');
    worker.retarget(last);
    return { release() { events.push('release first'); } };
  };
  t.after(() => worker.retarget(null));
  worker.retarget(first); await flush(); t.mock.timers.tick(0); await flush();
  assert.equal(events.includes('scan first'), false);
  assert.ok(events.indexOf('release first') < events.indexOf('retain last'));
  assert.equal(events.filter(event => event === 'retain last').length, 1);
});

for (const boundary of ['reference slice', 'key page']) test(`cancellation releases the ${boundary} yield without waiting for its timer`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = createFrontendRecovery(), events = [], selected = target('selected', async () => {}, events);
  if (boundary === 'key page') selected.lease.storage.draftScopes = async () => { events.push('scan selected'); return { scopes: [], after: 'next' }; };
  t.after(() => worker.retarget(null));
  worker.retarget(selected); await flush();
  assert.deepEqual(events, ['retain selected', 'scan selected']);
  worker.retarget(null); await flush();
  assert.deepEqual(events, ['retain selected', 'scan selected', 'release selected']);
  t.mock.timers.tick(6_000); await flush();
  assert.deepEqual(events, ['retain selected', 'scan selected', 'release selected']);
});
