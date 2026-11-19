import { ServiceError } from '@agentui/contracts/service';
import { sameScope } from '@agentui/contracts';
import type { ConversationScope } from '@agentui/contracts';
import { conversationPreview, transcriptProjection } from '@agentui/contracts/conversation';
import type { Transcript } from '@agentui/contracts/conversation';
import type { ContinuationAction, ContinuationView, ConversationCatalogEntry, ServiceConnection } from '@agentui/contracts/service';
import type { SavedView } from './view-state.js';
import type { StoreBorrow, ViewBorrow } from './view-leases.js';
import type { ApplicationSnapshot, ContinuationBoundary, ConversationContinuation, EarlierSegment, OpenConversation } from './application-controller.js';

export const EARLIER_SEGMENT_LIMIT = 5;
const CONTINUATION_POLL_MS = 500, CONTINUATION_POLL_MAX_MS = 4_000, CONTINUATION_READ_ATTEMPTS = 6, CONTINUATION_MOVE_ATTEMPTS = 3, CHAIN_HOP_LIMIT = 64;

interface ContinuationOwner {
  readonly connection: ServiceConnection;
  readonly pool: { recovery(view: ViewBorrow, scope: ConversationScope): Promise<StoreBorrow> };
  readonly view: { readonly borrow: ViewBorrow } | null;
}
interface ChainLink { readonly scope: ConversationScope; view: ContinuationView | null }
interface ContinuationRecord<Owner extends ContinuationOwner> {
  readonly owner: Owner;
  readonly target: OpenConversation;
  /** The open segment, then each predecessor read so far. */
  readonly chain: ChainLink[];
  readonly arrived: ConversationContinuation['arrived'];
  earlier: readonly EarlierSegment[];
  action: ConversationContinuation['action'];
  error: string;
  earlierError: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  delay: number;
  failures: number;
  /** Failed moves to a confirmed successor; unlike `failures`, a successful read never resets it. */
  moves: number;
  /** Check again returned no view. A click zeroes this with the budgets; settling a view clears it. */
  checkFailed: boolean;
  stopped: boolean;
}
interface ContinuationPort<Owner extends ContinuationOwner> {
  owner(): Owner | null;
  active(): OpenConversation | null;
  busy(): boolean;
  publish(update: Partial<Pick<ApplicationSnapshot, 'continuation' | 'catalog' | 'workspaces'>>): void;
  current<T>(owner: Owner, operation: Promise<T>): Promise<T>;
  install(owner: Owner, scope: ConversationScope, arrived?: ConversationContinuation['arrived']): Promise<void>;
  save(owner: Owner, next: SavedView): Promise<void>;
  requireSaved(owner: Owner): { readonly saved: SavedView };
  requireTarget(owner: Owner, target: OpenConversation): void;
  message(cause: unknown): string;
  loadedLists(): readonly (readonly ConversationCatalogEntry[])[];
  patchEntries(namespace: string | null, update: (entries: readonly ConversationCatalogEntry[]) => readonly ConversationCatalogEntry[] | null): Partial<Pick<ApplicationSnapshot, 'catalog' | 'workspaces'>>;
  run(operation: (owner: Owner) => Promise<void>): Promise<void>;
}
function stalled<Owner extends ContinuationOwner>(record: ContinuationRecord<Owner>): boolean {
  return record.checkFailed || record.failures >= CONTINUATION_READ_ATTEMPTS || record.moves >= CONTINUATION_MOVE_ATTEMPTS;
}

/** Continuation polling, draft moves, and earlier segments. The application controller keeps catalog, route, and install order. */
export function createContinuationSession<Owner extends ContinuationOwner>(port: ContinuationPort<Owner>) {
  let continuation: ContinuationRecord<Owner> | null = null;
  function stop(): void {
    if (continuation) { continuation.stopped = true; clearTimeout(continuation.timer); }
    continuation = null;
  }
  function readContinuation(owner: Owner, scope: ConversationScope, action: ContinuationAction = 'read'): Promise<ContinuationView> {
    return port.current(owner, Promise.resolve().then(() => owner.connection.continuation({ scope, action })));
  }
  /** Follows confirmed successors to the newest segment. An unreadable link ends the walk; a loop or 64 confirmed hops throws. */
  async function newestSegment(owner: Owner, scope: ConversationScope): Promise<ConversationScope> {
    let segment = scope;
    const seen = new Set<string>();
    for (let hop = 0; hop < CHAIN_HOP_LIMIT; hop++) {
      const key = JSON.stringify([segment.hostId, segment.conversationId]);
      if (seen.has(key)) throw new Error('The continuations of this chat form a loop, so its newest conversation cannot be opened.');
      seen.add(key);
      let view: ContinuationView;
      try { view = await readContinuation(owner, segment); }
      catch (cause) { if (port.owner() !== owner) throw cause; return segment; }
      if (view.successor?.kind !== 'confirmed') return segment;
      const next = view.successor.scope;
      if (seen.has(JSON.stringify([next.hostId, next.conversationId]))) throw new Error('The continuations of this chat form a loop, so its newest conversation cannot be opened.');
      segment = next;
    }
    throw new Error('This chat has too many continuations, so its newest conversation cannot be opened.');
  }
  function liveContinuation(record: ContinuationRecord<Owner>): boolean {
    return !record.stopped && continuation === record && port.owner() === record.owner && port.active()?.store === record.target.store;
  }
  function boundaryAt(record: ContinuationRecord<Owner>, index: number): ContinuationBoundary | null {
    const link = record.chain[index];
    if (!link?.view?.predecessor) return null;
    return { closure: record.chain[index + 1]?.view?.closure ?? 'unknown', carried: link.view.carried };
  }
  function publishContinuation(record: ContinuationRecord<Owner>): void {
    if (continuation !== record) return;
    port.publish({ continuation: { view: record.chain[0]?.view ?? null, action: record.action, error: record.error, stalled: stalled(record), arrived: record.arrived, boundary: boundaryAt(record, 0),
      earlier: record.earlier, earlierError: record.earlierError,
      more: record.earlier.length < EARLIER_SEGMENT_LIMIT && record.chain[record.earlier.length + 1] !== undefined } });
  }
  function pollContinuation(record: ContinuationRecord<Owner>): void {
    clearTimeout(record.timer);
    const delay = record.delay;
    record.delay = Math.min(delay * 2, CONTINUATION_POLL_MAX_MS);
    record.timer = setTimeout(() => { void refreshContinuation(record); }, delay);
  }
  /** Reads the next predecessor onto the chain once. A filled slot or a scope already on the chain is left alone. */
  async function appendPredecessor(record: ContinuationRecord<Owner>, index: number, scope: ConversationScope | null): Promise<void> {
    if (!scope || record.chain[index + 1] || record.chain.some(item => sameScope(item.scope, scope))) return;
    const link: ChainLink = { scope, view: null };
    record.chain.push(link);
    link.view = await readContinuation(record.owner, scope).catch(() => null);
  }
  /** Records the open segment's view, reads its predecessor's closure for the boundary, and polls while the host holds a start. */
  async function settleContinuation(record: ContinuationRecord<Owner>, view: ContinuationView): Promise<ConversationScope | null> {
    const [own] = record.chain;
    if (!own) return null;
    own.view = view;
    record.failures = 0;
    record.checkFailed = false;
    const kind = view.successor?.kind;
    if (kind === 'starting' || kind === 'confirmed') record.error = '';
    await appendPredecessor(record, 0, view.predecessor);
    if (!liveContinuation(record)) return null;
    publishContinuation(record);
    if (kind === 'starting') pollContinuation(record);
    return view.successor?.kind === 'confirmed' ? view.successor.scope : null;
  }
  /** Background reads; a click owns the record while its action runs. */
  async function refreshContinuation(record: ContinuationRecord<Owner>): Promise<void> {
    if (!liveContinuation(record) || record.action) return;
    let view: ContinuationView;
    try { view = await readContinuation(record.owner, record.target.scope); }
    catch {
      if (!liveContinuation(record) || record.action) return;
      if (++record.failures < CONTINUATION_READ_ATTEMPTS) pollContinuation(record);
      else publishContinuation(record);
      return;
    }
    if (!liveContinuation(record) || record.action) return;
    const successor = await settleContinuation(record, view);
    if (!successor || !liveContinuation(record) || record.action || stalled(record)) return;
    if (port.busy()) pollContinuation(record);
    else void port.run(owner => moveToSuccessor(owner, record, successor));
  }
  function watch(owner: Owner, target: OpenConversation, arrived: ConversationContinuation['arrived'] = null): void {
    if (continuation && liveContinuation(continuation) && continuation.target.store === target.store) {
      void refreshContinuation(continuation);
      return;
    }
    stop();
    const record: ContinuationRecord<Owner> = { owner, target, chain: [{ scope: target.scope, view: null }], arrived, earlier: [], action: null,
      error: '', earlierError: '', timer: undefined, delay: CONTINUATION_POLL_MS, failures: 0, moves: 0, checkFailed: false, stopped: false };
    continuation = record;
    publishContinuation(record);
    void refreshContinuation(record);
  }
  /** Moves the unsent draft of a chat that is no longer open into the open composer. It is never sent. */
  async function moveDraft(owner: Owner, earlier: ConversationScope): Promise<void> {
    const lease = owner.view?.borrow, next = port.active();
    if (port.owner() !== owner || !lease || !next || sameScope(next.scope, earlier)) return;
    // The earlier store closed when the open chat replaced it, after its queued saves landed, so this loads the last text typed there.
    const held = await owner.pool.recovery(lease, earlier);
    try {
      const text = held.store.getSnapshot().draft;
      if (!text || port.owner() !== owner || port.active()?.store !== next.store) return;
      const typed = next.store.getSnapshot().draft;
      const merged = !typed || typed.includes(text) ? (typed || text) : `${text}${typed}`;
      if (merged !== typed) await next.store.setDraft(merged);
      const visible = next.store.getSnapshot().draft;
      if (port.owner() === owner && port.active()?.store === next.store && visible.includes(text)) await held.store.setDraft('');
    } finally { held.release(); }
  }
  /** Provider from a loaded catalog or workspace row, or `undefined` when that scope is not loaded. An explicit `null` stays `null`. */
  function listedProvider(scope: ConversationScope): ConversationCatalogEntry['provider'] | undefined {
    for (const entries of port.loadedLists()) {
      const found = entries.find(entry => sameScope(entry.scope, scope));
      if (found) return found.provider;
    }
    return undefined;
  }
  async function moveToSuccessor(owner: Owner, record: ContinuationRecord<Owner>, successor: ConversationScope): Promise<void> {
    if (!liveContinuation(record)) return;
    const from = record.target;
    record.action = 'move';
    publishContinuation(record);
    try {
      const newest = await newestSegment(owner, successor);
      await port.install(owner, newest, 'continue');
      await moveDraft(owner, from.scope);
      await port.save(owner, { ...port.requireSaved(owner).saved, route: newest });
      const agent = from.agent;
      const fromAgent = 'kind' in agent && agent.providerAgentId !== null
        ? { namespace: agent.namespace, installationId: agent.installationId, providerAgentId: agent.providerAgentId }
        : null;
      const listed = listedProvider(from.scope);
      const carriedProvider = listed !== undefined ? listed : fromAgent;
      const active = port.active();
      const preview = conversationPreview(active?.store.getSnapshot().document.domain ?? { messages: [], currentRun: null });
      const entry = { scope: newest, preview, provider: carriedProvider };
      port.publish(port.patchEntries(carriedProvider?.namespace ?? null, entries => {
        const rest = entries.filter(item => !sameScope(item.scope, newest));
        const index = rest.findIndex(item => sameScope(item.scope, from.scope));
        return index < 0 ? [entry, ...rest] : rest.map((item, position) => position === index ? entry : item);
      }));
    } catch (cause) {
      if (liveContinuation(record)) {
        record.action = null;
        if (++record.moves < CONTINUATION_MOVE_ATTEMPTS) pollContinuation(record);
        publishContinuation(record);
      }
      throw cause;
    }
  }
  async function act(owner: Owner, target: OpenConversation, action: 'start' | 'check'): Promise<void> {
    port.requireTarget(owner, target);
    const record = continuation;
    if (!record || !liveContinuation(record) || record.action) return;
    clearTimeout(record.timer);
    record.action = action;
    record.error = '';
    record.delay = CONTINUATION_POLL_MS;
    record.failures = 0;
    record.moves = 0;
    record.checkFailed = false;
    publishContinuation(record);
    let view: ContinuationView | null = null, error = '', lost = false;
    try { view = await readContinuation(owner, target.scope, action); }
    catch (cause) {
      if (port.owner() !== owner) throw cause;
      error = port.message(cause);
      lost = !(cause instanceof ServiceError && cause.kind === 'invalid');
      // A lost or late reply says nothing about what the host did, so its saved record decides.
      if (lost) view = await readContinuation(owner, target.scope).catch(() => null);
    }
    if (!liveContinuation(record)) return;
    record.action = null;
    record.error = error;
    if (!view) {
      // Every failed Check again, including an invalid reply, keeps the give-up state. A kept starting or confirmed view would otherwise show Continuing… with nothing to press.
      if (action === 'check') record.checkFailed = true;
      publishContinuation(record);
      if (lost && action === 'start') pollContinuation(record);
      return;
    }
    const successor = await settleContinuation(record, view);
    if (successor) await moveToSuccessor(owner, record, successor);
  }
  /** Reads one earlier segment's saved messages through a short-lived watch. */
  async function readSegment(owner: Owner, scope: ConversationScope): Promise<Transcript> {
    let resolve: (transcript: Transcript) => void = () => {};
    const snapshot = new Promise<Transcript>(done => { resolve = done; });
    const feed = owner.connection.conversation(scope).watch({ after: null, projectionVersion: transcriptProjection.version }, async item => {
      if (item.kind === 'snapshot') resolve(item.snapshot.document.domain);
    });
    try {
      return await port.current(owner, Promise.race([snapshot, feed.ended.then(end => { throw new Error(end.reason); })]));
    } finally { feed.close(); }
  }
  async function readEarlier(owner: Owner, target: OpenConversation): Promise<void> {
    const record = continuation;
    if (!record || !liveContinuation(record) || record.target.store !== target.store || record.action) return;
    const index = record.earlier.length + 1, link = record.chain[index];
    if (!link || record.earlier.length >= EARLIER_SEGMENT_LIMIT) return;
    record.action = 'earlier';
    record.earlierError = '';
    publishContinuation(record);
    try {
      const transcript = await readSegment(owner, link.scope);
      link.view ??= await readContinuation(owner, link.scope);
      await appendPredecessor(record, index, link.view.predecessor);
      if (!liveContinuation(record)) return;
      record.earlier = [{ scope: link.scope, messages: transcript.messages, boundary: boundaryAt(record, index) }, ...record.earlier];
    } catch (cause) {
      if (liveContinuation(record)) record.earlierError = `Earlier messages could not load. ${port.message(cause)}`;
    } finally {
      if (liveContinuation(record)) {
        if (record.action === 'earlier') record.action = null;
        publishContinuation(record);
        // A poll that fired during the load gave way to it without arming another. A move that started during the load keeps its action.
        const kind = record.chain[0]?.view?.successor?.kind;
        if (record.action === null && (kind === 'starting' || kind === 'confirmed') && !stalled(record)) pollContinuation(record);
      }
    }
  }
  return { stop, watch, newestSegment, moveDraft, act, readEarlier };
}
