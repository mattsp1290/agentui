import { checkCompatibility, createConversationStore } from '@agentui/client';
import type { CompatibilityResult, ConversationStore } from '@agentui/client';
import { ServiceError, SERVICE_CATALOG_PAGE } from '@agentui/contracts/service';
import { sameScope } from '@agentui/contracts';
import { RECORDED_CLIENT_COMPATIBILITY } from '@agentui/contracts/compatibility';
import type { ConversationScope, SubmitResult } from '@agentui/contracts';
import { transcriptProjection } from '@agentui/contracts/conversation';
import type { Transcript } from '@agentui/contracts/conversation';
import type { ServiceConnection, ServiceMetadata } from '@agentui/contracts/service';
import type { OwnedViewStorage, SavedView, ViewStorageFactory } from './view-state.js';

export interface Page<T> { readonly items: readonly T[]; readonly after: string | null }
type HostState =
  | { readonly kind: 'loading' | 'unpaired' | 'unavailable' }
  | { readonly kind: 'ready'; readonly metadata: ServiceMetadata; readonly compatibility: CompatibilityResult };
export interface OpenConversation {
  readonly viewId: string;
  readonly scope: ConversationScope;
  readonly store: ConversationStore<Transcript>;
}
export interface ApplicationSnapshot {
  readonly host: HostState;
  readonly catalog: Page<ConversationScope>;
  readonly saved: SavedView;
  readonly savedViews: Page<string>;
  readonly savedViewNotice: string;
  readonly active: OpenConversation | null;
  readonly error: string;
  readonly storageFailure: string;
  readonly busy: boolean;
}
export interface ConversationActions {
  readonly enabled: boolean;
  readonly busy: boolean;
  readonly storageFailure: string;
  submit(operation: () => Promise<SubmitResult>): Promise<void>;
  reconcile(id: string): Promise<void>;
  reportDraftFailure(error: unknown): void;
}
export interface ApplicationController {
  getSnapshot(): ApplicationSnapshot;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  dispose(): void;
  pair(code: string): Promise<void>;
  reconnect(): Promise<void>;
  reopenView(viewId: string): Promise<void>;
  moreConversations(): Promise<void>;
  moreSavedViews(): Promise<void>;
  create(): Promise<void>;
  recoverCreation(): Promise<void>;
  open(scope: ConversationScope): Promise<void>;
  conversationActions(target: OpenConversation): ConversationActions;
}
type OwnedView = { readonly storage: OwnedViewStorage } & (
  | { readonly saved: null }
  | { readonly saved: SavedView; readonly hostId: string }
);
interface Session { view: OwnedView | null; readonly connection: ServiceConnection }
function initialSnapshot(): ApplicationSnapshot {
  return { host: { kind: 'loading' }, catalog: { items: [], after: null },
    saved: { version: 1, route: null, pendingCreation: null }, savedViews: { items: [], after: null },
    savedViewNotice: '', active: null, error: '', storageFailure: '', busy: false };
}
function message(error: unknown): string { return error instanceof Error ? error.message : 'The operation failed.'; }
export function applicationEnabled(state: ApplicationSnapshot): boolean {
  return state.host.kind === 'ready' && state.host.compatibility.kind === 'compatible' && !state.storageFailure && !state.busy;
}

export function createApplicationController(deps: {
  readonly createConnection: (options: { readonly onUnauthorized: () => void }) => ServiceConnection;
  readonly ownedViewStorage: ViewStorageFactory;
  readonly createId: () => string;
}): ApplicationController {
  let state = initialSnapshot();
  let session: Session | null = null;
  const listeners = new Set<() => void>();
  function publish(update: Partial<ApplicationSnapshot>): void {
    state = Object.freeze({ ...state, ...update });
    for (const listener of listeners) listener();
  }
  async function current<T>(owner: Session, operation: Promise<T>): Promise<T> {
    const result = await operation;
    if (session !== owner) throw new Error('This application has closed.');
    return result;
  }
  function failStorage(owner: Session, storage: OwnedViewStorage | null, cause: unknown): void {
    if (session !== owner || (owner.view?.storage ?? null) !== storage) return;
    publish({ storageFailure: message(cause) });
    state.active?.store.disconnect();
  }
  function local(owner: Session): OwnedViewStorage {
    if (session !== owner || !owner.view || state.storageFailure) throw new Error(state.storageFailure || 'Local storage is not ready.');
    return owner.view.storage;
  }
  function requireHost(owner: Session): ServiceMetadata {
    local(owner);
    if (state.host.kind !== 'ready' || state.host.compatibility.kind !== 'compatible') throw new Error('A compatible paired host is required.');
    return state.host.metadata;
  }
  function requireSaved(owner: Session): OwnedView & { readonly saved: SavedView; readonly hostId: string } {
    const host = requireHost(owner);
    const view = owner.view;
    if (!view || view.saved === null || view.hostId !== host.hostId) throw new Error('This view is still loading.');
    return view;
  }
  async function acquire(owner: Session, viewId: string | null): Promise<OwnedViewStorage> {
    let storage: OwnedViewStorage | null = null;
    const failed = (cause: unknown) => failStorage(owner, storage, cause);
    storage = await (viewId === null ? deps.ownedViewStorage.open(failed) : deps.ownedViewStorage.reopen(viewId, failed));
    if (session !== owner) { storage.close(); throw new Error('This application has closed.'); }
    return storage;
  }
  async function save(owner: Session, hostId: string, next: SavedView): Promise<void> {
    const view = requireSaved(owner);
    if (view.hostId !== hostId) throw new Error('Saved view belongs to another host.');
    try {
      await current(owner, view.storage.saveView(hostId, next));
      owner.view = { ...view, saved: next };
      publish({ saved: next });
    } catch (cause) { failStorage(owner, view.storage, cause); throw cause; }
  }
  async function install(owner: Session, scope: ConversationScope): Promise<void> {
    const storage = local(owner);
    if (state.active && sameScope(state.active.scope, scope)) { await current(owner, state.active.store.connect()); return; }
    state.active?.store.disconnect();
    const failed = (cause: unknown) => failStorage(owner, storage, cause);
    const store = createConversationStore({ scope, port: owner.connection.conversation(scope), projection: transcriptProjection,
      drafts: storage.drafts(failed), createCommandId: deps.createId });
    try { await current(owner, store.ready); local(owner); }
    catch (cause) { store.disconnect(); failed(cause); throw cause; }
    publish({ active: { scope, store, viewId: storage.viewId } });
    await current(owner, store.connect());
  }
  async function readCatalog(owner: Session, hostId: string, after: string | null = null): Promise<void> {
    const items = await current(owner, owner.connection.catalog(after, SERVICE_CATALOG_PAGE));
    if (items.some(scope => scope.hostId !== hostId)) throw new Error('Catalog belongs to another host.');
    const next = items.length === SERVICE_CATALOG_PAGE ? items.at(-1)?.conversationId ?? null : null;
    if (next !== null && next === after) throw new Error('Catalog did not advance.');
    publish({ catalog: { items: after === null ? items : [...state.catalog.items, ...items], after: next } });
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
    publish({ host: { kind: 'loading' } });
    let metadata: ServiceMetadata;
    try { metadata = await current(owner, owner.connection.metadata()); }
    catch (cause) {
      if (session === owner) publish({ host: { kind: 'unavailable' } });
      throw cause;
    }
    const previous = owner.view;
    if (previous && previous.saved !== null && previous.hostId !== metadata.hostId) {
      state.active?.store.disconnect();
      owner.view = { storage, saved: null };
      publish({ active: null, saved: initialSnapshot().saved, catalog: { items: [], after: null },
        savedViews: { items: [], after: null }, savedViewNotice: '' });
    }
    const compatibility = checkCompatibility(RECORDED_CLIENT_COMPATIBILITY, metadata.compatibility);
    if (compatibility.kind !== 'compatible') {
      state.active?.store.disconnect();
      publish({ host: { kind: 'ready', metadata, compatibility } });
      return;
    }
    let saved: SavedView;
    try { saved = await current(owner, storage.readView(metadata.hostId)); }
    catch (cause) { failStorage(owner, storage, cause); throw cause; }
    owner.view = { storage, saved, hostId: metadata.hostId };
    publish({ saved, host: { kind: 'ready', metadata, compatibility } });
    const results = await Promise.allSettled([readCatalog(owner, metadata.hostId), readSavedViews(owner, metadata.hostId),
      saved.route ? install(owner, saved.route) : Promise.resolve()]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  async function run(operation: (owner: Session) => Promise<void>): Promise<void> {
    const owner = session;
    if (!owner || state.busy) return;
    publish({ busy: true, error: '' });
    try { await operation(owner); }
    catch (cause) {
      if (session === owner) publish({ error: message(cause),
        ...(cause instanceof ServiceError && cause.kind === 'unauthorized' ? { host: { kind: 'unpaired' } } : {}) });
    } finally { if (session === owner) publish({ busy: false }); }
  }
  async function completeCreation(owner: Session, scope: ConversationScope): Promise<void> {
    await current(owner, owner.connection.create(scope));
    await save(owner, scope.hostId, { version: 1, route: scope, pendingCreation: null });
    await install(owner, scope);
    await readCatalog(owner, scope.hostId);
  }
  function requireTarget(owner: Session, target: OpenConversation): void {
    requireHost(owner);
    if (state.active !== target) throw new Error('Open the command’s conversation before continuing.');
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      if (session) return Promise.resolve();
      const next: Session = { view: null, connection: deps.createConnection({ onUnauthorized: () => {
        if (session !== next) return;
        state.active?.store.disconnect();
        publish({ host: { kind: 'unpaired' }, error: 'Pair this browser to the host. Its previous access may have been revoked.' });
      } }) };
      session = next;
      publish(initialSnapshot());
      return run(async owner => {
        try { owner.view = { storage: await acquire(owner, null), saved: null }; }
        catch (cause) { failStorage(owner, null, cause); return; }
        try { await refresh(owner); }
        catch (cause) {
          if (session === owner && !(cause instanceof ServiceError && cause.kind === 'unauthorized')) publish({ host: { kind: 'unavailable' } });
          throw cause;
        }
      });
    },
    dispose() {
      const owner = session;
      session = null;
      state.active?.store.disconnect();
      owner?.view?.storage.close();
    },
    pair: code => run(async owner => { local(owner); await current(owner, owner.connection.pair(code)); await refresh(owner); }),
    reconnect: () => run(refresh),
    reopenView: viewId => run(async owner => {
      requireHost(owner);
      const next = await acquire(owner, viewId);
      state.active?.store.disconnect();
      owner.view?.storage.close();
      owner.view = { storage: next, saved: null };
      publish({ active: null, saved: initialSnapshot().saved, catalog: { items: [], after: null }, savedViews: { items: [], after: null },
        savedViewNotice: '', host: { kind: 'loading' } });
      await refresh(owner);
    }),
    moreConversations: () => run(async owner => {
      const host = requireHost(owner);
      if (state.catalog.after !== null) await readCatalog(owner, host.hostId, state.catalog.after);
    }),
    moreSavedViews: () => run(async owner => {
      const host = requireHost(owner);
      if (state.savedViews.after !== null) await readSavedViews(owner, host.hostId, state.savedViews.after);
    }),
    create: () => run(async owner => {
      const host = requireHost(owner);
      const { saved } = requireSaved(owner);
      if (saved.pendingCreation) throw new Error('Recover the pending creation before creating another conversation.');
      const scope = { hostId: host.hostId, conversationId: deps.createId() };
      await save(owner, host.hostId, { ...saved, pendingCreation: scope });
      requireHost(owner);
      await completeCreation(owner, scope);
    }),
    recoverCreation: () => run(async owner => { const { saved } = requireSaved(owner); if (saved.pendingCreation) await completeCreation(owner, saved.pendingCreation); }),
    open: scope => run(async owner => {
      const host = requireHost(owner);
      if (scope.hostId !== host.hostId) throw new Error('Conversation belongs to another host.');
      await save(owner, scope.hostId, { ...requireSaved(owner).saved, route: scope });
      await install(owner, scope);
    }),
    conversationActions(target) {
      return { enabled: applicationEnabled(state), busy: state.busy, storageFailure: state.storageFailure,
        submit: operation => run(async owner => { requireTarget(owner, target); const result = await current(owner, operation()); if (result.kind === 'rejected') throw new Error(result.reason); }),
        reconcile: id => run(async owner => { requireTarget(owner, target); await current(owner, owner.connection.reconcile(target.scope, id)); await current(owner, target.store.refreshReceipt(id)); }),
        reportDraftFailure: cause => { if (session && state.active === target) failStorage(session, session.view?.storage ?? null, cause); } };
    },
  };
}
