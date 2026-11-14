import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserConnection } from '@agentui/client/service';
import { fixture, scope, storage } from './support.mjs';

for (const [label, text] of [['characters', 'x'.repeat(64001)], ['UTF-8 bytes', '🙂'.repeat(20000)], ['JSON escape bytes', '\0'.repeat(12000)]]) {
  test(`a ${label} overflow never reaches the network or strands a fresh command`, async () => {
    let calls = 0;
    const connection = createBrowserConnection({ fetch: async () => { calls++; throw new Error('Must not send'); } });
    const f = fixture({ port: connection.conversation(scope) });
    await f.store.setDraft(text);
    const result = await f.store.send();
    assert.equal(result.kind, 'rejected');
    assert.match(result.reason, /too large/);
    assert.equal(calls, 0);
    assert.deepEqual(f.store.getSnapshot().outbox, []);
    assert.equal(f.store.getSnapshot().draft, text);
  });
}
test('a local refusal of an old uncertain retry cannot erase its earlier identity or body', async () => {
  let calls = 0;
  const command = { version: 1, scope, clientCommandId: 'original', body: { kind: 'send', text: '🙂'.repeat(20000) } };
  const drafts = storage({ version: 1, scope, draft: 'newer', draftRevision: 2, outbox: [{ command, draftRevision: 1 }] });
  const connection = createBrowserConnection({ fetch: async () => { calls++; throw new Error('Must not send'); } });
  const f = fixture({ drafts, port: connection.conversation(scope) });
  const result = await f.store.retry('original');
  assert.equal(result.kind, 'rejected');
  assert.equal(calls, 0);
  assert.deepEqual(f.store.getSnapshot().outbox[0].command, command);
  assert.equal(f.store.getSnapshot().draft, 'newer');
});
