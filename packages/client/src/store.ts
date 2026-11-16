import { parseCommand, parseScope, sameScope } from '@agentui/contracts';
import type { CommandBody, Feed, Receipt, SubmitResult } from '@agentui/contracts';
import { applyDelivery, decodeReceipt, DeliveryError } from './delivery.js';
import type { DeliveryState } from './delivery.js';
import { copyCanonicalJson, immutable, restore } from './local-state.js';
import type { ClientView, ConnectionState, ConversationStore, LocalRecords, OutboxEntry, StoreOptions } from './types.js';

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
  const clearDraft = (receipt.state.kind === 'accepted' || receipt.state.kind === 'completed') &&
    entry.draftRevision === local.draftRevision && entry.command.body.kind === 'send' && entry.command.body.text === local.draft;
  return immutable({ ...local, draft: clearDraft ? '' : local.draft,
    outbox: local.outbox.filter(value => value.command.clientCommandId !== receipt.clientCommandId) });
}
export function createConversationStore<E, P>(options: StoreOptions<E, P>): ConversationStore<P> {
  const { port, projection, drafts, createCommandId } = options;
  const scope = immutable(parseScope(options.scope));
  if (!sameScope(scope, port.scope)) throw new Error('Port scope mismatch');
  let local = restore(null, scope);
  let replay: ReplayState<P> = { kind: 'untrusted', cause: { kind: 'cold' },
    delivery: { document: immutable({ domain: projection.initial(), receipts: {}, decisions: {} }), cursor: null, identities: new Map() } };
  let connection: ConnectionState = { kind: 'disconnected' };
  const inFlight = new Set<string>();
  let view: ClientView<P> = makeView();
  const listeners = new Set<() => void>();
  let feed: Feed | null = null;
  let generation = 0;
  function makeView(): ClientView<P> {
    const applied = replay.delivery;
    return Object.freeze({ document: applied.document, cursor: applied.cursor, draft: local.draft, outbox: local.outbox, connection: Object.freeze(connection), submitting: Object.freeze([...inFlight]) });
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
  async function persist(next: LocalRecords): Promise<void> {
    await drafts.save(next);
    local = next;
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
  async function dispatch(entry: OutboxEntry, admission: 'known-absent' | 'unknown-or-observed'): Promise<SubmitResult> {
    requireCompatible();
    const id = entry.command.clientCommandId;
    if (inFlight.has(id)) throw new Error('Command submission already in progress');
    inFlight.add(id);
    try {
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
      const command = immutable(parseCommand({ version: 1, scope, clientCommandId: createCommandId(), body: body ?? { kind: 'send', text: local.draft } }));
      if (local.outbox.some(value => value.command.clientCommandId === command.clientCommandId) || Object.hasOwn(view.document.receipts, command.clientCommandId)) throw new Error('Command ID generator reused an existing ID');
      const created = immutable({ command, draftRevision: body === null ? local.draftRevision : null });
      await persist(immutable({ ...local, outbox: [...local.outbox, created] }));
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
        if (local.draftRevision === Number.MAX_SAFE_INTEGER) throw new Error('Draft revision exhausted');
        await persist(immutable({ ...local, draft: text, draftRevision: local.draftRevision + 1 }));
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
