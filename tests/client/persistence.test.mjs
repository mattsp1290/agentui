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

test('revoke scope and identity restore without replay alongside old drafts and approval intents', async () => {
  const first = fixture();
  await first.store.setDraft('Keep my draft');
  await first.store.approve('old-decision', 'allow');
  first.port.submit = async command => {
    assert.deepEqual(first.drafts.value.outbox.at(-1).command, command);
    throw new Error('Reply lost');
  };
  await assert.rejects(first.store.revokePermission('permission', 'agent'), /Reply lost/);
  const saved = structuredClone(first.drafts.value), second = fixture({ drafts: storage(saved) });
  await second.store.ready;
  assert.deepEqual(second.drafts.value, saved);
  assert.deepEqual(second.port.submitted, []);
  await second.store.retry(saved.outbox.at(-1).command.clientCommandId);
  assert.deepEqual(second.port.submitted, [saved.outbox.at(-1).command]);
  assert.equal(second.store.getSnapshot().draft, 'Keep my draft');
  assert.deepEqual(second.store.getSnapshot().outbox, saved.outbox);
});

test('an unknown saved command prevents writes and retains the complete draft and outbox', async () => {
  const first = fixture();
  await first.store.setDraft('Preserve this draft');
  await first.store.approve('old-decision', 'allow');
  const saved = structuredClone(first.drafts.value);
  saved.outbox.push({ command: { version: 1, scope, clientCommandId: 'future-command',
    body: { kind: 'future-command', privateData: { original: true } } }, draftRevision: null });
  const second = fixture({ drafts: storage(saved) });
  await assert.rejects(second.store.ready, /Unsupported command kind/);
  await assert.rejects(second.store.setDraft('overwrite'), /Unsupported command kind/);
  await assert.rejects(second.store.revokePermission('permission', 'agent'), /Unsupported command kind/);
  assert.deepEqual(second.drafts.value, saved);
  assert.deepEqual(second.drafts.writes, []);
  assert.deepEqual(second.port.submitted, []);
});

const png = (...tail) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...tail]);
function uploads({ auto = true, fail = null } = {}) {
  let count = 0;
  return {
    calls: [],
    upload(input) {
      const reply = deferred();
      const attachment = { imageId: `00000000-0000-4000-8000-aaaaaaaaaa${String(++count).padStart(2, '0')}`, name: input.name,
        mediaType: 'image/png', byteLength: input.bytes.byteLength, width: 1, height: 1 };
      this.calls.push({ uploadId: input.uploadId, name: input.name, bytes: [...input.bytes], reply, attachment });
      if (fail) reply.reject(fail);
      else if (auto) reply.resolve(attachment);
      return reply.promise;
    },
  };
}

test('version 1 records restore without an image and version 2 image records round trip or are refused', async () => {
  const legacy = fixture({ drafts: storage({ version: 1, scope, draft: 'old', draftRevision: 3, outbox: [] }) });
  await legacy.store.ready;
  assert.equal(legacy.store.getSnapshot().image, null);
  const { store, drafts } = fixture({ images: uploads() });
  await store.selectImage({ name: 'chart.png', bytes: png(1) });
  assert.equal(drafts.value.version, 2);
  const reloaded = fixture({ drafts: storage(structuredClone(drafts.value)) });
  await reloaded.store.ready;
  assert.deepEqual({ ...reloaded.store.getSnapshot().image }, { ...store.getSnapshot().image });
  for (const image of [{ ...drafts.value.image, uploadId: 'upload' }, { ...drafts.value.image, byteLength: 4 * 1024 * 1024 + 1 },
    { ...drafts.value.image, attachment: { ...drafts.value.image.attachment, byteLength: 2 } }, { ...drafts.value.image, extra: true }]) {
    const invalid = fixture({ drafts: storage({ ...drafts.value, image }) });
    await assert.rejects(invalid.store.ready);
  }
});

test('image bytes are stored once beside the records and leave atomically on replace or remove', async () => {
  const images = uploads();
  const { store, drafts } = fixture({ images });
  await store.selectImage({ name: 'first.png', bytes: png(1) });
  const first = store.getSnapshot().image;
  assert.deepEqual({ status: first.status, name: first.name, byteLength: first.byteLength }, { status: 'ready', name: 'first.png', byteLength: 9 });
  assert.deepEqual(drafts.imageWrites, [{ put: first.selectionId, remove: [] }]);
  assert.equal(JSON.stringify(drafts.value).includes('"bytes"'), false);
  await store.setDraft('caption');
  await store.setDraft('caption edited');
  assert.equal(drafts.imageWrites.length, 1);
  await store.selectImage({ name: 'second.png', bytes: png(2) });
  const second = store.getSnapshot().image;
  assert.deepEqual(drafts.imageWrites.at(-1), { put: second.selectionId, remove: [first.selectionId] });
  assert.deepEqual([...drafts.images.keys()], [second.selectionId]);
  await store.removeImage();
  assert.deepEqual(drafts.imageWrites.at(-1), { put: null, remove: [second.selectionId] });
  assert.equal(drafts.images.size, 0);
  assert.equal(store.getSnapshot().image, null);
  assert.equal(store.getSnapshot().draft, 'caption edited');
});

test('local validation refuses unsupported files and bounds names without splitting characters', async () => {
  const images = uploads();
  const { store, drafts } = fixture({ images });
  await assert.rejects(store.selectImage({ name: 'a.gif', bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38]) }), /PNG or JPEG/);
  await assert.rejects(store.selectImage({ name: 'empty.png', bytes: new Uint8Array() }), /empty/);
  await assert.rejects(store.selectImage({ name: 'big.png', bytes: new Uint8Array(4 * 1024 * 1024 + 1) }), /4 MB/);
  await assert.rejects(store.selectImage({ name: ' \u0000 ', bytes: png() }), /file name/);
  assert.equal(images.calls.length, 0);
  assert.equal(drafts.writes.length, 0);
  await store.selectImage({ name: `${'a'.repeat(158)}😀.jpg`, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) });
  assert.equal(store.getSnapshot().image.name, 'a'.repeat(158));
});

test('late upload completion cannot confirm a replaced or removed selection but survives text edits', async () => {
  const images = uploads({ auto: false });
  const { store } = fixture({ images });
  const first = store.selectImage({ name: 'first.png', bytes: png(1) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getSnapshot().image.status, 'uploading');
  const second = store.selectImage({ name: 'second.png', bytes: png(2) });
  await new Promise(resolve => setImmediate(resolve));
  images.calls[0].reply.resolve(images.calls[0].attachment);
  await first;
  assert.equal(store.getSnapshot().image.name, 'second.png');
  assert.equal(store.getSnapshot().image.status, 'uploading');
  await store.setDraft('edited while uploading');
  images.calls[1].reply.resolve(images.calls[1].attachment);
  await second;
  assert.equal(store.getSnapshot().image.status, 'ready');
  assert.equal(store.getSnapshot().image.attachment.imageId, images.calls[1].attachment.imageId);
  const third = store.selectImage({ name: 'third.png', bytes: png(3) });
  await new Promise(resolve => setImmediate(resolve));
  await store.removeImage();
  images.calls[2].reply.resolve(images.calls[2].attachment);
  await third;
  assert.equal(store.getSnapshot().image, null);
});

test('composer send carries a ready image, waits for confirmation and allows image-only messages', async () => {
  const images = uploads({ auto: false });
  const { store, port } = fixture({ images });
  const selecting = store.selectImage({ name: 'chart.png', bytes: png(1) });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(store.send(), /Wait for the image to finish uploading/);
  images.calls[0].reply.resolve(images.calls[0].attachment);
  await selecting;
  await store.send('explicit text');
  assert.deepEqual(port.submitted[0].body, { kind: 'send', text: 'explicit text' });
  assert.equal(store.getSnapshot().image.status, 'ready');
  await store.send();
  assert.deepEqual(port.submitted[1].body, { kind: 'send', text: '', imageId: images.calls[0].attachment.imageId });
});

test('accepted image send clears draft, image and bytes only for the captured revision', async () => {
  const images = uploads();
  const { store, port, drafts } = fixture({ images });
  await store.setDraft('look');
  await store.selectImage({ name: 'chart.png', bytes: png(1) });
  const selected = store.getSnapshot().image.selectionId;
  port.submit = async command => { port.submitted.push(command); return { kind: 'receipt', receipt: receipt(command, 'accepted') }; };
  await store.send();
  assert.equal(store.getSnapshot().draft, '');
  assert.equal(store.getSnapshot().image, null);
  assert.deepEqual(drafts.imageWrites.at(-1), { put: null, remove: [selected] });
  assert.equal(drafts.images.size, 0);
  await store.setDraft('again');
  await store.selectImage({ name: 'first.png', bytes: png(2) });
  const entered = deferred();
  const reply = deferred();
  port.submit = async command => { entered.resolve(command); return reply.promise; };
  const sending = store.send();
  const command = await entered.promise;
  await store.selectImage({ name: 'replacement.png', bytes: png(3) });
  reply.resolve({ kind: 'receipt', receipt: receipt(command, 'accepted') });
  await sending;
  assert.equal(store.getSnapshot().draft, 'again');
  assert.equal(store.getSnapshot().image.name, 'replacement.png');
  assert.deepEqual([...drafts.images.keys()], [store.getSnapshot().image.selectionId]);
});

test('an unconfirmed selection reloads as interrupted and retry re-uploads its stored bytes with the same upload ID', async () => {
  const failed = uploads({ fail: Object.assign(new Error('raw host detail'), { kind: 'image-capacity' }) });
  const first = fixture({ images: failed });
  await first.store.selectImage({ name: 'chart.png', bytes: png(7) });
  assert.equal(first.store.getSnapshot().image.status, 'failed');
  assert.match(first.store.getSnapshot().image.reason, /no room for more images/);
  const generic = fixture({ images: uploads({ fail: new Error('socket closed at /private/path') }) });
  await generic.store.selectImage({ name: 'chart.png', bytes: png(7) });
  assert.equal(generic.store.getSnapshot().image.reason, 'Couldn’t upload this image. Try again.');
  const drafts = storage(structuredClone(first.drafts.value));
  drafts.images = new Map(first.drafts.images);
  const images = uploads();
  const { store } = fixture({ drafts, images });
  await store.ready;
  assert.equal(store.getSnapshot().image.status, 'interrupted');
  await store.retryImage();
  assert.equal(images.calls[0].uploadId, failed.calls[0].uploadId);
  assert.deepEqual(images.calls[0].bytes, [...png(7)]);
  assert.equal(store.getSnapshot().image.status, 'ready');
  assert.deepEqual(drafts.imageWrites, []);
});
