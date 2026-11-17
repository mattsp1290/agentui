import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDecision, parseHostEvent, parseReceipt } from '@agentui/contracts';
import { parseServiceRequest, parseServiceResponse } from '@agentui/contracts/service';
import { connected, snapshot as clientSnapshot } from '../client/support.mjs';
import { empty, fixture, installed, question, run, scope } from './fixture.mjs';

const receipt = { scope, clientCommandId: 'command', hostOperationId: 'operation', sequence: 1, state: { kind: 'accepted' } };

test('public receipt parser retains strict identifiers, reasons, states and sequence bounds', () => {
  for (const kind of ['pending', 'accepted', 'completed', 'uncertain', 'rejected', 'not-dispatched', 'abandoned']) {
    const state = ['uncertain', 'rejected', 'not-dispatched'].includes(kind) ? { kind, reason: 'recorded' } : { kind };
    const valid = { ...receipt, state };
    assert.deepEqual(parseReceipt(valid), valid);
  }
  for (const invalid of [
    ...['clientCommandId', 'hostOperationId'].map(key => ({ ...receipt, [key]: '' })),
    ...['uncertain', 'rejected', 'not-dispatched'].map(kind => ({ ...receipt, state: { kind, reason: '' } })),
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1'].map(sequence => ({ ...receipt, sequence })),
    { ...receipt, state: { kind: 'unknown' } },
    { ...receipt, state: { kind: 'abandoned', reason: 'recorded' } },
  ]) assert.throws(() => parseReceipt(invalid));
});

test('abandon request carries only scope and command id and returns a receipt or null', () => {
  const request = { op: 'abandon', scope, id: 'command' };
  assert.deepEqual(parseServiceRequest(request), request);
  for (const invalid of [{ ...request, id: '' }, { ...request, extra: true }, { op: 'abandon', scope }]) assert.throws(() => parseServiceRequest(invalid));
  const abandoned = { ...receipt, state: { kind: 'abandoned' } };
  assert.deepEqual(parseServiceResponse(request, { ok: true, value: abandoned }), { ok: true, value: abandoned });
  assert.deepEqual(parseServiceResponse(request, { ok: true, value: null }), { ok: true, value: null });
  assert.throws(() => parseServiceResponse(request, { ok: true, value: { kind: 'abandoned' } }));
});

test('public event parser preserves receiver, scope, sequence and decision checks', () => {
  const projection = { prefix: 'decoded ', decodeEvent(value) { return this.prefix + value; } };
  assert.deepEqual(parseHostEvent({ kind: 'domain', event: 'value' }, scope, 1, projection), { kind: 'domain', event: 'decoded value' });
  assert.deepEqual(parseHostEvent({ kind: 'receipt', receipt }, scope, 1, projection), { kind: 'receipt', receipt });
  assert.throws(() => parseHostEvent({ kind: 'receipt', receipt }, scope, 2, projection));
  assert.throws(() => parseHostEvent({ kind: 'receipt', receipt }, { ...scope, hostId: 'foreign' }, 1, projection));
  assert.throws(() => parseHostEvent({ kind: 'decision-closed', pendingId: '' }, scope, 1, projection));
  assert.deepEqual(parseHostEvent({ kind: 'decision-closed', pendingId: '__proto__' }, scope, 1, projection), { kind: 'decision-closed', pendingId: '__proto__' });
});

test('public contract, host append and client snapshot agree on strict decision validation', async t => {
  const host = fixture(t).open();
  host.createConversation(scope, installed);
  host.append(scope, { ...empty(), runs: [run()] });
  const pending = question().visible;
  for (const invalid of [
    ...[[], ['yes', 'yes'], ['']].map(choices => ({ ...pending, choices })),
    ...['pendingId', 'runId', 'prompt'].map(key => ({ ...pending, [key]: '' })),
  ]) {
    assert.throws(() => parseDecision(invalid));
    assert.throws(() => host.append(scope, { ...empty(), decisions: [{ visible: invalid, continuation: null }] }));
    const client = await connected();
    await assert.rejects(client.stream.receive(clientSnapshot(1, '', scope, {}, { [invalid.pendingId]: invalid })));
    assert.equal(client.store.getSnapshot().cursor, 0);
  }
  assert.deepEqual(parseDecision(pending), pending);
  host.append(scope, { ...empty(), decisions: [{ visible: pending, continuation: null }] });
  const client = await connected();
  await client.stream.receive(clientSnapshot(1, '', scope, {}, { [pending.pendingId]: pending }));
  assert.deepEqual(client.store.getSnapshot().document.decisions[pending.pendingId], pending);
});
