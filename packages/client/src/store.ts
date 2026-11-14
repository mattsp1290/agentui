import { parseCommand, parseScope, sameScope } from '@agentui/contracts';
import type { CommandBody, Feed, Receipt, SubmitResult } from '@agentui/contracts';
import { applyDelivery, decodeReceipt, DeliveryError } from './delivery.js';
import type { DeliveryState } from './delivery.js';
import { copyJson, immutable, restore } from './local-state.js';
import type { ClientView, ConnectionState, ConversationStore, LocalRecords, OutboxEntry, StoreOptions } from './types.js';

function settled(receipt: Receipt): boolean {
  return receipt.state.kind !== 'pending' && receipt.state.kind !== 'uncertain';
}
function reconcile(local: LocalRecords, receipts: readonly Receipt[]): LocalRecords {
  let draft = local.draft;
  const completed = new Set<string>();
  for (const receipt of receipts) {
    if (!settled(receipt)) continue;
    const entry = local.outbox.find(value => value.command.clientCommandId === receipt.clientCommandId);
    if (!entry) continue;
    completed.add(receipt.clientCommandId);
    if ((receipt.state.kind === 'accepted' || receipt.state.kind === 'completed') && entry.draftRevision === local.draftRevision && entry.command.body.kind === 'send' && entry.command.body.text === draft) draft = '';
  }
  if (!completed.size) return local;
  return immutable({ ...local, draft, outbox: local.outbox.filter(entry => !completed.has(entry.command.clientCommandId)) });
}
export function createConversationStore<E, P>(options: StoreOptions<E, P>): ConversationStore<P> {
  const { port, projection, drafts, createCommandId } = options;
  const scope = immutable(parseScope(options.scope));
  if (!sameScope(scope, port.scope)) throw new Error('Port scope mismatch');
  let local = restore(null, scope);
  let delivery: DeliveryState<P> = { document: { domain: projection.initial(), receipts: {}, decisions: {} }, cursor: null, identities: new Map() };
  let connection: ConnectionState = { kind: 'disconnected' };
  let view: ClientView<P> = makeView();
  const listeners = new Set<() => void>();
  let feed: Feed | null = null;
  let generation = 0;
  const inFlight = new Set<string>();
  function makeView(): ClientView<P> {
    return immutable({ document: delivery.document, cursor: delivery.cursor, draft: local.draft, outbox: local.outbox, connection });
  }
  function publish(): void {
    view = makeView();
    for (const listener of listeners) listener();
  }
  const ready = drafts.load(scope).then(value => { local = restore(value, scope); publish(); });
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
  function stop(next: ConnectionState): void {
    generation++;
    const previous = feed;
    feed = null;
    connection = next;
    previous?.close();
    publish();
  }
  async function dispatch(entry: OutboxEntry): Promise<SubmitResult> {
    const id = entry.command.clientCommandId;
    if (inFlight.has(id)) throw new Error('Command submission already in progress');
    inFlight.add(id);
    try {
      const result = await port.submit(entry.command);
      if (result.kind === 'rejected') return result;
      if (result.kind !== 'receipt') throw new Error('Unsupported submit result');
      const receipt = immutable(decodeReceipt(copyJson(result.receipt), scope));
      if (receipt.clientCommandId !== id) throw new Error('Submit receipt command ID mismatch');
      await enqueue(async () => {
        const next = reconcile(local, [receipt]);
        if (next !== local) { await persist(next); publish(); }
      });
      return { kind: 'receipt', receipt };
    } finally { inFlight.delete(id); }
  }
  async function submit(body: CommandBody | null): Promise<SubmitResult> {
    await ready;
    const entry = await enqueue(async () => {
      const command = immutable(parseCommand({ version: 1, scope, clientCommandId: createCommandId(), body: body ?? { kind: 'send', text: local.draft } }));
      if (local.outbox.some(value => value.command.clientCommandId === command.clientCommandId) || Object.hasOwn(delivery.document.receipts, command.clientCommandId)) throw new Error('Command ID generator reused an existing ID');
      const created = immutable({ command, draftRevision: command.body.kind === 'send' ? local.draftRevision : null });
      await persist(immutable({ ...local, outbox: [...local.outbox, created] }));
      publish();
      return created;
    });
    return dispatch(entry);
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
    send: () => submit(null),
    approve: (pendingId, choiceId) => submit({ kind: 'approve', pendingId, choiceId }),
    cancel: runId => submit({ kind: 'cancel', runId }),
    async retry(clientCommandId) {
      await ready;
      const entry = await enqueue(async () => {
        const found = local.outbox.find(value => value.command.clientCommandId === clientCommandId);
        if (!found) throw new Error('Command is not in the outbox');
        await drafts.save(local);
        return found;
      });
      return dispatch(entry);
    },
    async connect() {
      stop({ kind: 'connecting' });
      const current = generation;
      let receiving = false;
      let firstDelivery = true;
      try {
        await ready;
        if (current !== generation) return;
        const opened = port.watch({ after: null, projectionVersion: projection.version }, async item => {
          if (current !== generation) return;
          if (receiving) { stop({ kind: 'failed', reason: 'Host delivered concurrent callbacks' }); return; }
          receiving = true;
          try {
            const previous = firstDelivery ? { ...delivery, cursor: null } : delivery;
            const next = applyDelivery(previous, item, scope, projection);
            await Promise.resolve();
            if (current !== generation) return;
            firstDelivery = false;
            if (next === delivery && connection.kind === 'connected') return;
            delivery = next;
            connection = { kind: 'connected' };
            publish();
          } catch (error) {
            if (current === generation) stop({ kind: error instanceof DeliveryError ? error.kind : 'failed', reason: error instanceof Error ? error.message : 'Feed delivery failed' });
            throw error;
          } finally { receiving = false; }
        });
        if (current !== generation) { opened.close(); return; }
        feed = opened;
        void opened.ended.then(end => {
          if (current !== generation) return;
          const next: ConnectionState = end.kind === 'closed' ? { kind: 'disconnected' }
            : { kind: end.kind === 'refused' ? 'mismatch' : end.kind, reason: end.reason };
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
