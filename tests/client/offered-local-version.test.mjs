import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, scope, storage } from './support.mjs';

for (const version of [1, 2]) test(`local records ${version} refuse offered commands without rewriting saved data`, async () => {
  const command = { version: 2, scope, clientCommandId: 'original-offer', body: { kind: 'send', text: 'Keep original',
    frontend: { platform: 'desktop', tools: [{ activationId: 'original', definition: { name: 'original__read', description: 'Read' } }] } } };
  const original = { version, scope, draft: 'Keep draft', draftRevision: 1, outbox: [{ command, draftRevision: 1 }],
    ...(version === 2 ? { image: null } : {}) };
  const drafts = storage(original), bytes = new Uint8Array([1, 2, 3]);
  drafts.images.set('retained-image', bytes);
  const { store, port } = fixture({ drafts });
  await assert.rejects(store.ready, /Unsupported saved command version/);
  for (const operation of [() => store.setDraft('Changed'), () => store.send(), () => store.retry(command.clientCommandId)]) {
    await assert.rejects(operation(), /Unsupported saved command version/);
  }
  assert.deepEqual(drafts.value, original);
  assert.deepEqual(drafts.images.get('retained-image'), bytes);
  assert.deepEqual(drafts.writes, []);
  assert.deepEqual(drafts.imageWrites, []);
  assert.deepEqual(port.submitted, []);
});
