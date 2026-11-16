import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationStore } from '@agentui/client';
import { fakePort, storage, scope, projection, receipt } from './support.mjs';

const offer = { platform: 'desktop', tools: [{ definition: { name: 'fixture__echo', description: 'Original' }, activationId: 'A' }] };
test('both send callers atomically journal the exact original offer before dispatch and never recapture on retry', async () => {
  const drafts = storage(), port = fakePort(); let captures = 0, journal;
  const frontend = { ownerId: 'principal', capture() { captures++; return { offer, release() {}, commit() { return true; } }; },
    restore(value) { journal = value; }, canRetry() { return true; }, async rejected() {} };
  port.submit = async command => {
    assert.equal(command.version, 2);
    assert.deepEqual(drafts.value.frontendSends.at(-1).command, command);
    assert.deepEqual(drafts.value.outbox.at(-1).command, command);
    return { kind: 'receipt', receipt: receipt(command) };
  };
  let id = 0;
  const store = createConversationStore({ scope, port, projection, drafts, frontend, createCommandId: () => String(++id) });
  await store.setDraft('Composer'); await store.send(); await store.retry('1'); await store.send('Extension');
  assert.equal(captures, 2);
  await journal.unavailable('1'); await journal.acknowledged('1');
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
