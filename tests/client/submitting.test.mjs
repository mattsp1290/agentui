import assert from 'node:assert/strict';
import test from 'node:test';
import { connected, deferred, events, receipt } from './support.mjs';

test('submission snapshots identify concurrent commands and clear each independently on success or failure', async () => {
  const { store, port } = await connected();
  const started = [deferred(), deferred()], results = [deferred(), deferred()];
  const commands = [];
  port.submit = command => {
    const index = commands.length;
    commands.push(command);
    started[index].resolve();
    return results[index].promise;
  };
  const published = [];
  store.subscribe(() => published.push(store.getSnapshot().submitting));
  const first = store.cancel('first-run');
  await started[0].promise;
  const firstIds = store.getSnapshot().submitting;
  assert.deepEqual(firstIds, [commands[0].clientCommandId]);
  assert.ok(Object.isFrozen(firstIds));
  const second = store.cancel('second-run');
  await started[1].promise;
  assert.deepEqual(store.getSnapshot().submitting, commands.map(command => command.clientCommandId));
  assert.deepEqual(firstIds, [commands[0].clientCommandId]);
  results[0].resolve({ kind: 'receipt', receipt: receipt(commands[0], 'completed') });
  await first;
  assert.deepEqual(store.getSnapshot().submitting, [commands[1].clientCommandId]);
  const failed = assert.rejects(second, /Disconnected/);
  results[1].reject(new Error('Disconnected'));
  await failed;
  assert.deepEqual(store.getSnapshot().submitting, []);
  assert.deepEqual(store.getSnapshot().outbox.map(entry => entry.command), [commands[1]]);
  assert.ok(published.some(ids => ids.length === 2));
  assert.deepEqual(published.at(-1), []);
});

test('a failed command save clears the submitting snapshot even after another update published it', async () => {
  const { store, drafts, port } = await connected();
  const saving = deferred(), held = deferred();
  drafts.save = async () => { saving.resolve(); await held.promise; };
  const cancel = store.cancel('run');
  await saving.promise;
  await port.watches.at(-1).receive(events([1, 'progress']));
  const failed = assert.rejects(cancel, /disk full/);
  held.reject(new Error('disk full'));
  await failed;
  assert.deepEqual(store.getSnapshot().submitting, []);
  assert.deepEqual(store.getSnapshot().outbox, []);
  assert.equal(port.submitted.length, 0);
});

test('a new command is never published as retained before its submission starts', async () => {
  const { store, port } = await connected();
  const started = deferred(), result = deferred();
  let sent;
  port.submit = command => { sent = command; started.resolve(); return result.promise; };
  const retained = [];
  store.subscribe(() => {
    const view = store.getSnapshot();
    retained.push(view.outbox.filter(entry => !view.submitting.includes(entry.command.clientCommandId)).length);
  });
  const revoke = store.revokePermission('permission', 'conversation');
  await started.promise;
  result.resolve({ kind: 'receipt', receipt: receipt(sent, 'completed') });
  await revoke;
  assert.deepEqual(store.getSnapshot().outbox, []);
  assert.ok(retained.length > 0);
  assert.deepEqual([...new Set(retained)], [0]);
});
