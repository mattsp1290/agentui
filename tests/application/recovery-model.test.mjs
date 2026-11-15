import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryModel } from '../../apps/desktop/src/application/recovery.ts';

test('recovery classification hides only the command actually submitting and separates foreign pending and uncertain receipts', () => {
  const scope = { hostId: 'host', conversationId: 'conversation' };
  const entry = { command: { version: 1, scope, clientCommandId: 'own', body: { kind: 'send', text: 'Keep original' } }, draftRevision: 0 };
  const receipt = (id, kind) => ({ scope, clientCommandId: id, hostOperationId: id, sequence: 1, state: { kind } });
  const other = { ...entry, command: { ...entry.command, clientCommandId: 'other' } };
  const view = { submitting: [], outbox: [entry, other], document: { domain: {}, decisions: {}, receipts: {
    own: receipt('own', 'uncertain'), pending: receipt('pending', 'pending'), accepted: receipt('accepted', 'accepted'), uncertain: receipt('uncertain', 'uncertain'), complete: receipt('complete', 'completed'),
  } } };
  const idle = recoveryModel(view), busy = recoveryModel({ ...view, submitting: ['own'] });
  assert.deepEqual(idle.retained, view.outbox);
  assert.deepEqual(idle.pending.map(value => value.clientCommandId), ['pending', 'accepted']);
  assert.deepEqual(idle.uncertain.map(value => value.clientCommandId), ['uncertain']);
  assert.deepEqual(busy, { retained: [other], pending: idle.pending, uncertain: idle.uncertain });
  assert.deepEqual(view.outbox, [entry, other]);
});
