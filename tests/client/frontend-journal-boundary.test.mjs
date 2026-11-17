import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, parseCommand } from '@agentui/contracts';
import { createConversationStore } from '@agentui/client';
import { fakePort, storage, scope, projection, receipt } from './support.mjs';

for (const count of [1, 10]) test(`actual client saves and reloads ${count} legal large offers without losing history`, async t => {
  const drafts = storage(), port = fakePort();
  const offer = { platform: 'desktop', tools: [{ definition: { name: 'fixture__large', description: 'Large valid object schema',
    parameters: { type: 'object', properties: { value: { type: 'integer', enum: Array.from({ length: 10_000 }, (_, n) => n) } } } }, activationId: 'A' }] };
  const frontend = { capture: () => ({ ownerId: 'principal', offer, release() {}, commit: () => true }), canRetry: () => true, async rejected() {} };
  port.submit = async command => ({ kind: 'receipt', receipt: receipt(command, 'completed') });
  let id = 0;
  const store = createConversationStore({ scope, projection, drafts, port, frontend, createCommandId: () => String(++id) });
  t.after(() => store.dispose());
  for (let n = 1; n <= count; n++) {
    await store.send('Valid offer');
    await store.frontendJournal.unavailable(String(n));
    await store.frontendJournal.acknowledged(String(n));
  }
  assert.equal(drafts.value.frontendSends.length, count);
  assert.equal(drafts.value.outbox.length, 0);
  for (const entry of drafts.value.frontendSends) {
    assert.deepEqual(parseCommand(entry.command), entry.command);
    assert.ok(Buffer.byteLength(canonicalJson(entry.command)) < 64_000);
    assert.equal(entry.state, 'unavailable-confirmed');
  }
  const original = structuredClone(drafts.value.frontendSends);
  await store.dispose();
  const reloaded = createConversationStore({ scope, projection, drafts, port, frontend, createCommandId: () => 'never' });
  t.after(() => reloaded.dispose());
  await reloaded.ready;
  assert.deepEqual(reloaded.frontendJournal.read(), original);
  await reloaded.setDraft('Still editable after reload');
  assert.deepEqual(drafts.value.frontendSends, original);
  await reloaded.dispose();
  const again = createConversationStore({ scope, projection, drafts, port, createCommandId: () => 'never' });
  t.after(() => again.dispose());
  await again.ready;
  assert.deepEqual(again.frontendJournal.read(), original);
  assert.equal(again.getSnapshot().draft, 'Still editable after reload');
});

test('saved offers keep the standalone command depth budget through outbox and history', async t => {
  let metadata = {};
  for (let depth = 0; depth < 58; depth++) metadata = { nested: metadata };
  const offer = { platform: 'desktop', tools: [{ definition: { name: 'fixture__deep', description: 'Deep metadata', metadata }, activationId: 'A' }] };
  const command = { version: 2, scope, clientCommandId: 'deep', body: { kind: 'send', text: 'Deep', frontend: offer } };
  assert.deepEqual(parseCommand(command), command);
  const tooDeep = structuredClone(command);
  tooDeep.body.frontend.tools[0].definition.metadata = { nested: metadata };
  assert.throws(() => parseCommand(tooDeep), /structural limit/);
  const drafts = storage(), port = fakePort();
  const store = createConversationStore({ scope, projection, drafts, port, createCommandId: () => 'deep',
    frontend: { capture: () => ({ ownerId: 'principal', offer, release() {}, commit: () => true }), canRetry: () => true, async rejected() {} } });
  t.after(() => store.dispose());
  await store.send('Deep');
  const saved = structuredClone(drafts.value);
  await store.dispose();
  const reloaded = createConversationStore({ scope, projection, drafts, port, createCommandId: () => 'never' });
  t.after(() => reloaded.dispose());
  await reloaded.ready;
  await reloaded.setDraft('After deep reload');
  assert.deepEqual(drafts.value.frontendSends, saved.frontendSends);
  assert.deepEqual(drafts.value.outbox, saved.outbox);
});

for (const malformed of ['outer getter', 'outer prototype', 'array getter', 'sparse array', 'array symbol', 'command cycle', 'command depth', 'command getter', 'entry getter', 'extra field', 'duplicate identity', 'wrong scope', 'wrong revision', 'missing owner']) {
  test(`malformed journal ${malformed} is refused without rewriting storage`, async t => {
    const command = { version: 2, scope, clientCommandId: 'original', body: { kind: 'send', text: 'Saved', frontend: {
      platform: 'desktop', tools: [{ definition: { name: 'fixture__echo', description: 'Original' }, activationId: 'A' }] } } };
    const input = { version: 3, scope, draft: 'Keep me', draftRevision: 1, image: null,
      outbox: [{ command, draftRevision: 1 }], frontendSends: [{ command, ownerId: 'principal', state: 'retained' }] };
    let getterCalls = 0;
    const getter = () => { getterCalls++; throw new Error('Getter was invoked'); };
    if (malformed === 'outer getter') Object.defineProperty(input, 'draft', { get: getter });
    if (malformed === 'outer prototype') Object.setPrototypeOf(input, { inherited: true });
    if (malformed === 'array getter') Object.defineProperty(input.frontendSends, '0', { get: getter });
    if (malformed === 'sparse array') delete input.frontendSends[0];
    if (malformed === 'array symbol') input.frontendSends[Symbol('extra')] = true;
    if (malformed === 'command cycle') command.body.frontend.tools[0].definition.metadata = input;
    if (malformed === 'command depth') {
      let metadata = {};
      for (let depth = 0; depth < 59; depth++) metadata = { nested: metadata };
      command.body.frontend.tools[0].definition.metadata = metadata;
    }
    if (malformed === 'command getter') Object.defineProperty(command.body, 'text', { get: getter });
    if (malformed === 'entry getter') Object.defineProperty(input.frontendSends[0], 'ownerId', { get: getter });
    if (malformed === 'extra field') input.extra = true;
    if (malformed === 'duplicate identity') input.frontendSends.push(input.frontendSends[0]);
    if (malformed === 'wrong scope') command.scope = { ...scope, hostId: 'other' };
    if (malformed === 'wrong revision') input.outbox[0].draftRevision = 2;
    if (malformed === 'missing owner') input.frontendSends[0].ownerId = '';
    const descriptors = Object.getOwnPropertyDescriptors(input), writes = [];
    const store = createConversationStore({ scope, projection, port: fakePort(), createCommandId: () => 'never',
      drafts: { async load() { return input; }, async save(value) { writes.push(value); } } });
    t.after(() => store.dispose());
    await assert.rejects(store.ready);
    await assert.rejects(store.setDraft('Must not overwrite'));
    await assert.rejects(store.frontendJournal.unavailable('original'));
    assert.deepEqual(writes, []);
    assert.equal(getterCalls, 0);
    assert.deepEqual(Object.getOwnPropertyDescriptors(input), descriptors);
  });
}
