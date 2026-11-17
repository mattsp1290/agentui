import assert from 'node:assert/strict';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { createServiceConnection } from '../../../packages/client/dist/service-engine.js';

const input = await new Promise(resolve => process.once('message', resolve));
const connection = createServiceConnection(async (body, { op, signal }) => {
  const response = await fetch(`${input.origin}/native/v1`, {
    method: 'POST', signal, redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!input.recover && op === 'submit') {
    await response.body?.cancel();
    signal.throwIfAborted();
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }
  return response;
}, transcriptProjection);
const metadata = await connection.metadata();
assert.equal(metadata.hostId, input.hostId);
assert.equal(metadata.principalId, 'trusted-owner');
const scope = { hostId: input.hostId, conversationId: 'native-process-lifetime' };
await connection.create(scope, metadata.defaultAgentId);
const port = connection.conversation(scope);
let feed;
const snapshot = new Promise(resolve => {
  feed = port.watch({ after: null, projectionVersion: 4 }, item => { if (item.kind === 'snapshot') resolve(item.snapshot); });
});
const before = await snapshot;
const command = { version: 1, scope, clientCommandId: 'same-original-id', body: { kind: 'send', text: 'A separate host owns this command.' } };
if (input.recover) {
  const receipt = await connection.reconcile(scope, command.clientCommandId);
  assert.equal(receipt.state.kind, 'completed');
  assert.equal(Object.keys(before.document.decisions).length, 1);
  assert.equal(before.document.domain.messages.filter(value => value.role === 'user').length, 1);
  assert.deepEqual((await port.submit(command)).receipt, receipt);
  feed.close();
  await feed.ended;
  process.send({ kind: 'recovered', hostOperationId: receipt.hostOperationId });
  process.disconnect();
} else {
  feed.close();
  await feed.ended;
  await port.submit(command);
  throw new Error('Client confirmed a reply that the fixture should hold until death');
}
