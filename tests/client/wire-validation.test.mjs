import assert from 'node:assert/strict';
import test from 'node:test';
import { connected, events, projection, receipt, scope, snapshot } from './support.mjs';

const validDecision = { pendingId: 'pending', runId: 'run', choices: ['allow'], prompt: 'Allow?' };
const validReceipt = receipt({ scope, clientCommandId: 'command' });
const malformed = [
  ['empty choices', 'decision-opened', { ...validDecision, choices: [] }],
  ['duplicate choices', 'decision-opened', { ...validDecision, choices: ['allow', 'allow'] }],
  ['empty choice', 'decision-opened', { ...validDecision, choices: [''] }],
  ...['pendingId', 'runId', 'prompt'].map(key => [`empty ${key}`, 'decision-opened', { ...validDecision, [key]: '' }]),
  ...['clientCommandId', 'hostOperationId'].map(key => [`empty ${key}`, 'receipt', { ...validReceipt, [key]: '' }]),
  ...['uncertain', 'rejected', 'not-dispatched'].map(kind => [`empty ${kind} reason`, 'receipt', { ...validReceipt, state: { kind, reason: '' } }]),
];

for (const [name, kind, value] of malformed) {
  test(`client rejects ${name} in snapshots and atomically rejects event pages`, async () => {
    const first = await connected();
    const before = first.store.getSnapshot().document;
    const receipts = kind === 'receipt' ? { [value.clientCommandId]: value } : {};
    const decisions = kind === 'decision-opened' ? { [value.pendingId]: value } : {};
    await assert.rejects(first.stream.receive(snapshot(1, 'uncommitted', scope, receipts, decisions)));
    assert.equal(first.store.getSnapshot().document, before);
    assert.equal(first.store.getSnapshot().cursor, 0);
    const next = await connected();
    const page = events([1, 'uncommitted']);
    page.events.push({ scope, sequence: 2, event: kind === 'receipt'
      ? { kind, receipt: { ...value, sequence: 2 } } : { kind, decision: value } });
    await assert.rejects(next.stream.receive(page));
    assert.equal(next.store.getSnapshot().document.domain.text, '');
    assert.equal(next.store.getSnapshot().cursor, 0);
  });
}

test('receipt scope mismatches keep their connection classification and sequence mismatches reject atomically', async () => {
  for (const [changed, classification] of [
    [{ scope: { ...scope, hostId: 'foreign' } }, 'mismatch'],
    [{ sequence: 9 }, 'resync'],
  ]) {
    const { store, stream } = await connected();
    await assert.rejects(stream.receive({ kind: 'events', events: [{ scope, sequence: 1,
      event: { kind: 'receipt', receipt: { ...validReceipt, ...changed } } }] }));
    assert.equal(store.getSnapshot().connection.kind, classification);
    assert.equal(store.getSnapshot().cursor, 0);
  }
});

test('snapshot maps preserve prototype-like receipt and pending-decision identities', async () => {
  const { store, stream } = await connected();
  const specialReceipt = { ...validReceipt, clientCommandId: '__proto__' };
  const specialDecision = { ...validDecision, pendingId: '__proto__' };
  await stream.receive(snapshot(1, '', scope,
    { ['__proto__']: specialReceipt }, { ['__proto__']: specialDecision }));
  const document = store.getSnapshot().document;
  assert.equal(Object.hasOwn(document.receipts, '__proto__'), true);
  assert.equal(Object.hasOwn(document.decisions, '__proto__'), true);
  assert.deepEqual(document.receipts.__proto__, specialReceipt);
  assert.deepEqual(document.decisions.__proto__, specialDecision);
});

test('shared event decoding preserves the projection method receiver', async () => {
  const selectedProjection = { ...projection, prefix: 'decoded ',
    decodeEvent(value) { return this.prefix + value; } };
  const { store, stream } = await connected({ selectedProjection });
  await stream.receive(events([1, 'value']));
  assert.equal(store.getSnapshot().document.domain.text, 'decoded value');
});

test('only the latest 256 sequence identities can be recognized as duplicates', async () => {
  const { store, stream } = await connected();
  await stream.receive(events(...Array.from({ length: 257 }, (_, index) => [index + 1, 'x'])));
  await stream.receive(events([2, 'x']));
  assert.equal(store.getSnapshot().cursor, 257);
  await assert.rejects(stream.receive(events([1, 'x'])), /duplicate/);
  assert.equal(store.getSnapshot().connection.kind, 'resync');
  assert.equal(store.getSnapshot().document.domain.text.length, 257);
});
