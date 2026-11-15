import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { createRecordedDriver } from '@agentui/host';
import { fixture, scope, other, installed, command, completed, note, run, projection } from './fixture.mjs';

for (const changedBinding of ['authorizedScope', 'account']) {
  test(`full ${changedBinding} routes colliding native IDs and captured recovery after reopening`, async t => {
    const f = fixture(t), calls = [], lookups = [];
    const second = { ...installed, binding: { ...installed.binding, [changedBinding]: 'different-private-binding' } };
    const make = (installation, name) => {
      const base = createRecordedDriver({ installation, backendPath: join(f.dir, `${name}.jsonl`), decodeEvent: projection.decodeEvent,
        resolve: async (cmd, target) => {
          calls.push({ name, target });
          const native = run(cmd.scope);
          native.reference.binding = installation.binding;
          return completed({ ...note(name), runs: [native] });
        } });
      return { ...base, installation,
        async dispatch(cmd, target) { return cmd.clientCommandId === 'uncertain' ? { kind: 'outcome-unknown' } : base.dispatch(cmd, target); },
        async lookup(cmd, target) { lookups.push({ name, target }); return base.lookup(cmd, target); },
      };
    };
    const a = make(installed, 'a'), b = make(second, 'b');
    const host = f.open({ driver: [a, b] });
    host.createConversation(scope, installed); host.createConversation(other, second);
    for (const selected of [scope, other]) {
      assert.equal((await host.conversation(selected).submit(command('same-command', undefined, selected))).receipt.state.kind, 'completed');
      await host.conversation(selected).submit(command('next-command', undefined, selected));
      await host.conversation(selected).submit(command('uncertain', undefined, selected));
    }
    assert.deepEqual(calls.map(call => call.name), ['a', 'a', 'b', 'b']);
    assert.equal(calls[1].target.run.reference.opaque, calls[3].target.run.reference.opaque);
    assert.deepEqual(calls[1].target.installation, installed);
    assert.deepEqual(calls[3].target.installation, second);
    host.close(); await host.drained;
    const reopened = f.open({ driver: [b, a] });
    await reopened.reconcile(scope, 'uncertain'); await reopened.reconcile(other, 'uncertain');
    assert.deepEqual(lookups.map(call => call.name), ['a', 'b']);
    assert.deepEqual(lookups.map(call => call.target.installation), [installed, second]);
    assert.equal(calls.length, 4);
    reopened.close(); await reopened.drained;
    const removed = f.open({ driver: [b] });
    const replay = await removed.conversation(scope).submit(command('same-command'));
    assert.equal(replay.receipt.state.kind, 'completed');
    assert.equal((await removed.conversation(scope).submit(command('same-command', { kind: 'send', text: 'changed' }))).reason, 'command-id-conflict');
    assert.match((await removed.conversation(scope).submit(command('fresh'))).reason, /unavailable/);
    await removed.reconcile(scope, 'uncertain');
    assert.equal(lookups.length, 2);
    assert.deepEqual(removed.inspect(scope).snapshot.document.domain, ['a', 'a']);
    assert.equal(calls.length, 4);
  });
}
