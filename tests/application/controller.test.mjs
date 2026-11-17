import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendToolGeneration } from '@agentui/sdk/tools';
import { ServiceError } from '@agentui/contracts/service';
import { ServiceConnectionLost } from '@agentui/client/service';
import { CLAUDE_SDK_RUNTIMES, CODEX_RUNTIME, CODEX_SDK_RUNTIME, PI_RUNTIME, RECORDED_RUNTIME } from '@agentui/contracts/compatibility';
import { applicationEnabled } from '../../apps/desktop/dist/application/application-controller.js';
import { scope, empty, deferred, fixture } from './controller-fixture.mjs';

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
  f.behavior.search = async () => { throw new ServiceError('unavailable', 'Host offline'); };
  await assert.rejects(f.app.search('garden', null, live), /Host offline/);
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
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
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.leases[0].closed, true);
  f.behavior.write = async () => {};
  await f.app.getSnapshot().active.store.setDraft('New edit');
  assert.equal(f.drafts.get('restored-view/host/conversation').draft, 'New edit');
});

test('disposal closes admission and feeds immediately, and restart waits for the same drain promise', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  const old = f.app.getSnapshot().active;
  const actions = f.app.conversationActions(old);
  const drain = deferred();
  let closes = 0, settled = false;
  f.behavior.close = () => { closes++; return drain.promise; };
  const closing = f.app.dispose();
  assert.equal(f.app.dispose(), closing);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 1);
  assert.equal(f.leases[0].closed, true);
  assert.equal(old.store.getSnapshot().connection.kind, 'disconnected');
  assert.equal(f.feedCloses(), 1);
  void closing.then(() => { settled = true; });
  await assert.rejects(actions.commands.send('Closed session'), /application has closed/);
  await assert.rejects(f.app.search('closed', null, new AbortController().signal), /application has closed/);
  const restart = f.app.start();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(f.leases.length, 1);
  const interruptedRestart = f.app.dispose();
  assert.equal(f.app.dispose(), interruptedRestart);
  const finalRestart = f.app.start();
  await Promise.resolve();
  assert.equal(f.leases.length, 1);
  drain.resolve();
  await Promise.all([closing, restart, interruptedRestart, finalRestart]);
  assert.equal(settled, true);
  assert.equal(f.leases.length, 2);
  assert.equal(f.app.getSnapshot().active.viewId, 'original-view');
  assert.deepEqual(f.submitted, []);
});

test('reopening an owned view reuses its original store and exclusive storage lease', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  const old = f.app.getSnapshot().active;
  f.behavior.reopen = async () => { throw new Error('Must reuse original lease'); };
  await f.app.reopenView('original-view');
  assert.equal(f.leases.length, 1);
  assert.equal(f.leases[0].closed, false);
  assert.equal(f.app.getSnapshot().active.store, old.store);
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
});

test('failed replacement acquisition leaves the selected owner and saved records usable', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const saved = { ...empty(), route: scope };
  f.views.set('original-view/host', saved);
  await f.app.start();
  const active = f.app.getSnapshot().active;
  f.behavior.reopen = async () => { throw new Error('Saved view is already open'); };
  await f.app.reopenView('other-view');
  assert.equal(f.app.getSnapshot().active, active);
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  assert.match(f.app.getSnapshot().error, /already open/);
  assert.equal(f.leases[0].closed, false);
  assert.deepEqual(f.views.get('original-view/host'), saved);
  await active.store.setDraft('Still writable');
});

test('disposal during an existing same-view handover still awaits its admitted storage drain', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  const drain = deferred(); let disposed = false;
  f.behavior.close = () => drain.promise;
  const reopening = f.app.reopenView('original-view');
  const closing = f.app.dispose(); void closing.then(() => { disposed = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(disposed, false);
  drain.resolve(); await Promise.all([reopening, closing]);
  assert.equal(disposed, true); assert.deepEqual(f.submitted, []);
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

test('a disposed startup releases its late storage lease', async t => {
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
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
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

for (const entry of ['start', 'reconnect', 'reopenView']) {
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
  await feed.receive({ kind: 'snapshot', snapshot: { scope: feed.scope, projectionVersion: 4,
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

test('a lost native connection during a command disables the app until an explicit reconnect', async t => {
  const f = await openCommands(t);
  const failure = new ServiceConnectionLost('A different AgentUI host is answering on this Mac. Reconnect to switch to it.');
  f.behavior.submit = async () => { f.connectionLost(failure); throw failure; };
  await assert.rejects(f.actions.commands.send('prompt'), error => error === failure);
  const snapshot = f.app.getSnapshot();
  assert.equal(snapshot.host.kind, 'unavailable');
  assert.match(snapshot.error, /different AgentUI host/);
  assert.equal(applicationEnabled(snapshot), false);
  assert.equal(f.target.store.getSnapshot().connection.kind, 'disconnected');
  assert.equal(f.target.store.getSnapshot().outbox.length, 1);
  f.connectionLost(new ServiceConnectionLost('The local host connection changed. Reconnect before continuing.'));
  assert.match(f.app.getSnapshot().error, /different AgentUI host/);
  await f.app.reconnect();
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
});

test('a connection loss seen by a background request that ignores its own errors still disables the app', async t => {
  const f = await openCommands(t);
  f.connectionLost(new ServiceConnectionLost('The local host connection changed. Reconnect before continuing.'));
  assert.equal(f.app.getSnapshot().host.kind, 'unavailable');
  assert.match(f.app.getSnapshot().error, /host connection changed/);
  assert.equal(applicationEnabled(f.app.getSnapshot()), false);
  assert.equal(f.target.store.getSnapshot().connection.kind, 'disconnected');
  await f.app.reconnect();
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
});

test('SDK rejects transport failures while the UI submission stays caught', async t => {
  for (const sdk of [true, false]) {
    const f = await openCommands(t);
    const failure = new Error('Transport lost');
    f.behavior.submit = async () => { throw failure; };
    if (sdk) await assert.rejects(f.actions.commands.send('prompt'), error => error === failure);
    else { await f.target.store.setDraft('prompt'); await f.actions.submit(() => f.target.store.send()); }
    assert.match(f.app.getSnapshot().error, /Transport lost/);
    assert.equal(f.app.getSnapshot().busy, false);
    assert.equal(f.submitted.length, 1);
    assert.equal(f.target.store.getSnapshot().outbox.length, 1);
    assert.equal(f.app.getSnapshot().host.kind, 'ready');
  }
});

test('a closed conversation refusal is shown as a sentence while SDK commands keep the reason', async t => {
  const f = await openCommands(t);
  f.behavior.submit = async () => ({ kind: 'rejected', reason: 'conversation-closed' });
  assert.deepEqual(await f.actions.commands.send('after closure'), { kind: 'rejected', reason: 'conversation-closed' });
  assert.equal(f.app.getSnapshot().error, 'This conversation ended. Start a new chat to keep going.');
});

test('a send refused behind an unconfirmed earlier send names the recovery actions while SDK commands keep the reason', async t => {
  const f = await openCommands(t);
  f.behavior.submit = async () => ({ kind: 'rejected', reason: 'send-awaiting-confirmation' });
  assert.deepEqual(await f.actions.commands.send('behind an unconfirmed send'), { kind: 'rejected', reason: 'send-awaiting-confirmation' });
  assert.equal(f.app.getSnapshot().error, 'An earlier message has not been confirmed yet, so this one was not sent. Your draft is kept. '
    + 'Use Reconcile command under Command recovery, or Check pending command under Pending commands, to check it. '
    + 'If it stays unconfirmed, use Stop waiting under Command recovery to send new messages here; '
    + 'the earlier message may or may not have run.');
  const abandoned = [];
  f.behavior.abandon = async (selected, id) => { abandoned.push([selected, id]); return null; };
  await f.actions.abandon('earlier-send');
  assert.deepEqual(abandoned, [[f.target.scope, 'earlier-send']]);
});


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
      assert.strictEqual(f.app.getSnapshot(), replacementState);
    }
    assert.deepEqual([...f.drafts], records);
    assert.equal(f.submitted.length, 0);
    assert.equal(f.target.store.getSnapshot().outbox.length, 0);
  });
}

for (const blocked of ['disconnected', 'feed-ended', 'storage', 'incompatible']) {
  test(`SDK ${blocked} refusal persists and sends nothing`, async t => {
    const f = await openCommands(t);
    if (blocked === 'disconnected') f.target.store.disconnect();
    if (blocked === 'feed-ended') { f.feeds.at(-1).finish({ kind: 'failed', reason: 'Lost feed' }); await Promise.resolve(); }
    if (blocked === 'storage') f.leases[0].failure(new Error('Storage unavailable'));
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

test('absent pending creation never replaces its saved agent with an explicit choice', async t => {
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
    assert.fail('Recovery must not create with a replacement agent');
  };
  await f.app.recoverCreation();
  assert.deepEqual(f.app.getSnapshot().saved.pendingCreation, pending);
  assert.equal(f.app.getSnapshot().active, null);
  await f.app.recoverCreation('replacement');
  assert.deepEqual(f.selected, ['default']);
  assert.deepEqual(f.app.getSnapshot().saved.pendingCreation, pending);
  assert.equal(f.app.getSnapshot().active, null);
  assert.match(f.app.getSnapshot().error, /saved agent/);
  await f.app.recoverCreation();
  assert.deepEqual(f.selected, ['default', 'default']);
  assert.deepEqual(f.created, [scope, scope]);
  assert.deepEqual(f.app.getSnapshot().saved.pendingCreation, pending);
});

test('invalid or unavailable recovery choices preserve legacy pending intents', async t => {
  for (const agentId of [null]) {
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

test('a different host scope owner cannot replace a saved provider creation or its route and draft', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const pending = { scope: { ...scope, conversationId: 'pending-provider' }, agentId: 'original-provider' };
  const saved = { ...empty(), route: scope, pendingCreation: pending };
  f.views.set('original-view/host', saved);
  f.behavior.agentLookup = async () => f.descriptor('native-agent');
  await f.app.start();
  const active = f.app.getSnapshot().active;
  await active.store.setDraft('Keep my draft');
  for (const selected of [undefined, 'other']) {
    await f.app.recoverCreation(selected);
    assert.deepEqual(f.selected, []);
    assert.deepEqual(f.created, []);
    assert.deepEqual(f.app.getSnapshot().saved, saved);
    assert.deepEqual(f.views.get('original-view/host'), saved);
    assert.equal(f.app.getSnapshot().active, active);
    assert.equal(f.drafts.get('original-view/host/conversation').draft, 'Keep my draft');
    assert.match(f.app.getSnapshot().error, /different agent/);
  }
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

test('definitive creation refusal releases only its current pending scope and preserves the previous route and draft', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  await f.app.getSnapshot().active.store.setDraft('Keep this original draft');
  f.behavior.create = async () => { throw new ServiceError('create-rejected', 'Provider refused creation'); };
  await f.app.create('other');
  assert.equal(f.app.getSnapshot().saved.pendingCreation, null);
  assert.deepEqual(f.app.getSnapshot().saved.route, scope);
  assert.equal(f.drafts.get('original-view/host/conversation').draft, 'Keep this original draft');
  await f.app.create('other');
  assert.equal(f.created.length, 2);
  const pending = deferred();
  f.behavior.create = () => pending.promise;
  const creating = f.app.create('other');
  await new Promise(resolve => setImmediate(resolve));
  const originalPending = f.views.get('original-view/host').pendingCreation;
  await f.app.dispose();
  await f.app.start();
  pending.reject(new ServiceError('create-rejected', 'Late refusal'));
  await creating;
  assert.deepEqual(f.views.get('original-view/host').pendingCreation, originalPending);
  assert.deepEqual(f.app.getSnapshot().saved.pendingCreation, originalPending);
});

test('legacy pending recovery keeps host-recorded provider identity despite a different selected agent', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: null, pendingCreation: { scope, agentId: null } });
  const original = { id: 'original-provider', kind: 'provider', label: 'Provider', namespace: 'example', protocolVersion: '1', commands: [], availability: { kind: 'ready' } };
  f.behavior.agentLookup = async () => original;
  f.behavior.create = async () => { throw new ServiceError('unavailable', 'Original creation is unknown'); };
  await f.app.start();
  await f.app.recoverCreation('other');
  assert.deepEqual(f.selected, ['original-provider']);
  assert.equal(f.app.getSnapshot().saved.pendingCreation.agentId, 'original-provider');
  await f.app.recoverCreation();
  assert.deepEqual(f.selected, ['original-provider', 'original-provider']);
});

test('observation reads are serial, preserve active identity, and native not-applicable ends polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  const gate = deferred(), calls = [];
  f.behavior.observation = input => { calls.push(input); return gate.promise; };
  await f.app.start(); const active = f.app.getSnapshot().active;
  t.mock.timers.tick(10_000); assert.equal(calls.length, 1);
  gate.resolve({ kind: 'observing' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.app.getSnapshot().active, active);
  assert.deepEqual(f.app.getSnapshot().observation, { status: { kind: 'observing' }, retrying: false });
  f.behavior.observation = async input => { calls.push(input); return { kind: 'not-applicable' }; };
  t.mock.timers.tick(2000); await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10_000); assert.equal(calls.length, 2);
});

test('observation retry stays local, joins duplicate clicks, and ignores late selection and disposed results', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  const retry = deferred(), calls = [];
  f.behavior.observation = input => {
    calls.push(input);
    return input.action === 'retry' ? retry.promise : Promise.resolve(input.scope.conversationId === scope.conversationId
      ? { kind: 'stopped', reason: 'provider-disconnected' } : { kind: 'not-applicable' });
  };
  await f.app.start(); const active = f.app.getSnapshot().active;
  await active.store.setDraft('Retain draft');
  const actions = f.app.conversationActions(active), first = actions.retryObservation(), second = actions.retryObservation();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(applicationEnabled(f.app.getSnapshot()), true); assert.equal(f.app.getSnapshot().observation.retrying, true);
  assert.equal(calls.filter(value => value.action === 'retry').length, 1);
  await f.app.open({ ...scope, conversationId: 'other' });
  retry.resolve({ kind: 'observing' }); await Promise.all([first, second]);
  assert.equal(f.app.getSnapshot().active.scope.conversationId, 'other');
  assert.equal(f.app.getSnapshot().observation.status.kind, 'not-applicable');
  assert.equal(f.drafts.get('original-view/host/conversation').draft, 'Retain draft');
  assert.deepEqual(f.submitted, []);
  const read = deferred(); f.behavior.observation = () => read.promise;
  await f.app.open(scope); await f.app.dispose(); const disposed = f.app.getSnapshot();
  read.resolve({ kind: 'stopped', reason: 'cleanup-failed' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.app.getSnapshot(), disposed);
});

test('observation failures are local unknown status and keep the host connected', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  f.behavior.observation = async () => { throw new Error('SECRET_STATUS_TRANSPORT'); };
  await f.app.start(); const active = f.app.getSnapshot().active;
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  assert.deepEqual(f.app.getSnapshot().observation, { status: { kind: 'unknown' }, retrying: false });
  assert.equal(f.app.getSnapshot().error, ''); assert.equal(f.app.getSnapshot().active, active);
  f.behavior.observation = async () => { throw new ServiceError('unavailable', 'Host offline'); };
  t.mock.timers.tick(2000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  assert.deepEqual(f.app.getSnapshot().observation, { status: { kind: 'unknown' }, retrying: false });
  assert.equal(f.app.getSnapshot().error, '');
});

test('empty provider hosts reject create before saving and retain original pending creation recovery', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.behavior.agents = []; f.behavior.runtime = null; f.behavior.defaultId = null;
  await f.app.start();
  assert.equal(f.app.getSnapshot().host.kind, 'ready');
  const before = structuredClone(f.app.getSnapshot().saved);
  await f.app.create();
  assert.match(f.app.getSnapshot().error, /No agent is available/);
  assert.deepEqual(f.app.getSnapshot().saved, before);
  assert.equal(f.created.length, 0);
  const original = { scope, agentId: 'original-provider' };
  f.views.set('original-view/host', { ...empty(), pendingCreation: original });
  f.behavior.agentLookup = async () => ({ id: 'original-provider', kind: 'provider', label: 'Original',
    namespace: 'original', protocolVersion: '1', commands: [], availability: { kind: 'unavailable', reason: 'Removed' } });
  f.behavior.create = async () => { throw new ServiceError('unavailable', 'Original provider unavailable'); };
  await f.app.reconnect();
  await f.app.recoverCreation('replacement-provider');
  assert.equal(f.created.length, 0);
  await f.app.recoverCreation();
  assert.deepEqual(f.selected, ['original-provider']);
  assert.deepEqual(f.app.getSnapshot().saved.pendingCreation, original);
  assert.match(f.app.getSnapshot().error, /Original provider unavailable/);
});

test('module permission reads reject stale conversation results and revoke retains exact confirmed scope', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  const active = f.app.getSnapshot().active, actions = f.app.conversationActions(active), read = deferred();
  f.behavior.permissions = value => { assert.deepEqual(value, scope); return read.promise; };
  const pending = actions.permissions.read();
  await f.app.open({ ...scope, conversationId: 'other' });
  read.resolve({ kind: 'available', observedAt: new Date().toISOString(), permissions: [] });
  await assert.rejects(pending, /conversation/);
  await assert.rejects(actions.commands.revokePermission('permission', 'agent'), /conversation/);
  assert.deepEqual(f.submitted, []);
  f.behavior.permissions = async () => ({ kind: 'available', observedAt: new Date().toISOString(),
    permissions: [{ permissionId: 'permission', scope: 'agent', actionLabel: 'Work items', detail: 'All conversations' }] });
  await f.app.open(scope);
  const current = f.app.getSnapshot().active;
  await f.app.conversationActions(current).permissions.read();
  await current.store.setDraft('Keep my draft');
  await assert.rejects(f.app.conversationActions(current).commands.revokePermission('permission', 'agent'), /Reply lost/);
  assert.deepEqual(f.submitted[0].body, { kind: 'revoke-permission', permissionId: 'permission', scope: 'agent' });
  assert.deepEqual(current.store.getSnapshot().outbox[0].command, f.submitted[0]);
  assert.equal(current.store.getSnapshot().draft, 'Keep my draft');
});

test('permission freshness follows opening, failed commands, reconnect and newer reads', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  const listing = { kind: 'available', observedAt: '2026-11-16T01:00:00Z',
    permissions: [{ permissionId: 'grant', scope: 'conversation', actionLabel: 'Work items', detail: 'This conversation' }] };
  let reads = 0;
  f.behavior.permissions = async () => { reads++; return listing; };
  await f.app.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.app.getSnapshot().permissionState.kind, 'fresh');
  assert(reads > 0);
  let actions = f.app.conversationActions(f.app.getSnapshot().active);
  const old = deferred();
  f.behavior.permissions = () => old.promise;
  const pending = actions.permissions.read();
  assert.equal(f.app.getSnapshot().permissionState.kind, 'loading');
  await assert.rejects(actions.commands.revokePermission('grant', 'conversation'), /Refresh permissions/);
  f.behavior.permissions = async () => ({ ...listing, permissions: [] });
  await actions.permissions.read();
  old.resolve(listing); await pending;
  assert.deepEqual(f.app.getSnapshot().permissionState.listing.permissions, []);
  f.behavior.permissions = async () => { throw new Error('List unavailable'); };
  await assert.rejects(actions.permissions.read(), /List unavailable/);
  assert.equal(f.app.getSnapshot().permissionState.kind, 'stale');
  assert.equal(f.app.getSnapshot().permissionState.listing.observedAt, listing.observedAt);
  await assert.rejects(actions.commands.revokePermission('grant', 'conversation'), /Refresh permissions/);
  f.behavior.permissions = async () => { reads++; return listing; };
  const before = reads;
  await f.app.reconnect(); await new Promise(resolve => setImmediate(resolve));
  assert(reads > before);
  actions = f.app.conversationActions(f.app.getSnapshot().active);
  await actions.permissions.read();
  await assert.rejects(actions.commands.revokePermission('grant', 'conversation'), /Reply lost/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.app.getSnapshot().permissionState.kind, 'fresh');
  assert.equal(f.submitted.length, 1);
  assert.equal(f.app.getSnapshot().active.store.getSnapshot().outbox.length, 1);
});

test('permission reads from a disposed session cannot populate its replacement', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  const old = deferred(), actions = f.app.conversationActions(f.app.getSnapshot().active);
  f.behavior.permissions = () => old.promise;
  const pending = actions.permissions.read();
  await f.app.dispose();
  f.behavior.permissions = async () => ({ kind: 'available', observedAt: new Date().toISOString(), permissions: [] });
  await f.app.start(); await new Promise(resolve => setImmediate(resolve));
  old.resolve({ kind: 'available', observedAt: '2026-11-16T00:00:00Z', permissions: [
    { permissionId: 'old', scope: 'agent', actionLabel: 'Old', detail: 'Old session' }] });
  await assert.rejects(pending, /closed/);
  assert.deepEqual(f.app.getSnapshot().permissionState.listing.permissions, []);
});

test('original physical store and storage survive navigation and principal changes while old notification remains pending', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.behavior.frontendOffers = 'ag-ui-capture-and-bind';
  f.views.set('original-view/host', { ...empty(), route: scope });
  f.views.set('other-view/host', empty());
  const disposed = [], source = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'A', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'Original' }, decodeInput: x => x, async execute() { throw new Error('No effects'); } }); return { dispose() { disposed.push('A'); } }; } });
  const token = {}; f.app.frontendGenerations.begin(token); f.app.frontendGenerations.publish(token, { kind: 'ready', generations: [source.generation] });
  await f.app.start(); const original = f.app.getSnapshot().active.store;
  f.behavior.submit = async command => ({ kind: 'receipt', receipt: { scope, clientCommandId: command.clientCommandId, hostOperationId: 'operation', sequence: 1, state: { kind: 'completed' } } });
  await original.send('A message');
  assert.equal(original.getSnapshot().outbox.length, 0);
  const retiring = source.generation.retire();
  await f.app.reopenView('other-view');
  assert.equal(f.leases[0].closed, false);
  await f.app.reopenView('original-view');
  assert.equal(f.app.getSnapshot().active.store, original); assert.equal(f.leases.filter(lease => lease.viewId === 'original-view').length, 1);
  f.behavior.principalId = 'replacement';
  await f.app.reconnect(); await retiring;
  assert.equal(f.app.getSnapshot().active.store, original);
  assert.deepEqual(disposed, ['A']);
  assert.equal(f.drafts.get('original-view/host/conversation').frontendSends[0].ownerId, 'principal');
  assert.equal(f.drafts.get('original-view/host/conversation').frontendSends[0].state, 'unavailable-pending');
  await original.setDraft('New principal draft');
  assert.equal(f.drafts.get('original-view/host/conversation').draft, 'New principal draft');
  await assert.rejects(original.retry(f.submitted[0].clientCommandId), /outbox|unavailable/);
});

test('a failed background storage close blocks commands and disposal joins the same close without retrying it', async () => {
  const f = fixture(); let closes = 0;
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  f.behavior.close = owner => { if (owner.viewId === 'original-view') { closes++; throw new Error('Storage close failed'); } };
  await f.app.reopenView('other-view'); await new Promise(resolve => setImmediate(resolve));
  assert.match(f.app.getSnapshot().storageFailure, /Storage close failed/);
  await f.app.create(); assert.deepEqual(f.created, []);
  await assert.rejects(f.app.dispose(), /Storage close failed/); assert.equal(closes, 1);
});

test('a newly acquired view already owns its selected lease when another capture changes during selection', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.behavior.frontendOffers = 'ag-ui-capture-and-bind';
  f.views.set('original-view/host', { ...empty(), route: scope });
  const source = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'A', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'Original' }, decodeInput: x => x, async execute() { throw new Error('No effects'); } }); return { dispose() {} }; } });
  const token = {}; f.app.frontendGenerations.begin(token); f.app.frontendGenerations.publish(token, { kind: 'ready', generations: [source.generation] });
  await f.app.start();
  await assert.rejects(f.app.getSnapshot().active.store.send('Pending'), /Reply lost/);
  const key = f.app.getSnapshot().capturedSends[0].key;
  f.behavior.select = () => { void f.app.releaseCapturedSend(key); };
  await f.app.reopenView('new-view'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.leases.find(lease => lease.viewId === 'new-view').closed, false);
  assert.equal(applicationEnabled(f.app.getSnapshot()), true);
  await source.generation.retire();
});

const journalRecord = (selected, count = 1) => ({ version: 3, image: null, scope: selected, draft: 'Preserved', draftRevision: 1, outbox: [],
  frontendSends: Array.from({ length: count }, (_, index) => ({ ownerId: 'principal', state: 'retained', command: { version: 2, scope: selected,
    clientCommandId: `${selected.conversationId}-${index}`, body: { kind: 'send', text: 'Original', frontend: { platform: 'desktop', tools: [{ activationId: 'old', definition: { name: 'fixture__echo', description: 'Original' } }] } } } })) });
const eventually = async predicate => { for (let attempt = 0; attempt < 500; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Recovery did not reach its durable state'); };

test('foreign pending history never republishes or replaces the current owner row on later passes', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const record = journalRecord(scope, 33), requests = [];
  for (const reference of record.frontendSends.slice(0, 32)) reference.ownerId = 'foreign';
  f.drafts.set('original-view/host/conversation', record);
  f.behavior.binding = async request => { requests.push(request); throw new Error('Notification offline'); };
  await f.app.start();
  await eventually(() => requests.length === 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  const saved = f.drafts.get('original-view/host/conversation');
  assert.ok(saved.frontendSends.every(row => row.state === 'unavailable-pending'));
  const rows = f.app.getSnapshot().capturedSends;
  assert.deepEqual(rows.map(row => row.command.clientCommandId), ['conversation-32']);
  let publications = 0;
  const unsubscribe = f.app.subscribe(() => { publications++; }); t.after(unsubscribe);
  await eventually(() => requests.length === 2);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(publications, 0);
  assert.equal(f.app.getSnapshot().capturedSends, rows);
  assert.equal(f.app.getSnapshot().capturedSends[0], rows[0]);
  assert.ok(requests.every(request => request.id === 'conversation-32' && request.action === 'unavailable'));
  assert.equal(f.drafts.get('original-view/host/conversation'), saved);
  assert.deepEqual(saved.frontendSends.map(({ command, ownerId }) => ({ command, ownerId })), record.frontendSends.map(({ command, ownerId }) => ({ command, ownerId })));
});

for (const count of [1, 40]) test(`${count} own pending notifications keep captured keys and row identities stable across two failed passes`, async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const record = journalRecord(scope, count), requests = [];
  f.drafts.set('original-view/host/conversation', record);
  f.behavior.binding = async request => { requests.push(request); throw new Error('Notification offline'); };
  await f.app.start();
  await eventually(() => requests.length === count);
  await new Promise(resolve => setTimeout(resolve, 20));
  const rows = f.app.getSnapshot().capturedSends, keys = rows.map(row => row.key);
  assert.deepEqual(rows.map(row => row.command.clientCommandId), Array.from({ length: Math.min(count, 32) }, (_, index) => `conversation-${index + Math.max(0, count - 32)}`));
  const saved = f.drafts.get('original-view/host/conversation');
  assert.ok(saved.frontendSends.every(row => row.state === 'unavailable-pending'));
  let publications = 0;
  const unsubscribe = f.app.subscribe(() => { publications++; }); t.after(unsubscribe);
  for (const pass of [2, 3]) {
    await eventually(() => requests.length === count * pass);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(publications, 0);
    assert.equal(f.app.getSnapshot().capturedSends, rows);
    assert.deepEqual(f.app.getSnapshot().capturedSends.map(row => row.key), keys);
    for (let index = 0; index < rows.length; index++) assert.equal(f.app.getSnapshot().capturedSends[index], rows[index]);
    assert.equal(f.drafts.get('original-view/host/conversation'), saved);
  }
  assert.ok(requests.every(request => request.action === 'unavailable'));
  assert.deepEqual(saved.frontendSends.map(row => row.command), record.frontendSends.map(row => row.command));
});

test('settled history beyond 32 references keeps captured rows stable without another recovery pass', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.drafts.set('original-view/host/conversation', journalRecord(scope, 40));
  const requests = [];
  f.behavior.binding = async request => { requests.push(request); return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' }; };
  await f.app.start();
  await eventually(() => f.drafts.get('original-view/host/conversation').frontendSends.every(row => row.state === 'unavailable-confirmed'));
  await new Promise(resolve => setTimeout(resolve, 20));
  const rows = f.app.getSnapshot().capturedSends, order = rows.map(row => row.command.clientCommandId);
  assert.deepEqual(order, Array.from({ length: 32 }, (_, index) => `conversation-${index + 8}`));
  assert.equal(requests.length, 40);
  const loads = f.loads.length;
  let publications = 0;
  const unsubscribe = f.app.subscribe(() => { publications++; }); t.after(unsubscribe);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let index = 0; index < 3; index++) { t.mock.timers.tick(2_000); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(f.loads.length, loads);
  assert.equal(publications, 0);
  assert.equal(f.app.getSnapshot().capturedSends, rows);
  assert.deepEqual(f.app.getSnapshot().capturedSends.map(row => row.command.clientCommandId), order);
  assert.equal(requests.length, 40);
});

for (const route of [null, scope]) test(`owned-view sweep reaches more than 100 scopes and 32 references with route ${route?.conversationId ?? 'null'}`, async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route });
  for (let index = 0; index < 105; index++) {
    const selected = { ...scope, conversationId: `a-${String(index).padStart(3, '0')}` };
    f.drafts.set(`original-view/host/${selected.conversationId}`, { version: 1, scope: selected, draft: 'Preserved', draftRevision: 1, outbox: [] });
  }
  const last = { ...scope, conversationId: 'z-last' }, record = journalRecord(last, 70), requests = [], lookedUp = [];
  for (let index = 0; index < 35; index++) record.frontendSends[index].ownerId = 'foreign';
  record.frontendSends[35].state = 'unavailable-confirmed';
  f.drafts.set('original-view/host/z-last', record);
  f.behavior.agentLookup = selected => { lookedUp.push(selected); return selected.conversationId === scope.conversationId ? f.descriptor() : null; };
  f.behavior.binding = async request => { requests.push(request); if (request.id === 'z-last-36') throw new Error('Lost reply'); return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' }; };
  await f.app.start();
  await eventually(() => f.drafts.get('original-view/host/z-last').frontendSends[69].state === 'unavailable-confirmed');
  assert.deepEqual(lookedUp, route ? [scope] : []);
  assert.deepEqual(f.feeds.map(feed => feed.scope), route ? [scope] : []); assert.deepEqual(f.submitted, []);
  assert.equal(f.drafts.get('original-view/host/z-last').frontendSends[36].state, 'unavailable-pending');
  assert.ok(requests.every(request => request.action === 'unavailable' && Number(request.id.split('-').at(-1)) >= 36));
  assert.equal(f.app.getSnapshot().capturedSends.length, 32);
  assert.deepEqual(f.drafts.get('original-view/host/z-last').frontendSends.map(row => row.command), record.frontendSends.map(row => row.command));
});

test('recovery and visible install share one writer and gain eligibility from the actual conversation agent', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  const held = deferred(), entered = deferred();
  f.drafts.set('original-view/host/conversation', journalRecord(scope));
  const actual = { ...f.descriptor('actual'), frontendOffers: 'ag-ui-capture-and-bind' };
  f.behavior.agents = [f.descriptor(), actual]; f.behavior.agentLookup = () => actual;
  f.behavior.binding = async request => { entered.resolve(); await held.promise; return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' }; };
  const source = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'new', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'New' }, decodeInput: x => x, async execute() { throw new Error('No execution'); } }); return { dispose() {} }; } });
  const token = {}; f.app.frontendGenerations.begin(token); f.app.frontendGenerations.publish(token, { kind: 'ready', generations: [source.generation] });
  t.after(() => source.generation.retire());
  await f.app.start(); await entered.promise;
  await f.app.open(scope);
  const store = f.app.getSnapshot().active.store;
  const writing = deferred(), writingEntered = deferred();
  f.behavior.write = async () => { writingEntered.resolve(); await writing.promise; };
  const draft = store.setDraft('Concurrent draft'); await writingEntered.promise;
  f.behavior.submit = async command => ({ kind: 'receipt', receipt: { scope, clientCommandId: command.clientCommandId, hostOperationId: 'operation', sequence: 1, state: { kind: 'completed' } } });
  const sending = store.send('Explicit send'); held.resolve();
  await Promise.resolve(); writing.resolve(); await Promise.all([draft, sending]);
  await eventually(() => f.drafts.get('original-view/host/conversation').frontendSends[0].state === 'unavailable-confirmed');
  assert.equal(f.loads.filter(key => key === 'original-view/host/conversation').length, 1);
  assert.equal(f.submitted[0].version, 2); assert.equal(f.drafts.get('original-view/host/conversation').draft, 'Concurrent draft');
  assert.equal(f.drafts.get('original-view/host/conversation').outbox.length, 0);
});

for (const failed of [false, true]) test(`inactive view release ${failed ? 'reports its pinned save failure' : 'drains then defers notification until reopening'}`, async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope }); f.behavior.frontendOffers = 'ag-ui-capture-and-bind';
  const source = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'A', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'A' }, decodeInput: x => x, async execute() { throw new Error('No execution'); } }); return { dispose() {} }; } });
  const token = {}; f.app.frontendGenerations.begin(token); f.app.frontendGenerations.publish(token, { kind: 'ready', generations: [source.generation] });
  await f.app.start(); await assert.rejects(f.app.getSnapshot().active.store.send('Original'), /Reply lost/);
  const key = f.app.getSnapshot().capturedSends[0].key;
  await f.app.reopenView('other-view'); assert.equal(f.leases[0].closed, false);
  const entered = deferred(), write = deferred(), requests = [];
  f.behavior.binding = async request => { requests.push(request); return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' }; };
  f.behavior.write = async () => { entered.resolve(); await write.promise; };
  const release = f.app.releaseCapturedSend(key); await entered.promise;
  assert.equal(f.leases[0].closed, false);
  if (failed) write.reject(new Error('Inactive release save failed')); else write.resolve();
  await release; await source.generation.retire();
  await eventually(() => f.leases[0].closed);
  if (failed) assert.match(f.app.getSnapshot().storageFailure, /Inactive release save failed/);
  else {
    assert.equal(f.drafts.get('original-view/host/conversation').frontendSends[0].state, 'unavailable-pending'); assert.deepEqual(requests, []);
    f.behavior.write = async () => {};
    await f.app.reopenView('original-view');
    await eventually(() => f.drafts.get('original-view/host/conversation').frontendSends[0].state === 'unavailable-confirmed');
    assert.equal(f.leases.filter(lease => lease.viewId === 'original-view').length, 2);
    assert.equal(f.submitted.length, 1);
  }
});

test('owned-view discovery preserves corrupt journal bytes and blocks admission without agent lookup', async t => {
  const f = fixture(); t.after(() => f.app.dispose().catch(() => {}));
  const corrupt = { ...journalRecord(scope), version: 99 }; f.drafts.set('original-view/host/conversation', corrupt);
  f.behavior.agentLookup = () => { assert.fail('Recovery must not resolve an agent'); };
  await f.app.start(); await eventually(() => Boolean(f.app.getSnapshot().storageFailure));
  assert.match(f.app.getSnapshot().storageFailure, /Unsupported local storage version/);
  assert.equal(f.drafts.get('original-view/host/conversation'), corrupt);
  assert.deepEqual(f.submitted, []); assert.deepEqual(f.feeds, []);
});

test('navigating inactive scopes closes their handles while retaining the selected store', async t => {
  const f = fixture(); t.after(() => f.app.dispose()); await f.app.start();
  const stores = [];
  for (let index = 0; index < 40; index++) {
    await f.app.open({ ...scope, conversationId: `visited-${index}` }); stores.push(f.app.getSnapshot().active.store);
  }
  for (const old of stores.slice(0, -1)) await assert.rejects(old.setDraft('Stale handle'), /closed/);
  await stores.at(-1).setDraft('Current draft');
  assert.equal(f.drafts.get('original-view/host/visited-39').draft, 'Current draft');
  assert.equal(f.app.getSnapshot().storageFailure, '');
});

for (const replacement of ['view', 'same-principal reconnect']) test(`recovery cancellation starts ${replacement} work before the old notification replies`, async t => {
  const f = fixture(), oldReply = deferred(), nextReply = deferred(), requests = [];
  t.after(async () => { oldReply.resolve(); nextReply.resolve(); await f.app.dispose(); });
  f.drafts.set('original-view/host/conversation', journalRecord(scope));
  f.drafts.set('other-view/host/conversation', journalRecord(scope));
  f.behavior.binding = async request => {
    requests.push(request);
    await (requests.length === 1 ? oldReply.promise : nextReply.promise);
    return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' };
  };
  await f.app.start(); await eventually(() => requests.length === 1);
  if (replacement === 'view') await f.app.reopenView('other-view'); else await f.app.reconnect();
  await eventually(() => requests.length === 2);
  if (replacement === 'view') {
    await eventually(() => f.leases[0].closed);
    assert.equal(f.drafts.get('original-view/host/conversation').frontendSends[0].state, 'unavailable-pending');
  }
  const before = structuredClone([...f.drafts]);
  oldReply.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...f.drafts], before);
  assert.equal(f.app.getSnapshot().storageFailure, '');
  nextReply.resolve();
  const key = `${replacement === 'view' ? 'other-view' : 'original-view'}/host/conversation`;
  await eventually(() => f.drafts.get(key).frontendSends[0].state === 'unavailable-confirmed');
  assert.equal(requests.length, 2);
});

test('canceling a notification keeps live captures and drains their admitted release before closing the old view', async t => {
  const f = fixture(), oldReply = deferred(), requests = [];
  t.after(async () => { oldReply.resolve(); await f.app.dispose(); });
  f.behavior.frontendOffers = 'ag-ui-capture-and-bind';
  f.views.set('original-view/host', { ...empty(), route: scope });
  const lost = { ...scope, conversationId: 'a-lost' };
  f.drafts.set('original-view/host/a-lost', journalRecord(lost));
  f.drafts.set('other-view/host/conversation', journalRecord(scope));
  f.behavior.binding = async request => {
    requests.push(request);
    if (request.scope.conversationId === 'a-lost') await oldReply.promise;
    return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' };
  };
  const source = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'live', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'Live' }, decodeInput: x => x, async execute() { throw new Error('No execution'); } }); return { dispose() {} }; } });
  t.after(() => source.generation.retire());
  const token = {}; f.app.frontendGenerations.begin(token); f.app.frontendGenerations.publish(token, { kind: 'ready', generations: [source.generation] });
  await f.app.start(); await eventually(() => requests.length === 1);
  await assert.rejects(f.app.getSnapshot().active.store.send('Live original'), /Reply lost/);
  const live = f.app.getSnapshot().capturedSends.find(row => row.status === 'waiting');
  await f.app.reopenView('other-view');
  await eventually(() => requests.length === 2);
  assert.equal(f.leases[0].closed, false);
  assert.equal(f.app.getSnapshot().capturedSends.find(row => row.key === live.key).status, 'waiting');
  const entered = deferred(), write = deferred();
  f.behavior.write = async () => { entered.resolve(); await write.promise; };
  const release = f.app.releaseCapturedSend(live.key); await entered.promise;
  assert.equal(f.leases[0].closed, false);
  write.resolve(); await release;
  await eventually(() => f.leases[0].closed);
  const before = structuredClone([...f.drafts]);
  oldReply.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...f.drafts], before);
  assert.equal(f.app.getSnapshot().storageFailure, '');
});

test('canceling during the admitted unavailable save drains it before releasing the old lease', async t => {
  const f = fixture(), entered = deferred(), write = deferred(), requests = [];
  t.after(async () => { write.resolve(); await f.app.dispose(); });
  f.drafts.set('original-view/host/conversation', journalRecord(scope));
  f.drafts.set('other-view/host/conversation', journalRecord(scope));
  let first = true;
  f.behavior.write = async () => { if (first) { first = false; entered.resolve(); await write.promise; } };
  f.behavior.binding = async request => { requests.push(request); return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' }; };
  await f.app.start(); await entered.promise;
  await f.app.reopenView('other-view');
  assert.equal(f.leases[0].closed, false); assert.deepEqual(requests, []);
  write.resolve(); await eventually(() => f.leases[0].closed && requests.length === 1);
  assert.equal(f.drafts.get('original-view/host/conversation').frontendSends[0].state, 'unavailable-pending');
  assert.equal(f.app.getSnapshot().storageFailure, '');
});

for (const ending of ['storage failure', 'disposal']) test(`recovery cancellation handles ${ending} before a held reply`, async t => {
  const f = fixture(), gate = deferred(), entered = deferred();
  t.after(async () => { gate.resolve(); await f.app.dispose(); });
  f.drafts.set('original-view/host/conversation', journalRecord(scope));
  f.behavior.binding = async request => { entered.resolve(); await gate.promise; return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' }; };
  await f.app.start(); await entered.promise;
  if (ending === 'storage failure') f.leases[0].failure(new Error('Injected storage failure'));
  let disposed = false;
  const closing = f.app.dispose().then(() => { disposed = true; });
  await eventually(() => disposed); await closing;
  assert.equal(f.leases[0].closed, true);
  const before = structuredClone([...f.drafts]);
  gate.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...f.drafts], before);
  assert.equal(f.app.getSnapshot().storageFailure, ending === 'storage failure' ? 'Injected storage failure' : '');
});


for (const destination of ['other-view', 'original-view']) test(`a rejected ${destination} selection preserves the original loaded view and recovery pass`, async t => {
  const f = fixture(), gate = deferred(), requests = [];
  t.after(async () => { gate.resolve(); await f.app.dispose(); });
  f.drafts.set('original-view/host/conversation', journalRecord(scope));
  f.behavior.binding = async request => {
    requests.push(request);
    if (requests.length === 1) await gate.promise;
    return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' };
  };
  await f.app.start(); await eventually(() => requests.length === 1);
  f.behavior.select = () => { throw new Error('Selection failed'); };
  await f.app.reopenView(destination);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  if (destination === 'other-view') assert.equal(f.leases[1].closed, true);
  else assert.equal(f.leases.length, 1);
  gate.resolve();
  assert.match(f.app.getSnapshot().error, /Selection failed/);
  assert.equal(f.leases[0].closed, false);
  await eventually(() => f.drafts.get('original-view/host/conversation').frontendSends[0].state === 'unavailable-confirmed');
  assert.equal(requests.length, 1);
});

test('reconnect cancels the previous pass while metadata is held and starts only after refresh finishes', async t => {
  const f = fixture(), oldReply = deferred(), metadata = deferred(), entered = deferred(), requests = [];
  t.after(async () => { oldReply.resolve(); metadata.resolve(); await f.app.dispose(); });
  f.drafts.set('original-view/host/conversation', journalRecord(scope));
  f.behavior.binding = async request => {
    requests.push(request);
    if (requests.length === 1) await oldReply.promise;
    return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' };
  };
  await f.app.start(); await eventually(() => requests.length === 1);
  f.behavior.metadata = async () => { entered.resolve(); await metadata.promise; };
  const refreshing = f.app.reconnect(); await entered.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.app.getSnapshot().host.kind, 'loading'); assert.equal(requests.length, 1);
  metadata.resolve(); await refreshing;
  await eventually(() => requests.length === 2);
  await eventually(() => f.drafts.get('original-view/host/conversation').frontendSends[0].state === 'unavailable-confirmed');
});

for (const ending of ['navigation', 'disposal']) test(`a corrupt pending load releases its physical lease after ${ending}`, async () => {
  const f = fixture(), gate = deferred(), entered = deferred(), corrupt = { version: 99, scope };
  f.drafts.set('original-view/host/conversation', corrupt);
  f.behavior.load = async (_scope, id) => { if (id === 'original-view') { entered.resolve(); await gate.promise; } };
  try {
    await f.app.start(); await entered.promise;
    if (ending === 'navigation') await f.app.reopenView('other-view');
    const closing = ending === 'disposal' ? f.app.dispose() : null;
    gate.reject(new Error('Corrupt draft load'));
    if (closing) await closing;
    await eventually(() => f.leases[0].closed);
    assert.equal(f.app.getSnapshot().storageFailure, '');
    assert.equal(f.drafts.get('original-view/host/conversation'), corrupt);
    assert.deepEqual(f.submitted, []);
  } finally { gate.resolve(); await f.app.dispose().catch(() => {}); }
});

test('disposal waits for every physical close before rejecting the first close failure', async t => {
  const f = fixture(), gate = deferred(), entered = deferred(), closes = [];
  t.after(async () => { gate.resolve(); await f.app.dispose().catch(() => {}); });
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  f.behavior.close = owner => {
    closes.push(owner.viewId);
    if (owner.viewId === 'original-view') throw new Error('First physical close failed');
    entered.resolve(); return gate.promise;
  };
  await f.app.reopenView('other-view');
  await eventually(() => Boolean(f.app.getSnapshot().storageFailure));
  let settled = false;
  const closing = f.app.dispose();
  const rejected = assert.rejects(closing, /First physical close failed/).then(() => { settled = true; });
  await entered.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  gate.resolve(); await rejected;
  assert.deepEqual(closes, ['original-view', 'other-view']);
  assert.equal(f.app.dispose(), closing);
});

test('an existing selection reserves its lease while a storage callback releases its last capture', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.behavior.frontendOffers = 'ag-ui-capture-and-bind';
  f.views.set('original-view/host', { ...empty(), route: scope });
  const source = await createFrontendToolGeneration({ namespace: 'fixture', generation: 'reserved', platform: 'desktop', capture: () => undefined,
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'echo', description: 'Original' }, decodeInput: x => x, async execute() { throw new Error('No effects'); } }); return { dispose() {} }; } });
  const token = {}; f.app.frontendGenerations.begin(token); f.app.frontendGenerations.publish(token, { kind: 'ready', generations: [source.generation] });
  await f.app.start();
  await assert.rejects(f.app.getSnapshot().active.store.send('Pending'), /Reply lost/);
  await f.app.reopenView('other-view');
  assert.equal(f.leases[0].closed, false);
  f.behavior.select = () => {
    f.leases[0].failure(new Error('Selection storage failed'));
    assert.equal(f.leases[0].closed, false);
  };
  await f.app.reopenView('original-view');
  assert.match(f.app.getSnapshot().storageFailure, /Selection storage failed/);
  assert.equal(f.leases[0].closed, false);
  await source.generation.retire();
});

for (const destination of ['original-view', 'fresh-view']) test(`disposal inside physical selection cannot install ${destination}`, async () => {
  const f = fixture();
  await f.app.start();
  let closing;
  f.behavior.select = () => { closing = f.app.dispose(); };
  await f.app.reopenView(destination); await closing;
  assert(f.leases.every(lease => lease.closed));
  assert.equal(f.metadataCalls(), 1);
});

test('a fresh rejected selection retains its failed physical close for disposal and drains the selected lease', async t => {
  const f = fixture(), gate = deferred(), entered = deferred(), closes = [];
  t.after(async () => { gate.resolve(); await f.app.dispose().catch(() => {}); });
  await f.app.start();
  f.behavior.select = () => { throw new Error('Candidate selection failed'); };
  f.behavior.close = owner => {
    closes.push(owner.viewId);
    if (owner.viewId === 'candidate-view') throw new Error('Candidate close failed');
    entered.resolve(); return gate.promise;
  };
  await f.app.reopenView('candidate-view');
  assert.match(f.app.getSnapshot().storageFailure, /Candidate close failed/);
  assert.match(f.app.getSnapshot().error, /Candidate selection failed/);
  assert.equal(f.leases[0].closed, false);
  assert.deepEqual(closes, ['candidate-view']);
  let settled = false;
  const closing = f.app.dispose();
  const rejected = assert.rejects(closing, /Candidate close failed/).then(() => { settled = true; });
  await entered.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  gate.resolve(); await rejected;
  assert.deepEqual(closes, ['candidate-view', 'original-view']);
  assert.equal(f.app.dispose(), closing);
});

test('old capture disposal save failure does not poison a restarted owner', async t => {
  const f=fixture(); f.behavior.frontendOffers='ag-ui-capture-and-bind';
  f.views.set('original-view/host',{...empty(),route:scope});
  const source=await createFrontendToolGeneration({namespace:'fixture',generation:'A',platform:'desktop',capture:()=>undefined,
    activate({frontendTools}){frontendTools.add({definition:{name:'echo',description:'Original'},decodeInput:x=>x,async execute(){throw Error('No execution');}});return{dispose(){}};}});
  const token={}; f.app.frontendGenerations.begin(token);f.app.frontendGenerations.publish(token,{kind:'ready',generations:[source.generation]});
  const gate=deferred(),entered=deferred();
  t.after(async()=>{gate.reject(new Error('Cleanup'));await f.app.dispose();await source.generation.retire();});
  await f.app.start();
  f.behavior.submit=async command=>({kind:'receipt',receipt:{scope,clientCommandId:command.clientCommandId,hostOperationId:'operation',sequence:1,state:{kind:'completed'}}});
  await f.app.getSnapshot().active.store.send('Original');
  const original=f.drafts.get('original-view/host/conversation').frontendSends[0];
  let held=true;
  f.behavior.write=async()=>{if(held){held=false;entered.resolve();await gate.promise;}};
  const closing=f.app.dispose();await entered.promise;
  const restarted=f.app.start();gate.reject(new Error('Only old capture save failed'));
  await Promise.all([closing,restarted]);
  const state=f.app.getSnapshot();
  assert.equal(state.storageFailure,'');assert.equal(state.host.kind,'ready');
  await state.active.store.setDraft('Healthy restarted draft');
  const saved=f.drafts.get('original-view/host/conversation');
  assert.equal(saved.draft,'Healthy restarted draft');assert.deepEqual(saved.frontendSends[0].command,original.command);assert.equal(saved.frontendSends[0].ownerId,original.ownerId);
});

test('image previews and uploads share one host transfer slot, reusing concurrent reads and retrying refused overlaps', async t => {
  const f = fixture(); t.after(() => f.app.dispose());
  f.views.set('original-view/host', { ...empty(), route: scope });
  await f.app.start();
  const active = f.app.getSnapshot().active;
  let busy = false, overlaps = 0;
  const reads = [], uploads = [];
  // Mirrors the host: one transfer per host, overlaps refused as unavailable.
  const transfer = async work => {
    if (busy) { overlaps++; throw new ServiceError('unavailable', 'Another image transfer is in progress. Try again.'); }
    busy = true;
    try { await new Promise(resolve => setTimeout(resolve, 5)); return work(); } finally { busy = false; }
  };
  let refuseFirstUpload = true;
  f.behavior.readImage = (_, imageId) => transfer(() => { reads.push(imageId); return { attachment: null, bytes: new Uint8Array([imageId.length]) }; });
  f.behavior.uploadImage = input => {
    if (refuseFirstUpload) { refuseFirstUpload = false; return Promise.reject(new ServiceError('unavailable', 'Another image transfer is in progress. Try again.')); }
    return transfer(() => { uploads.push(input.uploadId);
      return { imageId: '00000000-0000-4000-8000-aaaaaaaaaaaa', name: input.name, mediaType: 'image/png', byteLength: input.bytes.byteLength, width: 1, height: 1 }; });
  };
  f.behavior.uuids = true;
  const actions = f.app.conversationActions(active);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
  const previews = ['a', 'bb', 'a', 'ccc'].map(id => actions.readImage(id));
  const selecting = active.store.selectImage({ name: 'chart.png', bytes: png });
  assert.deepEqual((await Promise.all(previews)).map(bytes => [...bytes]), [[1], [2], [1], [3]]);
  await selecting;
  assert.equal(active.store.getSnapshot().image.status, 'ready');
  assert.deepEqual(reads, ['a', 'bb', 'ccc']);
  assert.equal(uploads.length, 1);
  assert.equal(overlaps, 0);
  let refusals = 0;
  f.behavior.readImage = async () => { refusals++; throw new ServiceError('unavailable', 'Busy'); };
  await assert.rejects(actions.readImage('d'), { kind: 'unavailable' });
  assert.equal(refusals, 3);
  f.behavior.readImage = async () => { refusals++; throw new ServiceError('image-scope', 'Elsewhere'); };
  await assert.rejects(actions.readImage('d'), { kind: 'image-scope' });
  assert.equal(refusals, 4);
  assert.equal(f.app.getSnapshot().error, '');
});
