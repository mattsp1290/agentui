import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { CrewHttpError, CrewUnknownOutcomeError } from '@birbcrew/client';
import { fixture, conversationId, memberId, scope } from './http-fixture.mjs';

function assertRequestOnlyWrites(calls) {
  assert.ok(calls.filter(call => call.method === 'POST').every(call =>
    call.url === `/v1/conversations/${conversationId}/requests`));
}

test('packed SDK sends saved intent for an existing Crew member and retains remote authority', async t => {
  const f = await fixture(t), conversation = await f.open();
  const receipt = await conversation.send('Inspect the existing member conversation');
  assert.equal(receipt.status, 'completed');
  assert.deepEqual(conversation.runIdentity(), { conversation: scope, runId: receipt.requestId,
    authority: { kind: 'remote-provider', binding: { namespace: 'crew',
      installationId: 'crew-fixture-installation', opaqueSessionId: conversationId } } });
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(saved.receipt, receipt);
  assert.equal(saved.memberId, memberId);
  assert.equal(f.state.entries, 1);
  assertRequestOnlyWrites(f.calls);
  const next = await conversation.send('A second request after completion');
  assert.notEqual(next.requestId, receipt.requestId);
  assert.equal(f.state.entries, 2);
});

test('unknown outcome survives recreation, read-only missing lookup and explicit same-ID retry', async t => {
  const f = await fixture(t);
  const conversation = await f.open();
  f.state.dropReply = true;
  await assert.rejects(conversation.send('Do this once'), CrewUnknownOutcomeError);
  const original = conversation.intent();
  assert.equal(original.receipt, null);
  assert.equal(f.state.entries, 1);
  await assert.rejects(conversation.send('A different request'), /original Crew request/);
  const restored = await f.open();
  assert.deepEqual(restored.intent(), original);
  f.state.missingStatus = true;
  await assert.rejects(restored.reconcile(), error => error instanceof CrewHttpError && error.status === 404);
  assert.deepEqual(restored.intent(), original);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  f.state.missingStatus = false;
  const receipt = await restored.retry();
  assert.equal(receipt.requestId, original.command.requestId);
  const writes = f.calls.filter(call => call.method === 'POST');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].body, writes[1].body);
  assert.equal(f.state.entries, 1);
  assertRequestOnlyWrites(f.calls);
});

test('explicit reconciliation resolves a lost reply through GET without dispatching again', async t => {
  const f = await fixture(t), conversation = await f.open();
  f.state.dropReply = true;
  await assert.rejects(conversation.send('Lookup only'), CrewUnknownOutcomeError);
  const before = conversation.intent().command;
  const restored = await f.open();
  const receipt = await restored.reconcile();
  assert.equal(receipt.status, 'completed');
  assert.deepEqual(restored.intent().command, before);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.state.entries, 1);
});

test('failed durable save prevents any request dispatch', async t => {
  const f = await fixture(t);
  const conversation = await f.open({ intents: { load: async () => null, save: async () => { throw new Error('Disk full'); } } });
  await assert.rejects(conversation.send('Never dispatched'), /Disk full/);
  assert.equal(conversation.intent(), null);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
});

test('stored intent rejects foreign scope, remote installation and corrupted receipt identity before HTTP', async t => {
  const f = await fixture(t), conversation = await f.open();
  await conversation.send('Bind this intent');
  const calls = f.calls.length;
  await assert.rejects(f.open({ scope: { ...scope, conversationId: 'foreign' } }), /another scope or remote authority/);
  await assert.rejects(f.open({ installationId: 'another-crew-service' }), /another scope or remote authority/);
  const stored = conversation.intent();
  stored.receipt.requestId = '44444444-4444-4444-8444-444444444444';
  await writeFile(f.path, JSON.stringify(stored));
  await assert.rejects(f.open(), /another scope or remote authority/);
  assert.equal(f.calls.length, calls);
});

test('conversation-member mismatch rejects using GET without creating or registering anything', async t => {
  const f = await fixture(t);
  f.state.remoteMember = '44444444-4444-4444-8444-444444444444';
  await assert.rejects(f.open(), /another member/);
  assert.deepEqual(f.calls.map(call => call.method), ['GET']);
});
