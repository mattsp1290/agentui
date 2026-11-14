import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryModel } from '../../apps/desktop/src/application/recovery.ts';

test('recovery classification hides only busy own entries and separates foreign pending and uncertain receipts', () => {
  const scope = { hostId: 'host', conversationId: 'conversation' };
  const entry = { command: { version: 1, scope, clientCommandId: 'own', body: { kind: 'send', text: 'Keep original' } }, draftRevision: 0 };
  const receipt = (id, kind) => ({ scope, clientCommandId: id, hostOperationId: id, sequence: 1, state: { kind } });
  const view = { outbox: [entry], document: { domain: {}, decisions: {}, receipts: {
    own: receipt('own', 'uncertain'), pending: receipt('pending', 'pending'), uncertain: receipt('uncertain', 'uncertain'), complete: receipt('complete', 'completed'),
  } } };
  const idle = recoveryModel(view, false), busy = recoveryModel(view, true);
  assert.equal(idle.retained, view.outbox);
  assert.deepEqual(idle.pending.map(value => value.clientCommandId), ['pending']);
  assert.deepEqual(idle.uncertain.map(value => value.clientCommandId), ['uncertain']);
  assert.deepEqual(busy, { retained: [], pending: idle.pending, uncertain: idle.uncertain });
  assert.deepEqual(view.outbox, [entry]);
});
