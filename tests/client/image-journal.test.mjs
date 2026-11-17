import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createConversationStore, FrontendImagesUnsupportedError } from '@agentui/client';
import { deferred, fakePort, projection, receipt, scope, storage } from './support.mjs';

const bytes = new Uint8Array(readFileSync(new URL('../application/fixtures/released-local-images/selected-image.png', import.meta.url)));
const offer = { platform: 'desktop', tools: [{ definition: { name: 'fixture__echo', description: 'Original' }, activationId: 'A' }] };
const attachment = { imageId: '33333333-3333-4333-8333-333333333333', name: 'pixel.png', mediaType: 'image/png', byteLength: bytes.length, width: 1, height: 1 };
function fixture(t, { drafts = storage(), images = { upload: async () => attachment } } = {}) {
  const port = fakePort(), captures = [], commits = [], releases = [];
  let id = 0;
  const frontend = { capture(id) { captures.push(id); return { ownerId: 'principal', offer,
    commit(command, journal) { commits.push({ command, journal }); return true; }, release() { releases.push(id); } }; },
    canRetry: () => true, async rejected() {} };
  const store = createConversationStore({ scope, projection, drafts, port, frontend, images,
    createCommandId: () => `command-${++id}`, createImageId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}` });
  t.after(() => store.dispose());
  return { store, drafts, port, captures, commits, releases };
}

test('captured composer image refusal preserves draft, bytes and prior captures while explicit text remains supported', async t => {
  const f = fixture(t);
  await f.store.send('Earlier capture');
  await f.store.setDraft('Image caption');
  await f.store.selectImage({ name: attachment.name, bytes });
  const before = structuredClone(f.drafts.value), imageWrites = structuredClone(f.drafts.imageWrites), saves = f.drafts.writes.length;
  await assert.rejects(f.store.send(), error => error instanceof FrontendImagesUnsupportedError && error.kind === 'frontend-images-unsupported');
  assert.deepEqual(f.drafts.value, before);
  assert.equal(f.drafts.writes.length, saves);
  assert.deepEqual(f.drafts.imageWrites, imageWrites);
  assert.equal(f.port.submitted.length, 1);
  assert.equal(f.commits.length, 1);
  assert.deepEqual(f.releases, [f.captures[1]]);
  f.port.submit = async command => ({ kind: 'receipt', receipt: receipt(command, 'completed') });
  await f.store.send('Explicit text');
  assert.equal(f.commits.length, 2);
  assert.equal(f.commits[1].command.body.text, 'Explicit text');
  assert.equal(Object.hasOwn(f.commits[1].command.body, 'imageId'), false);
  assert.deepEqual(f.drafts.value.image, before.image);
  assert.equal(f.drafts.value.draft, before.draft);
  assert.deepEqual(f.drafts.imageWrites, imageWrites);
  assert.equal(f.drafts.value.frontendSends.length, 2);
  await f.store.removeImage();
  await f.store.send();
  assert.equal(f.commits.length, 3);
  assert.equal(f.drafts.value.draft, '');
});

test('late image confirmation merges current draft and both journal transitions without another byte put', async t => {
  const gate = deferred(), entered = deferred();
  const f = fixture(t, { images: { upload() { entered.resolve(); return gate.promise; } } });
  await f.store.send('Captured');
  const id = f.commits[0].command.clientCommandId;
  const selecting = f.store.selectImage({ name: attachment.name, bytes });
  await entered.promise;
  await f.store.setDraft('Newer caption');
  await f.store.frontendJournal.unavailable(id);
  await f.store.frontendJournal.acknowledged(id);
  gate.resolve(attachment); await selecting;
  assert.equal(f.drafts.value.version, 3);
  assert.equal(f.drafts.value.draft, 'Newer caption');
  assert.equal(f.drafts.value.frontendSends[0].state, 'unavailable-confirmed');
  assert.deepEqual(f.drafts.value.frontendSends[0].command, f.commits[0].command);
  assert.deepEqual(f.drafts.value.image.attachment, attachment);
  assert.equal(f.drafts.imageWrites.length, 1);
  assert.deepEqual(f.drafts.images.get(f.drafts.value.image.selectionId), bytes);
});

for (const boundary of ['upload', 'retry-read', 'upload-publication']) test(`closing at ${boundary} prevents late image writes and transport`, async t => {
  const gate = deferred(), entered = deferred(); let uploads = 0;
  const f = fixture(t, { images: { upload() { uploads++; entered.resolve(); return gate.promise; } } });
  let pending;
  if (boundary === 'upload-publication') {
    f.store.subscribe(() => { if (f.store.getSnapshot().image?.status === 'uploading') void f.store.dispose(); });
    pending = f.store.selectImage({ name: attachment.name, bytes });
    await pending;
    assert.equal(uploads, 0);
  } else {
    pending = f.store.selectImage({ name: attachment.name, bytes });
    await entered.promise;
    if (boundary === 'retry-read') {
      gate.reject(new Error('Interrupted')); await pending;
      f.drafts.loadImage = async () => { entered.resolve(); return new Promise(resolve => { gate.resolve = resolve; }); };
      pending = f.store.retryImage();
      await new Promise(resolve => setImmediate(resolve));
    }
    await f.store.dispose();
    const before = structuredClone(f.drafts.value), writes = f.drafts.writes.length;
    if (boundary === 'retry-read') { const refused = assert.rejects(pending, /closed/); gate.resolve(bytes); await refused; }
    else { gate.resolve(attachment); await pending; }
    assert.deepEqual(f.drafts.value, before); assert.equal(f.drafts.writes.length, writes);
    assert.equal(uploads, 1);
  }
  assert.equal(f.drafts.value.image.attachment, null);
  const successor = createConversationStore({ scope, projection, drafts: f.drafts, port: fakePort(), createCommandId: () => 'next' });
  await successor.ready;
  assert.equal(successor.getSnapshot().image.status, 'interrupted');
  await successor.dispose();
});

test('historical records have exact domains and failed hydration fences every mutator without touching bytes', async t => {
  const command = { version: 2, scope, clientCommandId: 'offered', body: { kind: 'send', text: 'Original', frontend: offer } };
  const image = { selectionId: 'selection', uploadId: '22222222-2222-4222-8222-222222222222', name: attachment.name, byteLength: bytes.length, attachment };
  const base = { version: 3, scope, draft: 'Keep', draftRevision: 2, outbox: [], image, frontendSends: [{ command, ownerId: 'principal', state: 'retained' }] };
  const legacy = { version: 1, scope, draft: 'Keep', draftRevision: 2, outbox: [] };
  const released = { ...legacy, version: 2, image };
  const plain = { version: 1, scope, clientCommandId: 'old', body: { kind: 'send', text: 'Old' } };
  const offeredOutbox = [{ command, draftRevision: 1 }];
  const invalid = [
    { ...legacy, image: null }, { ...legacy, frontendSends: [] },
    { ...legacy, outbox: [{ command: { ...plain, body: { ...plain.body, imageId: attachment.imageId } }, draftRevision: 1 }] },
    { ...released, frontendSends: [] }, { ...released, outbox: offeredOutbox }, { ...legacy, version: 2, frontendSends: base.frontendSends },
    { ...released, extra: true }, { ...base, image: undefined }, { ...base, frontendSends: undefined },
    { ...base, outbox: [{ command: plain, draftRevision: 1, extra: true }] },
    { ...base, frontendSends: [{ ...base.frontendSends[0], extra: true }] },
    { ...base, outbox: offeredOutbox, frontendSends: [] }, { ...base, version: 99 },
  ];
  for (const value of invalid) {
    const drafts = storage(value); drafts.images.set(image.selectionId, bytes.slice());
    const f = fixture(t, { drafts });
    await assert.rejects(f.store.ready);
    for (const mutate of [() => f.store.setDraft('Erase'), () => f.store.selectImage({ name: attachment.name, bytes }),
      () => f.store.retryImage(), () => f.store.removeImage(), () => f.store.send('Erase'),
      () => f.store.frontendJournal.unavailable('offered'), () => f.store.frontendJournal.acknowledged('offered')]) await assert.rejects(mutate());
    assert.deepEqual(drafts.value, value); assert.deepEqual(drafts.writes, []); assert.deepEqual(drafts.images.get(image.selectionId), bytes);
    assert.deepEqual(f.captures, []); assert.deepEqual(f.port.submitted, []);
  }
});

for (const change of ['closed', 'removed', 'current']) test(`rejected byte read belongs to its ${change} image operation`, async t => {
  const f = fixture(t, { images: { async upload() { throw new Error('Interrupted'); } } });
  await f.store.selectImage({ name: attachment.name, bytes });
  const gate = deferred(), entered = deferred();
  f.drafts.loadImage = () => { entered.resolve(); return gate.promise; };
  const retrying = f.store.retryImage();
  const result = retrying.then(() => null, error => error.message);
  await entered.promise;
  if (change === 'closed') await f.store.dispose();
  if (change === 'removed') await f.store.removeImage();
  const before = structuredClone(f.drafts.value), writes = f.drafts.writes.length;
  gate.reject(new Error('Byte read failed'));
  assert.equal(await result, change === 'closed' ? 'This conversation store has closed.' : change === 'current' ? 'Byte read failed' : null);
  assert.deepEqual(f.drafts.value, before); assert.equal(f.drafts.writes.length, writes);
});

test('typed unsupported upload preserves selected bytes and identity for later retry', async t => {
  const calls = [];
  const f = fixture(t, { images: { async upload(input) {
    calls.push(structuredClone(input));
    if (calls.length === 1) throw Object.assign(new Error('Unsupported'), { kind: 'image-unsupported' });
    return attachment;
  } } });
  await f.store.setDraft('Keep caption');
  await f.store.selectImage({ name: attachment.name, bytes });
  assert.equal(f.store.getSnapshot().image.status, 'failed');
  assert.match(f.store.getSnapshot().image.reason, /cannot receive images/);
  const selected = structuredClone(f.drafts.value.image);
  assert.deepEqual(f.drafts.images.get(selected.selectionId), bytes);
  await f.store.retryImage();
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(f.drafts.value.image.selectionId, selected.selectionId);
  assert.equal(f.drafts.value.image.uploadId, selected.uploadId);
  assert.equal(f.drafts.value.draft, 'Keep caption');
  assert.deepEqual(f.drafts.images.get(selected.selectionId), bytes);
  assert.equal(f.store.getSnapshot().image.status, 'ready');
});
