import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationController, applicationEnabled } from '../../apps/desktop/dist/application/application-controller.js';

const scope = { hostId: 'host', conversationId: 'conversation' };
const empty = () => ({ version: 1, route: null, pendingCreation: null });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const views = new Map(), drafts = new Map(), leases = [], created = [], submitted = [], cursors = [], unauthorized = [];
  let nextId = 0, hostId = 'host', feedCloses = 0, metadataCalls = 0;
  const behavior = { acquire: async () => {}, create: async () => {}, write: async () => {}, read: async () => {}, listing: async () => ({ ids: [], after: null, unreadable: 0 }),
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
    async metadata() { metadataCalls++; return { hostId, principalId: 'principal', compatibility: { wireVersion: 1, extensionSdkVersion: '0.0.0',
      nativeRuntime: { engine: 'agentui-recorded', version: 'recorded-v1', format: 'agentui-recorded-v1' },
      desiredGitRevision: 'revision', appliedArtifact: { gitRevision: 'revision', artifactId: 'artifact' } } }; },
    async catalog(after) { cursors.push(after); return after === null ? Array.from({ length: 100 }, (_, n) => ({ hostId, conversationId: `c-${n}` })) : []; },
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

test('late writes and draft reports from a replaced owner cannot poison the reopened view', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  f.views.set('restored-view/host', { ...empty(), route: scope });
  await f.app.start();
  const old = f.app.getSnapshot().active, actions = f.app.conversationActions(old);
  const gate = deferred(), entered = deferred();
  f.behavior.write = async () => { entered.resolve(); await gate.promise; };
  const pending = old.store.setDraft('Old edit');
  const failed = assert.rejects(pending, /Old write failed/);
  await entered.promise;
  await f.app.reopenView('restored-view');
  gate.reject(new Error('Old write failed'));
  await failed;
  actions.reportDraftFailure(new Error('Late React catch'));
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
