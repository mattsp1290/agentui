import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendToolGeneration } from '@agentui/sdk/tools';
import { fixture, scope, empty, deferred } from './controller-fixture.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
test('incompatible same-principal reconnect stops retained polling and persists the original release', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), requests = [];
  f.behavior.frontendOffers = 'ag-ui-capture-and-bind';
  f.views.set('original-view/host', { ...empty(), route: scope });
  f.behavior.binding = async request => { requests.push(request); return { kind: 'pending', id: request.id }; };
  const { generation } = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'A', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'A' }, decodeInput: value => value, execute() { assert.fail('No execution'); } }); return { dispose() {} }; } });
  t.after(async () => { await f.app.dispose(); await generation.retire(); });
  const token = {};
  f.app.frontendGenerations.begin(token); f.app.frontendGenerations.publish(token, { kind: 'ready', generations: [generation] });
  await f.app.start();
  await assert.rejects(f.app.getSnapshot().active.store.send('Original'), /Reply lost/);
  t.mock.timers.tick(0); await flush();
  const original = f.app.getSnapshot().capturedSends[0];
  f.behavior.wireVersion = 'incompatible';
  await f.app.reconnect();
  assert.equal(f.app.getSnapshot().host.kind, 'incompatible');
  const before = requests.length;
  t.mock.timers.tick(2000); await flush();
  assert.equal(requests.length, before);
  assert.deepEqual(f.app.getSnapshot().capturedSends, []);
  const saved = f.drafts.get('original-view/host/conversation').frontendSends[0];
  assert.equal(saved.state, 'unavailable-pending');
  assert.deepEqual(saved.command, original.command);
});

for (const history of ['empty', 'confirmed']) test(`idle ${history} history adds no discovery, loads, writes or publications over multiple intervals`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.app.dispose());
  await f.app.start(); await flush();
  if (history === 'confirmed') {
    f.drafts.set('original-view/host/conversation', { version: 3, image: null, scope, draft: 'Preserved', draftRevision: 1, outbox: [], frontendSends: [
      { ownerId: 'principal', state: 'unavailable-confirmed', command: { version: 2, scope, clientCommandId: 'old', body: { kind: 'send', text: 'Original', frontend: {
        platform: 'desktop', tools: [{ activationId: 'old', definition: { name: 'fixture__echo', description: 'Original' } }] } } } },
    ] });
  }
  const storage = f.leases[0], discover = storage.draftScopes;
  let discoveries = 0, writes = 0, publications = 0;
  storage.draftScopes = (...args) => { discoveries++; return discover(...args); };
  f.behavior.write = async () => { writes++; };
  await f.app.reconnect(); await flush(); t.mock.timers.tick(0); await flush();
  assert.equal(discoveries, 1);
  const before = { discoveries, loads: f.loads.length, writes };
  t.after(f.app.subscribe(() => { publications++; }));
  for (let index = 0; index < 3; index++) { t.mock.timers.tick(2_000); await flush(); t.mock.timers.tick(0); await flush(); }
  assert.deepEqual({ discoveries, loads: f.loads.length, writes }, before);
  assert.equal(publications, 0);
});

for (const ending of ['failure', 'dispose']) test(`derived recovery publication survives synchronous ${ending} in storage discovery`, async t => {
  const f = fixture();
  t.after(() => f.app.dispose());
  await f.app.start(); await flush();
  const original = f.leases[0], snapshots = [];
  let reads = 0, closing;
  original.draftScopes = async () => {
    reads++;
    assert.equal(f.app.getSnapshot().host.kind, 'ready');
    if (ending === 'failure') original.failure(new Error('Discovery failed synchronously'));
    else closing = f.app.dispose();
    return { scopes: [], after: null };
  };
  t.after(f.app.subscribe(() => snapshots.push(f.app.getSnapshot())));
  await f.app.reconnect(); await closing; await flush();
  assert.equal(reads, 1);
  if (ending === 'failure') assert.equal(f.app.getSnapshot().storageFailure, 'Discovery failed synchronously');
  else assert.equal(original.closed, true);
  assert.ok(snapshots.length > 0);
});

async function captured(t) {
  const f = fixture(), gates = [], requests = [];
  f.behavior.frontendOffers = 'ag-ui-capture-and-bind';
  f.views.set('original-view/host', { ...empty(), route: scope });
  f.behavior.binding = async request => { requests.push(request); return { kind: 'pending', id: request.id }; };
  const { generation } = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'A', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'Original' }, decodeInput: value => value,
      execute() { assert.fail('No execution'); } }); return { dispose() {} }; } });
  const token = {}; f.app.frontendGenerations.begin(token); f.app.frontendGenerations.publish(token, { kind: 'ready', generations: [generation] });
  t.after(async () => { for (const gate of gates) gate.resolve(); await f.app.dispose(); await generation.retire(); });
  await f.app.start();
  await assert.rejects(f.app.getSnapshot().active.store.send('Original'), /Reply lost/);
  const original = structuredClone(f.drafts.get('original-view/host/conversation').frontendSends[0]);
  return { ...f, requests, original, gate() { const gate = deferred(); gates.push(gate); return gate; } };
}

test('initial incompatible metadata admits no frontend authority and a later compatible connection opens the saved conversation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), requests = [];
  t.after(() => f.app.dispose());
  f.behavior.wireVersion = 'incompatible'; f.behavior.frontendOffers = 'ag-ui-capture-and-bind';
  f.views.set('original-view/host', { ...empty(), route: scope });
  f.behavior.binding = async request => { requests.push(request); return { kind: 'pending', id: request.id }; };
  await f.app.start();
  assert.equal(f.app.getSnapshot().host.kind, 'incompatible'); assert.equal(f.app.getSnapshot().active, null);
  t.mock.timers.tick(6_000); await flush();
  assert.deepEqual(requests, []); assert.deepEqual(f.submitted, []); assert.deepEqual(f.loads, []);
  f.behavior.wireVersion = undefined; await f.app.reconnect();
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  assert.ok(f.app.getSnapshot().active);
});

test('incompatible changed-principal reconnect persists release for the original owner without notifying either principal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await captured(t);
  f.behavior.wireVersion = 'incompatible'; f.behavior.principalId = 'replacement';
  await f.app.reconnect();
  assert.equal(f.app.getSnapshot().host.kind, 'incompatible'); assert.equal(f.app.getSnapshot().active, null);
  assert.deepEqual(f.app.getSnapshot().capturedSends, []);
  const saved = f.drafts.get('original-view/host/conversation').frontendSends[0];
  assert.deepEqual(saved.command, f.original.command); assert.equal(saved.ownerId, 'principal'); assert.equal(saved.state, 'unavailable-pending');
  t.mock.timers.tick(6_000); await flush();
  assert.deepEqual(f.requests, []);
  assert.equal(f.submitted.length, 1);
});

test('incompatible reconnect aborts a held live binding reply and a late bound reply cannot revive it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await captured(t), held = f.gate(), entered = f.gate();
  f.behavior.binding = async request => { f.requests.push(request); entered.resolve(); return held.promise; };
  t.mock.timers.tick(2_000); await entered.promise;
  f.behavior.wireVersion = 'incompatible';
  await f.app.reconnect();
  const before = structuredClone([...f.drafts]);
  assert.equal(f.app.getSnapshot().host.kind, 'incompatible');
  assert.equal(f.requests.length, 1);
  held.resolve({ kind: 'bound', command: f.original.command, hostOperationId: 'operation', threadId: 'thread',
    run: { conversation: scope, runId: 'run', authority: { kind: 'remote-provider', binding: { namespace: 'provider', installationId: 'installation', opaqueSessionId: 'session' } } } });
  await flush(); t.mock.timers.tick(6_000); await flush();
  assert.deepEqual([...f.drafts], before); assert.deepEqual(f.app.getSnapshot().capturedSends, []); assert.equal(f.requests.length, 1);
});

test('incompatible reconnect preserves the original durable record when release persistence fails', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await captured(t), before = structuredClone([...f.drafts]);
  f.behavior.write = async () => { throw new Error('Release persistence failed'); };
  f.behavior.wireVersion = 'incompatible';
  await f.app.reconnect();
  assert.equal(f.app.getSnapshot().host.kind, 'incompatible');
  assert.match(f.app.getSnapshot().storageFailure, /Release persistence failed/);
  assert.deepEqual([...f.drafts], before);
  t.mock.timers.tick(6_000); await flush(); assert.deepEqual(f.requests, []);
  await f.app.create(); assert.deepEqual(f.created, []);
});

test('dispose and restart drain an incompatible same-principal release before acquiring replacement storage', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await captured(t), entered = f.gate(), saved = f.gate();
  let first = true;
  f.behavior.write = async () => { if (first) { first = false; entered.resolve(); await saved.promise; } };
  f.behavior.wireVersion = 'incompatible';
  const reconnecting = f.app.reconnect(); await entered.promise;
  const closing = f.app.dispose(); f.behavior.wireVersion = undefined;
  const restarted = f.app.start();
  await flush(); assert.equal(f.leases.length, 1); assert.equal(f.leases[0].closed, false);
  const publications = []; t.after(f.app.subscribe(() => publications.push(f.app.getSnapshot())));
  saved.resolve(); await Promise.all([reconnecting, closing, restarted]);
  assert.equal(f.leases.length, 2); assert.equal(f.leases[0].closed, true); assert.equal(f.app.getSnapshot().host.kind, 'ready');
  assert.ok(publications.every(state => state.host.kind !== 'incompatible' && !state.error && !state.storageFailure));
  assert.equal(f.drafts.get('original-view/host/conversation').frontendSends[0].state, 'unavailable-pending');
  assert.deepEqual(f.drafts.get('original-view/host/conversation').frontendSends[0].command, f.original.command);
  assert.ok(f.requests.every(request => request.action === 'unavailable'));
});

test('ordinary permission and row publications do not restart an idle recovery target', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await captured(t), storage = f.leases[0], discover = storage.draftScopes;
  let scans = 0;
  storage.draftScopes = (...args) => { scans++; return discover(...args); };
  await flush(); t.mock.timers.tick(0); await flush();
  const actions = f.app.conversationActions(f.app.getSnapshot().active);
  await actions.permissions.read();
  await assert.rejects(f.app.getSnapshot().active.store.send('Another capture'), /Reply lost/);
  await flush(); t.mock.timers.tick(0); await flush();
  assert.equal(scans, 0);
});

for (const boundary of ['disconnect', 'detached']) test(`principal refresh disposal at ${boundary} publication closes the held store without touching its replacement`, async t => {
  const f = fixture(), acquiring = deferred();
  let closing, restarted;
  t.after(async () => { acquiring.resolve(); await restarted; await f.app.dispose(); });
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start(); const old = f.app.getSnapshot().active.store;
  f.behavior.principalId = 'replacement';
  const unsubscribe = f.app.subscribe(() => {
    const state = f.app.getSnapshot();
    if (state.permissionState.reason !== 'Reconnect to refresh permissions.' || (boundary === 'detached' && state.active !== null)) return;
    unsubscribe(); closing = f.app.dispose(); f.behavior.acquire = () => acquiring.promise; restarted = f.app.start();
  });
  t.after(unsubscribe);
  await f.app.reconnect(); await closing;
  assert.ok(restarted); assert.equal(f.leases[0].closed, true); assert.equal(f.app.getSnapshot().host.kind, 'loading');
  await assert.rejects(old.setDraft('Expired'), /closed/);
  acquiring.resolve(); await restarted;
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  await f.app.getSnapshot().active.store.setDraft('Replacement');
  assert.equal(f.drafts.get('original-view/host/conversation').draft, 'Replacement');
});
