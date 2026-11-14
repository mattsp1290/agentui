import assert from 'node:assert/strict';
import test from 'node:test';
import { connected, deferred, receipt } from './support.mjs';

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
