import assert from 'node:assert/strict';
import test from 'node:test';
import { settlement, isQuarantined } from '../../packages/host/dist/settlement.js';

const evidence = operation => ({ correlation: 'captured-operation', operation,
  source: { kind: 'test-evidence', value: 'original' } });
const native = { namespace: 'recorded', id: 'native' };
const unknown = { kind: 'outcome-unknown' };
const absent = { kind: 'not-dispatched', reason: 'aborted' };
const accepted = { kind: 'accepted', evidence: evidence(null) };
const conclusive = { kind: 'conclusive', evidence: evidence(null), result: { kind: 'rejected', reason: 'declined' } };

for (const [name, previous, incoming, quarantined, expected] of [
  ['first uncertainty applies', null, unknown, false, 'apply'],
  ['repeated uncertainty only records', unknown, unknown, false, 'record-evidence'],
  ['acceptance upgrades uncertainty', unknown, accepted, false, 'apply'],
  ['uncertainty cannot downgrade acceptance', accepted, unknown, false, 'keep'],
  ['absence conflicts with acceptance', accepted, absent, false, 'conflict'],
  ['repeated acceptance only records', accepted, accepted, false, 'record-evidence'],
  ['terminal upgrades acceptance', accepted, conclusive, false, 'apply'],
  ['acceptance cannot downgrade terminal', conclusive, accepted, false, 'keep'],
  ['uncertainty cannot downgrade terminal', conclusive, unknown, false, 'keep'],
  ['same terminal is kept', conclusive, conclusive, false, 'keep'],
  ['different terminal conflicts', conclusive, { ...conclusive, result: { kind: 'rejected', reason: 'changed' } }, false, 'conflict'],
  ['absence remains terminal', absent, accepted, false, 'keep'],
  ['changed absence conflicts', absent, { ...absent, reason: 'intent-failed' }, false, 'conflict'],
  ['quarantined terminal reapplies', conclusive, unknown, true, 'apply'],
  ['quarantined acceptance reapplies', accepted, accepted, true, 'apply'],
]) {
  test(`settlement ${name}`, () => {
    assert.equal(settlement(previous, incoming, { quarantined }).kind, expected);
  });
}

test('settlement preserves known native identity and rejects a competing native operation', () => {
  const known = { ...accepted, evidence: evidence(native) };
  assert.deepEqual(settlement(known, conclusive, { quarantined: false }).observed.evidence.operation, native);
  assert.equal(settlement(known, { ...conclusive, evidence: evidence({ ...native, id: 'other' }) }, { quarantined: false }).kind, 'conflict');
  const enriched = settlement(conclusive, { ...conclusive, evidence: evidence(native) }, { quarantined: false });
  assert.equal(enriched.kind, 'record-evidence');
  assert.deepEqual(enriched.observed.evidence.operation, native);
});

test('quarantine retry keeps the captured terminal fact and requires a quarantine reason', () => {
  const result = settlement(conclusive, accepted, { quarantined: true });
  assert.deepEqual(result, { kind: 'apply', observed: conclusive });
  for (const reason of ['output-rejected', 'capacity-exhausted']) {
    assert.equal(isQuarantined({ receipt: { state: { kind: 'uncertain', reason } } }), true);
  }
  assert.equal(isQuarantined({ receipt: { state: { kind: 'uncertain', reason: 'provider-outcome-unknown' } } }), false);
});

test('quarantined terminal application retains the terminal result while learning a compatible native id', () => {
  for (const incoming of [accepted, conclusive]) {
    const result = settlement(conclusive, { ...incoming, evidence: evidence(native) }, { quarantined: true });
    assert.equal(result.kind, 'apply');
    assert.equal(result.observed.kind, 'conclusive');
    assert.deepEqual(result.observed.result, conclusive.result);
    assert.deepEqual(result.observed.evidence.operation, native);
  }
  const changed = { ...conclusive, evidence: evidence(native), result: { kind: 'rejected', reason: 'changed' } };
  assert.equal(settlement(conclusive, changed, { quarantined: true }).kind, 'conflict');
});

test('settlement rejects evidence for another captured command even with the same execution id', () => {
  const foreign = { ...accepted, evidence: { ...evidence(native), correlation: 'another-command' } };
  assert.deepEqual(settlement(accepted, foreign, { quarantined: false }), { kind: 'conflict', reason: 'command identity' });
});

test('settlement retains source evidence while carrying forward the known execution id', () => {
  const source = { kind: 'test-evidence', value: 'authoritative lookup' };
  const incoming = { ...conclusive, evidence: { ...conclusive.evidence, source } };
  const result = settlement({ ...accepted, evidence: evidence(native) }, incoming, { quarantined: false });
  assert.equal(result.observed.evidence.source, source);
  assert.equal(result.observed.evidence.correlation, accepted.evidence.correlation);
  assert.deepEqual(result.observed.evidence.operation, native);
});
