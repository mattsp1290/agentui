import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, receipt, scope, storage } from './support.mjs';

test('explicit receipt refresh settles a lost result without dispatch and preserves a newer draft', async () => {
  const f = fixture();
  await f.store.setDraft('original');
  f.port.submit = async command => { f.port.submitted.push(command); throw new Error('Lost reply'); };
  await assert.rejects(f.store.send(), /Lost reply/);
  const [entry] = f.store.getSnapshot().outbox;
  await f.store.setDraft('newer unsent text');
  f.port.receipt = async () => receipt(entry.command, 'completed', 8);
  const result = await f.store.refreshReceipt(entry.command.clientCommandId);
  assert.equal(result.state.kind, 'completed');
  assert.deepEqual(f.store.getSnapshot().outbox, []);
  assert.equal(f.store.getSnapshot().draft, 'newer unsent text');
  assert.equal(f.port.submitted.length, 1);
  assert.deepEqual(f.drafts.value.outbox, []);
});
test('unknown, pending and malformed lookups retain the original command', async () => {
  const f = fixture();
  await f.store.setDraft('original');
  await f.store.send();
  const [entry] = f.store.getSnapshot().outbox;
  assert.equal(await f.store.refreshReceipt(entry.command.clientCommandId), null);
  f.port.receipt = async () => receipt(entry.command, 'pending');
  await f.store.refreshReceipt(entry.command.clientCommandId);
  f.port.receipt = async () => ({ ...receipt(entry.command, 'completed'), clientCommandId: 'another' });
  await assert.rejects(f.store.refreshReceipt(entry.command.clientCommandId), /ID mismatch/);
  f.port.receipt = async () => ({ ...receipt(entry.command, 'completed'), scope: { ...scope, hostId: 'another' } });
  await assert.rejects(f.store.refreshReceipt(entry.command.clientCommandId), /scope mismatch/);
  assert.equal(f.store.getSnapshot().outbox.length, 1);
  assert.equal(f.port.submitted.length, 1);
});
test('receipt refresh reports failed persistence while retaining recoverable intent', async () => {
  const drafts = storage();
  const f = fixture({ drafts });
  await f.store.setDraft('original');
  await f.store.send();
  const [entry] = f.store.getSnapshot().outbox;
  f.port.receipt = async () => receipt(entry.command, 'completed');
  drafts.save = async () => { throw new Error('Disk full'); };
  await assert.rejects(f.store.refreshReceipt(entry.command.clientCommandId), /Disk full/);
  assert.equal(f.store.getSnapshot().outbox.length, 1);
  assert.equal(f.store.getSnapshot().draft, 'original');
  assert.equal(f.port.submitted.length, 1);
});
