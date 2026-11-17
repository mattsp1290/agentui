import { parseCommand, parseScope, sameScope } from '@agentui/contracts';
import type { CommandBody, Feed, Receipt, SubmitResult } from '@agentui/contracts';
import { utf8Bytes } from '@agentui/contracts/decode';
import { IMAGE_MAX_BYTES, IMAGE_MAX_NAME_BYTES, parseImageAttachment, parseImageName, parseUploadId } from '@agentui/contracts/image';
import type { ImageFailureKind } from '@agentui/contracts/image';
import { applyDelivery, decodeReceipt, DeliveryError } from './delivery.js';
import type { DeliveryState } from './delivery.js';
import { copyCanonicalJson, immutable, restore } from './local-state.js';
import type { ClientView, ComposerImage, ComposerImageRecord, ConnectionState, ConversationStore, DraftImageChange, LocalRecords, OutboxEntry, StoreOptions } from './types.js';

type ReplayCause = { readonly kind: 'cold' | 'invalid' } | { readonly kind: 'mismatch'; readonly reason: string };
type ReplayState<P> = { readonly delivery: DeliveryState<P> } &
  ({ readonly kind: 'valid' } | { readonly kind: 'untrusted'; readonly cause: ReplayCause });
function baseline<P>(replay: ReplayState<P>): DeliveryState<P> {
  if (replay.kind === 'valid') return replay.delivery;
  return { document: replay.delivery.document, cursor: null, identities: new Map<number, string>() };
}

function acknowledgementBoundary(): Promise<void> { return Promise.resolve(); }
function settled(receipt: Receipt): boolean {
  return receipt.state.kind !== 'pending' && receipt.state.kind !== 'uncertain';
}
function settle(local: LocalRecords, receipt: Receipt): LocalRecords {
  if (!settled(receipt)) return local;
  const entry = local.outbox.find(value => value.command.clientCommandId === receipt.clientCommandId);
  if (!entry) return local;
  const body = entry.command.body;
  const sent = (receipt.state.kind === 'accepted' || receipt.state.kind === 'completed') && entry.draftRevision !== null && body.kind === 'send';
  const clearDraft = sent && entry.draftRevision === local.draftRevision && body.text === local.draft;
  // The sent image leaves the composer even when the user kept typing, so it is never sent twice. Settlement is not an
  // edit, so draftRevision stays put: a later capture of the same edit still clears its text, and any newer edit
  // already advanced the revision past older captures. A different image has a different imageId and is kept.
  const clearImage = sent && body.imageId !== undefined && local.image?.attachment?.imageId === body.imageId;
  return immutable({ ...local, draft: clearDraft ? '' : local.draft, image: clearImage ? null : local.image,
    outbox: local.outbox.filter(value => value.command.clientCommandId !== receipt.clientCommandId) });
}
const IMAGE_FAILURES: Record<ImageFailureKind, string> = {
  'invalid-image': 'This image could not be read. Choose a different PNG or JPEG.',
  'image-capacity': 'The host has no room for more images. Remove older conversations or try a smaller image.',
  'image-upload-conflict': 'This upload no longer matches the selected image. Remove it and choose the image again.',
  'image-scope': 'This conversation cannot accept the image.',
  'image-integrity': 'The host could not verify this image. Try again.',
};
function uploadFailure(error: unknown): string {
  const kind: unknown = error && typeof error === 'object' && 'kind' in error ? error.kind : null;
  return typeof kind === 'string' && Object.hasOwn(IMAGE_FAILURES, kind) ? IMAGE_FAILURES[kind as ImageFailureKind] : 'Couldn’t upload this image. Try again.';
}
function imageType(bytes: Uint8Array): boolean {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return png.every((value, index) => bytes[index] === value) || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff);
}
function imageName(value: string): string {
  let name = '';
  for (const character of value.replace(/[\p{Cc}\p{Cs}]/gu, '').trim()) {
    if (utf8Bytes(name + character) > IMAGE_MAX_NAME_BYTES) break;
    name += character;
  }
  if (!name.trim()) throw new Error('The image needs a file name.');
  return parseImageName(name.trim());
}
export function createConversationStore<E, P>(options: StoreOptions<E, P>): ConversationStore<P> {
  const { port, projection, drafts, createCommandId } = options;
  const createImageId = options.createImageId ?? createCommandId;
  const scope = immutable(parseScope(options.scope));
  if (!sameScope(scope, port.scope)) throw new Error('Port scope mismatch');
  let local = restore(null, scope);
  let replay: ReplayState<P> = { kind: 'untrusted', cause: { kind: 'cold' },
    delivery: { document: immutable({ domain: projection.initial(), receipts: {}, decisions: {} }), cursor: null, identities: new Map() } };
  let connection: ConnectionState = { kind: 'disconnected' };
  const inFlight = new Set<string>();
  let uploading: { readonly selectionId: string; promise?: Promise<void> } | null = null;
  let failure: { readonly selectionId: string; readonly reason: string } | null = null;
  let view: ClientView<P> = makeView();
  const listeners = new Set<() => void>();
  let feed: Feed | null = null;
  let generation = 0;
  function makeView(): ClientView<P> {
    const applied = replay.delivery;
    return Object.freeze({ document: applied.document, cursor: applied.cursor, draft: local.draft, outbox: local.outbox, connection: Object.freeze(connection), submitting: Object.freeze([...inFlight]), image: composerImage() });
  }
  function composerImage(): ComposerImage | null {
    const image = local.image;
    if (!image) return null;
    const { selectionId, name, byteLength, attachment } = image;
    if (attachment) return Object.freeze({ selectionId, name, byteLength, status: 'ready', attachment });
    if (uploading?.selectionId === selectionId) return Object.freeze({ selectionId, name, byteLength, status: 'uploading' });
    // A persisted selection without an upload in this session was cut off by a reload.
    return Object.freeze(failure?.selectionId === selectionId ? { selectionId, name, byteLength, status: 'failed', reason: failure.reason }
      : { selectionId, name, byteLength, status: 'interrupted' });
  }
  function publish(): void {
    view = makeView();
    for (const listener of listeners) listener();
  }
  const ready = drafts.load(scope).then(value => { local = restore(value, scope); publish(); });
  void ready.catch(error => {
    connection = { kind: 'failed', reason: error instanceof Error ? error.message : 'Local storage load failed' };
    publish();
  }).catch(() => undefined);
  let saves: Promise<void> = ready;
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = saves.then(operation);
    saves = result.then(() => undefined, () => undefined);
    return result;
  }
  async function persist(next: LocalRecords, put?: DraftImageChange['put']): Promise<void> {
    const previous = local.image?.selectionId;
    const remove = previous !== undefined && previous !== next.image?.selectionId ? [previous] : [];
    if (put || remove.length) await drafts.save(next, { ...(put ? { put } : {}), ...(remove.length ? { remove } : {}) });
    else await drafts.save(next);
    local = next;
  }
  function revised(changes: Partial<Pick<LocalRecords, 'draft' | 'image'>>): LocalRecords {
    if (local.draftRevision === Number.MAX_SAFE_INTEGER) throw new Error('Draft revision exhausted');
    return immutable({ ...local, ...changes, draftRevision: local.draftRevision + 1 });
  }
  function upload(image: ComposerImageRecord, bytes: Uint8Array): Promise<void> {
    if (uploading?.selectionId === image.selectionId && uploading.promise) return uploading.promise;
    const flight: { readonly selectionId: string; promise?: Promise<void> } = { selectionId: image.selectionId };
    uploading = flight;
    failure = null;
    publish();
    flight.promise = (async () => {
      try {
        if (!options.images) throw new Error('Image uploads are unavailable');
        const attachment = immutable(parseImageAttachment(copyCanonicalJson(await options.images.upload({ scope, uploadId: image.uploadId, name: image.name, bytes }))));
        if (attachment.name !== image.name || attachment.byteLength !== image.byteLength) throw new Error('Image upload response mismatch');
        await enqueue(async () => {
          const current = local.image;
          if (current?.selectionId !== image.selectionId || current.attachment) return;
          await persist(immutable({ ...local, image: { ...current, attachment } }));
        });
      } catch (error) {
        if (local.image?.selectionId === image.selectionId) failure = { selectionId: image.selectionId, reason: uploadFailure(error) };
      } finally {
        if (uploading === flight) uploading = null;
        publish();
      }
    })();
    return flight.promise;
  }
  function composerBody(): CommandBody {
    const image = local.image;
    if (!image) return { kind: 'send', text: local.draft };
    if (!image.attachment) throw new Error(uploading?.selectionId === image.selectionId ? 'Wait for the image to finish uploading.' : 'Retry or remove the image before sending.');
    return { kind: 'send', text: local.draft, imageId: image.attachment.imageId };
  }
  function requireWritableRetryStorage(): Promise<void> { return drafts.save(local); }
  function requireCompatible(): void {
    if (replay.kind === 'untrusted' && replay.cause.kind === 'mismatch') throw new Error(replay.cause.reason);
  }
  function invalidate(cause: ReplayCause): void {
    if (replay.kind === 'untrusted' && replay.cause.kind === 'mismatch' && cause.kind !== 'mismatch') cause = replay.cause;
    replay = { kind: 'untrusted', delivery: replay.delivery, cause };
  }
  function stop(next: ConnectionState): void {
    generation++;
    const previous = feed;
    feed = null;
    connection = next;
    previous?.close();
    publish();
  }
  function reserve(id: string): void {
    if (inFlight.has(id)) throw new Error('Command submission already in progress');
    inFlight.add(id);
  }
  async function dispatch(entry: OutboxEntry, admission: 'known-absent' | 'unknown-or-observed'): Promise<SubmitResult> {
    const id = entry.command.clientCommandId;
    try {
      requireCompatible();
      publish();
      const result = await port.submit(entry.command);
      if (result.kind === 'rejected') {
        if (admission === 'known-absent') await enqueue(async () => {
          await persist(immutable({ ...local, outbox: local.outbox.filter(value => value.command.clientCommandId !== id) }));
          publish();
        });
        return result;
      }
      if (result.kind !== 'receipt') throw new Error('Unsupported submit result');
      const receipt = immutable(decodeReceipt(copyCanonicalJson(result.receipt), scope));
      if (receipt.clientCommandId !== id) throw new Error('Submit receipt command ID mismatch');
      await enqueue(async () => {
        const next = settle(local, receipt);
        if (next !== local) { await persist(next); publish(); }
      });
      return { kind: 'receipt', receipt };
    } finally { inFlight.delete(id); publish(); }
  }
  async function submit(body: CommandBody | null): Promise<SubmitResult> {
    await ready;
    const entry = await enqueue(async () => {
      requireCompatible();
      const command = immutable(parseCommand({ version: 1, scope, clientCommandId: createCommandId(), body: body ?? composerBody() }));
      if (local.outbox.some(value => value.command.clientCommandId === command.clientCommandId) || Object.hasOwn(view.document.receipts, command.clientCommandId)) throw new Error('Command ID generator reused an existing ID');
      const created = immutable({ command, draftRevision: body === null ? local.draftRevision : null });
      // Reserved before the outbox publish so observers never see a new command as an unresolved retained one.
      reserve(command.clientCommandId);
      try { await persist(immutable({ ...local, outbox: [...local.outbox, created] })); }
      catch (error) { inFlight.delete(command.clientCommandId); throw error; }
      publish();
      return created;
    });
    return dispatch(entry, 'known-absent');
  }
  return {
    ready,
    getSnapshot: () => view,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async setDraft(text) {
      await ready;
      await enqueue(async () => {
        await persist(revised({ draft: text }));
        publish();
      });
    },
    async selectImage(file) {
      await ready;
      const bytes = file.bytes.slice();
      if (!bytes.byteLength) throw new Error('This image file is empty.');
      if (bytes.byteLength > IMAGE_MAX_BYTES) throw new Error('Choose an image of at most 4 MB.');
      if (!imageType(bytes)) throw new Error('Choose a PNG or JPEG image.');
      const name = imageName(file.name);
      const started = await enqueue(async () => {
        const image: ComposerImageRecord = immutable({ selectionId: createImageId(), uploadId: parseUploadId(createImageId()), name, byteLength: bytes.byteLength, attachment: null });
        await persist(revised({ image }), { selectionId: image.selectionId, bytes });
        // Awaiting here would deadlock: completion enqueues behind this operation.
        return { done: upload(image, bytes) };
      });
      await started.done;
    },
    async retryImage() {
      await ready;
      const image = local.image;
      if (!image || image.attachment) return;
      if (uploading?.selectionId === image.selectionId && uploading.promise) return uploading.promise;
      const bytes = await drafts.loadImage(scope, image.selectionId);
      if (local.image?.selectionId !== image.selectionId) return;
      if (bytes?.byteLength !== image.byteLength) {
        failure = { selectionId: image.selectionId, reason: 'This image is no longer saved on this device. Remove it and choose it again.' };
        publish();
        return;
      }
      return upload(image, bytes);
    },
    async removeImage() {
      await ready;
      await enqueue(async () => {
        if (!local.image) return;
        await persist(revised({ image: null }));
        publish();
      });
    },
    send: text => submit(text === undefined ? null : { kind: 'send', text }),
    approve: (pendingId, choiceId) => submit({ kind: 'approve', pendingId, choiceId }),
    revokePermission: (permissionId, scope) => submit({ kind: 'revoke-permission', permissionId, scope }),
    cancel: runId => submit({ kind: 'cancel', runId }),
    async retry(clientCommandId) {
      await ready;
      const entry = await enqueue(async () => {
        requireCompatible();
        const found = local.outbox.find(value => value.command.clientCommandId === clientCommandId);
        if (!found) throw new Error('Command is not in the outbox');
        await requireWritableRetryStorage();
        reserve(clientCommandId);
        return found;
      });
      return dispatch(entry, 'unknown-or-observed');
    },
    async refreshReceipt(clientCommandId) {
      await ready;
      const value = await port.receipt(clientCommandId);
      if (value === null) return null;
      const receipt = immutable(decodeReceipt(copyCanonicalJson(value), scope));
      if (receipt.clientCommandId !== clientCommandId) throw new Error('Lookup receipt command ID mismatch');
      await enqueue(async () => {
        const next = settle(local, receipt);
        if (next !== local) { await persist(next); publish(); }
      });
      return receipt;
    },
    async connect() {
      stop({ kind: 'connecting' });
      const current = generation;
      let receiving = false;
      try {
        await ready;
        if (current !== generation) return;
        const after = baseline(replay).cursor;
        const opened = port.watch({ after, projectionVersion: projection.version }, async item => {
          if (current !== generation) return;
          if (receiving) { invalidate({ kind: 'invalid' }); stop({ kind: 'failed', reason: 'Host delivered concurrent callbacks' }); return; }
          receiving = true;
          try {
            const previous = baseline(replay);
            const next = applyDelivery(previous, item, scope, projection);
            await acknowledgementBoundary();
            if (current !== generation) return;
            if (next === previous && connection.kind === 'connected') return;
            replay = { kind: 'valid', delivery: { ...next, document: immutable(next.document) } };
            connection = { kind: 'connected' };
            publish();
          } catch (error) {
            if (current === generation) {
              invalidate(error instanceof DeliveryError && error.kind === 'mismatch' ? { kind: 'mismatch', reason: error.message } : { kind: 'invalid' });
              stop({ kind: error instanceof DeliveryError ? error.kind : 'resync', reason: error instanceof Error ? error.message : 'Feed delivery failed' });
            }
            throw error;
          } finally { receiving = false; }
        });
        if (current !== generation) { opened.close(); return; }
        feed = opened;
        void opened.ended.then(end => {
          if (current !== generation) return;
          const next: ConnectionState = end.kind === 'closed' ? { kind: 'disconnected' }
            : { kind: end.kind === 'refused' ? 'mismatch' : end.kind, reason: end.reason };
          if (end.kind === 'resync' || end.kind === 'refused') invalidate(end.kind === 'refused' ? { kind: 'mismatch', reason: end.reason } : { kind: 'invalid' });
          stop(next);
        }, error => {
          if (current === generation) stop({ kind: 'failed', reason: error instanceof Error ? error.message : 'Feed failed' });
        });
      } catch (error) {
        if (current === generation) stop({ kind: 'failed', reason: error instanceof Error ? error.message : 'Connection failed' });
        throw error;
      }
    },
    disconnect() { if (connection.kind !== 'disconnected') stop({ kind: 'disconnected' }); },
  };
}
