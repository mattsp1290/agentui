import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deferred, fakePort, fixture, receipt, scope, storage } from './support.mjs';

test('exact command is saved before submission and pending entries remain inspectable', async () => {
  const { store, port, drafts } = fixture();
  await store.setDraft('hello');
  const saved = drafts.save.bind(drafts);
  drafts.save = async records => { assert.equal(port.submitted.length, 0); await saved(records); };
  await store.send();
  assert.deepEqual(drafts.value.outbox[0].command, port.submitted[0]);
  assert.equal(store.getSnapshot().outbox.length, 1);
  assert.equal(store.getSnapshot().draft, 'hello');
});

test('failed save prevents dispatch and does not change the visible draft', async () => {
  const { store, port, drafts } = fixture();
  await store.setDraft('keep');
  drafts.save = async () => { throw new Error('disk full'); };
  await assert.rejects(store.send(), /disk full/);
  assert.equal(port.submitted.length, 0);
  assert.equal(store.getSnapshot().outbox.length, 0);
  await assert.rejects(store.setDraft('lost'), /disk full/);
  assert.equal(store.getSnapshot().draft, 'keep');
});

test('delayed saves serialize and submission waits for durable command', async () => {
  const { store, port, drafts } = fixture();
  await store.ready;
  const entered = deferred();
  const release = deferred();
  const save = drafts.save.bind(drafts);
  let active = 0;
  drafts.save = async records => {
    assert.equal(++active, 1);
    if (records.draft === 'first') { entered.resolve(); await release.promise; }
    await save(records);
    active--;
  };
  const first = store.setDraft('first');
  await entered.promise;
  const second = store.setDraft('second');
  const sending = store.send();
  assert.equal(port.submitted.length, 0);
  release.resolve();
  await Promise.all([first, second, sending]);
  assert.equal(port.submitted[0].body.text, 'second');
  assert.deepEqual(drafts.writes.map(record => record.draft), ['first', 'second', 'second']);
});

test('lost response and uncertainty require explicit retry with identical persisted ID and body', async () => {
  const { store, port } = fixture();
  await store.setDraft('exact');
  port.submit = async command => { port.submitted.push(structuredClone(command)); throw new Error('reply lost'); };
  await assert.rejects(store.send(), /reply lost/);
  const command = port.submitted[0];
  await Promise.resolve();
  assert.equal(port.submitted.length, 1);
  port.submit = async command => { port.submitted.push(structuredClone(command)); return { kind: 'receipt', receipt: receipt(command, 'uncertain') }; };
  await store.retry(command.clientCommandId);
  assert.deepEqual(port.submitted, [command, command]);
  assert.equal(store.getSnapshot().outbox.length, 1);
});

test('accepted send clears captured draft but never a newer revision with equal text', async () => {
  const { store, port } = fixture();
  await store.setDraft('same');
  const entered = deferred();
  const reply = deferred();
  port.submit = async command => { entered.resolve(command); return reply.promise; };
  const sending = store.send();
  const command = await entered.promise;
  await store.setDraft('different');
  await store.setDraft('same');
  reply.resolve({ kind: 'receipt', receipt: receipt(command, 'accepted') });
  await sending;
  assert.equal(store.getSnapshot().draft, 'same');
  assert.equal(store.getSnapshot().outbox.length, 0);
  port.submit = async command => ({ kind: 'receipt', receipt: receipt(command, 'completed') });
  await store.send();
  assert.equal(store.getSnapshot().draft, '');
});

test('recreation hydrates outbox without submitting and preserves approval target', async () => {
  const first = fixture();
  await first.store.setDraft('local text');
  await first.store.approve('decision-a', 'allow');
  const second = fixture({ drafts: storage(first.drafts.value) });
  await second.store.ready;
  assert.equal(second.store.getSnapshot().draft, 'local text');
  assert.deepEqual(second.store.getSnapshot().outbox, first.store.getSnapshot().outbox);
  assert.equal(second.port.submitted.length, 0);
  await second.store.retry(second.store.getSnapshot().outbox[0].command.clientCommandId);
  assert.deepEqual(second.port.submitted[0], first.port.submitted[0]);
});

test('port and storage scope mismatches fail before submission', async () => {
  assert.throws(() => fixture({ selectedScope: { ...scope, hostId: 'other' } }), /scope mismatch/);
  const first = fixture();
  await first.store.setDraft('private');
  const other = fixture({ port: fakePort({ ...scope, conversationId: 'other' }), drafts: storage(first.drafts.value) });
  await assert.rejects(other.store.ready, /scope mismatch/);
  await assert.rejects(other.store.send(), /scope mismatch/);
  assert.equal(other.port.submitted.length, 0);
});

test('initial admission rejection durably removes the command and retains the draft', async () => {
  const { store, port, drafts } = fixture();
  await store.setDraft('correct this draft');
  const refusal = { kind: 'rejected', reason: 'command-too-large' };
  port.submit = async () => refusal;
  assert.equal(await store.send(), refusal);
  assert.deepEqual(store.getSnapshot().outbox, []);
  assert.equal(store.getSnapshot().draft, 'correct this draft');
  const recreated = fixture({ drafts: storage(drafts.value) });
  await recreated.store.ready;
  assert.deepEqual(recreated.store.getSnapshot().outbox, []);
  assert.equal(recreated.store.getSnapshot().draft, 'correct this draft');
});

test('rejection removal save failure retains recoverable original command and draft', async () => {
  const { store, port, drafts } = fixture();
  await store.setDraft('keep');
  const save = drafts.save.bind(drafts);
  port.submit = async () => {
    drafts.save = async () => { throw new Error('removal save failed'); };
    return { kind: 'rejected', reason: 'conversation-capacity' };
  };
  await assert.rejects(store.send(), /removal save failed/);
  assert.equal(store.getSnapshot().draft, 'keep');
  const [entry] = store.getSnapshot().outbox;
  const recreated = fixture({ drafts: storage(drafts.value) });
  await recreated.store.ready;
  assert.deepEqual(recreated.store.getSnapshot().outbox, [entry]);
  drafts.save = save;
  port.submit = async command => ({ kind: 'receipt', receipt: receipt(command, 'completed') });
  await store.retry(entry.command.clientCommandId);
  assert.deepEqual(store.getSnapshot().outbox, []);
});

test('lost reply followed by retry refusal retains original identity after recreation', async () => {
  const { store, port, drafts } = fixture();
  await store.setDraft('one effect');
  port.submit = async () => { throw new Error('reply lost'); };
  await assert.rejects(store.send(), /reply lost/);
  const [entry] = store.getSnapshot().outbox;
  for (const reason of ['invalid-or-unauthorized-command', 'command-id-conflict']) {
    port.submit = async command => {
      assert.deepEqual(command, entry.command);
      return { kind: 'rejected', reason };
    };
    assert.deepEqual(await store.retry(entry.command.clientCommandId), { kind: 'rejected', reason });
    assert.deepEqual(store.getSnapshot().outbox, [entry]);
  }
  const recreated = fixture({ drafts: storage(drafts.value) });
  await recreated.store.ready;
  assert.deepEqual(recreated.store.getSnapshot().outbox, [entry]);
});

test('wrong-command receipt and duplicate generated IDs never remove the saved command', async () => {
  const { store, port } = fixture({ createCommandId: () => '00000000-0000-4000-8000-000000000001' });
  await store.setDraft('keep');
  port.submit = async command => ({ kind: 'receipt', receipt: { ...receipt(command, 'accepted'), clientCommandId: 'foreign' } });
  await assert.rejects(store.send(), /ID mismatch/);
  assert.equal(store.getSnapshot().outbox.length, 1);
  await assert.rejects(store.send(), /reused/);
});

test('failed settlement persistence keeps retryable command and captured draft', async () => {
  const { store, port, drafts } = fixture();
  await store.setDraft('keep');
  port.submit = async command => {
    drafts.save = async () => { throw new Error('settlement save failed'); };
    return { kind: 'receipt', receipt: receipt(command, 'accepted') };
  };
  await assert.rejects(store.send(), /settlement save failed/);
  assert.equal(store.getSnapshot().draft, 'keep');
  assert.equal(store.getSnapshot().outbox.length, 1);
});

test('opaque command IDs accepted by shared contracts survive persistence and retry', async () => {
  const { store, port, drafts } = fixture({ createCommandId: () => 'mobile-command/opaque-id' });
  await store.cancel('run');
  assert.equal(drafts.value.outbox[0].command.clientCommandId, 'mobile-command/opaque-id');
  await store.retry('mobile-command/opaque-id');
  assert.deepEqual(port.submitted[1], port.submitted[0]);
});

test('failed hydration prevents all submission and connection becomes failed', async () => {
  const drafts = storage({ version: 99 });
  const { store, port } = fixture({ drafts });
  await assert.rejects(store.ready, /version/);
  await assert.rejects(store.connect(), /version/);
  await assert.rejects(store.cancel('run'), /version/);
  assert.equal(store.getSnapshot().connection.kind, 'failed');
  assert.equal(port.submitted.length, 0);
  assert.equal(drafts.writes.length, 0);
});

test('delayed initial refusal preserves an edited draft while removing only its command', async () => {
  const { store, port, drafts } = fixture();
  await store.setDraft('original');
  const entered = deferred(), reply = deferred();
  port.submit = async () => { entered.resolve(); return reply.promise; };
  const sending = store.send();
  await entered.promise;
  await store.setDraft('newer draft');
  reply.resolve({ kind: 'rejected', reason: 'command-too-large' });
  await sending;
  assert.equal(store.getSnapshot().draft, 'newer draft');
  assert.equal(drafts.value.draft, 'newer draft');
  assert.deepEqual(drafts.value.outbox, []);
});

test('failed retry storage check prevents submission and retains the durable identity', async () => {
  const { store, port, drafts } = fixture();
  await store.setDraft('saved command');
  await store.send();
  const before = structuredClone(drafts.value);
  const submissions = port.submitted.length;
  drafts.save = async () => { throw new Error('retry storage unavailable'); };
  await assert.rejects(store.retry(before.outbox[0].command.clientCommandId), /retry storage unavailable/);
  assert.equal(port.submitted.length, submissions);
  assert.deepEqual(drafts.value, before);
  assert.deepEqual(store.getSnapshot().outbox, before.outbox);
});

test('a lost Stop reply keeps its exact run and command ID after recreation without changing the draft', async () => {
  const first = fixture();
  await first.store.setDraft('My next question');
  first.port.submit = async command => {
    first.port.submitted.push(structuredClone(command));
    throw new Error('Stop reply lost');
  };
  await assert.rejects(first.store.cancel('native-turn-id'), /Stop reply lost/);
  const saved = first.port.submitted[0];
  assert.deepEqual(saved.body, { kind: 'cancel', runId: 'native-turn-id' });
  const second = fixture({ drafts: storage(first.drafts.value) });
  await second.store.ready;
  assert.deepEqual(second.port.submitted, []);
  assert.equal(second.store.getSnapshot().draft, 'My next question');
  assert.deepEqual(second.store.getSnapshot().outbox[0].command, saved);
  second.port.submit = async command => {
    second.port.submitted.push(structuredClone(command));
    return { kind: 'receipt', receipt: receipt(command, 'uncertain') };
  };
  await second.store.retry(saved.clientCommandId);
  assert.deepEqual(second.port.submitted, [saved]);
  assert.deepEqual(second.store.getSnapshot().outbox[0].command, saved);
  assert.equal(second.store.getSnapshot().draft, 'My next question');
});

for (const draft of ['unfinished draft', 'review prompt']) {
  for (const kind of ['accepted', 'completed']) {
    test(`explicit ${kind} send preserves ${draft === 'review prompt' ? 'identical' : 'different'} composer draft`, async () => {
      const { store, port, drafts } = fixture();
      await store.setDraft(draft);
      port.submit = async command => {
        port.submitted.push(structuredClone(command));
        assert.equal(drafts.value.outbox[0].draftRevision, null);
        return { kind: 'receipt', receipt: receipt(command, kind) };
      };
      const result = await store.send('review prompt');
      assert.deepEqual(port.submitted[0].body, { kind: 'send', text: 'review prompt' });
      assert.equal(result.receipt.state.kind, kind);
      assert.equal(store.getSnapshot().draft, draft);
      assert.deepEqual(store.getSnapshot().outbox, []);
      assert.equal(drafts.value.draft, draft);
    });
  }
}

test('explicit send never dispatches before persistence or falls back from empty input', async () => {
  const { store, port, drafts } = fixture();
  await store.setDraft('keep');
  await assert.rejects(store.send(''));
  assert.equal(port.submitted.length, 0);
  assert.equal(store.getSnapshot().draft, 'keep');
  drafts.save = async () => { throw new Error('disk full'); };
  await assert.rejects(store.send('review prompt'), /disk full/);
  assert.equal(port.submitted.length, 0);
  assert.equal(store.getSnapshot().draft, 'keep');
  assert.deepEqual(store.getSnapshot().outbox, []);
});

test('explicit send restores without dispatch and retries its exact ID, body and null draft ownership', async () => {
  const first = fixture();
  await first.store.setDraft('review prompt');
  first.port.submit = async command => { first.port.submitted.push(structuredClone(command)); throw new Error('reply lost'); };
  await assert.rejects(first.store.send('review prompt'), /reply lost/);
  const [entry] = first.drafts.value.outbox;
  assert.equal(entry.draftRevision, null);
  const second = fixture({ drafts: storage(first.drafts.value) });
  await second.store.ready;
  assert.deepEqual(second.port.submitted, []);
  assert.deepEqual(second.store.getSnapshot().outbox, [entry]);
  second.port.submit = async command => {
    second.port.submitted.push(structuredClone(command));
    return { kind: 'receipt', receipt: receipt(command, 'accepted') };
  };
  await second.store.retry(entry.command.clientCommandId);
  assert.deepEqual(second.port.submitted, first.port.submitted);
  assert.equal(second.store.getSnapshot().draft, 'review prompt');
  assert.deepEqual(second.store.getSnapshot().outbox, []);
});
