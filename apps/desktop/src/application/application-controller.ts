import { checkCompatibility, createConversationStore } from '@agentui/client';
import type { CompatibilityIssue, ConversationStore } from '@agentui/client';
import { ServiceConnectionLost } from '@agentui/client/service';
import type { ServiceConnectionOptions } from '@agentui/client/service';
import { ServiceError, SERVICE_CATALOG_PAGE } from '@agentui/contracts/service';
import { canRetryObservation, sameScope } from '@agentui/contracts';
import { SOLO_CLIENT_COMPATIBILITY } from '@agentui/contracts/compatibility';
import type { ConversationScope, SubmitResult, ProviderObservationStatus, ConversationPermissions, ContinuationCarried, ConversationClosure } from '@agentui/contracts';
import type { ImageId } from '@agentui/contracts/image';
import { conversationPreview, transcriptProjection } from '@agentui/contracts/conversation';
import type { Transcript } from '@agentui/contracts/conversation';
import type { AgentDescriptor, ContinuationAction, ContinuationView, ConversationCatalogEntry, ConversationSearchPage, ServiceConnection, ServiceMetadata } from '@agentui/contracts/service';
import type { ConversationCommands, ConversationModuleProps } from '@agentui/sdk/react';
import type { OwnedViewStorage, SavedView, ViewStorageFactory } from './view-state.js';
import { agentPresentation } from './agent-presentation.js';
import { createFrontendSends, createGenerationSource } from './frontend-sends.js';
import type { CapturedSend, FrontendSends, GenerationSink } from './frontend-sends.js';
import { createFrontendRecovery } from './frontend-recovery.js';
import { createViewLeasePool } from './view-leases.js';
import type { StoreBorrow, ViewBorrow } from './view-leases.js';
import { conversationResponding } from './responding.js';

export interface Page<T> { readonly items: readonly T[]; readonly after: string | null }
type HostState =
  | { readonly kind: 'loading' | 'unavailable' }
  | { readonly kind: 'ready'; readonly metadata: ServiceMetadata }
  | { readonly kind: 'incompatible'; readonly metadata: ServiceMetadata; readonly issues: readonly CompatibilityIssue[] };
export interface OpenConversation {
  readonly agent: AgentDescriptor;
  readonly viewId: string;
  readonly scope: ConversationScope;
  readonly store: ConversationStore<Transcript>;
}
export interface ConversationObservation {
  readonly status: ProviderObservationStatus | { readonly kind: 'unknown' };
  readonly retrying: boolean;
}
type AvailablePermissions = Extract<ConversationPermissions, { kind: 'available' }>;
export type PermissionState =
  | { readonly kind: 'fresh'; readonly listing: AvailablePermissions }
  | { readonly kind: 'loading' | 'stale'; readonly listing: AvailablePermissions | null; readonly reason: string }
  | { readonly kind: 'unsupported'; readonly reason: string };
/** What the boundary above one segment of a continued chat reports. */
export interface ContinuationBoundary {
  /** How the earlier segment ended; `unknown` or `null` when that could not be read. */
  readonly closure: ConversationClosure | 'unknown' | null;
  readonly carried: ContinuationCarried | null;
}
export interface EarlierSegment {
  readonly scope: ConversationScope;
  readonly messages: Transcript['messages'];
  /** The boundary above this segment when it continues an even earlier one. */
  readonly boundary: ContinuationBoundary | null;
}
export const EARLIER_SEGMENT_LIMIT = 5;
export interface ConversationContinuation {
  /** `null` until the host answers the first read. */
  readonly view: ContinuationView | null;
  readonly action: 'start' | 'check' | 'move' | 'earlier' | null;
  readonly error: string;
  /** Background reads or moves reached their bound; only a click tries again. */
  readonly stalled: boolean;
  /** Set when a Continue or Start a new chat click opened this chat, so its composer takes focus. */
  readonly arrived: 'continue' | 'new-chat' | null;
  /** The boundary above the open segment's own messages, when it continues an earlier one. */
  readonly boundary: ContinuationBoundary | null;
  /** Earlier segments loaded on request, oldest first. */
  readonly earlier: readonly EarlierSegment[];
  readonly earlierError: string;
  readonly more: boolean;
}
export interface ApplicationSnapshot {
  readonly host: HostState;
  readonly catalog: Page<ConversationCatalogEntry>;
  readonly saved: SavedView;
  readonly savedViews: Page<string>;
  readonly savedViewNotice: string;
  readonly active: OpenConversation | null;
  readonly observation: ConversationObservation | null;
  readonly continuation: ConversationContinuation | null;
  readonly permissionState: PermissionState;
  readonly error: string;
  readonly storageFailure: string;
  readonly busy: boolean;
  readonly capturedSends: readonly CapturedSend[];
}
export interface ConversationActions {
  readonly commands: ConversationCommands;
  readonly permissions: ConversationModuleProps['permissions'];
  submit(operation: () => Promise<SubmitResult>): Promise<void>;
  reconcile(id: string): Promise<void>;
  /** Stops waiting on an unconfirmed send so the conversation can take new work. Says nothing about whether it ran. */
  abandon(id: string): Promise<void>;
  retryObservation(): Promise<void>;
  /** Continue and Try again: the host starts this closed conversation's successor, or answers with the one it has. */
  continueConversation(): Promise<void>;
  /** Check again: looks up unsettled attempts and never starts another. */
  checkContinuation(): Promise<void>;
  /** Starts an unrelated new chat with the same agent through the ordinary create flow; only the unsent draft moves. */
  startNewChat(): Promise<void>;
  loadEarlierSegment(): Promise<void>;
  /** Reads an image of this conversation for preview; failures never mark the application failed. */
  readImage(imageId: ImageId): Promise<Uint8Array>;
}
export interface ApplicationController {
  readonly frontendGenerations: GenerationSink;
  releaseCapturedSend(key: string): Promise<void>;
  getSnapshot(): ApplicationSnapshot;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  dispose(): Promise<void>;
  reconnect(): Promise<void>;
  reopenView(viewId: string): Promise<void>;
  moreConversations(): Promise<void>;
  search(query: string, after: string | null, signal: AbortSignal): Promise<ConversationSearchPage>;
  moreSavedViews(): Promise<void>;
  create(agentId?: string): Promise<void>;
  recoverCreation(agentId?: string): Promise<void>;
  open(scope: ConversationScope): Promise<void>;
  conversationActions(target: OpenConversation): ConversationActions;
}
interface LoadedView { readonly borrow: ViewBorrow; readonly saved: SavedView; readonly hostId: string }
type OwnedView = { readonly borrow: ViewBorrow; readonly saved: null } | LoadedView;
interface ImageTransfers {
  upload: ServiceConnection['uploadImage'];
  read(scope: ConversationScope, imageId: ImageId): Promise<Uint8Array>;
}
interface ActiveStoreOwner { readonly borrow: StoreBorrow; readonly target: OpenConversation }
interface Session { readonly pool: ReturnType<typeof createViewLeasePool>; activeOwner: ActiveStoreOwner | null; view: OwnedView | null; readonly connection: ServiceConnection; readonly frontend: FrontendSends; readonly images: ImageTransfers }
const EMPTY_SAVED_VIEW: SavedView = { version: 2, route: null, pendingCreation: null };
const DETACHED_VIEW = {
  observation: null, continuation: null, permissionState: { kind: 'stale', listing: null, reason: 'Open a conversation to read permissions.' }, catalog: { items: [], after: null }, savedViews: { items: [], after: null }, savedViewNotice: '',
} satisfies Pick<ApplicationSnapshot, 'observation' | 'continuation' | 'permissionState' | 'catalog' | 'savedViews' | 'savedViewNotice'>;
interface ChainLink { readonly scope: ConversationScope; view: ContinuationView | null }
interface ContinuationRecord {
  readonly owner: Session;
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
  stopped: boolean;
}
const CONTINUATION_POLL_MS = 500, CONTINUATION_POLL_MAX_MS = 4_000, CONTINUATION_READ_ATTEMPTS = 6, CONTINUATION_MOVE_ATTEMPTS = 3, CHAIN_HOP_LIMIT = 64;
function stalled(record: ContinuationRecord): boolean {
  return record.failures >= CONTINUATION_READ_ATTEMPTS || record.moves >= CONTINUATION_MOVE_ATTEMPTS;
}
function compatibleAgent(agent: AgentDescriptor): AgentDescriptor {
  if ('kind' in agent) return agent;
  return SOLO_CLIENT_COMPATIBILITY.supportedNativeRuntimes.some(runtime => runtime.engine === agent.runtime.engine &&
    runtime.version === agent.runtime.version && runtime.format === agent.runtime.format) ? agent
    : { ...agent, availability: { kind: 'unavailable', reason: 'This agent runtime is unsupported by this app.' } };
}
const IMAGE_TRANSFER_ATTEMPTS = 3;
// The host admits one image transfer per access and refuses overlaps as unavailable, so transfers run one at a time.
function imageTransfers(connection: ServiceConnection): ImageTransfers {
  let tail: Promise<unknown> = Promise.resolve();
  const reads = new Map<string, Promise<Uint8Array>>();
  function queued<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      for (let attempt = 1; ; attempt++) {
        try { return await operation(); }
        catch (cause) {
          if (!(cause instanceof ServiceError && cause.kind === 'unavailable') || cause instanceof ServiceConnectionLost || attempt === IMAGE_TRANSFER_ATTEMPTS) throw cause;
          await new Promise(resolve => setTimeout(resolve, 200 * attempt));
        }
      }
    });
    tail = result.catch(() => undefined);
    return result;
  }
  return {
    upload: input => queued(() => connection.uploadImage(input)),
    read(scope, imageId) {
      const key = JSON.stringify([scope.hostId, scope.conversationId, imageId]);
      const pending = reads.get(key);
      if (pending) return pending;
      const read = queued(async () => (await connection.readImage(scope, imageId)).bytes).finally(() => reads.delete(key));
      reads.set(key, read);
      return read;
    },
  };
}
function initialSnapshot(): ApplicationSnapshot {
  return { ...DETACHED_VIEW, active: null, host: { kind: 'loading' }, saved: EMPTY_SAVED_VIEW, error: '', storageFailure: '', busy: false, capturedSends: [] };
}
function message(error: unknown): string { return error instanceof Error ? error.message : 'The operation failed.'; }
export function applicationEnabled(state: ApplicationSnapshot): boolean {
  return state.host.kind === 'ready' && !state.storageFailure && !state.busy;
}
const SEND_AWAITING_CONFIRMATION = 'An earlier message has not been confirmed yet, so this one was not sent. Your draft is kept. '
  + 'Use Reconcile command under Command recovery, or Check pending command under Pending commands, to check it. '
  + 'If it stays unconfirmed, use Stop waiting beside that button to send new messages here; '
  + 'the earlier message may or may not have run.';
export const NOTHING_TO_STOP_WAITING = 'Nothing to stop waiting on: this command is not holding up new messages.';
export function refusalMessage(reason: string): string {
  if (reason === 'conversation-closed') return 'This conversation ended. Start a new chat to keep going.';
  if (reason === 'send-awaiting-confirmation') return SEND_AWAITING_CONFIRMATION;
  return reason;
}

export function createApplicationController(deps: {
  readonly createConnection: (options: ServiceConnectionOptions) => ServiceConnection;
  readonly ownedViewStorage: ViewStorageFactory;
  readonly createId: () => string;
}): ApplicationController {
  let state = initialSnapshot();
  let session: Session | null = null;
  let disposal: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const recovery = createFrontendRecovery();
  let observationPoll: { stop(): void; retry(): Promise<void> } | null = null;
  let continuation: ContinuationRecord | null = null, arrival: ConversationContinuation['arrived'] = null;
  const concludedScopes = new Map<string, Extract<ProviderObservationStatus, { readonly kind: 'concluded' }>>();
  let unsubscribeActive: (() => void) | null = null;
  function publish(update: Partial<Omit<ApplicationSnapshot, 'saved' | 'active'>>): void {
    state = Object.freeze({ ...state, ...update, saved: session?.view?.saved ?? EMPTY_SAVED_VIEW,
      active: session?.activeOwner?.target ?? null });
    syncRecovery();
    for (const listener of listeners) listener();
  }
  function setActive(owner: Session, next: ActiveStoreOwner | null): void {
    const previous = owner.activeOwner;
    owner.activeOwner = next;
    if (previous?.borrow !== next?.borrow) previous?.borrow.release();
  }
  const generations = createGenerationSource();
  function syncRecovery(): void {
    const owner = session, view = owner?.view, host = state.host;
    recovery.retarget(owner && view && view.saved !== null && host.kind === 'ready'
      && !state.storageFailure && view.hostId === host.metadata.hostId
      ? { pool: owner.pool, frontend: owner.frontend, lease: view.borrow, metadata: host.metadata } : null);
  }
  let permissionRead = 0;
  function stalePermissions(reason: string): void {
    permissionRead++;
    const previous = state.permissionState;
    publish({ permissionState: { kind: 'stale', listing: 'listing' in previous ? previous.listing : null, reason } });
  }
  async function readPermissions(owner: Session, target: OpenConversation): Promise<ConversationPermissions> {
    requireTarget(owner, target);
    const version = ++permissionRead, previous = state.permissionState;
    publish({ permissionState: { kind: 'loading', listing: 'listing' in previous ? previous.listing : null, reason: 'Refreshing permissions…' } });
    try {
      const result = await current(owner, owner.connection.conversationPermissions(target.scope));
      requireTarget(owner, target);
      if (version === permissionRead) publish({ permissionState: result.kind === 'available'
        ? { kind: 'fresh', listing: result } : result.kind === 'unsupported' ? { kind: 'unsupported', reason: result.reason }
          : { kind: 'stale', listing: 'listing' in previous ? previous.listing : null, reason: result.reason } });
      return result;
    } catch (cause) {
      if (session === owner && state.active === target && version === permissionRead) stalePermissions(message(cause));
      throw cause;
    }
  }
  function refreshPermissions(owner: Session, target: OpenConversation): void {
    if (session === owner && state.active === target && state.host.kind === 'ready') void readPermissions(owner, target).catch(() => {});
  }
  function stopObservation(): void { observationPoll?.stop(); observationPoll = null; }
  function stopContinuation(): void {
    if (continuation) { continuation.stopped = true; clearTimeout(continuation.timer); }
    continuation = null;
  }
  function disconnectActive(): void {
    const target = state.active;
    stalePermissions('Reconnect to refresh permissions.');
    stopObservation();
    stopContinuation();
    unsubscribeActive?.();
    unsubscribeActive = null;
    target?.store.disconnect();
  }
  function fail(owner: Session, cause: unknown, phase: 'handshake' | 'operation' = 'operation'): void {
    if (session !== owner) return;
    publish(phase === 'handshake' ? { host: { kind: 'unavailable' }, error: message(cause) } : { error: message(cause) });
  }
  function lose(owner: Session, cause: ServiceConnectionLost): void {
    if (session !== owner) return;
    if (state.host.kind !== 'unavailable') publish({ host: { kind: 'unavailable' }, error: message(cause) });
    disconnectActive();
    owner.frontend.pause();
  }
  async function current<T>(owner: Session, operation: Promise<T>): Promise<T> {
    const result = await operation;
    if (session !== owner) throw new Error('This application has closed.');
    return result;
  }
  function failStorage(owner: Session, storage: OwnedViewStorage | null, cause: unknown): void {
    if (session !== owner || (storage !== null && !owner.pool.owns(storage))) return;
    publish({ storageFailure: message(cause) });
    if (storage) owner.frontend.storageFailed(storage.viewId);
    disconnectActive();
  }
  function local(owner: Session): OwnedViewStorage {
    if (session !== owner || !owner.view || state.storageFailure) throw new Error(state.storageFailure || 'Local storage is not ready.');
    return owner.view.borrow.storage;
  }
  function requireHost(owner: Session): ServiceMetadata {
    local(owner);
    if (state.host.kind !== 'ready') throw new Error('A compatible connected host is required.');
    return state.host.metadata;
  }
  function requireSaved(owner: Session): LoadedView {
    const host = requireHost(owner);
    const view = owner.view;
    if (!view || view.saved === null || view.hostId !== host.hostId) throw new Error('This view is still loading.');
    return view;
  }
  async function acquire(owner: Session, viewId: string | null): Promise<OwnedViewStorage> {
    let borrow = viewId === null ? null : owner.pool.reserve(viewId);
    if (!borrow) {
      let storage: OwnedViewStorage | null = null;
      const failed = (cause: unknown) => storage ? owner.pool.failed(storage, cause) : failStorage(owner, null, cause);
      storage = await (viewId === null ? deps.ownedViewStorage.open(failed) : deps.ownedViewStorage.reopen(viewId, failed));
      borrow = owner.pool.adopt(storage);
    }
    try {
      if (session !== owner) throw new Error('This application has closed.');
      if (viewId !== null) borrow.storage.select();
      if (session !== owner) throw new Error('This application has closed.');
      const previous = owner.view;
      owner.view = { borrow, saved: null };
      syncRecovery();
      previous?.borrow.release();
      return borrow.storage;
    } catch (cause) { borrow.release(); throw cause; }
  }
  async function save(owner: Session, next: SavedView): Promise<void> {
    const view = requireSaved(owner);
    try {
      await current(owner, view.borrow.storage.saveView(view.hostId, next));
      if (owner.view?.borrow.storage !== view.borrow.storage) throw new Error('The saved view changed.');
      owner.view = { ...view, saved: next };
      publish({});
    } catch (cause) { failStorage(owner, view.borrow.storage, cause); throw cause; }
  }
  function observeActive(owner: Session, target: OpenConversation): void {
    stopObservation();
    let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
    let pending: Promise<void> | null = null, retrying = false;
    const current = () => !stopped && session === owner && state.active?.store === target.store && state.host.kind === 'ready';
    const key = JSON.stringify([target.scope.hostId, target.scope.conversationId]), concluded = concludedScopes.get(key);
    publish({ observation: concluded ? { status: concluded, retrying: false } : null });
    function schedule(): void {
      const kind = state.observation?.status.kind;
      if (current() && !retrying && kind !== 'not-applicable' && kind !== 'concluded') timer = setTimeout(() => { void read('read'); }, 2_000);
    }
    function observed(status: ConversationObservation['status']): void {
      if (status.kind === 'concluded') concludedScopes.set(key, status);
      // The host never clears a closure, so a later failed read or a stopped status during an extension change is transient.
      // Only those are masked: any live status the host reports wins.
      const sticky = status.kind === 'unknown' || status.kind === 'stopped' ? concludedScopes.get(key) : undefined;
      publish({ observation: { status: sticky ?? status, retrying } });
    }
    function read(action: 'read' | 'retry'): Promise<void> {
      const task = (async () => {
        try {
          const status = await owner.connection.providerObservation({ scope: target.scope, action });
          if (current()) observed(status);
        } catch {
          if (current()) observed({ kind: 'unknown' });
        }
      })();
      pending = task;
      return task.finally(() => { if (pending === task) pending = null; schedule(); });
    }
    observationPoll = {
      stop() { stopped = true; clearTimeout(timer); },
      async retry() {
        if (!current() || retrying || !state.observation || state.observation.status.kind === 'unknown' || !canRetryObservation(state.observation.status)) return;
        retrying = true;
        publish({ observation: { ...state.observation, retrying: true } });
        clearTimeout(timer);
        await pending;
        if (!current()) return;
        await read('retry');
        retrying = false;
        if (current() && state.observation) publish({ observation: { ...state.observation, retrying: false } });
        schedule();
      },
    };
    void read('read');
  }
  function readContinuation(owner: Session, scope: ConversationScope, action: ContinuationAction = 'read'): Promise<ContinuationView> {
    return current(owner, Promise.resolve().then(() => owner.connection.continuation({ scope, action })));
  }
  /** Follows confirmed successors to the newest segment. An unreadable link ends the walk; a loop or 64 confirmed hops throws. */
  async function newestSegment(owner: Session, scope: ConversationScope): Promise<ConversationScope> {
    let segment = scope;
    const seen = new Set<string>();
    for (let hop = 0; hop < CHAIN_HOP_LIMIT; hop++) {
      const key = JSON.stringify([segment.hostId, segment.conversationId]);
      if (seen.has(key)) throw new Error('The continuations of this chat form a loop, so its newest conversation cannot be opened.');
      seen.add(key);
      let view: ContinuationView;
      try { view = await readContinuation(owner, segment); }
      catch (cause) { if (session !== owner) throw cause; return segment; }
      if (view.successor?.kind !== 'confirmed') return segment;
      const next = view.successor.scope;
      if (seen.has(JSON.stringify([next.hostId, next.conversationId]))) throw new Error('The continuations of this chat form a loop, so its newest conversation cannot be opened.');
      segment = next;
    }
    throw new Error('This chat has too many continuations, so its newest conversation cannot be opened.');
  }
  /** Reopens a saved route at the newest segment, then saves that route only after its draft has moved. */
  async function reopenNewest(owner: Session, route: ConversationScope): Promise<void> {
    const newest = await newestSegment(owner, route);
    await install(owner, newest);
    await moveDraft(owner, route);
    if (!sameScope(newest, route)) await save(owner, { ...requireSaved(owner).saved, route: newest });
  }
  function liveContinuation(record: ContinuationRecord): boolean {
    return !record.stopped && continuation === record && session === record.owner && state.active?.store === record.target.store;
  }
  function boundaryAt(record: ContinuationRecord, index: number): ContinuationBoundary | null {
    const link = record.chain[index];
    if (!link?.view?.predecessor) return null;
    return { closure: record.chain[index + 1]?.view?.closure ?? 'unknown', carried: link.view.carried };
  }
  function publishContinuation(record: ContinuationRecord): void {
    if (continuation !== record) return;
    publish({ continuation: { view: record.chain[0]?.view ?? null, action: record.action, error: record.error, stalled: stalled(record), arrived: record.arrived, boundary: boundaryAt(record, 0),
      earlier: record.earlier, earlierError: record.earlierError,
      more: record.earlier.length < EARLIER_SEGMENT_LIMIT && record.chain[record.earlier.length + 1] !== undefined } });
  }
  function watchContinuation(owner: Session, target: OpenConversation): void {
    if (continuation && liveContinuation(continuation) && continuation.target.store === target.store) {
      void refreshContinuation(continuation);
      return;
    }
    stopContinuation();
    const record: ContinuationRecord = { owner, target, chain: [{ scope: target.scope, view: null }], arrived: arrival, earlier: [], action: null,
      error: '', earlierError: '', timer: undefined, delay: CONTINUATION_POLL_MS, failures: 0, moves: 0, stopped: false };
    continuation = record;
    arrival = null;
    publishContinuation(record);
    void refreshContinuation(record);
  }
  function pollContinuation(record: ContinuationRecord): void {
    clearTimeout(record.timer);
    const delay = record.delay;
    record.delay = Math.min(delay * 2, CONTINUATION_POLL_MAX_MS);
    record.timer = setTimeout(() => { void refreshContinuation(record); }, delay);
  }
  /** Records the open segment's view, reads its predecessor's closure for the boundary, and polls while the host holds a start. */
  async function settleContinuation(record: ContinuationRecord, view: ContinuationView): Promise<ConversationScope | null> {
    const [own] = record.chain;
    if (!own) return null;
    own.view = view;
    record.failures = 0;
    const kind = view.successor?.kind;
    if (kind === 'starting' || kind === 'confirmed') record.error = '';
    const predecessor = view.predecessor;
    if (predecessor && !record.chain[1] && !record.chain.some(item => sameScope(item.scope, predecessor))) {
      const link: ChainLink = { scope: predecessor, view: null };
      record.chain.push(link);
      link.view = await readContinuation(record.owner, link.scope).catch(() => null);
    }
    if (!liveContinuation(record)) return null;
    publishContinuation(record);
    if (kind === 'starting') pollContinuation(record);
    return view.successor?.kind === 'confirmed' ? view.successor.scope : null;
  }
  /** Background reads; a click owns the record while its action runs. */
  async function refreshContinuation(record: ContinuationRecord): Promise<void> {
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
    if (state.busy) pollContinuation(record);
    else void run(owner => moveToSuccessor(owner, record, successor));
  }
  /** Moves the unsent draft of a chat that is no longer open into the open composer. It is never sent. */
  async function moveDraft(owner: Session, earlier: ConversationScope): Promise<void> {
    const lease = owner.view?.borrow, next = state.active;
    if (session !== owner || !lease || !next || sameScope(next.scope, earlier)) return;
    // The earlier store closed when the open chat replaced it, after its queued saves landed, so this loads the last text typed there.
    const held = await owner.pool.recovery(lease, earlier);
    try {
      const text = held.store.getSnapshot().draft;
      if (!text || session !== owner || state.active?.store !== next.store) return;
      const typed = next.store.getSnapshot().draft;
      const merged = !typed || typed.includes(text) ? (typed || text) : `${text}${typed}`;
      if (merged !== typed) await next.store.setDraft(merged);
      const visible = next.store.getSnapshot().draft;
      if (session === owner && state.active?.store === next.store && visible.includes(text)) await held.store.setDraft('');
    } finally { held.release(); }
  }
  async function arrive(how: 'continue' | 'new-chat', open: () => Promise<void>): Promise<void> {
    arrival = how;
    try { await open(); } finally { arrival = null; }
  }
  async function moveToSuccessor(owner: Session, record: ContinuationRecord, successor: ConversationScope): Promise<void> {
    if (!liveContinuation(record)) return;
    const from = record.target;
    record.action = 'move';
    publishContinuation(record);
    try {
      const newest = await newestSegment(owner, successor);
      await arrive('continue', () => install(owner, newest));
      await moveDraft(owner, from.scope);
      await save(owner, { ...requireSaved(owner).saved, route: newest });
      const preview = conversationPreview(state.active?.store.getSnapshot().document.domain ?? { messages: [], currentRun: null });
      const items = state.catalog.items.filter(entry => !sameScope(entry.scope, newest));
      const at = items.findIndex(entry => sameScope(entry.scope, from.scope));
      const entry = { scope: newest, preview };
      publish({ catalog: { ...state.catalog, items: at < 0 ? [entry, ...items] : items.map((item, index) => index === at ? entry : item) } });
    } catch (cause) {
      if (liveContinuation(record)) {
        record.action = null;
        if (++record.moves < CONTINUATION_MOVE_ATTEMPTS) pollContinuation(record);
        publishContinuation(record);
      }
      throw cause;
    }
  }
  async function continuationAction(owner: Session, target: OpenConversation, action: 'start' | 'check'): Promise<void> {
    requireTarget(owner, target);
    const record = continuation;
    if (!record || !liveContinuation(record) || record.action) return;
    clearTimeout(record.timer);
    record.action = action;
    record.error = '';
    record.delay = CONTINUATION_POLL_MS;
    record.failures = 0;
    record.moves = 0;
    publishContinuation(record);
    let view: ContinuationView | null = null, error = '', lost = false;
    try { view = await readContinuation(owner, target.scope, action); }
    catch (cause) {
      if (session !== owner) throw cause;
      error = message(cause);
      lost = !(cause instanceof ServiceError && cause.kind === 'invalid');
      // A lost or late reply says nothing about what the host did, so its saved record decides.
      if (lost) view = await readContinuation(owner, target.scope).catch(() => null);
    }
    if (!liveContinuation(record)) return;
    record.action = null;
    record.error = error;
    if (!view) {
      // Every failed Check again, including an invalid reply, keeps the give-up state. A kept starting or confirmed view would otherwise show Continuing… with nothing to press.
      if (action === 'check') record.failures = CONTINUATION_READ_ATTEMPTS;
      publishContinuation(record);
      if (lost && action === 'start') pollContinuation(record);
      return;
    }
    const successor = await settleContinuation(record, view);
    if (successor) await moveToSuccessor(owner, record, successor);
  }
  /** Reads one earlier segment's saved messages through a short-lived watch. */
  async function readSegment(owner: Session, scope: ConversationScope): Promise<Transcript> {
    let resolve: (transcript: Transcript) => void = () => {};
    const snapshot = new Promise<Transcript>(done => { resolve = done; });
    const feed = owner.connection.conversation(scope).watch({ after: null, projectionVersion: transcriptProjection.version }, async item => {
      if (item.kind === 'snapshot') resolve(item.snapshot.document.domain);
    });
    try {
      return await current(owner, Promise.race([snapshot, feed.ended.then(end => { throw new Error(end.reason); })]));
    } finally { feed.close(); }
  }
  async function readEarlierSegment(owner: Session, target: OpenConversation): Promise<void> {
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
      const previousScope = link.view.predecessor;
      if (previousScope && !record.chain[index + 1] && !record.chain.some(item => sameScope(item.scope, previousScope))) {
        const previous: ChainLink = { scope: previousScope, view: null };
        record.chain.push(previous);
        previous.view = await readContinuation(owner, previous.scope).catch(() => null);
      }
      if (!liveContinuation(record)) return;
      record.earlier = [{ scope: link.scope, messages: transcript.messages, boundary: boundaryAt(record, index) }, ...record.earlier];
    } catch (cause) {
      if (liveContinuation(record)) record.earlierError = `Earlier messages could not load. ${message(cause)}`;
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
  async function createConversation(owner: Session, agentId?: string, carried?: ConversationScope): Promise<void> {
    const host = requireHost(owner);
    const { saved } = requireSaved(owner);
    if (saved.pendingCreation) throw new Error('Recover the pending creation before creating another conversation.');
    const selected = agentId ?? host.defaultAgentId;
    if (selected === null) throw new Error('No agent is available to start a conversation.');
    const agent = host.agents.find(agent => agent.id === selected);
    if (!agent || agent.availability.kind !== 'ready') throw new Error('Choose an available agent.');
    const scope = { hostId: host.hostId, conversationId: deps.createId() };
    await save(owner, { ...saved, pendingCreation: { scope, agentId: selected } });
    requireHost(owner);
    await completeCreation(owner, scope, selected, carried);
  }
  async function install(owner: Session, scope: ConversationScope): Promise<void> {
    const storage = local(owner);
    const found = await current(owner, owner.connection.conversationAgent(scope));
    if (!found) throw new Error('Conversation does not exist.');
    const agent = compatibleAgent(found);
    const lease = owner.view?.borrow;
    if (!lease) throw new Error('The original view lease is unavailable.');
    const borrow = await owner.pool.active(lease, scope, agent.id);
    try {
      local(owner);
      const store = borrow.store;
      const previous = owner.activeOwner;
      if (previous?.target.store === store) {
        const active: OpenConversation = { ...previous.target, agent };
        setActive(owner, { borrow: previous.borrow, target: active });
        publish({});
        local(owner);
        observeActive(owner, active);
        watchContinuation(owner, active);
        await current(owner, store.connect());
        refreshPermissions(owner, active); return;
      }
      disconnectActive();
      local(owner);
      const active: OpenConversation = { scope, agent, viewId: storage.viewId, store };
      setActive(owner, { borrow, target: active });
      publish({ permissionState: { kind: 'loading', listing: null, reason: 'Reading permissions…' } });
      local(owner);
      observeActive(owner, active);
      watchContinuation(owner, active);
      let connected = false;
      unsubscribeActive = store.subscribe(() => {
        if (session !== owner || state.active?.store !== store) return;
        const snapshot = store.getSnapshot();
        if (snapshot.connection.kind !== 'connected') {
          if (connected) stalePermissions('Reconnect to refresh permissions.');
          connected = false;
          return;
        }
        if (!connected && state.active) refreshPermissions(owner, state.active);
        connected = true;
        const preview = conversationPreview(snapshot.document.domain);
        const existing = state.catalog.items.find(entry => sameScope(entry.scope, scope));
        if (existing && existing.preview !== preview) publish({ catalog: { ...state.catalog,
          items: state.catalog.items.map(entry => entry === existing ? { scope: entry.scope, preview } : entry) } });
      });
      await current(owner, store.connect());
      refreshPermissions(owner, active);
    } finally { if (owner.activeOwner?.borrow !== borrow) borrow.release(); }
  }
  async function readCatalog(owner: Session, hostId: string, after: string | null = null): Promise<void> {
    const items = await current(owner, owner.connection.catalog(after, SERVICE_CATALOG_PAGE));
    if (items.some(entry => entry.scope.hostId !== hostId)) throw new Error('Catalog belongs to another host.');
    const next = items.length === SERVICE_CATALOG_PAGE ? items.at(-1)?.scope.conversationId ?? null : null;
    if (next !== null && next === after) throw new Error('Catalog did not advance.');
    const loaded = new Map((after === null ? [] : state.catalog.items).map(entry => [JSON.stringify([entry.scope.hostId, entry.scope.conversationId]), entry]));
    for (const entry of items) loaded.set(JSON.stringify([entry.scope.hostId, entry.scope.conversationId]), entry);
    publish({ catalog: { items: [...loaded.values()], after: next } });
  }
  async function readSavedViews(owner: Session, hostId: string, after: string | null = null): Promise<void> {
    try {
      const page = await current(owner, local(owner).savedViews(hostId, after));
      publish({ savedViews: { items: after === null ? page.ids : [...state.savedViews.items, ...page.ids], after: page.after },
        savedViewNotice: page.unreadable ? `${page.unreadable} saved views on this page could not be opened. Their records were left untouched.` : '' });
    } catch {
      if (session === owner) publish({ savedViewNotice: 'Saved views could not be listed. This view and its records remain available.' });
    }
  }
  async function refresh(owner: Session): Promise<void> {
    const storage = local(owner);
    const previousHost = state.host;
    publish({ host: { kind: 'loading' } });
    stopObservation();
    stalePermissions('Reconnecting to refresh permissions.');
    let held: StoreBorrow | undefined;
    try {
      const received = await current(owner, owner.connection.metadata());
      const metadata = { ...received, agents: received.agents.map(compatibleAgent) };
      const compatibility = checkCompatibility(SOLO_CLIENT_COMPATIBILITY, metadata.compatibility);
      const issues = compatibility.kind === 'incompatible' ? compatibility.issues.filter(issue => issue.dimension !== 'native-runtime') : [];
      await current(owner, owner.frontend.session(issues.length ? null : metadata, owner.connection));
      if ('metadata' in previousHost && previousHost.metadata.principalId !== metadata.principalId) {
        disconnectActive();
        local(owner);
        held = owner.activeOwner?.borrow;
        owner.activeOwner = null;
        publish({});
        local(owner);
      }
      const previous = owner.view;
      if (previous && previous.saved !== null && previous.hostId !== metadata.hostId) {
        disconnectActive();
        setActive(owner, null);
        owner.view = { borrow: previous.borrow, saved: null };
        publish(DETACHED_VIEW);
      }
      if (issues.length) {
        state.active?.store.disconnect();
        publish({ host: { kind: 'incompatible', metadata, issues } });
        return;
      }
      const saved = await current(owner, storage.readView(metadata.hostId)).catch(cause => {
        failStorage(owner, storage, cause);
        throw cause;
      });
      const borrow = owner.view?.borrow;
      if (!borrow) throw new Error('The original view lease is unavailable.');
      owner.view = { borrow, saved, hostId: metadata.hostId };
      publish({ host: { kind: 'ready', metadata } });
      const { hostId } = metadata;
      const results = await Promise.allSettled([readCatalog(owner, hostId), readSavedViews(owner, hostId),
        saved.route ? reopenNewest(owner, saved.route) : Promise.resolve()]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') fail(owner, failed.reason);
    } catch (cause) { fail(owner, cause, 'handshake'); }
    finally { held?.release(); }
  }
  async function run(operation: (owner: Session) => Promise<void>): Promise<void> {
    const owner = session;
    if (!owner || state.busy) return;
    publish({ busy: true, error: '' });
    try { await operation(owner); }
    catch (cause) { fail(owner, cause); } finally { if (session === owner) publish({ busy: false }); }
  }
  async function submitCommand(owner: Session | null, target: OpenConversation, operation: () => Promise<SubmitResult>): Promise<SubmitResult> {
    if (!owner || session !== owner) throw new Error('This application has closed.');
    if (state.busy) throw new Error('Another operation is in progress.');
    requireTarget(owner, target);
    stalePermissions('A command is in progress. Permissions will refresh afterward.');
    publish({ busy: true, error: '' });
    try {
      if (target.agent.availability.kind !== 'ready') throw new Error(target.agent.availability.reason);
      const result = await current(owner, operation());
      if (result.kind === 'rejected') publish({ error: refusalMessage(result.reason) });
      else if (result.receipt.state.kind === 'rejected') publish({ error: result.receipt.state.reason });
      return result;
    } catch (cause) {
      fail(owner, cause);
      throw cause;
    } finally { if (session === owner) { publish({ busy: false }); refreshPermissions(owner, target); } }
  }
  async function completeCreation(owner: Session, scope: ConversationScope, agentId: string, carried?: ConversationScope): Promise<void> {
    const view = requireSaved(owner), host = requireHost(owner);
    const matches = () => session === owner && state.host.kind === 'ready' && state.host.metadata.principalId === host.principalId && state.host.metadata.hostId === host.hostId && owner.view?.borrow.storage === view.borrow.storage && owner.view.saved !== null && owner.view.hostId === scope.hostId &&
      owner.view.saved?.pendingCreation?.agentId === agentId && sameScope(owner.view.saved.pendingCreation.scope, scope);
    try { await current(owner, owner.connection.create(scope, agentId)); }
    catch (error) {
      if (error instanceof ServiceError && error.kind === 'create-rejected' && matches()) {
        await save(owner, { ...requireSaved(owner).saved, pendingCreation: null });
      }
      throw error;
    }
    if (!matches()) throw new Error('The creation view changed. Recover it in its original view.');
    // Start a new chat installs and moves the closed draft before this route is saved. A failed lookup leaves the route on the closed chat.
    if (carried) {
      await install(owner, scope);
      await moveDraft(owner, carried);
    }
    await save(owner, { version: 2, route: scope, pendingCreation: null });
    publish({ catalog: { ...state.catalog, items: [{ scope, preview: null }, ...state.catalog.items.filter(item => !sameScope(item.scope, scope))] } });
    if (!carried) await install(owner, scope);
  }
  function requireTarget(owner: Session, target: OpenConversation): void {
    requireHost(owner);
    if (state.active !== target) throw new Error('Open the command’s conversation before continuing.');
  }
  return {
    frontendGenerations: generations,
    async releaseCapturedSend(key) {
      const owner = session;
      if (!owner) return;
      try { await owner.frontend.release(key); }
      catch (cause) { if (session === owner) publish({ error: message(cause) }); }
    },
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      if (session) return Promise.resolve();
      const closing = disposal;
      const connection = deps.createConnection({ onConnectionLost: cause => lose(next, cause) });
      const next: Session = {
        activeOwner: null, view: null, images: imageTransfers(connection),
        pool: createViewLeasePool({
          createStore: (storage, scope, agentId, capture) => createConversationStore({ scope,
            port: next.connection.conversation(scope), projection: transcriptProjection,
            drafts: storage.drafts(error => next.pool.failed(storage, error)), createCommandId: deps.createId,
            images: { upload: input => next.images.upload(input) },
            frontend: next.frontend.forStore({ viewId: storage.viewId, scope, capture, recoveryNeeded: () => recovery.wake({ pool: next.pool, storage }), eligibility: () => state.host.kind === 'ready'
              ? state.host.metadata.agents.find(item => item.id === agentId())?.frontendOffers ?? 'unsupported' : 'unsupported' }) }),
          failed: (storage, error) => failStorage(next, storage, error),
        }),
        connection,
        frontend: createFrontendSends({
          generations,
          rowsChanged() {
            if (session !== next) return;
            const capturedSends = next.frontend.snapshot();
            if (capturedSends !== state.capturedSends) publish({ capturedSends });
          },
        }),
      };
      session = next;
      publish(initialSnapshot());
      return run(async owner => {
        try {
          if (closing) await current(owner, closing);
          await current(owner, acquire(owner, null));
        }
        catch (cause) { failStorage(owner, null, cause); if (session === owner) publish({ host: { kind: 'unavailable' } }); return; }
        await refresh(owner);
      });
    },
    dispose() {
      if (!session && disposal) return disposal;
      const owner = session, drains: unknown[] = [disposal];
      const closing = Promise.resolve().then(async () => {
        const results = await Promise.allSettled(drains);
        const failures = results.filter(result => result.status === 'rejected');
        if (failures.length === 1 && failures[0]) throw failures[0].reason;
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Application disposal failed');
      });
      disposal = closing;
      const observation = observationPoll, unsubscribe = unsubscribeActive;
      observationPoll = null;
      unsubscribeActive = null;
      session = null;
      for (const close of [() => owner?.frontend.dispose(), () => owner?.pool.dispose(),
        () => recovery.retarget(null), () => observation?.stop(), stopContinuation, () => unsubscribe?.(),
        () => { if (owner) setActive(owner, null); },
        () => { if (session === null && disposal === closing) stalePermissions('Reconnect to refresh permissions.'); }]) {
        try { drains.push(close()); } catch (error) { drains.push(Promise.reject(error)); }
      }
      return closing;
    },
    reconnect: () => run(refresh),
    reopenView: viewId => run(async owner => {
      requireHost(owner);
      const previous = owner.view;
      const next = await current(owner, acquire(owner, viewId));
      if (previous?.borrow.storage === next) { await refresh(owner); return; }
      disconnectActive();
      setActive(owner, null);
      publish({ ...DETACHED_VIEW, host: { kind: 'loading' } });
      await refresh(owner);
    }),
    moreConversations: () => run(async owner => {
      const host = requireHost(owner);
      if (state.catalog.after !== null) await readCatalog(owner, host.hostId, state.catalog.after);
    }),
    async search(query, after, signal) {
      const owner = session;
      if (!owner) throw new Error('This application has closed.');
      const { hostId, principalId } = requireHost(owner);
      const page = await current(owner, owner.connection.search(query, after));
      const host = requireHost(owner);
      if (signal.aborted || host.hostId !== hostId || host.principalId !== principalId) throw new Error('Search connection changed.');
      if (page.items.some(entry => entry.scope.hostId !== hostId)) throw new Error('Search belongs to another host.');
      if (page.after !== null && page.after === after) throw new Error('Search did not advance.');
      return page;
    },
    moreSavedViews: () => run(async owner => {
      const host = requireHost(owner);
      if (state.savedViews.after !== null) await readSavedViews(owner, host.hostId, state.savedViews.after);
    }),
    create: agentId => run(owner => createConversation(owner, agentId)),
    recoverCreation: (selected) => run(async owner => {
      const view = requireSaved(owner), { saved } = view;
      const pending = saved.pendingCreation;
      if (!pending) return;
      const existing = await current(owner, owner.connection.conversationAgent(pending.scope));
      if (requireSaved(owner) !== view) throw new Error('The creation view changed.');
      if (pending.agentId !== null && existing && existing.id !== pending.agentId) {
        throw new Error('This conversation belongs to a different agent. The saved creation still needs confirmation.');
      }
      if (pending.agentId !== null && selected !== undefined && selected !== pending.agentId) {
        throw new Error('Recovery must use the saved agent. The original creation still needs confirmation.');
      }
      const agentId = pending.agentId ?? existing?.id ?? selected ?? null;
      if (agentId === null) throw new Error('This older pending creation has no saved agent. Choose an agent explicitly to continue.');
      if (pending.agentId === null && !existing && selected !== undefined) {
        const host = await current(owner, owner.connection.metadata());
        if (requireSaved(owner) !== view) throw new Error('The creation view changed.');
        const agent = host.agents.find(agent => agent.id === selected);
        if (!agent || agent.availability.kind !== 'ready') throw new Error('Choose an available agent.');
      }
      if (agentId !== pending.agentId) {
        await save(owner, { ...saved, pendingCreation: { scope: pending.scope, agentId } });
      }
      await completeCreation(owner, pending.scope, agentId);
    }),
    open: scope => run(async owner => {
      const host = requireHost(owner);
      if (scope.hostId !== host.hostId) throw new Error('Conversation belongs to another host.');
      requireSaved(owner);
      const newest = await newestSegment(owner, scope);
      await install(owner, newest);
      await moveDraft(owner, scope);
      await save(owner, { ...requireSaved(owner).saved, route: newest });
    }),
    conversationActions(target) {
      const owner = session;
      const invoke = (kind: 'send' | 'approve' | 'cancel', operation: () => Promise<SubmitResult>) => submitCommand(owner, target, () => {
        const view = target.store.getSnapshot();
        if (view.connection.kind !== 'connected') throw new Error('Connect the conversation before continuing.');
        if (!target.agent.commands.includes(kind)) throw new Error('This agent does not support that command.');
        if (kind === 'send' && conversationResponding(agentPresentation('runtime' in target.agent ? target.agent.runtime : target.agent).agent, view.document.domain)) {
          throw new Error('Wait for the current response before sending.');
        }
        return operation();
      });
      return {
        async readImage(imageId) {
          if (!owner || session !== owner) throw new Error('This application has closed.');
          requireTarget(owner, target);
          return owner.images.read(target.scope, imageId);
        },
        async retryObservation() {
          if (owner && session === owner && state.active === target) await observationPoll?.retry();
        },
        continueConversation: () => run(async active => { if (active === owner) await continuationAction(active, target, 'start'); }),
        checkContinuation: () => run(async active => { if (active === owner) await continuationAction(active, target, 'check'); }),
        startNewChat: () => run(async active => {
          if (active !== owner) return;
          requireTarget(active, target);
          await arrive('new-chat', () => createConversation(active, target.agent.id, target.scope));
        }),
        async loadEarlierSegment() {
          if (owner && session === owner) await readEarlierSegment(owner, target);
        },
        permissions: { async read() {
          if (!owner) throw new Error('Connect the conversation before continuing.');
          return readPermissions(owner, target);
        } },
        commands: {
          revokePermission: (permissionId, scope) => {
            if (!owner) return Promise.reject(new Error('Connect the conversation before continuing.'));
            try { requireTarget(owner, target); } catch (cause) { return Promise.reject(cause); }
            const current = state.permissionState;
            if (state.active !== target || current.kind !== 'fresh' ||
              !current.listing.permissions.some(row => row.permissionId === permissionId && row.scope === scope)) {
              return Promise.reject(new Error('Refresh permissions before revoking this permission.'));
            }
            return submitCommand(owner, target, () => target.store.revokePermission(permissionId, scope));
          },
          send: text => invoke('send', () => {
            if (typeof text !== 'string') throw new Error('An explicit message is required.');
            return target.store.send(text);
          }),
          approve: (pendingId, choiceId) => invoke('approve', () => target.store.approve(pendingId, choiceId)),
          cancel: runId => invoke('cancel', () => target.store.cancel(runId)),
        },
        async submit(operation) {
          try { await submitCommand(owner, target, operation); } catch {}
        },
        reconcile: id => run(async owner => {
          requireTarget(owner, target);
          await current(owner, owner.connection.reconcile(target.scope, id));
          await current(owner, target.store.refreshReceipt(id));
        }),
        abandon: id => run(async owner => {
          requireTarget(owner, target);
          const receipt = await current(owner, owner.connection.abandon(target.scope, id));
          await current(owner, target.store.refreshReceipt(id));
          if (receipt?.state.kind !== 'abandoned' && session === owner) publish({ error: NOTHING_TO_STOP_WAITING });
        }),
      };
    },
  };
}
