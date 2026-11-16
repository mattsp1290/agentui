import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendToolGeneration } from '@agentui/sdk/tools';
import { scope, empty, deferred, fixture } from './controller-fixture.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));

async function generation(id) {
  return (await createFrontendToolGeneration({
    namespace: 'fixture', generation: id, platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) {
      frontendTools.add({
        definition: { name: 'echo', description: id }, decodeInput: value => value,
        async execute() { throw new Error('Execution is not enabled'); },
      });
      return { dispose() {} };
    },
  })).generation;
}

async function capturedFixture(t) {
  const f = fixture(), unblock = [];
  f.behavior.frontendOffers = 'ag-ui-capture-and-bind';
  f.views.set('original-view/host', { ...empty(), route: scope });
  const originalGeneration = await generation('A');
  const source = f.app.frontendGenerations, token = {};
  source.begin(token);
  source.publish(token, { kind: 'ready', generations: [originalGeneration] });
  t.after(async () => {
    for (const release of unblock) release();
    await f.app.dispose();
    await originalGeneration.retire();
  });
  f.behavior.submit = async command => ({
    kind: 'receipt', receipt: { scope, clientCommandId: command.clientCommandId,
      hostOperationId: 'operation', sequence: 1, state: { kind: 'completed' } },
  });
  await f.app.start();
  await f.app.getSnapshot().active.store.send('Original');
  return { ...f, source, token, unblock, original: structuredClone(f.drafts.get('original-view/host/conversation').frontendSends[0]) };
}

function holdNextSave(f) {
  const entered = deferred(), gate = deferred();
  f.unblock.push(gate.resolve);
  let held = true;
  f.behavior.write = async () => {
    if (!held) return;
    held = false;
    entered.resolve();
    await gate.promise;
  };
  return { entered: entered.promise, resolve: gate.resolve, reject: gate.reject };
}

test('explicit old capture release failure stays with its original session', async t => {
  const f = await capturedFixture(t), save = holdNextSave(f);
  const releasing = f.app.releaseCapturedSend(f.app.getSnapshot().capturedSends[0].key);
  await save.entered;
  const closing = f.app.dispose(), restarted = f.app.start();
  await flush();
  assert.equal(f.leases.length, 1);
  assert.equal(f.leases[0].closed, false);
  save.reject(new Error('Only old capture save failed'));
  await Promise.all([releasing, closing, restarted]);
  const state = f.app.getSnapshot();
  assert.equal(state.error, '');
  assert.equal(state.storageFailure, '');
  assert.equal(state.host.kind, 'ready');
  assert.equal(f.leases[0].closed, true);
  assert.equal(f.leases.length, 2);
  await state.active.store.setDraft('Healthy restarted draft');
  const saved = f.drafts.get('original-view/host/conversation');
  assert.equal(saved.draft, 'Healthy restarted draft');
  assert.deepEqual(saved.frontendSends[0].command, f.original.command);
  assert.equal(saved.frontendSends[0].ownerId, f.original.ownerId);
});

test('old refresh publishes nothing after the replacement resets while its authority save drains', async t => {
  const f = await capturedFixture(t), save = holdNextSave(f);
  f.behavior.principalId = 'old-transition';
  f.behavior.wireVersion = 'incompatible-old-session';
  const reconnecting = f.app.reconnect();
  await save.entered;
  const closing = f.app.dispose();
  f.behavior.principalId = 'replacement';
  f.behavior.wireVersion = undefined;
  const acquiring = deferred(), acquired = deferred();
  f.behavior.acquire = async () => { acquired.resolve(); await acquiring.promise; };
  f.unblock.push(acquiring.resolve);
  const restarted = f.app.start();
  const publications = [];
  const unsubscribe = f.app.subscribe(() => publications.push(f.app.getSnapshot()));
  t.after(unsubscribe);
  await flush();
  assert.equal(f.leases.length, 1);
  assert.equal(f.app.getSnapshot().host.kind, 'loading');
  save.resolve();
  await Promise.all([closing, reconnecting, acquired.promise]);
  const beforeAcquisition = publications.slice();
  acquiring.resolve();
  await restarted;
  assert.deepEqual(beforeAcquisition, [], 'The disposed refresh cannot publish during replacement acquisition');
  assert.ok(publications.length > 0);
  for (const state of publications) {
    assert.equal(state.error, '');
    assert.equal(state.storageFailure, '');
    assert.ok(state.host.kind === 'loading' || state.host.kind === 'ready');
    if ('metadata' in state.host) assert.equal(state.host.metadata.principalId, 'replacement');
  }
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
});

test('disposed session cannot send pairing after its authority-reset await', async t => {
  const f = fixture();
  t.after(() => f.app.dispose());
  await f.app.start();
  const pairedCodes = [];
  f.behavior.pair = async code => { pairedCodes.push(code); };
  await f.app.pair('active-code');
  assert.deepEqual(pairedCodes, ['active-code']);
  const pairing = f.app.pair('old-code'), closing = f.app.dispose();
  await Promise.all([pairing, closing]);
  assert.deepEqual(pairedCodes, ['active-code']);
});

test('public pairing cannot send after disposal while a captured journal save is held', async t => {
  const f = await capturedFixture(t), save = holdNextSave(f);
  const pairedCodes = [];
  f.behavior.pair = async code => { pairedCodes.push(code); };
  const pairing = f.app.pair('old-code');
  await save.entered;
  const closing = f.app.dispose(), restarted = f.app.start();
  await flush();
  assert.equal(f.leases.length, 1);
  save.resolve();
  await Promise.all([pairing, closing, restarted]);
  assert.deepEqual(pairedCodes, []);
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
});

for (const updateSource of [false, true]) {
  test(`generation source survives restart ${updateSource ? 'with an update during the old save' : 'without republishing'}`, async t => {
    const f = await capturedFixture(t), save = holdNextSave(f);
    const originalSnapshot = f.source.snapshot();
    const closing = f.app.dispose();
    await save.entered;
    const restarted = f.app.start();
    let expectedSnapshot = originalSnapshot;
    if (updateSource) {
      const replacement = await generation('B');
      t.after(() => replacement.retire());
      expectedSnapshot = { kind: 'ready', generations: [replacement] };
      f.source.publish(f.token, expectedSnapshot);
    }
    assert.equal(f.app.frontendGenerations, f.source);
    assert.equal(f.source.snapshot(), expectedSnapshot);
    assert.equal(f.leases.length, 1);
    save.resolve();
    await Promise.all([closing, restarted]);
    assert.equal(f.app.frontendGenerations, f.source);
    assert.equal(f.source.snapshot(), expectedSnapshot);
    await f.app.getSnapshot().active.store.send('Successor');
    const saved = f.drafts.get('original-view/host/conversation').frontendSends;
    assert.deepEqual(saved[0].command, f.original.command);
    assert.equal(saved[0].ownerId, f.original.ownerId);
    assert.equal(saved[1].ownerId, 'principal');
    assert.equal(saved[1].command.body.frontend.tools[0].definition.description, updateSource ? 'B' : 'A');
    assert.equal(f.app.getSnapshot().error, '');
    assert.equal(f.app.getSnapshot().storageFailure, '');
  });
}

test('disposal clears published active state and disconnects the captured old target synchronously', async t => {
  const f = fixture();
  t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  const store = f.app.getSnapshot().active.store, snapshots = [];
  t.after(f.app.subscribe(() => snapshots.push(f.app.getSnapshot())));
  const closing = f.app.dispose();
  assert.equal(f.feedCloses(), 1);
  assert.equal(store.getSnapshot().connection.kind, 'disconnected');
  assert.ok(snapshots.length > 0);
  assert.ok(snapshots.every(snapshot => snapshot.active === null));
  await closing;
});

for (const failure of ['view read', 'missing conversation', 'catalog', 'connect']) {
  test(`principal refresh ${failure} failure releases only an unfinished active handover`, async t => {
    const f = fixture();
    t.after(() => f.app.dispose());
    f.views.set('original-view/host', { ...empty(), route: scope });
    await f.app.start();
    const store = f.app.getSnapshot().active.store;
    f.behavior.principalId = 'replacement';
    if (failure === 'view read') f.behavior.read = async () => { throw new Error('View read failed'); };
    if (failure === 'missing conversation') f.behavior.agentLookup = () => null;
    if (failure === 'catalog') f.behavior.catalog = async () => { throw new Error('Catalog failed'); };
    if (failure === 'connect') store.connect = async () => { throw new Error('Connect failed'); };
    await f.app.reconnect();
    await flush();
    const active = f.app.getSnapshot().active;
    if (failure === 'view read' || failure === 'missing conversation') {
      assert.equal(active, null);
      await assert.rejects(store.setDraft('Expired owner'), /closed/);
    } else {
      assert.equal(active.store, store);
      await store.setDraft('Retained owner');
      assert.equal(f.drafts.get('original-view/host/conversation').draft, 'Retained owner');
      assert.match(f.app.getSnapshot().error, /failed/);
    }
  });
}

for (const publication of ['disconnect', 'install', 'same-store']) {
  test(`disposal during ${publication} publication prevents the old install from publishing into a replacement`, async t => {
    const f = fixture(), acquiring = deferred();
    let restarted, closing, replacement;
    t.after(async () => { acquiring.resolve(); await restarted; await f.app.dispose(); });
    if (publication === 'same-store') f.views.set('original-view/host', { ...empty(), route: scope });
    await f.app.start();
    const original = f.app.getSnapshot().active, snapshots = [];
    const unsubscribe = f.app.subscribe(() => {
      const state = f.app.getSnapshot();
      if (publication === 'disconnect' ? state.permissionState.reason !== 'Reconnect to refresh permissions.'
        : !state.active || state.active === original) return;
      unsubscribe();
      closing = f.app.dispose();
      f.behavior.acquire = () => acquiring.promise;
      restarted = f.app.start();
      replacement = f.app.getSnapshot();
      t.after(f.app.subscribe(() => snapshots.push(f.app.getSnapshot())));
    });
    t.after(unsubscribe);
    if (publication === 'same-store') await f.app.reconnect();
    else await f.app.open(scope);
    await closing;
    assert.ok(restarted);
    assert.ok(snapshots.every(snapshot => snapshot === replacement));
    assert.equal(f.app.getSnapshot(), replacement);
    acquiring.resolve(); await restarted;
    assert.equal(f.app.getSnapshot().host.kind, 'ready');
  });
}
