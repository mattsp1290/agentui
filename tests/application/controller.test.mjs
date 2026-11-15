import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceError } from '@agentui/contracts/service';
import { CLAUDE_SDK_RUNTIMES, CODEX_RUNTIME, CODEX_SDK_RUNTIME, PI_RUNTIME, RECORDED_RUNTIME } from '@agentui/contracts/compatibility';
import { createApplicationController, applicationEnabled } from '../../apps/desktop/dist/application/application-controller.js';

const scope = { hostId: 'host', conversationId: 'conversation' };
const empty = () => ({ version: 2, route: null, pendingCreation: null });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  const selected = [], captured = new Map(), views = new Map(), drafts = new Map(), leases = [], created = [], submitted = [], cursors = [], unauthorized = [], feeds = [];
  let nextId = 0, hostId = 'host', feedCloses = 0, metadataCalls = 0;
  const behavior = { agents: null, runtime: RECORDED_RUNTIME, defaultId: 'default', agentLookup: null, pair: async () => {}, catalog: async () => {}, metadata: async () => {}, acquire: async () => {}, create: async () => {}, write: async () => {}, read: async () => {}, listing: async () => ({ ids: [], after: null, unreadable: 0 }),
    search: async () => ({ items: [], after: null }), submit: async () => { throw new Error('Reply lost'); } };
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
  const descriptor = (id = behavior.defaultId, runtime = behavior.runtime) => ({ id, label: id, runtime, commands: ['send', 'cancel', 'approve'], availability: { kind: 'ready' } });
  const connection = {
    pair: code => behavior.pair(code),
    async metadata() { metadataCalls++; await behavior.metadata(); return { hostId, principalId: 'principal', agents: behavior.agents ?? [descriptor(), descriptor('other', CODEX_SDK_RUNTIME)], defaultAgentId: behavior.defaultId, compatibility: { wireVersion: 2, extensionSdkVersion: '0.0.0',
      nativeRuntime: behavior.runtime,
      desiredGitRevision: 'revision', appliedArtifact: { gitRevision: 'revision', artifactId: 'artifact' } } }; },
    async catalog(after) { const supplied = await behavior.catalog(after); cursors.push(after); return (supplied ?? (after === null ? Array.from({ length: 100 }, (_, n) => ({ hostId, conversationId: `c-${n}` })) : [])).map(scope => ({ scope, preview: null })); },
    async create(value, agentId) { created.push(value); selected.push(agentId); captured.set(value.conversationId, descriptor(agentId)); await behavior.create(); return value; },
    async conversationAgent(value) { return behavior.agentLookup ? behavior.agentLookup(value) : captured.get(value.conversationId) ?? descriptor(); },
    search: (...args) => behavior.search(...args),
    async reconcile() { return null; },
    conversation(selected) { return { scope: selected,
      async submit(command) { submitted.push(command); return behavior.submit(command); },
      async receipt() { return null; },
      watch(request, receive) { const end = deferred(); const feed = { scope: selected, receive, ended: end.promise, finish: end.resolve, close() { feedCloses++; } }; feeds.push(feed); return feed; } }; },
  };
  const app = createApplicationController({ createConnection: options => { unauthorized.push(options.onUnauthorized); return connection; },
    ownedViewStorage: { open: async failure => { await behavior.acquire(); return lease('original-view', failure); }, reopen: async (id, failure) => lease(id, failure) }, createId: () => `id-${++nextId}` });
  return { app, views, drafts, selected, captured, descriptor, leases, created, submitted, cursors, unauthorized, feeds, behavior,
    host: value => { hostId = value; }, feedCloses: () => feedCloses, metadataCalls: () => metadataCalls };
}

test('background search leaves active state usable and rejects stale, foreign and nonadvancing pages', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  const active = f.app.getSnapshot().active;
  await active.store.setDraft('Unsent during search');
  const gate = deferred(), signal = new AbortController();
  f.behavior.search = () => gate.promise;
  const pending = f.app.search('garden', null, signal.signal);
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
  assert.equal(f.app.getSnapshot().active, active);
  signal.abort();
  gate.resolve({ items: [], after: 'last-scanned' });
  await assert.rejects(pending, /Search connection changed/);
  const live = new AbortController().signal;
  f.behavior.search = async () => ({ items: [], after: 'a' });
  await assert.rejects(f.app.search('garden', 'a', live), /did not advance/);
  f.behavior.search = async () => ({ items: [], after: '😀' });
  assert.deepEqual(await f.app.search('garden', '\uE000', live), { items: [], after: '😀' });
  f.behavior.search = async () => ({ items: [{ scope: { ...scope, hostId: 'foreign' }, preview: null, excerpt: null }], after: null });
  await assert.rejects(f.app.search('garden', null, live), /another host/);
  const replaced = deferred();
  f.behavior.search = () => replaced.promise;
  const outdated = f.app.search('garden', null, live);
  f.host('new-host');
  await f.app.reconnect();
  replaced.resolve({ items: [], after: null });
  await assert.rejects(outdated, /Search connection changed/);
  f.behavior.search = async () => { throw new ServiceError('unauthorized', 'Revoked'); };
  await assert.rejects(f.app.search('garden', null, live), /Revoked/);
  assert.equal(f.app.getSnapshot().host.kind, 'unpaired');
  assert.equal(f.drafts.get('original-view/host/conversation').draft, 'Unsent during search');
});

test('creation recovery persists and reuses the original identity before sending', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  await f.app.start();
  f.behavior.create = async () => {
    assert.deepEqual(f.views.get('original-view/host').pendingCreation, { scope: f.created.at(-1), agentId: f.selected.at(-1) });
    throw new Error('Create reply lost');
  };
  await f.app.create();
  assert.deepEqual(f.app.getSnapshot().saved.pendingCreation, { scope: { hostId: 'host', conversationId: 'id-1' }, agentId: 'default' });
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
  const restored = { ...empty(), pendingCreation: { scope: { hostId: 'host', conversationId: 'pending-restored' }, agentId: 'default' } };
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
  assert.deepEqual(f.created, [restored.pendingCreation.scope]);
  assert.equal(f.app.getSnapshot().active.viewId, 'restored-view');
  assert.deepEqual(f.app.getSnapshot().active.scope, restored.pendingCreation.scope);
  assert.equal(f.views.get('restored-view/host').pendingCreation, null);
});

test('a host change without an active conversation replaces the loaded recovery record', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const original = { ...empty(), pendingCreation: { scope, agentId: 'default' } };
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
  assert.equal(f.app.getSnapshot().catalog.items[0].scope.conversationId, f.created[0].conversationId);
  assert.equal(f.app.getSnapshot().catalog.after, cursor);
  assert.deepEqual(f.cursors, [null, 'c-099']);
  await f.app.moreConversations();
  assert.equal(f.app.getSnapshot().catalog.items.length, 211);
  assert.equal(f.app.getSnapshot().catalog.items.filter(entry => entry.scope.conversationId === f.created[0].conversationId).length, 1);
  assert.equal(f.app.getSnapshot().catalog.after, null);
});


for (const operation of ['metadata', 'catalog', 'create']) {
  test(`a revoked ${operation} request keeps the feed-expiry explanation`, async t => {
    const f = fixture(); t.after(() => f.app.dispose());
    f.views.set('original-view/host', { ...empty(), route: scope });
    await f.app.start();
    const active = f.app.getSnapshot().active;
    f.unauthorized[0]();
    const explanation = f.app.getSnapshot().error;
    assert.match(explanation, /previous access may have been revoked/);
    await f.app.reconnect();
    assert.equal(applicationEnabled(f.app.getSnapshot()), true);
    f.behavior[operation] = async () => {
      f.unauthorized[0]();
      throw new ServiceError('unauthorized', 'Pair this device with the host');
    };
    await (operation === 'create' ? f.app.create() : f.app.reconnect());
    const snapshot = f.app.getSnapshot();
    assert.equal(snapshot.host.kind, 'unpaired');
    assert.equal(snapshot.error, explanation);
    assert.equal(snapshot.busy, false);
    assert.equal(applicationEnabled(snapshot), false);
    assert.equal(active.store.getSnapshot().connection.kind, 'disconnected');
  });
}

for (const reason of ['Invalid pairing code', 'Pairing code expired']) {
  test(`a rejected pairing shows ${reason} and can be retried`, async t => {
    const f = fixture(); t.after(() => f.app.dispose());
    f.behavior.metadata = async () => {
      f.unauthorized[0]();
      throw new ServiceError('unauthorized', 'Pair this device with the host');
    };
    await f.app.start();
    assert.equal(f.app.getSnapshot().host.kind, 'unpaired');
    const calls = f.metadataCalls();
    f.behavior.pair = async () => { throw new ServiceError('unauthorized', reason); };
    await f.app.pair('expired-or-invalid');
    assert.equal(f.app.getSnapshot().error, reason);
    assert.equal(f.app.getSnapshot().host.kind, 'unpaired');
    assert.equal(f.app.getSnapshot().busy, false);
    assert.equal(f.metadataCalls(), calls);
    f.behavior.pair = async () => {};
    f.behavior.metadata = async () => {};
    await f.app.pair('valid');
    assert.equal(applicationEnabled(f.app.getSnapshot()), true);
    assert.equal(f.app.getSnapshot().error, '');
  });
}

test('a successful pairing followed by revoked metadata uses the revocation explanation', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  await f.app.start();
  f.behavior.metadata = async () => {
    f.unauthorized[0]();
    throw new ServiceError('unauthorized', 'Pair this device with the host');
  };
  await f.app.pair('valid');
  assert.equal(f.app.getSnapshot().host.kind, 'unpaired');
  assert.match(f.app.getSnapshot().error, /previous access may have been revoked/);
  assert.equal(applicationEnabled(f.app.getSnapshot()), false);
});

test('an initial metadata failure ends loading without enabling commands', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.behavior.metadata = async () => { throw new Error('Host cannot be reached'); };
  await f.app.start();
  assert.equal(f.app.getSnapshot().host.kind, 'unavailable');
  assert.equal(f.app.getSnapshot().error, 'Host cannot be reached');
  assert.equal(applicationEnabled(f.app.getSnapshot()), false);
  assert.equal(f.app.getSnapshot().busy, false);
});

test('a native rejected receipt is explained to the user without repeating the request', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  f.behavior.submit = async command => ({ kind: 'receipt', receipt: { scope,
    clientCommandId: command.clientCommandId, hostOperationId: 'native-refusal', sequence: 1,
    state: { kind: 'rejected', reason: 'Codex requires login before this request can start.' } } });
  await f.app.start();
  const target = f.app.getSnapshot().active;
  await target.store.setDraft('My first message');
  await f.app.conversationActions(target).submit(() => target.store.send());
  assert.match(f.app.getSnapshot().error, /Codex requires login/);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.app.getSnapshot().busy, false);
});

async function openCommands(t, runtime = RECORDED_RUNTIME) {
  const f = fixture(); t.after(() => f.app.dispose());
  f.behavior.runtime = runtime;
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  await deliver(f);
  const target = f.app.getSnapshot().active;
  return { ...f, target, actions: f.app.conversationActions(target) };
}
async function deliver(f, domain = { messages: [], currentRun: null }) {
  const feed = f.feeds.at(-1);
  await feed.receive({ kind: 'snapshot', snapshot: { scope: feed.scope, projectionVersion: 1,
    cursor: (f.app.getSnapshot().active.store.getSnapshot().cursor ?? -1) + 1,
    document: { domain, decisions: {}, receipts: {} } } });
  assert.equal(f.app.getSnapshot().active.store.getSnapshot().connection.kind, 'connected');
}
function resultFor(command, state) {
  return { kind: 'receipt', receipt: { scope: command.scope, clientCommandId: command.clientCommandId,
    hostOperationId: 'operation', sequence: 1, state } };
}

for (const outcome of ['admission-rejected', 'rejected', 'uncertain', 'accepted', 'completed', 'pending', 'not-dispatched']) {
  test(`SDK commands return actual ${outcome} outcome and retain the composer draft`, async t => {
    const f = await openCommands(t);
    await f.target.store.setDraft('review prompt');
    let expected;
    f.behavior.submit = async command => {
      expected = outcome === 'admission-rejected' ? { kind: 'rejected', reason: 'Admission refused' }
        : resultFor(command, ['rejected', 'uncertain', 'not-dispatched'].includes(outcome) ? { kind: outcome, reason: 'Host reason' } : { kind: outcome });
      return expected;
    };
    assert.deepEqual(await f.actions.commands.send('review prompt'), expected);
    assert.deepEqual(f.submitted[0].body, { kind: 'send', text: 'review prompt' });
    assert.equal(f.target.store.getSnapshot().draft, 'review prompt');
    assert.equal(f.app.getSnapshot().error, outcome === 'admission-rejected' ? 'Admission refused' : outcome === 'rejected' ? 'Host reason' : '');
    assert.equal(f.app.getSnapshot().busy, false);
  });
}

for (const unauthorized of [false, true]) {
  test(`SDK rejects ${unauthorized ? 'authorization' : 'transport'} failures while the UI submission stays caught`, async t => {
    for (const sdk of [true, false]) {
      const f = await openCommands(t);
      const failure = unauthorized ? new ServiceError('unauthorized', 'Access denied') : new Error('Transport lost');
      f.behavior.submit = async () => { throw failure; };
      if (sdk) await assert.rejects(f.actions.commands.send('prompt'), error => error === failure);
      else { await f.target.store.setDraft('prompt'); await f.actions.submit(() => f.target.store.send()); }
      assert.match(f.app.getSnapshot().error, unauthorized ? /previous access may have been revoked/ : /Transport lost/);
      assert.equal(f.app.getSnapshot().busy, false);
      assert.equal(f.submitted.length, 1);
      assert.equal(f.target.store.getSnapshot().outbox.length, 1);
      if (unauthorized) assert.equal(f.app.getSnapshot().host.kind, 'unpaired');
    }
  });
}

test('SDK busy refusal does not persist another command or release the running operation', async t => {
  const f = await openCommands(t), entered = deferred(), reply = deferred();
  f.behavior.submit = async command => { entered.resolve(); await reply.promise; return resultFor(command, { kind: 'accepted' }); };
  const sending = f.actions.commands.send('first');
  await entered.promise;
  await assert.rejects(f.actions.commands.send('second'), /operation is in progress/);
  assert.equal(f.app.getSnapshot().busy, true);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.target.store.getSnapshot().outbox.length, 1);
  reply.resolve(); await sending;
  assert.equal(f.app.getSnapshot().busy, false);
});

for (const replacement of ['conversation', 'view', 'session']) {
  test(`SDK captured commands refuse a replacement ${replacement} before storage or dispatch`, async t => {
    const f = await openCommands(t);
    if (replacement === 'conversation') await f.app.open({ ...scope, conversationId: 'other' });
    if (replacement === 'view') { f.views.set('restored-view/host', { ...empty(), route: scope }); await f.app.reopenView('restored-view'); }
    if (replacement === 'session') { f.app.dispose(); await f.app.start(); }
    const replacementState = f.app.getSnapshot();
    const records = structuredClone([...f.drafts]);
    for (const invoke of [() => f.actions.commands.send('old'), () => f.actions.commands.approve('decision', 'accept'), () => f.actions.commands.cancel('run')]) {
      await assert.rejects(invoke());
    }
    assert.deepEqual([...f.drafts], records);
    assert.equal(f.submitted.length, 0);
    assert.equal(f.target.store.getSnapshot().outbox.length, 0);
    if (replacement === 'session') assert.strictEqual(f.app.getSnapshot(), replacementState);
  });
}

for (const blocked of ['disconnected', 'feed-ended', 'storage', 'revoked', 'incompatible']) {
  test(`SDK ${blocked} refusal persists and sends nothing`, async t => {
    const f = await openCommands(t);
    if (blocked === 'disconnected') f.target.store.disconnect();
    if (blocked === 'feed-ended') { f.feeds.at(-1).finish({ kind: 'failed', reason: 'Lost feed' }); await Promise.resolve(); }
    if (blocked === 'storage') f.leases[0].failure(new Error('Storage unavailable'));
    if (blocked === 'revoked') f.unauthorized[0]();
    if (blocked === 'incompatible') { f.behavior.runtime = { engine: 'unknown', version: '1', format: 'unknown' }; await f.app.reconnect(); }
    const records = structuredClone([...f.drafts]);
    for (const invoke of [() => f.actions.commands.send('blocked'), () => f.actions.commands.approve('decision', 'accept'), () => f.actions.commands.cancel('run')]) {
      await assert.rejects(invoke());
    }
    assert.deepEqual([...f.drafts], records);
    assert.equal(f.submitted.length, 0);
    assert.equal(f.app.getSnapshot().busy, false);
  });
}

for (const runtime of [CODEX_RUNTIME, CODEX_SDK_RUNTIME, CLAUDE_SDK_RUNTIMES.sonnet, PI_RUNTIME]) {
  for (const state of ['running', 'stopping', 'incomplete']) {
    test(`SDK ${runtime.engine} ${state} response blocks send while approval and cancel stay usable`, async t => {
      const f = await openCommands(t, runtime);
      const currentRun = state === 'incomplete' ? null : state === 'running' ? { kind: 'running', runId: 'run' }
        : { kind: 'stopping', runId: 'run', clientCommandId: 'cancel-id' };
      await deliver(f, { currentRun, messages: state === 'incomplete' ? [{ messageId: 'partial', revision: 1, role: 'assistant', text: 'partial', complete: false }] : [] });
      f.behavior.submit = async command => resultFor(command, { kind: 'accepted' });
      await assert.rejects(f.actions.commands.send('wait'), /current response/);
      assert.equal(f.drafts.size, 0);
      await f.actions.commands.approve('pending', 'accept');
      await f.actions.commands.cancel('run');
      assert.deepEqual(f.submitted.map(command => command.body), [
        { kind: 'approve', pendingId: 'pending', choiceId: 'accept' }, { kind: 'cancel', runId: 'run' },
      ]);
      await deliver(f, { currentRun: { kind: 'ended', runId: 'run', outcome: 'completed' }, messages: [] });
      await f.actions.commands.send('next');
      assert.deepEqual(f.submitted.at(-1).body, { kind: 'send', text: 'next' });
    });
  }
}

test('UI recovery can retry a retained command while disconnected', async t => {
  const f = await openCommands(t);
  await assert.rejects(f.actions.commands.send('retained'), /Reply lost/);
  const [entry] = f.target.store.getSnapshot().outbox;
  f.target.store.disconnect();
  f.behavior.submit = async command => resultFor(command, { kind: 'accepted' });
  await f.actions.submit(() => f.target.store.retry(entry.command.clientCommandId));
  assert.deepEqual(f.submitted, [entry.command, entry.command]);
  assert.deepEqual(f.target.store.getSnapshot().outbox, []);
});


test('SDK send refuses missing and non-string text without submitting the composer draft', async t => {
  const f = await openCommands(t);
  await f.target.store.setDraft('Private unfinished draft');
  const records = structuredClone([...f.drafts]);
  await assert.rejects(f.actions.commands.send(), /explicit message/);
  for (const text of [undefined, null, 42, {}, '']) await assert.rejects(f.actions.commands.send(text));
  assert.deepEqual([...f.drafts], records);
  assert.equal(f.target.store.getSnapshot().draft, 'Private unfinished draft');
  assert.deepEqual(f.target.store.getSnapshot().outbox, []);
  assert.equal(f.submitted.length, 0);
});

test('lost selected creation survives reload and changed default without choosing a new agent', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  await f.app.start();
  f.behavior.create = async () => { throw new Error('Create reply lost'); };
  await f.app.create('other');
  const pending = f.app.getSnapshot().saved.pendingCreation;
  assert.equal(pending.agentId, 'other');
  f.app.dispose();
  f.behavior.defaultId = 'new-default';
  f.behavior.create = async () => {};
  await f.app.start();
  await f.app.recoverCreation();
  assert.deepEqual(f.selected, ['other', 'other']);
  assert.deepEqual(f.created, [pending.scope, pending.scope]);
  assert.equal(f.app.getSnapshot().active.agent.id, 'other');
});

test('legacy pending creation queries the saved scope and never silently selects the default', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), pendingCreation: { scope, agentId: null } });
  let lookedUp;
  f.behavior.agentLookup = async value => { lookedUp = value; return null; };
  await f.app.start();
  await f.app.recoverCreation();
  assert.deepEqual(lookedUp, scope);
  assert.equal(f.created.length, 0);
  assert.equal(f.app.getSnapshot().saved.pendingCreation.agentId, null);
  assert.match(f.app.getSnapshot().error, /Choose an agent explicitly/);
  f.behavior.agentLookup = async () => f.descriptor('original-agent', CODEX_RUNTIME);
  await f.app.recoverCreation();
  assert.deepEqual(f.selected, ['original-agent']);
  assert.equal(f.app.getSnapshot().active.agent.id, 'original-agent');
});

test('legacy absent creation accepts only an explicit selection and persists it before request', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), pendingCreation: { scope, agentId: null } });
  f.behavior.agentLookup = async () => null;
  f.behavior.create = async () => {
    assert.deepEqual(f.views.get('original-view/host').pendingCreation, { scope, agentId: 'other' });
    throw new Error('Reply lost again');
  };
  await f.app.start();
  await f.app.recoverCreation('other');
  assert.deepEqual(f.selected, ['other']);
  f.behavior.defaultId = 'replacement';
  await f.app.recoverCreation();
  assert.deepEqual(f.selected, ['other', 'other']);
});

test('absent pending creation replaces a removed saved agent only after an explicit available choice', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const pending = { scope, agentId: 'default' };
  f.views.set('original-view/host', { ...empty(), pendingCreation: pending });
  f.behavior.agentLookup = async value => f.captured.get(value.conversationId) ?? null;
  await f.app.start();
  f.behavior.defaultId = 'replacement';
  f.behavior.create = async () => {
    if (f.selected.at(-1) === 'default') {
      f.captured.delete(scope.conversationId);
      throw new ServiceError('invalid', 'Choose a configured agent.');
    }
    assert.deepEqual(f.views.get('original-view/host').pendingCreation, { scope, agentId: 'replacement' });
  };
  await f.app.recoverCreation();
  assert.deepEqual(f.app.getSnapshot().saved.pendingCreation, pending);
  assert.equal(f.app.getSnapshot().active, null);
  await f.app.recoverCreation('replacement');
  assert.deepEqual(f.selected, ['default', 'replacement']);
  assert.equal(f.app.getSnapshot().saved.pendingCreation, null);
  assert.equal(f.app.getSnapshot().active.agent.id, 'replacement');
  assert.deepEqual(f.created, [scope, scope]);
});

test('invalid or unavailable recovery choices preserve legacy and captured pending intents', async t => {
  for (const agentId of [null, 'gone', 'default']) {
    const f = fixture(); t.after(() => f.app.dispose());
    const pending = { scope, agentId };
    f.views.set('original-view/host', { ...empty(), pendingCreation: pending });
    f.behavior.agentLookup = async value => f.captured.get(value.conversationId) ?? null;
    await f.app.start();
    f.behavior.agents = [f.descriptor('other'), { ...f.descriptor(), availability: { kind: 'unavailable', reason: 'Agent offline' } }];
    f.behavior.create = async () => {
      if (f.selected.at(-1) !== 'other') {
        f.captured.delete(scope.conversationId);
        throw new ServiceError('unavailable', 'Choose an available agent.');
      }
    };
    for (const selected of ['unknown', 'default']) {
      await f.app.recoverCreation(selected);
      assert.deepEqual(f.views.get('original-view/host').pendingCreation, pending);
      assert.deepEqual(f.created, []);
      assert.match(f.app.getSnapshot().error, /available agent/);
    }
    await f.app.recoverCreation('other');
    assert.equal(f.app.getSnapshot().active.agent.id, 'other');
    assert.deepEqual(f.created, [scope]);
  }
});

test('an existing pending scope keeps its actual agent despite a different explicit recovery choice', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), pendingCreation: { scope, agentId: 'default' } });
  const original = { ...f.descriptor('original-agent'), availability: { kind: 'unavailable', reason: 'Agent removed' } };
  f.behavior.agentLookup = async () => original;
  await f.app.start();
  await f.app.recoverCreation('other');
  assert.deepEqual(f.selected, ['original-agent']);
  assert.deepEqual(f.created, [scope]);
  assert.equal(f.app.getSnapshot().active.agent.id, 'original-agent');
  assert.equal(f.app.getSnapshot().saved.pendingCreation, null);
});

test('active descriptors override default controls and unavailable history stays readable', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  f.behavior.runtime = { engine: 'unsupported-default', version: '99', format: 'unknown' };
  f.behavior.agentLookup = async () => ({ ...f.descriptor('sdk', CODEX_SDK_RUNTIME), commands: ['send', 'cancel'] });
  await f.app.start(); await deliver(f);
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  let target = f.app.getSnapshot().active;
  assert.deepEqual(target.agent.runtime, CODEX_SDK_RUNTIME);
  await assert.rejects(f.app.conversationActions(target).commands.approve('decision', 'yes'), /does not support/);
  f.behavior.agentLookup = async () => ({ ...f.descriptor('sdk', CODEX_SDK_RUNTIME), availability: { kind: 'unavailable', reason: 'Agent removed' } });
  await f.app.reconnect(); await deliver(f, { messages: [{ messageId: 'saved', revision: 1, role: 'assistant', text: 'Saved response', complete: true }], currentRun: null });
  target = f.app.getSnapshot().active;
  assert.equal(target.store.getSnapshot().document.domain.messages[0].text, 'Saved response');
  await assert.rejects(f.app.conversationActions(target).commands.send('hello'), /Agent removed/);
  let effects = 0;
  await f.app.conversationActions(target).submit(async () => { effects++; });
  await f.app.conversationActions(target).reconcile('old-command');
  assert.equal(effects, 0);
  assert.equal(f.submitted.length, 0);
});
