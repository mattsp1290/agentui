import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationController, applicationEnabled } from '../../apps/desktop/dist/application/application-controller.js';

const scope = { hostId: 'host', conversationId: 'conversation' };
const empty = () => ({ version: 1, route: null, pendingCreation: null });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const views = new Map(), drafts = new Map(), leases = [], created = [], submitted = [], cursors = [], unauthorized = [];
  let nextId = 0, hostId = 'host', feedCloses = 0, metadataCalls = 0;
  const behavior = { catalog: async () => {}, metadata: async () => {}, acquire: async () => {}, create: async () => {}, write: async () => {}, read: async () => {}, listing: async () => ({ ids: [], after: null, unreadable: 0 }),
    submit: async () => { throw new Error('Reply lost'); } };
  function lease(viewId, failure) {
    const owner = { viewId, failure, closed: false,
      async readView(host) { await behavior.read(); return views.get(`${viewId}/${host}`) ?? empty(); },
      async saveView(host, value) { if (owner.closed) throw new Error('Closed owner'); views.set(`${viewId}/${host}`, value); },
      savedViews: (...args) => behavior.listing(...args),
      drafts(onFailure) {
        return { load: async selected => drafts.get(`${viewId}/${selected.hostId}/${selected.conversationId}`) ?? null,
          async save(value) {
            try { await behavior.write(); if (owner.closed) throw new Error('Closed owner'); drafts.set(`${viewId}/${value.scope.hostId}/${value.scope.conversationId}`, value); }
            catch (error) { onFailure(error); throw error; }
          } };
      },
      close() { owner.closed = true; } };
    leases.push(owner);
    return owner;
  }
  const connection = {
    async pair() {},
    async metadata() { metadataCalls++; await behavior.metadata(); return { hostId, principalId: 'principal', compatibility: { wireVersion: 1, extensionSdkVersion: '0.0.0',
      nativeRuntime: { engine: 'agentui-recorded', version: 'recorded-v1', format: 'agentui-recorded-v1' },
      desiredGitRevision: 'revision', appliedArtifact: { gitRevision: 'revision', artifactId: 'artifact' } } }; },
    async catalog(after) { const supplied = await behavior.catalog(after); cursors.push(after); return supplied ?? (after === null ? Array.from({ length: 100 }, (_, n) => ({ hostId, conversationId: `c-${n}` })) : []); },
    async create(value) { created.push(value); await behavior.create(); return value; },
    async reconcile() { return null; },
    conversation(selected) { return { scope: selected,
      async submit(command) { submitted.push(command); return behavior.submit(command); },
      async receipt() { return null; },
      watch() { return { ended: new Promise(() => {}), close() { feedCloses++; } }; } }; },
  };
  const app = createApplicationController({ createConnection: options => { unauthorized.push(options.onUnauthorized); return connection; },
    ownedViewStorage: { open: async failure => { await behavior.acquire(); return lease('original-view', failure); }, reopen: async (id, failure) => lease(id, failure) }, createId: () => `id-${++nextId}` });
  return { app, views, drafts, leases, created, submitted, cursors, unauthorized, behavior,
    host: value => { hostId = value; }, feedCloses: () => feedCloses, metadataCalls: () => metadataCalls };
}

test('creation recovery persists and reuses the original identity before sending', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  await f.app.start();
  f.behavior.create = async () => {
    assert.deepEqual(f.views.get('original-view/host').pendingCreation, f.created.at(-1));
    throw new Error('Create reply lost');
  };
  await f.app.create();
  assert.deepEqual(f.app.getSnapshot().saved.pendingCreation, { hostId: 'host', conversationId: 'id-1' });
  await f.app.create();
  assert.equal(f.created.length, 1);
  f.behavior.create = async () => {};
  await f.app.recoverCreation();
  assert.deepEqual(f.created, [f.created[0], f.created[0]]);
  assert.equal(f.app.getSnapshot().active.scope.conversationId, 'id-1');
  assert.equal(f.app.getSnapshot().saved.pendingCreation, null);
});

test('a synchronous storage failure blocks actions captured before failure', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  const actions = f.app.conversationActions(f.app.getSnapshot().active);
  let commands = 0;
  f.leases[0].failure(new Error('Storage unavailable'));
  assert.equal(applicationEnabled(f.app.getSnapshot()), false);
  await actions.submit(async () => { commands++; return { kind: 'rejected', reason: 'should not run' }; });
  await f.app.create();
  await f.app.reconnect();
  assert.equal(commands, 0);
  assert.equal(f.created.length, 0);
  assert.equal(f.metadataCalls(), 1);
  assert.match(f.app.getSnapshot().storageFailure, /Storage unavailable/);
});

test('late writes from a replaced storage owner cannot poison the reopened view', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  f.views.set('restored-view/host', { ...empty(), route: scope });
  await f.app.start();
  const old = f.app.getSnapshot().active;
  const gate = deferred(), entered = deferred();
  f.behavior.write = async () => { entered.resolve(); await gate.promise; };
  const pending = old.store.setDraft('Old edit');
  const failed = assert.rejects(pending, /Old write failed/);
  await entered.promise;
  await f.app.reopenView('restored-view');
  gate.reject(new Error('Old write failed'));
  await failed;
  assert.equal(f.app.getSnapshot().storageFailure, '');
  assert.equal(f.app.getSnapshot().active.viewId, 'restored-view');
  assert.equal(f.leases[0].closed, true);
  f.behavior.write = async () => {};
  await f.app.getSnapshot().active.store.setDraft('New edit');
  assert.equal(f.drafts.get('restored-view/host/conversation').draft, 'New edit');
});

test('busy actions are ignored and original commands and newer drafts survive reopening', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  let active = f.app.getSnapshot().active;
  await active.store.setDraft('Original message');
  const gate = deferred(), entered = deferred();
  f.behavior.submit = async command => {
    assert.equal(f.drafts.get('original-view/host/conversation').outbox[0].command.clientCommandId, command.clientCommandId);
    entered.resolve(); await gate.promise;
  };
  const actions = f.app.conversationActions(active);
  const sending = actions.submit(() => active.store.send());
  await entered.promise;
  await actions.submit(() => active.store.send());
  await active.store.setDraft('Newer draft');
  gate.reject(new Error('Reply lost'));
  await sending;
  assert.equal(f.submitted.length, 1);
  const original = f.submitted[0];
  f.app.dispose();
  await f.app.start();
  active = f.app.getSnapshot().active;
  assert.equal(active.viewId, 'original-view');
  assert.equal(active.store.getSnapshot().draft, 'Newer draft');
  assert.deepEqual(active.store.getSnapshot().outbox[0].command, original);
  f.behavior.submit = async () => ({ kind: 'rejected', reason: 'Still unknown' });
  await f.app.conversationActions(active).submit(() => active.store.retry(original.clientCommandId));
  assert.deepEqual(f.submitted[1], original);
  assert.equal(active.store.getSnapshot().outbox.length, 1);
  assert.match(f.app.getSnapshot().error, /Still unknown/);
});

test('listing corrupt foreign views remains nonfatal and pagination reads the current cursor', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.behavior.listing = async () => ({ ids: ['good-view'], unreadable: 1, after: null });
  await f.app.start();
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
  assert.match(f.app.getSnapshot().savedViewNotice, /1 saved views/);
  await f.app.moreConversations();
  await f.app.moreConversations();
  assert.deepEqual(f.cursors, [null, 'c-99']);
  assert.equal(f.app.getSnapshot().catalog.items.length, 100);
  f.behavior.listing = async () => { throw new Error('Unreadable listing'); };
  await f.app.reconnect();
  assert.equal(f.app.getSnapshot().storageFailure, '');
  assert.match(f.app.getSnapshot().savedViewNotice, /could not be listed/);
});

test('own corrupt view blocks commands; a new host clears the old active conversation', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  const old = f.app.getSnapshot().active;
  f.host('replacement-host');
  await f.app.reconnect();
  assert.equal(f.app.getSnapshot().active, null);
  assert.equal(old.store.getSnapshot().connection.kind, 'disconnected');
  f.behavior.read = async () => { throw new Error('Own saved view corrupt'); };
  await f.app.reconnect();
  assert.match(f.app.getSnapshot().storageFailure, /Own saved view corrupt/);
  await f.app.create();
  assert.equal(f.created.length, 0);
});


test('a disposed startup releases its late storage lease and ignores old connection callbacks', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const gate = deferred();
  f.behavior.acquire = () => gate.promise;
  const firstStart = f.app.start();
  f.app.dispose();
  f.behavior.acquire = async () => {};
  await f.app.start();
  gate.resolve();
  await firstStart;
  assert.equal(f.leases[0].closed, false);
  assert.equal(f.leases[1].closed, true);
  f.unauthorized[0]();
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
  f.unauthorized[1]();
  assert.equal(f.app.getSnapshot().host.kind, 'unpaired');
  await f.app.create();
  assert.equal(f.created.length, 0);
  assert.equal(f.submitted.length, 0);
});

test('failed reopening refuses view mutations and reconnect preserves creation recovery', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const original = { ...empty(), route: scope };
  const restored = { ...empty(), pendingCreation: { hostId: 'host', conversationId: 'pending-restored' } };
  f.views.set('original-view/host', original);
  f.views.set('restored-view/host', restored);
  f.behavior.listing = async () => ({ ids: ['restored-view'], unreadable: 1, after: 'next-page' });
  await f.app.start();
  f.behavior.metadata = async () => { throw new Error('Metadata temporarily unavailable'); };
  await f.app.reopenView('restored-view');
  assert.match(f.app.getSnapshot().error, /Metadata temporarily unavailable/);
  assert.equal(applicationEnabled(f.app.getSnapshot()), false);
  assert.deepEqual(f.app.getSnapshot().saved, empty());
  assert.deepEqual(f.app.getSnapshot().catalog, { items: [], after: null });
  assert.deepEqual(f.app.getSnapshot().savedViews, { items: [], after: null });
  assert.equal(f.app.getSnapshot().savedViewNotice, '');
  assert.equal(f.app.getSnapshot().active, null);
  for (const action of [() => f.app.open(scope), () => f.app.create(), () => f.app.recoverCreation()]) {
    await action();
    assert.notEqual(f.app.getSnapshot().error, '');
    assert.deepEqual(f.views.get('restored-view/host'), restored);
    assert.deepEqual(f.views.get('original-view/host'), original);
    assert.equal(f.created.length, 0);
  }
  f.behavior.metadata = async () => {};
  await f.app.reconnect();
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
  assert.deepEqual(f.app.getSnapshot().saved, restored);
  await f.app.recoverCreation();
  assert.deepEqual(f.created, [restored.pendingCreation]);
  assert.equal(f.app.getSnapshot().active.viewId, 'restored-view');
  assert.deepEqual(f.app.getSnapshot().active.scope, restored.pendingCreation);
  assert.equal(f.views.get('restored-view/host').pendingCreation, null);
});

test('a host change without an active conversation replaces the loaded recovery record', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const original = { ...empty(), pendingCreation: scope };
  f.views.set('original-view/host', original);
  f.behavior.listing = async () => ({ ids: ['old-host-view'], unreadable: 1, after: 'old-page' });
  await f.app.start();
  assert.equal(f.app.getSnapshot().active, null);
  f.host('replacement-host');
  const entered = deferred(), loading = deferred();
  f.behavior.read = async () => { entered.resolve(); await loading.promise; };
  const reconnecting = f.app.reconnect();
  await entered.promise;
  try {
    assert.equal(applicationEnabled(f.app.getSnapshot()), false);
    assert.deepEqual(f.app.getSnapshot().saved, empty());
    assert.deepEqual(f.app.getSnapshot().savedViews, { items: [], after: null });
    assert.equal(f.app.getSnapshot().savedViewNotice, '');
  } finally { loading.resolve(); await reconnecting; }
  await f.app.recoverCreation();
  assert.equal(f.created.length, 0);
  await f.app.create();
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].hostId, 'replacement-host');
  assert.deepEqual(f.views.get('original-view/host'), original);
});


test('a storage acquisition failure stops the loading status and blocks commands', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.behavior.acquire = async () => { throw new Error('Storage cannot be owned'); };
  await f.app.start();
  assert.equal(f.app.getSnapshot().host.kind, 'unavailable');
  assert.equal(applicationEnabled(f.app.getSnapshot()), false);
  assert.match(f.app.getSnapshot().storageFailure, /Storage cannot be owned/);
});

test('a startup catalog failure keeps the ready host enabled and reconnect clears the error', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.behavior.catalog = async () => { throw new Error('Catalog temporarily unavailable'); };
  await f.app.start();
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
  assert.match(f.app.getSnapshot().error, /Catalog temporarily unavailable/);
  f.behavior.catalog = async () => {};
  await f.app.reconnect();
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
  assert.equal(f.app.getSnapshot().error, '');
  assert.equal(f.app.getSnapshot().catalog.items.length, 100);
});

for (const entry of ['start', 'reconnect', 'pair', 'reopenView']) {
  test(`a saved-view read failure during ${entry} ends loading and blocks commands`, async t => {
    const f = fixture(); t.after(() => f.app.dispose());
    if (entry !== 'start') await f.app.start();
    f.behavior.read = async () => { throw new Error('Saved view cannot be read'); };
    await f.app[entry]('restored-view');
    assert.equal(f.app.getSnapshot().host.kind, 'unavailable');
    assert.equal(applicationEnabled(f.app.getSnapshot()), false);
    assert.match(f.app.getSnapshot().storageFailure, /Saved view cannot be read/);
    await f.app.create();
    assert.equal(f.created.length, 0);
  });
}

test('a late saved-view read failure cannot change a replacement session', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  await f.app.start();
  const entered = deferred(), reading = deferred();
  f.behavior.read = async () => { entered.resolve(); await reading.promise; };
  const refreshing = f.app.reconnect();
  await entered.promise;
  f.app.dispose();
  f.behavior.read = async () => {};
  await f.app.start();
  const replacement = f.app.getSnapshot();
  reading.reject(new Error('Old saved view cannot be read'));
  await refreshing;
  assert.strictEqual(f.app.getSnapshot(), replacement);
  assert.equal(applicationEnabled(replacement), true);
  assert.equal(replacement.storageFailure, '');
  assert.equal(replacement.error, '');
});


test('confirmed creation preserves expanded catalog pages and later paging does not duplicate it', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const pages = Array.from({ length: 210 }, (_, index) => ({ hostId: 'host', conversationId: `c-${String(index).padStart(3, '0')}` }));
  f.behavior.catalog = async after => after === null ? pages.slice(0, 100)
    : after === 'c-099' ? pages.slice(100, 200) : [...pages.slice(200), f.created[0]];
  await f.app.start();
  await f.app.moreConversations();
  assert.equal(f.app.getSnapshot().catalog.items.length, 200);
  const cursor = f.app.getSnapshot().catalog.after;
  await f.app.create();
  assert.equal(f.app.getSnapshot().catalog.items.length, 201);
  assert.equal(f.app.getSnapshot().catalog.items[0].conversationId, f.created[0].conversationId);
  assert.equal(f.app.getSnapshot().catalog.after, cursor);
  assert.deepEqual(f.cursors, [null, 'c-099']);
  await f.app.moreConversations();
  assert.equal(f.app.getSnapshot().catalog.items.length, 211);
  assert.equal(f.app.getSnapshot().catalog.items.filter(scope => scope.conversationId === f.created[0].conversationId).length, 1);
  assert.equal(f.app.getSnapshot().catalog.after, null);
});
