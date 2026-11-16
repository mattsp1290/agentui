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
    metadata: { hostId: 'host' }, lease: { storage }, frontend: { recover },
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
  t.mock.timers.tick(0); await flush();
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
