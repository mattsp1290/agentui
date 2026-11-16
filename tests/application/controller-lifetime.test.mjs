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
