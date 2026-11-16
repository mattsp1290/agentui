import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationStore } from '@agentui/client';
import { fakePort, storage, scope, projection, receipt } from './support.mjs';

const offer = { platform: 'desktop', tools: [{ definition: { name: 'fixture__echo', description: 'Original' }, activationId: 'A' }] };
test('both send callers atomically journal the exact original offer before dispatch and never recapture on retry', async () => {
  const drafts = storage(), port = fakePort(); let captures = 0;
  const frontend = { capture() { captures++; return { ownerId: 'principal', offer, release() {}, commit() { return true; } }; },
    canRetry() { return true; }, async rejected() {} };
  port.submit = async command => {
    assert.equal(command.version, 2);
    assert.deepEqual(drafts.value.frontendSends.at(-1).command, command);
    assert.equal(drafts.value.frontendSends.at(-1).ownerId, 'principal');
    assert.deepEqual(drafts.value.outbox.at(-1).command, command);
    return { kind: 'receipt', receipt: receipt(command) };
  };
  let id = 0;
  const store = createConversationStore({ scope, port, projection, drafts, frontend, createCommandId: () => String(++id) });
  await store.setDraft('Composer'); await store.send(); await store.retry('1'); await store.send('Extension');
  assert.equal(captures, 2);
  await store.frontendJournal.unavailable('1'); await store.frontendJournal.acknowledged('1');
  assert.equal(drafts.value.frontendSends[0].state, 'unavailable-confirmed');
});

test('version one local records upgrade without changing canonical commands and corrupt recovery identities refuse before writes', async () => {
  const plain = { version: 1, scope, clientCommandId: 'old', body: { kind: 'send', text: 'Original' } };
  const old = { version: 1, scope, draft: 'Unsent', draftRevision: 1, outbox: [{ command: plain, draftRevision: 0 }] };
  const drafts = storage(old), port = fakePort();
  const store = createConversationStore({ scope, port, projection, drafts, createCommandId: () => 'new' });
  await store.setDraft('Edited');
  assert.equal(drafts.value.version, 2); assert.deepEqual(drafts.value.frontendSends, []); assert.deepEqual(drafts.value.outbox[0].command, plain);
  const command = { ...plain, version: 2, body: { ...plain.body, frontend: offer } };
  const valid = { ...drafts.value, outbox: [{ command: structuredClone(command), draftRevision: 0 }], frontendSends: [{ command, ownerId: 'original', state: 'retained' }] };
  for (const change of [value => { value.frontendSends = []; }, value => { value.frontendSends[0].ownerId = ''; },
    value => { value.frontendSends[0].command.body.text = 'Changed'; }, value => { value.frontendSends[0].state = 'bound'; },
    value => { value.frontendSends.push(value.frontendSends[0]); }]) {
    const corrupt = structuredClone(valid); change(corrupt); const storagePort = storage(corrupt);
    const restored = createConversationStore({ scope, port, projection, drafts: storagePort, createCommandId: () => 'new' });
    await assert.rejects(restored.ready); await assert.rejects(restored.send('Unsafe'));
    assert.deepEqual(storagePort.writes, []);
  }
});

for (const result of ['receipt', 'rejected', 'lookup']) test(`terminal disposal fences late ${result} without waiting for transport or overwriting a successor`, async () => {
  const { deferred } = await import('./support.mjs');
  const drafts = storage(), port = fakePort(), gate = deferred(), entered = deferred();
  const old = createConversationStore({ scope, projection, drafts, port, createCommandId: () => 'original' });
  await old.setDraft('Original');
  if (result !== 'lookup') port.submit = command => { entered.resolve(command); return gate.promise; };
  if (result === 'lookup') { await old.send(); port.receipt = () => { entered.resolve(port.submitted[0]); return gate.promise; }; }
  const sending = result === 'lookup' ? old.refreshReceipt('original') : old.send();
  const rejected = assert.rejects(sending, /closed/), command = await entered.promise;
  const closing = old.dispose(); assert.equal(old.dispose(), closing); await closing;
  const nextPort = fakePort(), successor = createConversationStore({ scope, projection, drafts, port: nextPort, createCommandId: () => 'next' });
  await successor.setDraft('Successor draft'); const before = structuredClone(drafts.value);
  gate.resolve(result === 'lookup' ? receipt(command, 'completed') : result === 'rejected' ? { kind: 'rejected', reason: 'absent' } : { kind: 'receipt', receipt: receipt(command, 'completed') });
  await rejected;
  assert.deepEqual(drafts.value, before); assert.equal(drafts.value.outbox.length, 1);
  await assert.rejects(old.setDraft('Closed edit'), /closed/);
  await assert.rejects(old.connect(), /closed/);
  assert.deepEqual(drafts.value, before);
  nextPort.receipt = async () => receipt(command, 'completed');
  await successor.refreshReceipt('original');
  assert.equal(drafts.value.outbox.length, 0); assert.equal(drafts.value.draft, 'Successor draft');
  await successor.dispose();
});

test('terminal disposal drains admitted journal saves and retains duplicate IDs after final settlement and reload', async () => {
  const { deferred } = await import('./support.mjs');
  const drafts = storage(), port = fakePort();
  const frontend = { capture: () => ({ ownerId: 'principal', offer, release() {}, commit: () => true }), canRetry: () => true, async rejected() {} };
  port.submit = async command => ({ kind: 'receipt', receipt: receipt(command, 'completed') });
  const store = createConversationStore({ scope, projection, drafts, port, frontend, createCommandId: () => 'same' });
  await store.send('Original');
  const gate = deferred(), entered = deferred(), save = drafts.save.bind(drafts);
  drafts.save = async records => { entered.resolve(); await gate.promise; await save(records); };
  const writing = store.frontendJournal.acknowledged('same'); await entered.promise;
  let disposed = false; const closing = store.dispose().then(() => { disposed = true; });
  await Promise.resolve(); assert.equal(disposed, false); gate.resolve(); await Promise.all([writing, closing]);
  assert.equal(drafts.value.frontendSends[0].state, 'unavailable-confirmed'); assert.equal(drafts.value.outbox.length, 0);
  const next = createConversationStore({ scope, projection, drafts, port, frontend, createCommandId: () => 'same' });
  await assert.rejects(next.send('Reuse'), /reused/); await next.dispose();
});

for (const timing of ['before disposal', 'during disposal']) test(`failed hydration ${timing} drains without erasing the error or rewriting corrupt bytes`, async () => {
  const { deferred } = await import('./support.mjs');
  const gate = deferred(), corrupt = { version: 99, scope }, drafts = storage(corrupt);
  drafts.load = () => gate.promise;
  const store = createConversationStore({ scope, projection, drafts, port: fakePort(), createCommandId: () => 'never' });
  const rejected = assert.rejects(store.ready, /Unsupported local storage version/);
  let closing;
  if (timing === 'during disposal') closing = store.dispose();
  gate.resolve(corrupt); await rejected;
  if (!closing) closing = store.dispose();
  await closing;
  assert.equal(store.getSnapshot().connection.kind, 'failed');
  assert.match(store.getSnapshot().connection.reason, /Unsupported local storage version/);
  await assert.rejects(store.send('Never'), /Unsupported local storage version/);
  await assert.rejects(store.frontendJournal.unavailable('never'), /closed/);
  assert.deepEqual(drafts.value, corrupt); assert.deepEqual(drafts.writes, []);
});

for (const timing of ['sequential', 'concurrent']) test(`journal mutations preserve failed hydration for ${timing} calls`, async () => {
  const { deferred } = await import('./support.mjs');
  const gate = deferred(), corrupt = { version: 99, scope, draft: 'Preserve the failed-load record' }, drafts = storage(corrupt);
  drafts.load = () => gate.promise;
  const store = createConversationStore({ scope, projection, drafts, port: fakePort(), createCommandId: () => 'never' });
  const failure = /Unsupported local storage version/;
  const ready = assert.rejects(store.ready, failure);
  try {
    if (timing === 'concurrent') {
      const mutations = Promise.all([store.frontendJournal.unavailable('original'), store.frontendJournal.acknowledged('original'),
        store.frontendJournal.unavailable('original')].map(result => assert.rejects(result, failure)));
      gate.resolve(corrupt); await ready; await mutations;
    } else {
      gate.resolve(corrupt); await ready;
      await assert.rejects(store.frontendJournal.unavailable('original'), failure);
      await assert.rejects(store.frontendJournal.acknowledged('original'), failure);
      await assert.rejects(store.frontendJournal.unavailable('original'), failure);
    }
    assert.equal(store.getSnapshot().connection.kind, 'failed');
    assert.deepEqual(drafts.value, corrupt); assert.deepEqual(drafts.writes, []);
  } finally { gate.resolve(corrupt); await store.dispose(); }
});

test('journal can recover after an ordinary save error once hydration succeeded', async () => {
  const drafts = storage(), save = drafts.save.bind(drafts);
  let fail = true;
  drafts.save = async value => { if (fail) { fail = false; throw new Error('Journal save failed'); } await save(value); };
  const store = createConversationStore({ scope, projection, drafts, port: fakePort(), createCommandId: () => 'never' });
  try {
    await store.ready;
    await assert.rejects(store.frontendJournal.unavailable('original'), /Journal save failed/);
    await store.frontendJournal.acknowledged('original');
    assert.equal(drafts.writes.length, 1);
  } finally { await store.dispose(); }
});


for (const [kind, action] of [['generic', 'dispose'], ['offered', 'dispose'], ['offered', 'release']]) {
  test(`${kind} ${action} during submitting publication prevents transport and retains the original command`, async t => {
    const drafts = storage(), port = fakePort();
    let retained = true, invalidated = false;
    const frontend = kind === 'offered' ? {
      capture: () => ({ ownerId: 'principal', offer, release() {}, commit: () => true }),
      canRetry: () => retained, async rejected() {},
    } : undefined;
    const store = createConversationStore({ scope, port, projection, drafts, frontend, createCommandId: () => 'command' });
    t.after(() => store.dispose());
    store.subscribe(() => {
      if (invalidated || !store.getSnapshot().submitting.length) return;
      invalidated = true;
      if (action === 'dispose') void store.dispose(); else retained = false;
    });
    await assert.rejects(store.send('Original'), action === 'dispose' ? /closed/ : /unavailable/);
    assert.equal(invalidated, true);
    assert.equal(port.submitted.length, 0);
    assert.equal(drafts.value.outbox[0].command.clientCommandId, 'command');
    assert.equal(drafts.value.outbox[0].command.body.text, 'Original');
    assert.deepEqual(store.getSnapshot().submitting, []);
    if (kind === 'offered') assert.deepEqual(drafts.value.frontendSends[0].command, drafts.value.outbox[0].command);
  });
}
